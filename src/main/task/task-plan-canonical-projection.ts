import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { WorkItem, WorkItemPatch } from '../../shared/project-workspace-types'
import {
  TASK_PLAN_SCHEMA_VERSION,
  type TaskPlanProjectionReceipt,
  type TaskPlanStep,
  type TaskPlanVersion
} from '../../shared/task-plan-types'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { institutionResponsibilityLines } from './task-plan-institutions'

const IMMUTABLE_STATUSES = new Set(['running', 'waiting_approval', 'blocked', 'verifying', 'done', 'failed', 'cancelled'])
const CANCELLABLE_UNSTARTED_STATUSES = new Set(['backlog', 'ready'])

export class TaskPlanCanonicalProjector {
  constructor(private readonly userDataRoot: () => string) {}

  async project(
    version: TaskPlanVersion,
    previous?: TaskPlanProjectionReceipt,
    reusePreviousReceipt = false
  ): Promise<TaskPlanProjectionReceipt> {
    const binding = version.binding
    if (!binding.workspaceId) {
      if (reusePreviousReceipt && previous?.mode === 'conversation') return previous
      return conversationReceipt()
    }
    if (!binding.workItemId) {
      throw new Error('已绑定 Project 的计划缺少父 WorkItem，已阻止审批')
    }

    const root = this.userDataRoot()
    const reads = createProjectWorkspaceReadService(root, 'canonical')
    const workspaceItems = await reads.listWorkItems(binding.workspaceId)
    const workspaceItemsById = new Map(workspaceItems.map((item) => [item.id, item]))
    const parent = workspaceItemsById.get(binding.workItemId)
    assertParentBinding(version, parent)

    const orderedSteps = topologicalSteps(version.steps)
    const workItemIds = new Map(version.steps.map((step) => [step.id, projectedWorkItemId(binding.sessionId, step.id)]))
    const positions = new Map(version.steps.map((step, index) => [step.id, index]))
    const desired = orderedSteps.map((step) => desiredWorkItem(
      version,
      step,
      positions.get(step.id)!,
      workItemIds,
      parent!
    ))
    const existing = new Map<string, WorkItem>()
    for (const entry of desired) {
      const item = workspaceItemsById.get(entry.id)
      if (item) existing.set(entry.id, item)
    }

    const removed = removedProjectionItems(previous, new Set(workItemIds.values()), workspaceItemsById)
    preflight(version, desired, existing, removed)

    const commands = await openProjectWorkspaceCommandService(root)
    for (const entry of desired) {
      const item = existing.get(entry.id)
      if (!item) {
        await commands.createWorkItem(entry)
      } else {
        const patch = changedPatch(item, entry)
        if (patch) await commands.updateWorkItem(item.id, patch, { expectedRevision: item.revision })
      }
    }
    for (const item of removed) {
      if (item.status !== 'cancelled') {
        await commands.transitionWorkItem(item.id, 'cancelled', { expectedRevision: item.revision })
      }
    }

    const receipt = canonicalReceipt(version, workItemIds, reusePreviousReceipt ? previous : undefined)
    await verifyProjection(version, receipt, reads)
    return receipt
  }
}

export function projectedWorkItemId(sessionId: string, stepId: string): string {
  const hash = createHash('sha256').update(`${sessionId}\u0000${stepId}`).digest('hex').slice(0, 32)
  return `task-plan-${hash}`
}

function conversationReceipt(): TaskPlanProjectionReceipt {
  return {
    schemaVersion: TASK_PLAN_SCHEMA_VERSION,
    mode: 'conversation',
    steps: [],
    projectedAt: Date.now()
  }
}

function canonicalReceipt(
  version: TaskPlanVersion,
  ids: Map<string, string>,
  previous?: TaskPlanProjectionReceipt
): TaskPlanProjectionReceipt {
  const stable = previous?.mode === 'canonical' &&
    previous.workspaceId === version.binding.workspaceId &&
    previous.goalId === version.binding.goalId &&
    previous.parentWorkItemId === version.binding.workItemId &&
    previous.steps.length === version.steps.length &&
    previous.steps.every((entry) => ids.get(entry.stepId) === entry.workItemId)
  if (stable) return previous
  return {
    schemaVersion: TASK_PLAN_SCHEMA_VERSION,
    mode: 'canonical',
    workspaceId: version.binding.workspaceId,
    goalId: version.binding.goalId,
    parentWorkItemId: version.binding.workItemId,
    steps: version.steps.map((step) => ({ stepId: step.id, workItemId: ids.get(step.id)! })),
    projectedAt: Date.now()
  }
}

function desiredWorkItem(
  version: TaskPlanVersion,
  step: TaskPlanStep,
  index: number,
  ids: Map<string, string>,
  parent: WorkItem
) {
  return {
    id: ids.get(step.id)!,
    projectId: version.binding.workspaceId!,
    goalId: parent.goalId,
    parentId: parent.id,
    businessLineId: parent.businessLineId ?? 'studio',
    type: step.workItemType ?? 'custom',
    ...(step.role === undefined ? {} : { role: step.role }),
    title: step.title,
    description: [step.description || `计划步骤: ${step.id}`, ...institutionResponsibilityLines(version, step.institution)].join('\n'),
    dependencyIds: step.dependsOn.map((id) => ids.get(id)!),
    priority: 10_000 - index,
    status: 'backlog' as const,
    acceptanceSpec: step.acceptanceSpec ?? step.expectedArtifacts.map((artifact, artifactIndex) => ({
      id: `artifact-${artifactIndex + 1}`,
      criterion: `产出并提供证据：${artifact}`,
      required: true
    }))
  }
}

