import type {
  ModelAttemptReconciliationQuery,
  ModelAttemptReconciliationResolution,
  ModelAttemptReconciliationView
} from '../../shared/model-attempt-types'
import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import { app } from 'electron'
import { assertSideChatBinding } from '../side-chat/side-chat-policy'
import { verifyConversationLedgerEntries } from '../transcript'
import { prepareSessionDomainOwnershipForActivation } from '../session-domain-activation'
import {
  bindAndValidateTaskRun,
  bindLegacyUnscopedSessionForRecovery,
  resolveDigitalWorkerSessionScope
} from '../digital-worker/session-binding'
import { appendTaskRunEvidence } from './task-evidence-store'
import { reconcilePersistedTaskSnapshot, runHasWaitingEffects } from './effect-runtime'
import {
  getModelAttemptReconciliation,
  listModelAttemptReconciliations,
  listModelAttemptRetryAuthorizations,
  resolveModelAttemptReconciliation
} from './model-attempt-reconciliation'
import {
  hasPersistedModelAttemptReconciliation,
  listPersistedModelAttemptReconciliations,
  listPersistedModelAttemptRetryAuthorizations
} from './model-attempt-api'
import { recoverTaskExecutionState } from './task-execution'
import { reconcileSnapshotWithReceipts } from './task-recovery'
import { createTaskRun, isTaskRunTerminal, mergeTaskRunRecords, transitionTaskRun } from './task-run'
import { taskSnapshotTaskIdMatchesRun } from './task-snapshot-identity'
import {
  deleteTaskSnapshot,
  getWorkflowLedgerReadMode,
  mutateTaskSnapshotDatabase
} from './task-snapshot'
import { projectTaskEvidenceIntoWorkflow } from './workflow-ledger-evidence-projection'
import { projectRunIntoWorkflow, resolveRunWorkflowProjectionContext } from './workflow-ledger-projection'
import {
  findRecoveryTaskRun,
  readCanonicalTaskRuns,
  selectRecoverySnapshots,
  upsertWorkflowRecoverySession,
  type WorkflowLedgerReadMode
} from './workflow-ledger-recovery'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'

export interface PreparedTaskSnapshotRecovery {
  snapshot: TaskSnapshotRecord
  recoveredRun: TaskRunRecord
}

export interface PersistedModelAttemptRecoveryState {
  reconciliations: ModelAttemptReconciliationView[]
  retryAuthorizations: ModelAttemptReconciliationView[]
}

export interface ResolvedModelAttemptRecoveryState extends PersistedModelAttemptRecoveryState {
  view: ModelAttemptReconciliationView
  run: TaskRunRecord
}

type FinalizationRecoveryProbe = (sessionId: string) => boolean

export async function prepareTaskSnapshotRecovery(
  stored: TaskSnapshotRecord,
  rootDir: string,
  hasIncompleteFinalization: FinalizationRecoveryProbe
): Promise<PreparedTaskSnapshotRecovery> {
  assertConversationLedgerRecoveryIntegrity(stored)
  await assertNoStartedModelAttemptReconciliation(stored, rootDir)
  const reconciled = reconcileSnapshotWithReceipts(stored)
  await settleTerminalRecoverySnapshot(stored, reconciled, hasIncompleteFinalization)
  assertWorkspaceSnapshotOwnership(reconciled.snapshot)
  const ownership = await prepareSessionDomainOwnershipForActivation(reconciled.snapshot.meta, rootDir)
  const boundMeta = bindLegacyUnscopedSessionForRecovery({ ...reconciled.snapshot.meta, ...ownership })
  resolveDigitalWorkerSessionScope(boundMeta, rootDir)
  const boundRun = bindAndValidateTaskRun(boundMeta, reconciled.snapshot.run, { allowLegacyUnscoped: true })
  const ownedSnapshot = {
    ...reconciled.snapshot,
    meta: boundMeta,
    ...(boundRun ? { run: boundRun } : {})
  }
  const persistedSnapshot = await reconcilePersistedTaskSnapshot(ownedSnapshot, rootDir)
  const persistedMeta = bindLegacyUnscopedSessionForRecovery({ ...persistedSnapshot.meta, ...ownership })
  resolveDigitalWorkerSessionScope(persistedMeta, rootDir)
  const persistedRun = bindAndValidateTaskRun(persistedMeta, persistedSnapshot.run)
  const snapshot = {
    ...persistedSnapshot,
    meta: persistedMeta,
    ...(persistedRun ? { run: persistedRun } : {})
  }
  const finalizerRecovery = hasIncompleteFinalization(snapshot.sessionId) || snapshot.dagRuntimes?.some((runtime) => runtime.council) === true
  assertTaskSnapshotRecoverable(snapshot, finalizerRecovery)
  return { snapshot, recoveredRun: recoveredTaskRun(snapshot, finalizerRecovery) }
}

