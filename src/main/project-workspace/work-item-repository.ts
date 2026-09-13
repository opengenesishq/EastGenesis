import { randomUUID } from 'node:crypto'
import { newBusinessLineId } from '../business-line-ownership'
import type {
  AcceptanceResult,
  Goal,
  GoalContract,
  MutationOptions,
  ProjectWorkspaceState,
  WorkItem,
  WorkItemInput,
  WorkItemLease,
  WorkItemPatch,
  WorkItemReorderPlacement,
  WorkItemStatus,
  WorkItemType
} from '../../shared/project-workspace-types'
import {
  isAcceptanceSatisfied,
  isWorkItemStatus,
  isWorkItemType,
  PROJECT_WORKSPACE_SCHEMA_VERSION
} from '../../shared/project-workspace-types'
import {
  clone,
  finiteNumber,
  normalizeAcceptanceResult,
  normalizeAcceptanceSpecs,
  normalizeOwner,
  optionalId,
  optionalText,
  requiredId,
  requiredText,
  timestamp
} from './codec'
import { ProjectWorkspaceError } from './errors'
import { appendEvent, ProjectWorkspacePersistence } from './persistence'
import type { LeaseOptions, ListOptions } from './repository-types'
import {
  activeWorkspaceFrom,
  assertProject,
  assertSameProject,
  goalFrom,
  workItemFrom,
  workspaceFrom
} from './state-access'
import { assertProjectAuthorized, projectMutationActor } from './project-authorization'

const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, ReadonlySet<WorkItemStatus>> = {
  backlog: new Set(['ready', 'cancelled']),
  ready: new Set(['running', 'cancelled']),
  running: new Set(['waiting_approval', 'blocked', 'verifying', 'cancelled']),
  waiting_approval: new Set(['running', 'blocked']),
  blocked: new Set(['ready', 'failed', 'cancelled']),
  verifying: new Set(['done', 'failed', 'ready']),
  done: new Set([]),
  failed: new Set([]),
  cancelled: new Set([])
}

const BOARD_ORDER_STEP = 1024

export class WorkItemRepository {
  constructor(private readonly persistence: ProjectWorkspacePersistence) {}