function assertParentBinding(version: TaskPlanVersion, parent: WorkItem | undefined): void {
  if (!parent) throw new Error('计划绑定的父 WorkItem 不存在，已阻止审批')
  if (parent.projectId !== version.binding.workspaceId ||
    (version.binding.goalId !== undefined && parent.goalId !== version.binding.goalId)) {
    throw new Error('计划绑定与 canonical WorkItem 归属不一致，已阻止审批')
  }
}

function removedProjectionItems(
  previous: TaskPlanProjectionReceipt | undefined,
  currentIds: Set<string>,
  itemsById: Map<string, WorkItem>
): WorkItem[] {
  if (previous?.mode !== 'canonical') return []
  const removed: WorkItem[] = []
  for (const entry of previous.steps) {
    if (currentIds.has(entry.workItemId)) continue
    const item = itemsById.get(entry.workItemId)
    if (item) removed.push(item)
  }
  return removed
}

function preflight(
  version: TaskPlanVersion,
  desired: ReturnType<typeof desiredWorkItem>[],
  existing: Map<string, WorkItem>,
  removed: WorkItem[]
): void {
  for (const entry of desired) {
    const item = existing.get(entry.id)
    if (!item) continue
    if (item.projectId !== entry.projectId || item.goalId !== entry.goalId || item.parentId !== entry.parentId ||
        (item.businessLineId ?? 'studio') !== entry.businessLineId) {
      throw new Error(`计划步骤 ${entry.title} 的 canonical WorkItem 归属冲突，已阻止审批`)
    }
    if (item.status === 'cancelled') {
      throw new Error(`计划步骤 ${entry.title} 对应的 canonical WorkItem 已取消，不能被重新启用`)
    }
    if (changedPatch(item, entry) && IMMUTABLE_STATUSES.has(item.status)) {
      throw new Error(`计划步骤 ${entry.title} 已启动或结束，不能被新版本重写`)
    }
  }
  for (const item of removed) {
    if (item.projectId !== version.binding.workspaceId || item.parentId !== version.binding.workItemId) {
      throw new Error('旧计划步骤的 canonical WorkItem 归属冲突，已阻止审批')
    }
    if (item.status !== 'cancelled' && !CANCELLABLE_UNSTARTED_STATUSES.has(item.status)) {
      throw new Error(`旧计划步骤 ${item.title} 已启动，不能从新版本中移除`)
    }
  }
}

function changedPatch(item: WorkItem, desired: ReturnType<typeof desiredWorkItem>): WorkItemPatch | undefined {
  const patch: WorkItemPatch = {}
  if (item.title !== desired.title) patch.title = desired.title
  if (item.description !== desired.description) patch.description = desired.description ?? ''
  if (item.type !== desired.type) patch.type = desired.type
  if (item.role !== desired.role) patch.role = desired.role ?? null
  if (item.parentId !== desired.parentId) patch.parentId = desired.parentId
  if (!same(item.dependencyIds, desired.dependencyIds)) patch.dependencyIds = desired.dependencyIds
  if (item.priority !== desired.priority) patch.priority = desired.priority
  if (!same(item.acceptanceSpec, desired.acceptanceSpec)) patch.acceptanceSpec = desired.acceptanceSpec
  return Object.keys(patch).length > 0 ? patch : undefined
}

async function verifyProjection(
  version: TaskPlanVersion,
  receipt: TaskPlanProjectionReceipt,
  reads: ReturnType<typeof createProjectWorkspaceReadService>
): Promise<void> {
  if (receipt.mode !== 'canonical') return
  const workspaceItems = await reads.listWorkItems(receipt.workspaceId)
  const itemsById = new Map(workspaceItems.map((item) => [item.id, item]))
  const parent = itemsById.get(receipt.parentWorkItemId!)
  assertParentBinding(version, parent)
  const ids = new Map(receipt.steps.map((entry) => [entry.stepId, entry.workItemId]))
  for (let index = 0; index < version.steps.length; index += 1) {
    const step = version.steps[index]
    const expected = desiredWorkItem(version, step, index, ids, parent!)
    const actual = itemsById.get(expected.id)
    const mismatch = actual ? changedPatch(actual, expected) : undefined
    if (!actual || actual.projectId !== expected.projectId || actual.goalId !== expected.goalId ||
      (actual.businessLineId ?? 'studio') !== expected.businessLineId ||
      actual.parentId !== expected.parentId || mismatch) {
      const fields = mismatch ? `（字段：${Object.keys(mismatch).join(', ')}）` : ''
      throw new Error(`计划步骤 ${step.title} 未完成 canonical 投影${fields}，已阻止审批`)
    }
  }
}

function topologicalSteps(steps: TaskPlanStep[]): TaskPlanStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const emitted = new Set<string>()
  const ordered: TaskPlanStep[] = []
  const emit = (step: TaskPlanStep): void => {
    if (emitted.has(step.id)) return
    for (const dependency of step.dependsOn) emit(byId.get(dependency)!)
    emitted.add(step.id)
    ordered.push(step)
  }
  for (const step of steps) emit(step)
  return ordered
}

function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}