function assertConversationLedgerRecoveryIntegrity(snapshot: TaskSnapshotRecord): void {
  const actual = verifyConversationLedgerEntries(snapshot.transcript)
  if (!actual.valid) {
    throw new Error(`Canonical Conversation Ledger 校验失败，已阻止恢复:${actual.error ?? 'unknown integrity error'}`)
  }
  const persisted = snapshot.conversationLedger
  if (!persisted) return
  const mismatch = persisted.valid !== actual.valid ||
    persisted.mode !== actual.mode ||
    persisted.entryCount !== actual.entryCount ||
    (persisted.headDigest ?? '') !== (actual.headDigest ?? '')
  if (mismatch) {
    throw new Error('Canonical Conversation Ledger 完整性投影与任务快照不一致，已阻止恢复。')
  }
}

export async function assertNoStartedModelAttemptReconciliation(
  snapshot: TaskSnapshotRecord,
  rootDir?: string
): Promise<void> {
  if (await hasPersistedModelAttemptReconciliation(modelAttemptQuery(snapshot), rootDir)) {
    throw new Error(
      '任务存在 Provider 结果未知的 ModelAttempt，已阻止自动恢复；请先选择授权重试或取消。'
    )
  }
}

export async function hasPersistedModelAttemptRecoveryBarrier(
  snapshot: TaskSnapshotRecord,
  rootDir?: string
): Promise<boolean> {
  const query = modelAttemptQuery(snapshot)
  const [reconciliations, retryAuthorizations] = await Promise.all([
    listPersistedModelAttemptReconciliations({ ...query, limit: 1 }, rootDir),
    listPersistedModelAttemptRetryAuthorizations({ ...query, limit: 1 }, rootDir)
  ])
  return reconciliations.length > 0 || retryAuthorizations.length > 0
}

export function reconcilePersistedModelAttemptRecoveryState(
  rootDir?: string
): Promise<PersistedModelAttemptRecoveryState> {
  const readMode = getWorkflowLedgerReadMode(rootDir)
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    const state = readModelAttemptRecoveryState(db)
    const byRun = new Map<string, ModelAttemptReconciliationView>()
    for (const view of [...state.reconciliations, ...state.retryAuthorizations]) {
      if (!byRun.has(view.runId)) byRun.set(view.runId, view)
    }
    for (const view of byRun.values()) {
      persistModelAttemptRunState(db, readMode, view, 'waiting_reconciliation')
    }
    return state
  })
}