  async create(input: WorkItemInput, options?: MutationOptions | number): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const projectId = requiredId(input.projectId, 'work item projectId')
      const project = activeWorkspaceFrom(state, projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      const id = optionalId(input.id, 'work item id') ?? randomUUID()
      assertUniqueWorkItem(state, id)
      const goal = resolveGoal(state, input.goalId, projectId)
      const item = buildWorkItem(state, input, id, projectId, goal, now)
      assertParentAndDependencies(state, item.id, projectId, item.parentId, item.dependencyIds)
      assertRunReferenceOwnership(state, item)
      if (item.status === 'ready') assertDependencySatisfied(state, item)
      state.workItems.push(item)
      appendEvent(state, projectId, 'work_item', id, 'work_item.created', 1, item as unknown as Record<string, unknown>, now)
      return item
    })
  }

  async get(id: string): Promise<WorkItem | undefined> {
    const state = await this.persistence.read()
    const item = state.workItems.find((candidate) => candidate.id === id)
    return item ? clone(item) : undefined
  }

  async list(projectId?: string, options: ListOptions = {}): Promise<WorkItem[]> {
    const state = await this.persistence.read()
    if (projectId !== undefined) requiredId(projectId, 'projectId')
    return state.workItems
      .filter((item) => projectId === undefined || item.projectId === projectId)
      .filter((item) => options.goalId === undefined || item.goalId === options.goalId)
      .filter((item) => options.includeDeleted || workspaceFrom(state, item.projectId).status !== 'deleted')
      .map(clone)
  }

  async update(id: string, patch: WorkItemPatch, options?: MutationOptions | number): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const item = workItemFrom(state, id)
      const project = assertProject(state, item.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      this.persistence.assertEntityRevision(item.revision, options, 'work item')
      assertWorkItemEditable(item)
      applyWorkItemPatch(state, item, patch)
      item.updatedAt = now
      item.revision += 1
      appendEvent(state, item.projectId, 'work_item', item.id, 'work_item.updated', item.revision, patch as unknown as Record<string, unknown>, now)
      return item
    })
  }

  async reorder(
    id: string,
    targetId: string,
    placement: WorkItemReorderPlacement,
    options?: MutationOptions | number
  ): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const item = workItemFrom(state, id)
      const target = workItemFrom(state, requiredId(targetId, 'work item reorder targetId'))
      const project = assertProject(state, item.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      this.persistence.assertEntityRevision(item.revision, options, 'work item')
      assertSameProject(target.projectId, item.projectId, 'reorder target')
      if (item.id === target.id) throw new ProjectWorkspaceError('invalid_input', 'work item cannot be reordered relative to itself')
      if (placement !== 'before' && placement !== 'after') {
        throw new ProjectWorkspaceError('invalid_input', 'work item reorder placement must be before or after')
      }

      const siblings = state.workItems
        .filter((candidate) => candidate.projectId === item.projectId && candidate.id !== item.id)
        .sort(compareBoardOrder)
      const targetIndex = siblings.findIndex((candidate) => candidate.id === target.id)
      if (targetIndex < 0) throw new ProjectWorkspaceError('not_found', `work item reorder target ${target.id} does not exist`)
      const insertionIndex = placement === 'before' ? targetIndex : targetIndex + 1
      let previous = siblings[insertionIndex - 1]
      let next = siblings[insertionIndex]
      if (!hasBoardOrderSpace(previous, next)) {
        normalizeBoardOrders(state, item.projectId, item.id, now)
        siblings.sort(compareBoardOrder)
        previous = siblings[insertionIndex - 1]
        next = siblings[insertionIndex]
      }
      item.boardOrder = boardOrderBetween(previous, next)
      item.updatedAt = now
      item.revision += 1
      appendEvent(state, item.projectId, 'work_item', item.id, 'work_item.reordered', item.revision, {
        targetId: target.id,
        placement,
        boardOrder: item.boardOrder
      }, now)
      return item
    })
  }

  async setAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const item = workItemFrom(state, id)
      const project = assertProject(state, item.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'approve')
      this.persistence.assertEntityRevision(item.revision, options, 'work item')
      item.acceptance = normalizeAcceptanceResult(result)
      if (!item.acceptance) throw new ProjectWorkspaceError('invalid_input', 'work item acceptance result is required')
      item.updatedAt = now
      item.revision += 1
      appendEvent(state, item.projectId, 'work_item', item.id, 'work_item.acceptance_updated', item.revision, { acceptance: item.acceptance }, now)
      return item
    })
  }

  async transition(id: string, status: WorkItemStatus, options?: MutationOptions | number): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const item = workItemFrom(state, id)
      const project = assertProject(state, item.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      this.persistence.assertEntityRevision(item.revision, options, 'work item')
      validateWorkItemTransition(state, item, status, now)
      if (item.status === status) return item
      item.status = status
      item.updatedAt = now
      if (isTerminalWorkItem(status)) item.lease = undefined
      item.revision += 1
      appendEvent(state, item.projectId, 'work_item', item.id, `work_item.${status}`, item.revision, { status }, now)
      return item
    })
  }

  async acquireLease(id: string, options: LeaseOptions = {}): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const item = workItemFrom(state, id)
      const project = assertProject(state, item.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'execute')
      this.persistence.assertEntityRevision(item.revision, options, 'work item')
      const ownerId = validateLeaseAcquisition(item, options, now)
      item.lease = buildLease(item.lease, ownerId, options, now)
      item.updatedAt = now
      item.revision += 1
      appendEvent(state, item.projectId, 'work_item', item.id, 'work_item.lease_acquired', item.revision, { lease: item.lease }, now)
      return item
    })
  }

  async renewLease(id: string, options: LeaseOptions = {}): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const item = workItemFrom(state, id)
      const project = assertProject(state, item.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'execute')
      this.persistence.assertEntityRevision(item.revision, options, 'work item')
      validateCurrentLease(item, options, now)
      const durationMs = leaseDuration(options.durationMs)
      if (!item.lease) throw new ProjectWorkspaceError('lease_expired', `work item ${id} lease is expired`)
      item.lease.expiresAt = now + durationMs
      item.updatedAt = now
      item.revision += 1
      appendEvent(state, item.projectId, 'work_item', item.id, 'work_item.lease_renewed', item.revision, { lease: item.lease }, now)
      return item
    })
  }

  async releaseLease(id: string, options: LeaseOptions = {}): Promise<WorkItem> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const item = workItemFrom(state, id)
      const project = assertProject(state, item.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'execute')
      this.persistence.assertEntityRevision(item.revision, options, 'work item')
      validateLeaseIdentity(item.lease, options)
      item.lease = undefined
      item.updatedAt = now
      item.revision += 1
      appendEvent(state, item.projectId, 'work_item', item.id, 'work_item.lease_released', item.revision, {}, now)
      return item
    })
  }

  async effectiveContract(id: string): Promise<GoalContract | undefined> {
    const item = await this.get(id)
    return item?.inheritedGoalContract ? clone(item.inheritedGoalContract) : undefined
  }
}

