import type { EffectRecord, TaskDagExecutionView, TaskSnapshotRecord } from '../shared/types'
import type { SessionCreationDraft } from './session-create-lifecycle'
import { listPendingSessionCreations } from './session-creation-journal'
import {
  inspectManagedWorktreeRegistryRecord,
  prepareManagedWorktreeCreateEffect,
  type ManagedWorktreeRecord
} from './worktrees'

type DagTaskStatus = TaskDagExecutionView['tasks'][number]['status']

export type PendingSessionRecoveryPlan =
  | { kind: 'acknowledge'; draft: SessionCreationDraft }
  | { kind: 'hold'; draft: SessionCreationDraft }
  | { kind: 'block'; draft: SessionCreationDraft; reason: string }
  | {
      kind: 'restore'
      draft: SessionCreationDraft
      recoveredDag: boolean
      record?: ManagedWorktreeRecord
    }

export function planPendingSessionCreations(
  snapshots: TaskSnapshotRecord[]
): PendingSessionRecoveryPlan[] {
  const evidence = buildRecoveryEvidence(snapshots)
  return listPendingSessionCreations().map((draft) => planPendingDraft(draft, evidence))
}

export function activeSessionRecoveryBlocks(snapshots: TaskSnapshotRecord[]): Set<string> {
  const sessionIds = new Set(snapshots.map((snapshot) => snapshot.sessionId))
  for (const sessionId of lifecycleEffectSessionIds(snapshots)) sessionIds.add(sessionId)
  for (const snapshot of snapshots) {
    const sourceSessionId = snapshot.run?.operation?.sourceSessionId
    if (sourceSessionId) sessionIds.add(sourceSessionId)
  }
  return sessionIds
}

export function managedSessionActivationRecoveryError(error: unknown, sessionId: string): Error {
  const detail = error instanceof Error ? error.message : String(error)
  const inherited = error && typeof error === 'object' ? error : {}
  return Object.assign(
    new Error(
      `托管会话 ${sessionId} 的 placement 已确认，但激活持久化失败；` +
      `必须从 session creation journal 恢复，禁止创建新会话: ${detail}`
    ),
    inherited,
    {
      cause: error,
      nonRetryable: true,
      requiresReconciliation: true,
      sessionId,
      sessionCreationJournalPending: true
    }
  )
}

export function requiresEffectReconciliation(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' &&
    (error as { requiresReconciliation?: unknown }).requiresReconciliation === true
  )
}

export function sessionCreationResolutionBarrier(
  resolution: import('../shared/effect-recovery-types').EffectResolution,
  acknowledge: (sessionId: string) => void
): ((effect: EffectRecord) => void) | undefined {
  if (resolution === 'confirmed_applied') return undefined
  return (effect) => {
    if (effect.target.kind === 'git_worktree_create') acknowledge(effect.target.sessionId)
  }
}

interface RecoveryEvidence {
  snapshotSessionIds: ReadonlySet<string>
  lifecycleEffectSessionIds: ReadonlySet<string>
  dagExecutionIds: ReadonlySet<string>
  dagTaskStatuses: ReadonlyMap<string, DagTaskStatus>
}

function buildRecoveryEvidence(snapshots: TaskSnapshotRecord[]): RecoveryEvidence {
  return {
    snapshotSessionIds: new Set(snapshots.map((snapshot) => snapshot.sessionId)),
    lifecycleEffectSessionIds: lifecycleEffectSessionIds(snapshots),
    dagExecutionIds: new Set(
      snapshots.flatMap((snapshot) => snapshot.dagExecutions.map((execution) => execution.id))
    ),
    dagTaskStatuses: newestDagTaskStatuses(snapshots)
  }
}

