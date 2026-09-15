import type {
  Goal,
  ProjectWorkspace,
  ProjectWorkspaceState,
  WorkItem
} from '../../shared/project-workspace-types'
import type {
  WorkflowGoalProjectionInput,
  WorkflowGoalRecord,
  WorkflowWorkItemProjectionInput,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import {
  digest,
  normalizeGoalInput,
  normalizeWorkItemInput
} from '../task/workflow-ledger-codec'
import { readRegularFile, sha256 } from '../task/workflow-ledger-migration-storage'
import { findWorkflowRun, type WorkflowLedgerDatabase } from '../task/workflow-ledger-store'
import {
  parseProjectWorkspaceState,
  projectWorkspaceFile
} from './persistence'
import { canonicalJson } from './codec'
import {
  finiteTimestamp,
  isId,
  migrationError,
  nonNegativeRevision,
  positiveRevision,
  safeError
} from './ledger-migration-errors'

export interface SourceFile {
  path: string
  bytes: Buffer
  sha256: string
  state: ProjectWorkspaceState
  aggregate: WorkspaceAggregate
}

export type ProjectWorkspaceSourceValidationMode = 'global' | 'workspace'

export interface WorkspaceAggregate {
  workspace: ProjectWorkspace
  goals: Goal[]
  workItems: WorkItem[]
}

export interface ProjectedGoal {
  source: Goal
  input: WorkflowGoalProjectionInput
  record: WorkflowGoalRecord
  descriptor: GoalMigrationDescriptor
}

export interface ProjectedWorkItem {
  source: WorkItem
  input: WorkflowWorkItemProjectionInput
  record: WorkflowWorkItemRecord
  descriptor: WorkItemMigrationDescriptor
}

export interface GoalMigrationDescriptor {
  id: string
  sourceRevision: number
  sourceDigest: string
  ledgerDigest: string
  projectId: string
  source: Goal
}

export interface WorkItemMigrationDescriptor {
  id: string
  sourceRevision: number
  sourceDigest: string
  ledgerDigest: string
  projectId: string
  goalId?: string
  parentId?: string
  runRefs: string[]
  source: WorkItem
}

export interface ProjectionBundle {
  workspaceDigest: string
  projectionDigest: string
  goals: ProjectedGoal[]
  workItems: ProjectedWorkItem[]
}

export async function readProjectWorkspaceMigrationSource(
  rootDir: string,
  workspaceId: string,
  validationMode: ProjectWorkspaceSourceValidationMode = 'global'
): Promise<SourceFile> {
  const path = projectWorkspaceFile(rootDir)
  let bytes: Buffer
  try {
    bytes = await readRegularFile(path, 'ProjectWorkspace JSON source')
  } catch (error) {
    throw migrationError('SOURCE_UNAVAILABLE', `Cannot read ProjectWorkspace JSON source: ${safeError(error)}`)
  }
  let state: ProjectWorkspaceState
  try {
    state = parseProjectWorkspaceState(bytes.toString('utf8'))
  } catch (error) {
    throw migrationError('SOURCE_INVALID', `Cannot parse ProjectWorkspace JSON source: ${safeError(error)}`)
  }
  return {
    path,
    bytes,
    sha256: sha256(bytes),
    state,
    aggregate: validationMode === 'global'
      ? validateGlobalState(state, workspaceId)
      : validateWorkspaceState(state, workspaceId)
  }
}

export function buildProjectWorkspaceMigrationSourceFromState(
  state: ProjectWorkspaceState,
  rootDir: string,
  workspaceId: string,
  validationMode: ProjectWorkspaceSourceValidationMode = 'global'
): SourceFile {
  const path = projectWorkspaceFile(rootDir)
  const bytes = Buffer.from(`${canonicalJson(state)}\n`, 'utf8')
  return {
    path,
    bytes,
    sha256: sha256(bytes),
    state,
    aggregate: buildProjectWorkspaceAggregateFromState(state, workspaceId, validationMode)
  }
}

export function buildProjectWorkspaceAggregateFromState(
  state: ProjectWorkspaceState,
  workspaceId: string,
  validationMode: ProjectWorkspaceSourceValidationMode = 'global'
): WorkspaceAggregate {
  return validationMode === 'global'
    ? validateGlobalState(state, workspaceId)
    : validateWorkspaceState(state, workspaceId)
}

export function buildProjectWorkspaceProjection(aggregate: WorkspaceAggregate): ProjectionBundle {
  const goals = aggregate.goals.map((source): ProjectedGoal => {
    const input: WorkflowGoalProjectionInput = {
      id: source.id,
      projectId: source.projectId,
      title: source.title,
      objective: source.objective,
      status: source.status,
      revision: source.revision,
      source: 'explicit',
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      dueAt: source.dueAt,
      archivedAt: source.archivedAt
    }
    const record = normalizeGoalInput(input)
    return {
      source,
      input,
      record,
      descriptor: {
        id: source.id,
        sourceRevision: source.revision,
        sourceDigest: digest(source),
        ledgerDigest: digest(record),
        projectId: source.projectId,
        source
      }
    }
  })

  const workItems = aggregate.workItems.map((source): ProjectedWorkItem => {
    const input: WorkflowWorkItemProjectionInput = {
      id: source.id,
      projectId: source.projectId,
      goalId: source.goalId,
      parentId: source.parentId,
      businessLineId: source.businessLineId,
      type: source.type,
      ...(source.role === undefined ? {} : { role: source.role }),
      title: source.title,
      description: source.description,
      status: source.status,
      revision: source.revision,
      source: 'explicit',
      runIds: [...source.runRefs],
      currentRunId: source.runRefs.at(-1),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      dueAt: source.dueAt
    }
    const record = normalizeWorkItemInput(input)
    return {
      source,
      input,
      record,
      descriptor: {
        id: source.id,
        sourceRevision: source.revision,
        sourceDigest: digest(source),
        ledgerDigest: digest(record),
        projectId: source.projectId,
        goalId: source.goalId,
        parentId: source.parentId,
        runRefs: [...source.runRefs],
        source
      }
    }
  })

  return {
    workspaceDigest: digest(aggregate.workspace),
    projectionDigest: digest({
      workspace: aggregate.workspace,
      goals: goals.map((item) => item.source),
      workItems: workItems.map((item) => item.source)
    }),
    goals,
    workItems
  }
}

export function validateProjectWorkspaceRunReferences(
  db: WorkflowLedgerDatabase,
  items: readonly ProjectedWorkItem[]
): void {
  const claimed = new Map<string, string>()
  for (const item of items) {
    for (const runId of item.source.runRefs) {
      const owner = claimed.get(runId)
      if (owner && owner !== item.source.id) {
        throw migrationError('RUN_REFERENCE_CONFLICT', `Run ${runId} is claimed by multiple ProjectWorkspace WorkItems`)
      }
      claimed.set(runId, item.source.id)
      const run = findWorkflowRun(db, runId)
      if (!run) throw migrationError('RUN_REFERENCE_MISSING', `work item ${item.source.id} references missing Run ${runId}`)
      if (run.workItemId !== item.source.id || run.projectId !== item.source.projectId || run.goalId !== item.source.goalId) {
        throw migrationError('RUN_REFERENCE_OWNERSHIP', `Run ${runId} crosses ProjectWorkspace ownership boundaries`)
      }
    }
  }
}

export function parentFirst(items: readonly ProjectedWorkItem[]): ProjectedWorkItem[] {
  const byId = new Map(items.map((item) => [item.source.id, item]))
  const emitted = new Set<string>()
  const result: ProjectedWorkItem[] = []
  const emit = (item: ProjectedWorkItem): void => {
    if (emitted.has(item.source.id)) return
    const parent = item.source.parentId ? byId.get(item.source.parentId) : undefined
    if (parent) emit(parent)
    emitted.add(item.source.id)
    result.push(item)
  }
  for (const item of items) emit(item)
  return result
}

export async function assertProjectWorkspaceSourceUnchanged(source: SourceFile): Promise<void> {
  const current = await readRegularFile(source.path, 'ProjectWorkspace JSON source')
  if (current.byteLength !== source.bytes.byteLength || sha256(current) !== source.sha256) {
    throw migrationError('SOURCE_CHANGED_DURING_MIGRATION', 'ProjectWorkspace JSON changed while its Ledger candidate was being prepared')
  }
}

function validateGlobalState(state: ProjectWorkspaceState, workspaceId: string): WorkspaceAggregate {
  if (!nonNegativeRevision(state.revision)) throw migrationError('SOURCE_INVALID', 'ProjectWorkspace store revision is invalid')
  const workspaces = uniqueEntityMap(state.workspaces, 'workspace')
  const goals = uniqueEntityMap(state.goals, 'goal')
  const workItems = uniqueEntityMap(state.workItems, 'work item')
  const workspace = workspaces.get(workspaceId)
  if (!workspace) throw migrationError('WORKSPACE_NOT_FOUND', `Workspace ${workspaceId} does not exist`)

  for (const item of state.workspaces) assertEntityShape(item, 'workspace')
  for (const goal of state.goals) {
    assertEntityShape(goal, 'goal')
    if (!isId(goal.projectId) || !workspaces.has(goal.projectId)) {
      throw migrationError('REFERENCE_MISSING', `goal ${goal.id} references missing Workspace ${String(goal.projectId)}`)
    }
  }
  for (const item of state.workItems) {
    assertEntityShape(item, 'work item')
    if (!isId(item.projectId) || !workspaces.has(item.projectId)) {
      throw migrationError('REFERENCE_MISSING', `work item ${item.id} references missing Workspace ${String(item.projectId)}`)
    }
    assertUniqueReferences(item.dependencyIds, `work item ${item.id} dependencies`)
    assertUniqueReferences(item.runRefs, `work item ${item.id} Run references`)
    if (item.goalId) {
      const goal = goals.get(item.goalId)
      if (!goal) throw migrationError('REFERENCE_MISSING', `work item ${item.id} references missing Goal ${item.goalId}`)
      if (goal.projectId !== item.projectId) {
        throw migrationError('CROSS_WORKSPACE_REFERENCE', `work item ${item.id} crosses Workspace boundary to Goal ${item.goalId}`)
      }
    }
    if (item.parentId) assertWorkItemReference(item, item.parentId, 'parent', workItems)
    for (const dependencyId of item.dependencyIds) assertWorkItemReference(item, dependencyId, 'dependency', workItems)
  }
  assertAcyclic(state.workItems, (item) => item.parentId ? [item.parentId] : [], 'parent')
  assertAcyclic(state.workItems, (item) => item.dependencyIds, 'dependency')
  return {
    workspace,
    goals: state.goals.filter((goal) => goal.projectId === workspaceId),
    workItems: state.workItems.filter((item) => item.projectId === workspaceId)
  }
}

function validateWorkspaceState(state: ProjectWorkspaceState, workspaceId: string): WorkspaceAggregate {
  if (!nonNegativeRevision(state.revision)) throw migrationError('SOURCE_INVALID', 'ProjectWorkspace store revision is invalid')
  const workspace = uniqueTargetEntity(state.workspaces, workspaceId, 'workspace')
  assertEntityShape(workspace, 'workspace')

  const goals = projectEntities(state.goals, workspaceId, 'goal')
  const workItems = projectEntities(state.workItems, workspaceId, 'work item')
  const goalById = new Map(goals.map((goal) => [goal.id, goal]))
  const workItemById = new Map(workItems.map((item) => [item.id, item]))

  for (const goal of goals) assertEntityShape(goal, 'goal')
  for (const item of workItems) {
    assertEntityShape(item, 'work item')
    assertUniqueReferences(item.dependencyIds, `work item ${item.id} dependencies`)
    assertUniqueReferences(item.runRefs, `work item ${item.id} Run references`)
    if (item.goalId) {
      const goal = referencedEntity(state.goals, item.goalId, 'goal')
      if (goal.projectId !== workspaceId || goalById.get(goal.id) !== goal) {
        throw migrationError('CROSS_WORKSPACE_REFERENCE', `work item ${item.id} crosses Workspace boundary to Goal ${item.goalId}`)
      }
    }
    if (item.parentId) assertScopedWorkItemReference(item, item.parentId, 'parent', state.workItems, workItemById)
    for (const dependencyId of item.dependencyIds) {
      assertScopedWorkItemReference(item, dependencyId, 'dependency', state.workItems, workItemById)
    }
  }
  assertAcyclic(workItems, (item) => item.parentId ? [item.parentId] : [], 'parent')
  assertAcyclic(workItems, (item) => item.dependencyIds, 'dependency')
  return { workspace, goals, workItems }
}

function uniqueTargetEntity<T extends { id: string }>(items: readonly T[], id: string, label: string): T {
  const matches = items.filter((item) => item?.id === id)
  if (matches.length === 0) throw migrationError('WORKSPACE_NOT_FOUND', `Workspace ${id} does not exist`)
  if (matches.length > 1) throw migrationError('DUPLICATE_ID', `duplicate ${label} id ${id}`)
  return matches[0]
}

function projectEntities<T extends { id: string; projectId: string }>(
  items: readonly T[],
  workspaceId: string,
  label: string
): T[] {
  const selected = items.filter((item) => item?.projectId === workspaceId)
  const idCounts = new Map<string, number>()
  for (const item of items) {
    if (!isId(item?.id)) throw migrationError('SOURCE_INVALID', `${label} id is invalid`)
    idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1)
  }
  for (const item of selected) {
    if ((idCounts.get(item.id) ?? 0) > 1) {
      throw migrationError('DUPLICATE_ID', `duplicate ${label} id ${item.id}`)
    }
  }
  return selected
}