function assertUniqueWorkItem(state: ProjectWorkspaceState, id: string): void {
  if (state.workItems.some((item) => item.id === id)) {
    throw new ProjectWorkspaceError('already_exists', `work item ${id} already exists`)
  }
}

function resolveGoal(state: ProjectWorkspaceState, goalId: string | undefined, projectId: string): Goal | undefined {
  if (goalId === undefined) return undefined
  const goal = goalFrom(state, requiredId(goalId, 'work item goalId'))
  assertSameProject(goal.projectId, projectId, 'goal')
  if (goal.status === 'completed' || goal.status === 'failed' || goal.status === 'cancelled' || goal.status === 'archived') {
    throw new ProjectWorkspaceError('terminal', `goal ${goal.id} is terminal and cannot accept new WorkItems`)
  }
  return goal
}

function buildWorkItem(
  state: ProjectWorkspaceState,
  input: WorkItemInput,
  id: string,
  projectId: string,
  goal: Goal | undefined,
  now: number
): WorkItem {
  const type: WorkItemType = input.type ?? 'custom'
  if (!isWorkItemType(type)) throw new ProjectWorkspaceError('invalid_input', 'work item type is invalid')
  const status = input.status ?? 'backlog'
  if (!isWorkItemStatus(status) || status === 'running' || status === 'done') {
    throw new ProjectWorkspaceError('invalid_input', 'work item status is invalid at creation')
  }
  const createdAt = timestamp(input.createdAt, 'work item createdAt', now)
  return {
    schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    id,
    projectId,
    businessLineId: newBusinessLineId(input.businessLineId, input.parentId ? state.workItems.find((item) => item.id === input.parentId)?.businessLineId ?? 'studio' : undefined),
    goalId: goal?.id,
    parentId: optionalId(input.parentId, 'work item parentId'),
    type,
    title: requiredText(input.title, 'work item title'),
    description: optionalText(input.description, 'work item description'),
    dependencyIds: uniqueIds(input.dependencyIds, 'work item dependency id'),
    priority: finiteNumber(input.priority, 'work item priority', 0),
    boardOrder: nextBoardOrder(state, projectId),
    owner: normalizeOwner(input.owner),
    status,
    dueAt: resolveDueAt(input.dueAt, goal),
    acceptanceSpec: normalizeAcceptanceSpecs(input.acceptanceSpec ?? goal?.contract.acceptance, 'work item acceptanceSpec'),
    artifactRefs: uniqueIds(input.artifactRefs, 'work item artifact ref'),
    runRefs: uniqueIds(input.runRefs, 'work item run ref'),
    inheritedGoalContract: goal ? clone(goal.contract) : undefined,
    createdAt,
    updatedAt: timestamp(input.updatedAt, 'work item updatedAt', createdAt),
    revision: 1
  }
}

function nextBoardOrder(state: ProjectWorkspaceState, projectId: string): number {
  let maximum: number | undefined
  for (const item of state.workItems) {
    if (item.projectId !== projectId) continue
    const order = effectiveBoardOrder(item)
    maximum = maximum === undefined ? order : Math.max(maximum, order)
  }
  return maximum === undefined ? BOARD_ORDER_STEP : maximum + BOARD_ORDER_STEP
}