function planPendingDraft(
  draft: SessionCreationDraft,
  evidence: RecoveryEvidence
): PendingSessionRecoveryPlan {
  const dag = pendingDraftDagEvidence(draft, evidence)
  if (evidence.lifecycleEffectSessionIds.has(draft.baseMeta.id)) return snapshotBlockedPlan(draft, dag)
  const lookup = inspectManagedWorktreeRegistryRecord(draft.baseMeta.id)
  if ('error' in lookup) {
    return { kind: 'block', draft, reason: `managed worktree registry unavailable: ${lookup.error}` }
  }
  const record = lookup.record
  if (isTerminalDagTask(dag.taskStatus)) {
    return terminalDraftRecoveryPlan(draft, record)
  }
  if (evidence.snapshotSessionIds.has(draft.baseMeta.id)) return snapshotBlockedPlan(draft, dag)
  if (isOrchestratedDraft(draft) && !dag.recovered) {
    return { kind: 'block', draft, reason: 'parent DAG evidence is missing' }
  }
  if (record?.state === 'removed') return { kind: 'acknowledge', draft }
  return { kind: 'restore', draft, recoveredDag: dag.recovered, ...(record ? { record } : {}) }
}

function terminalDraftRecoveryPlan(
  draft: SessionCreationDraft,
  record: ManagedWorktreeRecord | null
): PendingSessionRecoveryPlan {
  if (record?.state === 'active') return { kind: 'restore', draft, recoveredDag: false, record }
  if (record?.state === 'removed') return { kind: 'acknowledge', draft }
  const absence = prepareManagedWorktreeCreateEffect({
    sessionId: draft.baseMeta.id,
    cwd: draft.opts.cwd,
    isolated: draft.opts.isolated
  })
  if ('error' in absence) {
    return { kind: 'block', draft, reason: `managed worktree absence is unverified: ${absence.error}` }
  }
  if (absence.isolated && 'existing' in absence) {
    return { kind: 'restore', draft, recoveredDag: false, record: absence.record }
  }
  return { kind: 'acknowledge', draft }
}

function pendingDraftDagEvidence(
  draft: SessionCreationDraft,
  evidence: RecoveryEvidence
): { recovered: boolean; taskStatus?: DagTaskStatus } {
  const { orchestrationId, childTaskId } = draft.baseMeta
  const recovered = Boolean(orchestrationId && evidence.dagExecutionIds.has(orchestrationId))
  if (!orchestrationId || !childTaskId) return { recovered }
  return {
    recovered,
    taskStatus: evidence.dagTaskStatuses.get(dagTaskRecoveryKey(orchestrationId, childTaskId))
  }
}

function snapshotBlockedPlan(
  draft: SessionCreationDraft,
  dag: { recovered: boolean; taskStatus?: DagTaskStatus }
): PendingSessionRecoveryPlan {
  if (dag.recovered && (dag.taskStatus === 'waiting' || dag.taskStatus === 'running')) {
    return { kind: 'block', draft, reason: 'recoverable child snapshot outranks creation journal' }
  }
  return { kind: 'hold', draft }
}

function isTerminalDagTask(status: DagTaskStatus | undefined): boolean {
  return status === 'success' || status === 'failed'
}

function isOrchestratedDraft(draft: SessionCreationDraft): boolean {
  const { parentSessionId, orchestrationId, childTaskId } = draft.baseMeta
  return Boolean(parentSessionId || orchestrationId || childTaskId)
}

function lifecycleEffectSessionIds(snapshots: TaskSnapshotRecord[]): Set<string> {
  const sessionIds = new Set<string>()
  for (const snapshot of snapshots) {
    for (const effect of snapshot.run?.effects ?? []) {
      const target = effect.target
      if (target.kind === 'git_worktree_create' || target.kind === 'git_worktree_remove') {
        sessionIds.add(target.sessionId)
      }
    }
  }
  return sessionIds
}

function newestDagTaskStatuses(snapshots: TaskSnapshotRecord[]): Map<string, DagTaskStatus> {
  const statuses = new Map<string, DagTaskStatus>()
  for (const snapshot of snapshots) {
    for (const execution of snapshot.dagExecutions) {
      for (const task of execution.tasks) {
        const key = dagTaskRecoveryKey(execution.id, task.task.id)
        if (!statuses.has(key)) statuses.set(key, task.status)
      }
    }
  }
  return statuses
}

function dagTaskRecoveryKey(executionId: string, taskId: string): string {
  return `${executionId}\0${taskId}`
}
