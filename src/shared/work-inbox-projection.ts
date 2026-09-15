import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowGoalRecord,
  WorkflowRunInboxRecord,
  WorkflowWorkItemRecord,
  WorkflowAcceptanceStatus,
  WorkflowGoalStatus,
  WorkflowWorkItemStatus
} from './workflow-types'
import type { TaskRunStatus } from './task-runtime-types'

/** The five stable user-facing lanes of the Work Inbox. */
export type WorkInboxLane =
  | 'needs_confirmation'
  | 'running'
  | 'blocked'
  | 'ready_for_delivery'
  | 'completed'

export type WorkInboxSourceKind = 'goal' | 'work_item' | 'run'

export interface WorkInboxProjectionInput {
  projectId?: string
  goals?: readonly WorkflowGoalRecord[]
  workItems?: readonly WorkflowWorkItemRecord[]
  runs?: readonly WorkflowRunInboxRecord[]
  artifacts?: readonly WorkflowArtifactRecord[]
  acceptances?: readonly WorkflowAcceptanceRecord[]
}

export interface WorkInboxItem {
  id: string
  sourceKind: WorkInboxSourceKind
  sourceId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  title: string
  detail?: string
  lane: WorkInboxLane
  status: WorkflowGoalStatus | WorkflowWorkItemStatus | TaskRunStatus
  acceptanceStatus?: WorkflowAcceptanceStatus
  artifactIds: string[]
  updatedAt: number
}

export interface WorkInboxLaneProjection {
  lane: WorkInboxLane
  items: WorkInboxItem[]
  count: number
}

export interface WorkInboxProjection {
  schemaVersion: 1
  projectId?: string
  total: number
  lanes: Record<WorkInboxLane, WorkInboxLaneProjection>
  items: WorkInboxItem[]
}

export class WorkInboxProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkInboxProjectionError'
  }
}

const LANE_ORDER: readonly WorkInboxLane[] = [
  'needs_confirmation',
  'running',
  'blocked',
  'ready_for_delivery',
  'completed'
]

const ACTIVE_RUN_STATUSES = new Set<TaskRunStatus>([
  'queued', 'planning', 'executing', 'verifying'
])

const BLOCKED_RUN_STATUSES = new Set<TaskRunStatus>([
  'failed', 'recovering', 'waiting_reconciliation', 'cancelled'
])

const BLOCKED_WORK_ITEM_STATUSES = new Set<WorkflowWorkItemStatus>([
  'blocked', 'failed', 'cancelled'
])

const CONFIRMATION_WORK_ITEM_STATUSES = new Set<WorkflowWorkItemStatus>([
  'backlog', 'ready', 'waiting_approval'
])

/**
 * Project canonical Ledger entities into the five Work Inbox lanes.
 *
 * This is deliberately a pure, renderer-safe projection. It performs no
 * mutation, Provider call, filesystem access, or action authorization.
 */
export function projectWorkInbox(input: WorkInboxProjectionInput): WorkInboxProjection {
  const goals = validateAndScope(input.goals ?? [], input.projectId, 'goal')
  const workItems = validateAndScope(input.workItems ?? [], input.projectId, 'work item')
  const runs = validateAndScope(input.runs ?? [], input.projectId, 'run')
  const artifacts = validateAndScope(input.artifacts ?? [], input.projectId, 'artifact')
  const acceptances = validateAndScope(input.acceptances ?? [], input.projectId, 'acceptance')

  const runByWorkItem = latestBy(runs.filter((run) => Boolean(run.workItemId)), (run) => run.workItemId)
  const acceptanceByWorkItem = latestBy(acceptances.filter((acceptance) => Boolean(acceptance.workItemId)), (acceptance) => acceptance.workItemId)
  const artifactIdsByWorkItem = groupArtifactIds(artifacts)
  const representedWorkItemIds = new Set(workItems.map((item) => item.id))
  const items: WorkInboxItem[] = []

  for (const item of workItems) {
    const run = runByWorkItem.get(item.id)
    const acceptance = acceptanceByWorkItem.get(item.id)
    const artifactIds = artifactIdsByWorkItem.get(item.id) ?? []
    const lane = classifyWorkItem(item, run, acceptance, artifactIds.length > 0)
    items.push({
      id: `work-item:${item.id}`,
      sourceKind: 'work_item',
      sourceId: item.id,
      projectId: item.projectId,
      goalId: item.goalId,
      workItemId: item.id,
      runId: run?.id,
      title: item.title,
      detail: item.description,
      lane,
      status: run?.status ?? item.status,
      acceptanceStatus: acceptance?.status,
      artifactIds,
      updatedAt: Math.max(item.updatedAt, run?.updatedAt ?? 0, acceptance?.updatedAt ?? 0)
    })
  }

  // A Run without a canonical WorkItem remains visible, but cannot create a
  // synthetic WorkItem identity. This keeps legacy/runtime failures observable.
  for (const run of runs) {
    if (run.workItemId && representedWorkItemIds.has(run.workItemId)) continue
    const lane = classifyRun(run)
    items.push({
      id: `run:${run.id}`,
      sourceKind: 'run',
      sourceId: run.id,
      projectId: run.projectId,
      goalId: run.goalId,
      runId: run.id,
      // Renderer-safe run summaries intentionally omit the full TaskRun
      // payload; never reach through taskRun here or recreate its title.
      title: `Run ${run.id}`,
      lane,
      status: run.status,
      artifactIds: [],
      updatedAt: run.updatedAt
    })
  }

  // Keep a goal visible when it has no child WorkItem. Goals with children are
  // represented by those WorkItems to avoid duplicate Inbox rows.
  const representedGoalIds = new Set(workItems.map((item) => item.goalId).filter((id): id is string => Boolean(id)))
  for (const goal of goals) {
    if (representedGoalIds.has(goal.id)) continue
    items.push({
      id: `goal:${goal.id}`,
      sourceKind: 'goal',
      sourceId: goal.id,
      projectId: goal.projectId,
      goalId: goal.id,
      title: goal.title,
      detail: goal.objective,
      lane: classifyGoal(goal),
      status: goal.status,
      artifactIds: [],
      updatedAt: goal.updatedAt
    })
  }

  const sorted = items.sort(compareItems)
  const lanes = Object.fromEntries(LANE_ORDER.map((lane) => {
    const laneItems = sorted.filter((item) => item.lane === lane)
    return [lane, { lane, items: laneItems, count: laneItems.length }]
  })) as Record<WorkInboxLane, WorkInboxLaneProjection>
  return {
    schemaVersion: 1,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    total: sorted.length,
    lanes,
    items: sorted
  }
}

