import type { FrozenRunRoutingPolicyV1 } from '../../shared/frozen-routing-types'
import type { TaskSnapshotRecord } from '../../shared/types'
import type { WorkflowRunRecord, WorkflowWorkItemRecord } from '../../shared/workflow-types'
import { FrozenRoutingPolicyError, frozenRoutingPolicyForRun } from './frozen-routing-policy'

/** Snapshot claims cannot re-home a bound policy even when their revision is newer. */
export function assertFrozenRoutingSnapshotOwner(snapshot: TaskSnapshotRecord): void {
  const policy = snapshot.run && frozenRoutingPolicyForRun(snapshot.run)
  if (!policy) return
  assertFrozenSnapshotClaims(snapshot, policy)
}

export function assertFrozenSnapshotClaims(snapshot: TaskSnapshotRecord, policy: FrozenRunRoutingPolicyV1): void {
  const { owner } = policy
  const claims = {
    runId: snapshot.run?.id, sessionId: snapshot.sessionId, taskId: snapshot.taskId,
    projectId: snapshot.meta.workspaceId ?? snapshot.meta.projectId,
    goalId: snapshot.meta.goalId, workItemId: snapshot.meta.workItemId,
    businessLineId: snapshot.meta.businessLineId
  }
  if (snapshot.meta.id !== owner.sessionId || Object.entries(claims).some(([key, value]) => value !== owner[key as keyof typeof owner])) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'Recovery snapshot does not belong to the frozen canonical task.')
  }
}

export function assertFrozenCanonicalOwner(input: {
  policy: FrozenRunRoutingPolicyV1; run: WorkflowRunRecord; workItem: WorkflowWorkItemRecord | null
}): void {
  const { owner } = input.policy
  const { run, workItem } = input
  const actual = {
    runId: run.id, sessionId: run.sessionId, taskId: run.taskId,
    projectId: run.projectId, goalId: run.goalId, workItemId: run.workItemId,
    businessLineId: workItem?.businessLineId
  }
  if (Object.entries(actual).some(([key, value]) => value !== owner[key as keyof typeof owner])) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'Policy owner differs from the canonical Run and WorkItem.')
  }
  if (!workItem || workItem.projectId !== run.projectId || workItem.goalId !== run.goalId || workItem.currentRunId !== run.id) {
    throw new FrozenRoutingPolicyError('OWNER_MISMATCH', 'The canonical WorkItem does not own this current Run.')
  }
}