function effectiveBoardOrder(item: WorkItem): number {
  return Number.isFinite(item.boardOrder) ? item.boardOrder! : item.createdAt
}

function compareBoardOrder(left: WorkItem, right: WorkItem): number {
  const order = effectiveBoardOrder(left) - effectiveBoardOrder(right)
  if (order !== 0) return order
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id.localeCompare(right.id)
}

function boardOrderBetween(previous: WorkItem | undefined, next: WorkItem | undefined): number {
  if (!previous && !next) return 0
  if (!previous) return effectiveBoardOrder(next!) - BOARD_ORDER_STEP
  if (!next) return effectiveBoardOrder(previous) + BOARD_ORDER_STEP
  return (effectiveBoardOrder(previous) + effectiveBoardOrder(next)) / 2
}

function hasBoardOrderSpace(previous: WorkItem | undefined, next: WorkItem | undefined): boolean {
  const candidate = boardOrderBetween(previous, next)
  return Number.isFinite(candidate) &&
    (!previous || candidate > effectiveBoardOrder(previous)) &&
    (!next || candidate < effectiveBoardOrder(next))
}

function normalizeBoardOrders(
  state: ProjectWorkspaceState,
  projectId: string,
  movingId: string,
  now: number
): void {
  const ordered = state.workItems
    .filter((candidate) => candidate.projectId === projectId && candidate.id !== movingId)
    .sort(compareBoardOrder)
  ordered.forEach((candidate, index) => {
    const boardOrder = (index + 1) * BOARD_ORDER_STEP
    if (candidate.boardOrder === boardOrder) return
    candidate.boardOrder = boardOrder
    candidate.updatedAt = now
    candidate.revision += 1
    appendEvent(state, candidate.projectId, 'work_item', candidate.id, 'work_item.order_normalized', candidate.revision, {
      boardOrder
    }, now)
  })
}

function uniqueIds(values: string[] | undefined, label: string): string[] {
  return [...new Set((values ?? []).map((value) => requiredId(value, label)))]
}

function resolveDueAt(value: number | undefined, goal: Goal | undefined): number | undefined {
  const dueAt = value ?? goal?.contract.dueAt
  if (dueAt === undefined) return undefined
  timestamp(dueAt, 'work item dueAt')
  if (goal?.contract.dueAt !== undefined && dueAt > goal.contract.dueAt) {
    throw new ProjectWorkspaceError('contract_violation', 'work item dueAt exceeds inherited Goal dueAt')
  }
  return dueAt
}

function assertWorkItemEditable(item: WorkItem): void {
  if (item.status === 'done' || item.status === 'cancelled') {
    throw new ProjectWorkspaceError('terminal', `work item ${item.id} is terminal`)
  }
}

function applyWorkItemPatch(state: ProjectWorkspaceState, item: WorkItem, patch: WorkItemPatch): void {
  applyWorkItemRelations(state, item, patch)
  applyWorkItemFields(state, item, patch)
  applyWorkItemReferences(state, item, patch)
}

function applyWorkItemRelations(state: ProjectWorkspaceState, item: WorkItem, patch: WorkItemPatch): void {
  const parentId = patch.parentId === undefined ? item.parentId : optionalId(patch.parentId, 'work item parentId')
  const dependencyIds = patch.dependencyIds === undefined
    ? item.dependencyIds
    : uniqueIds(patch.dependencyIds, 'work item dependency id')
  assertParentAndDependencies(state, item.id, item.projectId, parentId, dependencyIds)
  item.parentId = parentId
  item.dependencyIds = dependencyIds
}

function applyWorkItemFields(state: ProjectWorkspaceState, item: WorkItem, patch: WorkItemPatch): void {
  if (patch.title !== undefined) item.title = requiredText(patch.title, 'work item title')
  if (patch.description !== undefined) item.description = optionalText(patch.description, 'work item description')
  if (patch.type !== undefined) {
    if (!isWorkItemType(patch.type)) throw new ProjectWorkspaceError('invalid_input', 'work item type is invalid')
    item.type = patch.type
  }
  if (patch.priority !== undefined) item.priority = finiteNumber(patch.priority, 'work item priority', item.priority)
  if (Object.hasOwn(patch, 'owner')) {
    item.owner = normalizeOwner(patch.owner)
    item.lease = undefined
  }
  if (patch.dueAt !== undefined) item.dueAt = resolveDueAt(patch.dueAt, item.goalId ? goalFrom(state, item.goalId) : undefined)
}

