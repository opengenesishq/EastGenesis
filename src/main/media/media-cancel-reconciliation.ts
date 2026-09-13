import type { EffectTarget } from '../../shared/types'
import type { MediaJobRecord } from '../../shared/media-types'
import { listTaskRuns } from '../task/task-snapshot'
import { isEffectTarget } from '../task/effect-target-validation'
import { stableValueDigest } from '../task/tool-idempotency'
import { notApplied, type EffectReconciliationResult } from '../task/effect-reconciliation-result'

type MediaTarget = Extract<EffectTarget, { kind: 'media_job_operation' }>
const observedCancellationResults = new WeakMap<EffectReconciliationResult, string>()

/** Only a later, confirmed original-job query can prove a cancellation lost its race. */
export async function reconcileUnappliedMediaCancellation(
  target: MediaTarget, job: MediaJobRecord, rootDir: string
): Promise<EffectReconciliationResult | undefined> {
  if (!isCancellationResultAvailable(target, job)) return undefined
  const cancelIndex = job.statusHistory.findIndex((event) => event.runId === target.runId && Boolean(event.effectId))
  if (cancelIndex < 0) return undefined
  const observations = job.statusHistory.slice(cancelIndex + 1).filter((event) => event.status === job.status)
  for (const event of observations) {
    if (!event.runId || !event.effectId) continue
    // Interactive operation run.id and sessionId are both the frozen operation scope.
    const runs = await listTaskRuns(event.runId, rootDir)
    const run = runs.find((item) => item.id === event.runId && item.status === 'completed')
    const effect = run?.effects?.find((item) => item.id === event.effectId)
    if (effect?.status !== 'confirmed' || !isMatchingCancellationPoll(target, effect.target)) continue
    const result = notApplied({ kind: target.kind, mediaJobId: job.id, status: job.status,
      cancellationApplied: false, queryRunId: event.runId, queryEffectId: event.effectId },
    '取消未生效：同一远端任务的后续查询已确认实际结果；保留任务状态与账单。')
    observedCancellationResults.set(result, stableValueDigest(target))
    return result
  }
  return undefined
}

/** An in-process proof, never caller-supplied metadata, narrows the owner fence. */
export function isObservedMediaCancellationNotApplied(result: EffectReconciliationResult, target: EffectTarget): boolean {
  return result.kind === 'not_applied' && observedCancellationResults.get(result) === stableValueDigest(target)
}

export function isCancellationResultAvailable(target: MediaTarget, job: MediaJobRecord): boolean {
  if (!isEffectTarget(target) || target.operation !== 'cancel' || target.expectedStatus !== 'cancelled') return false
  if (job.providerMode !== 'remote' || !job.executionBinding?.target) return false
  if (!ownsCancellationTarget(target, job)) return false
  if (job.status === 'failed' || job.status === 'succeeded') return true
  return job.status === 'downloading' && Boolean(job.remoteOutputRef || (job.preparedOutputPath && job.preparedOutputDigest))
}

function ownsCancellationTarget(target: MediaTarget, job: MediaJobRecord): boolean {
  const fields = ['externalJobId', 'projectId', 'goalId', 'workItemId'] as const
  return target.mediaJobId === job.id && fields.every((key) => target[key] === job[key])
    && target.idempotencyKeyDigest === stableValueDigest(job.idempotencyKey)
}

export function isMatchingCancellationPoll(cancel: MediaTarget, read: EffectTarget): boolean {
  if (read.kind !== 'media_job_operation' || !isEffectTarget(read) || read.operation !== 'poll' || read.expectedStatus !== 'running') return false
  const fields = ['mediaJobId', 'externalJobId', 'projectId', 'goalId', 'workItemId', 'idempotencyKeyDigest'] as const
  return read.runId !== cancel.runId && fields.every((key) => read[key] === cancel[key])
}