function classifyWorkItem(
  item: WorkflowWorkItemRecord,
  run: WorkflowRunInboxRecord | undefined,
  acceptance: WorkflowAcceptanceRecord | undefined,
  hasArtifact: boolean
): WorkInboxLane {
  if (BLOCKED_WORK_ITEM_STATUSES.has(item.status) || (run && BLOCKED_RUN_STATUSES.has(run.status)) || acceptance?.status === 'failed') return 'blocked'
  if (item.status === 'waiting_approval' || run?.status === 'waiting_approval') return 'needs_confirmation'
  if (item.status === 'done' || run?.status === 'completed') {
    return acceptance?.status === 'passed' || acceptance?.status === 'waived' ? 'completed' : 'ready_for_delivery'
  }
  if (acceptance?.status === 'passed' || acceptance?.status === 'waived') return hasArtifact ? 'ready_for_delivery' : 'running'
  if (item.status === 'verifying' || (run && ACTIVE_RUN_STATUSES.has(run.status)) || item.status === 'running') return 'running'
  if (CONFIRMATION_WORK_ITEM_STATUSES.has(item.status)) return 'needs_confirmation'
  return 'running'
}

function classifyRun(run: WorkflowRunInboxRecord): WorkInboxLane {
  if (BLOCKED_RUN_STATUSES.has(run.status)) return 'blocked'
  if (run.status === 'waiting_approval') return 'needs_confirmation'
  if (run.status === 'completed') return 'completed'
  if (ACTIVE_RUN_STATUSES.has(run.status)) return 'running'
  return 'needs_confirmation'
}

function classifyGoal(goal: WorkflowGoalRecord): WorkInboxLane {
  if (goal.status === 'blocked' || goal.status === 'failed' || goal.status === 'cancelled') return 'blocked'
  if (goal.status === 'completed') return 'completed'
  if (goal.status === 'waiting_approval' || goal.status === 'draft' || goal.status === 'planned') return 'needs_confirmation'
  if (goal.status === 'running' || goal.status === 'verifying') return 'running'
  return 'needs_confirmation'
}

function compareItems(left: WorkInboxItem, right: WorkInboxItem): number {
  const laneDelta = LANE_ORDER.indexOf(left.lane) - LANE_ORDER.indexOf(right.lane)
  return laneDelta || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

function latestBy<T extends { id: string; updatedAt: number; revision?: number }>(
  records: readonly T[],
  key: (record: T) => string | undefined
): Map<string, T> {
  const result = new Map<string, T>()
  for (const record of records) {
    const groupingKey = key(record)
    if (!groupingKey) continue
    const previous = result.get(groupingKey)
    if (!previous || (record.revision ?? 0) > (previous.revision ?? 0) || ((record.revision ?? 0) === (previous.revision ?? 0) && (record.updatedAt > previous.updatedAt || (record.updatedAt === previous.updatedAt && record.id > previous.id)))) {
      result.set(groupingKey, record)
    }
  }
  return result
}

function groupArtifactIds(artifacts: readonly WorkflowArtifactRecord[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const artifact of artifacts) {
    if (!artifact.workItemId) continue
    const ids = grouped.get(artifact.workItemId) ?? []
    ids.push(artifact.id)
    grouped.set(artifact.workItemId, ids)
  }
  for (const ids of grouped.values()) ids.sort()
  return grouped
}

function validateAndScope<T extends { id: string; projectId?: string; updatedAt: number }>(
  records: readonly T[],
  projectId: string | undefined,
  kind: string
): T[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    if (!record || typeof record.id !== 'string' || record.id.trim() === '') throw new WorkInboxProjectionError(`${kind} id is required`)
    if (seen.has(record.id)) throw new WorkInboxProjectionError(`duplicate ${kind} id: ${record.id}`)
    seen.add(record.id)
    if (!Number.isFinite(record.updatedAt) || record.updatedAt < 0) throw new WorkInboxProjectionError(`${kind} ${record.id} updatedAt is invalid`)
    return projectId === undefined || record.projectId === projectId
  })
}