function applyWorkItemReferences(state: ProjectWorkspaceState, item: WorkItem, patch: WorkItemPatch): void {
  if (patch.acceptanceSpec !== undefined) {
    item.acceptanceSpec = normalizeAcceptanceSpecs(patch.acceptanceSpec, 'work item acceptanceSpec')
  }
  if (patch.artifactRefs !== undefined) item.artifactRefs = uniqueIds(patch.artifactRefs, 'work item artifact ref')
  if (patch.runRefs !== undefined) {
    const runRefs = uniqueIds(patch.runRefs, 'work item run ref')
    assertRunReferenceOwnership(state, { ...item, runRefs })
    item.runRefs = runRefs
  }
}

/**
 * A Run is a single execution identity. It may have many historical entries
 * on one WorkItem, but it must never be claimed by two canonical WorkItems.
 * Keep this check inside the repository mutation so the ProjectWorkspace lock
 * makes the invariant atomic across concurrent command callers.
 */
function assertRunReferenceOwnership(
  state: ProjectWorkspaceState,
  item: Pick<WorkItem, 'id' | 'runRefs'>
): void {
  const references = new Set(item.runRefs)
  if (references.size === 0) return
  const conflict = state.workItems.find((candidate) =>
    candidate.id !== item.id && candidate.runRefs.some((runId) => references.has(runId))
  )
  if (!conflict) return
  const runId = conflict.runRefs.find((candidate) => references.has(candidate))!
  throw new ProjectWorkspaceError(
    'run_reference_conflict',
    `Run ${runId} is already claimed by WorkItem ${conflict.id}`,
    { runId, ownerWorkItemId: conflict.id, requestedWorkItemId: item.id }
  )
}

function assertParentAndDependencies(
  state: ProjectWorkspaceState,
  itemId: string,
  projectId: string,
  parentId: string | undefined,
  dependencyIds: string[]
): void {
  assertParent(state, itemId, projectId, parentId)
  for (const dependencyId of dependencyIds) {
    if (dependencyId === itemId) throw new ProjectWorkspaceError('cycle', 'work item cannot depend on itself')
    const dependency = workItemFrom(state, dependencyId)
    assertSameProject(dependency.projectId, projectId, 'dependency')
    if (hasDependencyPath(state, dependency.id, itemId, new Set())) {
      throw new ProjectWorkspaceError('cycle', `dependency cycle detected through ${dependencyId}`)
    }
  }
}

function assertParent(state: ProjectWorkspaceState, itemId: string, projectId: string, parentId: string | undefined): void {
  if (parentId === undefined) return
  if (parentId === itemId) throw new ProjectWorkspaceError('invalid_relation', 'work item cannot be its own parent')
  let cursor: WorkItem | undefined = workItemFrom(state, parentId)
  assertSameProject(cursor.projectId, projectId, 'parent')
  const visited = new Set<string>([itemId])
  while (cursor?.parentId) {
    if (visited.has(cursor.parentId)) throw new ProjectWorkspaceError('cycle', 'work item parent cycle detected')
    visited.add(cursor.parentId)
    cursor = state.workItems.find((candidate) => candidate.id === cursor?.parentId)
  }
}

function hasDependencyPath(state: ProjectWorkspaceState, fromId: string, targetId: string, visited: Set<string>): boolean {
  if (fromId === targetId) return true
  if (visited.has(fromId)) return false
  visited.add(fromId)
  const item = state.workItems.find((candidate) => candidate.id === fromId)
  return item ? item.dependencyIds.some((dependencyId) => hasDependencyPath(state, dependencyId, targetId, visited)) : false
}

