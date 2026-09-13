import type { BindFrozenRoutingPolicyInput, FrozenRunRoutingPolicyV1 } from '../../shared/frozen-routing-types'
import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkflowRunRecord } from '../../shared/workflow-types'
import { mutateTaskSnapshotDatabase } from './task-snapshot'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { canonicalJson, digest } from './workflow-ledger-canonical'
import { findWorkflowRun, findWorkflowWorkItem, readAndVerifyEvents } from './workflow-ledger-query'
import { selectRecoverySnapshots, selectRecoveryTaskRuns, upsertWorkflowRecoverySession } from './workflow-ledger-recovery'
import { appendWorkflowEvent, projectTaskRun } from './workflow-ledger-store'
import { insertRun } from './workflow-ledger-sql'
import { workflowContextForSnapshot } from './workflow-ledger-projection'
import { FrozenRoutingPolicyError, frozenRoutingPolicyForRun, verifyFrozenRoutingPolicy } from './frozen-routing-policy'
import { assertFrozenCanonicalOwner, assertFrozenSnapshotClaims } from './frozen-routing-ownership'
import { assertFrozenRunUnstarted } from './frozen-routing-evidence'

/** Main-only first binding. All projections and the event commit in the existing
 * task-store queue/atomic database replacement before this promise resolves.
 * It never dispatches a request and cannot retrofit an already executed Run. */
export async function bindFrozenRunRoutingPolicy(input: BindFrozenRoutingPolicyInput, rootDir: string): Promise<TaskRunRecord> {
  const policy = verifyFrozenRoutingPolicy(input.policy)
  assertBindingCommand(input, policy)
  return mutateTaskSnapshotDatabase(rootDir, (db) => bindWithinDatabase(db, input, policy))
}

function bindWithinDatabase(db: WorkflowLedgerDatabase, input: BindFrozenRoutingPolicyInput, policy: FrozenRunRoutingPolicyV1): TaskRunRecord {
  readAndVerifyEvents(db)
  let canonical = findWorkflowRun(db, input.runId)
  if (!canonical) {
    // A successor Run can race the terminal cleanup of its predecessor. The
    // recovery projections are authoritative and may already contain the new
    // TaskRun/Snapshot while the WorkflowRun row is not yet materialized.
    // Project that exact pair before binding; never synthesize a Run or widen
    // ownership when either recovery record is missing.
    const recoveryRun = selectRecoveryTaskRuns(db, 'compare').find((item) => item.id === input.runId)
    const recoverySnapshot = selectRecoverySnapshots(db, 'compare').find((item) => item.sessionId === input.sessionId && item.run?.id === input.runId)
    if (recoveryRun && recoverySnapshot) {
      projectTaskRun(db, recoveryRun, workflowContextForSnapshot(recoverySnapshot))
      canonical = findWorkflowRun(db, input.runId)
    }
  }
  if (!canonical) throw new FrozenRoutingPolicyError('BINDING_UNAVAILABLE', 'First binding requires an existing canonical Run.')
  assertFrozenCanonicalOwner({ policy, run: canonical, workItem: findWorkflowWorkItem(db, canonical.workItemId) })
  const run = canonical.taskRun
  const snapshots = bindingSnapshots(db, run, policy)
  const existing = frozenRoutingPolicyForRun(run)
  if (existing) {
    if (existing.policyDigest !== policy.policyDigest) throw new FrozenRoutingPolicyError('POLICY_CONFLICT', 'This Run already has a different frozen policy.')
    return run
  }
  if (run.revision !== input.expectedRunRevision) throw new FrozenRoutingPolicyError('STALE_RUN', 'Run revision changed before routing was frozen.')
  assertFrozenRunUnstarted(db, run, snapshots, policy.messageId)
  const next = { ...run, routingPolicy: policy, messageId: policy.messageId, revision: run.revision + 1, updatedAt: Math.max(run.updatedAt, policy.frozenAt) }
  persistBinding(db, canonical, next, snapshots)
  readAndVerifyEvents(db)
  return next
}

function bindingSnapshots(db: WorkflowLedgerDatabase, run: TaskRunRecord, policy: FrozenRunRoutingPolicyV1): TaskSnapshotRecord[] {
  const stored = selectRecoveryTaskRuns(db, 'compare').find((item) => item.id === run.id)
  if (!stored || digest(stored) !== digest(run)) throw new FrozenRoutingPolicyError('BINDING_UNAVAILABLE', 'Canonical and recovery Run projections disagree.')
  const snapshots = selectRecoverySnapshots(db, 'compare').filter((item) => item.sessionId === run.sessionId && item.run?.id === run.id)
  if (snapshots.length !== 1) throw new FrozenRoutingPolicyError('MISSING_SNAPSHOT', 'First binding requires one exact session and Run recovery snapshot.')
  for (const snapshot of snapshots) {
    assertFrozenSnapshotClaims(snapshot, policy)
    if (digest(snapshot.run) !== digest(run)) throw new FrozenRoutingPolicyError('STALE_RUN', 'The recovery snapshot does not contain the current Run revision.')
  }
  return snapshots
}

function assertBindingCommand(input: BindFrozenRoutingPolicyInput, policy: FrozenRunRoutingPolicyV1): void {
  if (input.runId !== policy.owner.runId || input.sessionId !== policy.owner.sessionId) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'Binding command does not match the policy owner.')
  }
  if (!Number.isSafeInteger(input.expectedRunRevision) || input.expectedRunRevision < 1) {
    throw new FrozenRoutingPolicyError('STALE_RUN', 'Binding requires an explicit positive expected Run revision.')
  }
}

function persistBinding(db: WorkflowLedgerDatabase, current: WorkflowRunRecord, next: TaskRunRecord, snapshots: TaskSnapshotRecord[]): void {
  const canonical = { ...current, taskRun: next, revision: next.revision, updatedAt: next.updatedAt }
  // Use low-level writes on this exact db. Calling the normal projection facade
  // would either nest a transaction or let arbitrary writers authorize first bind.
  insertRun(db, canonical)
  appendWorkflowEvent(db, {
    eventId: `workflow:run:${next.id}:revision:${next.revision}:updated:${next.updatedAt}`,
    streamId: `work-item:${current.workItemId}`, entityType: 'run', entityId: next.id, kind: 'run.projected',
    payload: { runId: next.id, workItemId: current.workItemId, taskId: next.taskId, status: next.status,
      revision: next.revision, attempt: next.attempt, routingPolicyDigest: next.routingPolicy!.policyDigest },
    occurredAt: next.updatedAt, correlationId: next.sessionId
  }, { projectId: current.projectId, goalId: current.goalId, workItemId: current.workItemId, runId: next.id, sessionId: next.sessionId })
  db.run('UPDATE task_runs SET updated_at = ?, payload = ? WHERE id = ? AND session_id = ?',
    [next.updatedAt, canonicalJson(next), next.id, next.sessionId])
  for (const snapshot of snapshots) {
    const updated = { ...snapshot, run: next, updatedAt: Math.max(snapshot.updatedAt, next.updatedAt) }
    db.run('UPDATE task_snapshots SET updated_at = ?, payload = ? WHERE id = ? AND session_id = ?',
      [updated.updatedAt, canonicalJson(updated), updated.id, updated.sessionId])
    upsertWorkflowRecoverySession(db, updated)
  }
}