export function resolveTaskSnapshotModelAttemptReconciliation(
  attemptId: string,
  expectedRevision: number,
  resolution: ModelAttemptReconciliationResolution,
  rootDir?: string
): Promise<ResolvedModelAttemptRecoveryState> {
  const readMode = getWorkflowLedgerReadMode(rootDir)
  // Attempt, legacy Run, canonical Run, and snapshot share one exported DB image.
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    const current = getModelAttemptReconciliation(db, attemptId)
    if (!current) throw new Error('未找到待处置的 ModelAttempt')
    if (resolution === 'retry_authorized' && !hasMatchingRecoverySnapshot(db, readMode, current)) {
      throw new Error('ModelAttempt 缺少匹配的可恢复任务快照，不能授权重试；只能取消该未知结果。')
    }
    const view = resolveModelAttemptReconciliation(db, attemptId, expectedRevision, resolution)
    const state = readModelAttemptRecoveryState(db, { runId: view.runId })
    const keepWaiting = resolution === 'retry_authorized' ||
      state.reconciliations.length > 0 || state.retryAuthorizations.length > 0
    const run = persistModelAttemptRunState(
      db,
      readMode,
      view,
      keepWaiting ? 'waiting_reconciliation' : 'cancelled'
    )
    return { view, run, ...state }
  })
}

async function settleTerminalRecoverySnapshot(
  stored: TaskSnapshotRecord,
  reconciled: ReturnType<typeof reconcileSnapshotWithReceipts>,
  hasIncompleteFinalization: FinalizationRecoveryProbe
): Promise<void> {
  if (!reconciled.terminalRun || hasIncompleteFinalization(stored.sessionId) || stored.dagRuntimes?.some((runtime) => runtime.council)) return
  await deleteTaskSnapshot(stored.id, undefined, reconciled.terminalRun)
  throw new Error('任务已完成，恢复入口已自动收敛')
}

function assertTaskSnapshotRecoverable(snapshot: TaskSnapshotRecord, finalizerRecovery: boolean): void {
  assertWorkspaceSnapshotOwnership(snapshot)
  if (runHasWaitingEffects(snapshot.run)) {
    throw new Error('任务包含 waiting_reconciliation 外部副作用，已阻止自动续跑；请先在恢复面板完成专用对账处置。')
  }
  const status = snapshot.run?.status
  if ((status === 'completed' || status === 'cancelled') && !finalizerRecovery) {
    throw new Error(`任务已处于终态，不能恢复:${status}`)
  }
}

function assertWorkspaceSnapshotOwnership(snapshot: TaskSnapshotRecord): void {
  if (snapshot.meta.workspaceId && !snapshot.meta.workItemId) {
    if (assertSideChatBinding(snapshot.meta, app.getPath('userData'), { checkSource: false })) return
    throw new Error('Workspace 任务快照缺少 canonical WorkItem，已阻止创建或恢复孤立 Run。')
  }
}

function recoveredTaskRun(snapshot: TaskSnapshotRecord, finalizerRecovery: boolean): TaskRunRecord {
  const run = snapshot.run
  if (run && isTaskRunTerminal(run.status) && finalizerRecovery) return run
  const base = run && !isTaskRunTerminal(run.status)
    ? transitionTaskRun(run, 'recovering', { lastEventKind: snapshot.execution.lastEventKind })
    : transitionTaskRun(
        createTaskRun({
          id: `legacy-${snapshot.sessionId}`,
          sessionId: snapshot.sessionId,
          taskId: snapshot.taskId,
          now: snapshot.createdAt,
          digitalWorkerBinding: snapshot.meta.digitalWorkerBinding
        }),
        'recovering',
        { now: Date.now(), lastEventKind: snapshot.execution.lastEventKind }
      )
  return recoverTaskExecutionState(base)
}

function readModelAttemptRecoveryState(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptReconciliationQuery = {}
): PersistedModelAttemptRecoveryState {
  return {
    reconciliations: listModelAttemptReconciliations(db, query),
    retryAuthorizations: listModelAttemptRetryAuthorizations(db, query)
  }
}