function referencedEntity<T extends { id: string }>(items: readonly T[], id: string, label: string): T {
  const matches = items.filter((item) => item?.id === id)
  if (matches.length === 0) throw migrationError('REFERENCE_MISSING', `${label} ${id} does not exist`)
  if (matches.length > 1) throw migrationError('DUPLICATE_ID', `duplicate ${label} id ${id}`)
  return matches[0]
}

function assertScopedWorkItemReference(
  owner: WorkItem,
  referenceId: string,
  relation: string,
  allItems: readonly WorkItem[],
  scopedItems: ReadonlyMap<string, WorkItem>
): void {
  const target = referencedEntity(allItems, referenceId, 'work item')
  if (target.projectId !== owner.projectId || scopedItems.get(referenceId) !== target) {
    throw migrationError('CROSS_WORKSPACE_REFERENCE', `work item ${owner.id} crosses Workspace boundary to ${relation} ${referenceId}`)
  }
}

function uniqueEntityMap<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    if (!isId(item?.id)) throw migrationError('SOURCE_INVALID', `${label} id is invalid`)
    if (result.has(item.id)) throw migrationError('DUPLICATE_ID', `duplicate ${label} id ${item.id}`)
    result.set(item.id, item)
  }
  return result
}

function assertEntityShape(value: { id: string; revision: number; createdAt: number; updatedAt: number }, label: string): void {
  if (!positiveRevision(value.revision) || !finiteTimestamp(value.createdAt) || !finiteTimestamp(value.updatedAt)) {
    throw migrationError('SOURCE_INVALID', `${label} ${value.id} revision or timestamp is invalid`)
  }
}

function assertWorkItemReference(
  owner: WorkItem,
  referenceId: string,
  relation: string,
  items: ReadonlyMap<string, WorkItem>
): void {
  const target = items.get(referenceId)
  if (!target) throw migrationError('REFERENCE_MISSING', `work item ${owner.id} references missing ${relation} ${referenceId}`)
  if (target.projectId !== owner.projectId) {
    throw migrationError('CROSS_WORKSPACE_REFERENCE', `work item ${owner.id} crosses Workspace boundary to ${relation} ${referenceId}`)
  }
}

function assertAcyclic(items: readonly WorkItem[], edges: (item: WorkItem) => readonly string[], label: string): void {
  const byId = new Map(items.map((item) => [item.id, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw migrationError('RELATION_CYCLE', `work item ${label} relation contains a cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    const item = byId.get(id)
    if (item) for (const next of edges(item)) visit(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const item of items) visit(item.id)
}

function assertUniqueReferences(values: unknown, label: string): asserts values is string[] {
  if (!Array.isArray(values) || !values.every(isId)) throw migrationError('SOURCE_INVALID', `${label} are invalid`)
  if (new Set(values).size !== values.length) throw migrationError('DUPLICATE_REFERENCE', `${label} contain duplicates`)
}
