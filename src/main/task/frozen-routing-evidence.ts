import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { FrozenRoutingPolicyError } from './frozen-routing-policy'
import { readRuns } from './workflow-ledger-query'
import { verifyModelAttemptLedger } from './model-attempt-store'

export function assertFrozenRunUnstarted(db: WorkflowLedgerDatabase, run: TaskRunRecord, snapshots: TaskSnapshotRecord[], messageId: string): void {
  assertPristineRun(run)
  if (hasPhysicalEvidence(db, run.id)) alreadyStarted('This Run already has model or effect evidence.')
  for (const snapshot of snapshots) {
    if (!snapshot.run) alreadyStarted('Recovery snapshot has no Run.')
    assertPristineRun(snapshot.run)
    assertPriorConversation(db, run, snapshot, messageId)
  }
}

function assertPristineRun(run: TaskRunRecord): void {
  const scalarEvidence = [run.startedAt, run.finishedAt, run.pendingPermissionRequestId, run.lastAppliedEventId,
    run.lastAppliedEventSeq, run.lastEventKind, run.operation, run.error]
  const collections = [run.steps, run.toolExecutions, run.effects, run.recentEventIds]
  if (run.status !== 'queued' || run.attempt !== 1 || run.recoveryCount !== 0) alreadyStarted('Only a pristine queued Run can first bind routing.')
  if (scalarEvidence.some((value) => value !== undefined) || collections.some((items) => items && items.length > 0)) {
    alreadyStarted('Run execution fields already contain evidence.')
  }
}

function hasPhysicalEvidence(db: WorkflowLedgerDatabase, runId: string): boolean {
  const attempts = verifyModelAttemptLedger(db)
  return (attempts.attempts > 0 && hasRow(db, 'SELECT 1 FROM model_attempts WHERE run_id = ? LIMIT 1', runId)) ||
    hasRow(db, 'SELECT 1 FROM task_evidence WHERE run_id = ? LIMIT 1', runId)
}

function hasRow(db: WorkflowLedgerDatabase, sql: string, runId: string): boolean {
  const statement = db.prepare(sql)
  try { statement.bind([runId]); return statement.step() } finally { statement.free() }
}

function assertPriorConversation(db: WorkflowLedgerDatabase, run: TaskRunRecord, snapshot: TaskSnapshotRecord, messageId: string): void {
  if (snapshot.replayCandidate || snapshot.execution.lastUserMessageId === messageId) alreadyStarted('A submitted user message cannot acquire a new policy.')
  const hasSubmittedUserMessage = snapshot.transcript.some(({ event }) => event.kind === 'user-message')
  if (snapshot.transcript.some(({ event }) => event.kind === 'user-message' && event.messageId === messageId)) {
    alreadyStarted('The policy message already appears in the conversation ledger.')
  }
  // A newly created Session may already contain starting/init/idle lifecycle
  // events. Those events do not establish a prior conversation and must not
  // force a completed predecessor before the first canonical user message.
  if (!hasSubmittedUserMessage && snapshot.execution.lastUserMessageId === undefined) return
  const end = Math.max(snapshot.execution.lastSeq, ...snapshot.transcript.map((entry) => entry.seq))
  if (end === 0 && snapshot.eventCount === 0 && snapshot.transcript.length === 0) return
  // A timestamp/renderer cursor is not proof: only a completed canonical prior Run
  // can account for the entire persisted conversation before the new request.
  // Resume/fork creates a fresh local Session id while reusing the same
  // canonical conversation/WorkItem. A predecessor therefore may belong to
  // the old Session id; the canonical WorkItem is the durable continuity
  // boundary in that case. Keep the same-session path for legacy snapshots
  // that do not carry WorkItem ownership.
  const workItemId = snapshot.meta.workItemId
  const previous = readRuns(db).filter((item) => item.id !== run.id && (
    item.sessionId === run.sessionId ||
    (Boolean(workItemId) && item.workItemId === workItemId)
  ))
  const covering = previous.some((item) => {
    if (item.status !== 'completed' || item.taskRun.status !== 'completed' || item.taskRun.finishedAt === undefined) return false
    if (item.taskRun.lastAppliedEventSeq !== undefined && item.taskRun.lastAppliedEventSeq >= end) return true
    // Resume/fork restores the prior transcript into a fresh Session. Its
    // lifecycle events advance the local cursor, while the predecessor's
    // completed user message remains the durable conversation boundary.
    return Boolean(workItemId && item.workItemId === workItemId &&
      item.taskRun.messageId && item.taskRun.messageId === snapshot.execution.lastUserMessageId)
  })
  if (!covering) alreadyStarted('Existing conversation lacks a completed canonical predecessor covering its cursor.')
}

function alreadyStarted(message: string): never { throw new FrozenRoutingPolicyError('RUN_ALREADY_STARTED', message) }