function persistModelAttemptRunState(
  db: WorkflowLedgerDatabase,
  readMode: WorkflowLedgerReadMode,
  view: ModelAttemptReconciliationView,
  status: 'waiting_reconciliation' | 'cancelled'
): TaskRunRecord {
  const current = findModelAttemptTaskRun(db, readMode, view.runId)
  if (!current || current.sessionId !== view.sessionId) {
    throw new Error(`ModelAttempt ${view.attempt.id} 对应的 TaskRun 不存在或会话不匹配`)
  }
  const candidate = modelAttemptRunState(current, status)
  const snapshots = matchingRecoverySnapshots(db, readMode, view, current)
  const projectionSnapshot = snapshots[0]
  const run = mergeTaskRunRecords(current, candidate)
  const workflowContext = resolveRunWorkflowProjectionContext(
    db,
    run,
    projectionSnapshot?.meta.projectId,
    projectionSnapshot
  )
  db.run(
    `INSERT INTO task_runs(id, session_id, updated_at, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at = excluded.updated_at,
       payload = excluded.payload`,
    [run.id, run.sessionId, run.updatedAt, JSON.stringify(run)]
  )
  appendTaskRunEvidence(db, run, workflowContext.projectId)
  projectRunIntoWorkflow(db, run, workflowContext)
  projectTaskEvidenceIntoWorkflow(db, { runId: run.id })
  for (const snapshot of snapshots) persistModelAttemptSnapshot(db, snapshot, run)
  return run
}

function modelAttemptRunState(
  current: TaskRunRecord,
  status: 'waiting_reconciliation' | 'cancelled'
): TaskRunRecord {
  if (status === current.status &&
      (status !== 'waiting_reconciliation' || (current.finishedAt === undefined && current.error === undefined))) {
    return current
  }
  if (!isTaskRunTerminal(current.status)) return transitionTaskRun(current, status)
  const now = Date.now()
  return {
    ...current,
    status,
    revision: current.revision + 1,
    updatedAt: now,
    finishedAt: status === 'cancelled' ? now : undefined,
    pendingPermissionRequestId: undefined,
    error: undefined
  }
}

function persistModelAttemptSnapshot(
  db: WorkflowLedgerDatabase,
  snapshot: TaskSnapshotRecord,
  run: TaskRunRecord
): void {
  const next = {
    ...snapshot,
    updatedAt: Math.max(snapshot.updatedAt, run.updatedAt),
    run: snapshot.run ? mergeTaskRunRecords(snapshot.run, run) : run
  }
  db.run(
    `INSERT INTO task_snapshots(id, session_id, updated_at, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at = excluded.updated_at,
       payload = excluded.payload`,
    [next.id, next.sessionId, next.updatedAt, JSON.stringify(next)]
  )
  upsertWorkflowRecoverySession(db, next)
}

function hasMatchingRecoverySnapshot(
  db: WorkflowLedgerDatabase,
  readMode: WorkflowLedgerReadMode,
  view: ModelAttemptReconciliationView
): boolean {
  const run = findModelAttemptTaskRun(db, readMode, view.runId)
  return Boolean(run && matchingRecoverySnapshots(db, readMode, view, run).length > 0)
}

function findModelAttemptTaskRun(
  db: WorkflowLedgerDatabase,
  readMode: WorkflowLedgerReadMode,
  runId: string
): TaskRunRecord | null {
  return findRecoveryTaskRun(db, runId, readMode) ??
    (readMode === 'legacy'
      ? readCanonicalTaskRuns(db).find((run) => run.id === runId) ?? null
      : null)
}

function matchingRecoverySnapshots(
  db: WorkflowLedgerDatabase,
  readMode: WorkflowLedgerReadMode,
  view: ModelAttemptReconciliationView,
  run: TaskRunRecord
): TaskSnapshotRecord[] {
  return selectRecoverySnapshots(db, readMode).filter((snapshot) =>
    snapshot.sessionId === view.sessionId &&
    (snapshot.run?.id === view.runId ||
      (!snapshot.run && taskSnapshotTaskIdMatchesRun(snapshot.taskId, run)))
  )
}

function modelAttemptQuery(snapshot: TaskSnapshotRecord): ModelAttemptReconciliationQuery {
  return {
    sessionId: snapshot.sessionId,
    ...(snapshot.run?.id ? { runId: snapshot.run.id } : {})
  }
}