function assertDependencySatisfied(state: ProjectWorkspaceState, item: WorkItem): void {
  const unresolved = item.dependencyIds.map((id) => workItemFrom(state, id)).filter((dependency) => dependency.status !== 'done')
  if (unresolved.length > 0) {
    throw new ProjectWorkspaceError('dependency_blocked', `work item ${item.id} has unresolved dependencies`, {
      dependencyIds: unresolved.map((dependency) => dependency.id)
    })
  }
}

function validateWorkItemTransition(state: ProjectWorkspaceState, item: WorkItem, status: WorkItemStatus, now: number): void {
  if (!isWorkItemStatus(status)) throw new ProjectWorkspaceError('invalid_input', `work item status ${String(status)} is invalid`)
  if (item.status === status) return
  if (!WORK_ITEM_TRANSITIONS[item.status].has(status)) {
    throw new ProjectWorkspaceError('invalid_transition', `work item ${item.id} cannot transition ${item.status} -> ${status}`)
  }
  if (status === 'ready' || status === 'running') assertDependencySatisfied(state, item)
  if (status === 'running') assertRunnable(item, now)
  if (status === 'done' && !isAcceptanceSatisfied(item.acceptance)) {
    throw new ProjectWorkspaceError('acceptance_required', `work item ${item.id} needs passed or waived Acceptance before done`)
  }
}

function assertRunnable(item: WorkItem, now: number): void {
  if (!item.owner) throw new ProjectWorkspaceError('owner_required', `work item ${item.id} needs an owner before running`)
  if (!isActiveLease(item.lease, now)) throw new ProjectWorkspaceError('lease_required', `work item ${item.id} needs an active lease before running`)
}

function isTerminalWorkItem(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function isActiveLease(lease: WorkItemLease | undefined, now: number): boolean {
  return Boolean(lease && lease.expiresAt > now)
}

function validateLeaseAcquisition(item: WorkItem, options: LeaseOptions, now: number): string {
  if (item.status !== 'ready' && item.status !== 'running') {
    throw new ProjectWorkspaceError('invalid_transition', `work item ${item.id} cannot acquire a lease from ${item.status}`)
  }
  if (!item.owner) throw new ProjectWorkspaceError('owner_required', `work item ${item.id} needs an owner before lease`)
  const ownerId = requiredId(options.ownerId ?? item.owner.id, 'lease ownerId')
  if (ownerId !== item.owner.id) throw new ProjectWorkspaceError('lease_owner', `lease owner ${ownerId} does not match work item owner`)
  if (isActiveLease(item.lease, now) && item.lease?.id !== options.leaseId) {
    throw new ProjectWorkspaceError('lease_conflict', `work item ${item.id} already has an active lease`)
  }
  return ownerId
}

function leaseDuration(value: number | undefined): number {
  const durationMs = value ?? 30_000
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86_400_000) {
    throw new ProjectWorkspaceError('invalid_input', 'lease durationMs must be between 1 and 86400000')
  }
  return durationMs
}

function buildLease(current: WorkItemLease | undefined, ownerId: string, options: LeaseOptions, now: number): WorkItemLease {
  return {
    id: options.leaseId ? requiredId(options.leaseId, 'lease id') : randomUUID(),
    ownerId,
    acquiredAt: now,
    expiresAt: now + leaseDuration(options.durationMs),
    fencingToken: (current?.fencingToken ?? 0) + 1
  }
}

function validateCurrentLease(item: WorkItem, options: LeaseOptions, now: number): void {
  if (!item.lease || !isActiveLease(item.lease, now)) {
    throw new ProjectWorkspaceError('lease_expired', `work item ${item.id} lease is expired`)
  }
  validateLeaseIdentity(item.lease, options)
}

function validateLeaseIdentity(lease: WorkItemLease | undefined, options: LeaseOptions): void {
  if (!lease) return
  if (options.leaseId && lease.id !== options.leaseId) throw new ProjectWorkspaceError('stale_lease', 'lease id is stale')
  if (options.fencingToken !== undefined && lease.fencingToken !== options.fencingToken) {
    throw new ProjectWorkspaceError('stale_lease', 'lease fencing token is stale')
  }
  if (options.ownerId && lease.ownerId !== options.ownerId) throw new ProjectWorkspaceError('lease_owner', 'lease owner does not match')
}
