import type { EffectRecord, EffectTarget } from '../../shared/types'
import type { MediaJobRecord } from '../../shared/media-types'
import { isEffectTarget } from './effect-target-validation'
import { stableValueDigest } from './tool-idempotency'

type MediaTarget = Extract<EffectTarget, { kind: 'media_job_operation' }>

/** Only a durable original job can authorize a read through an unresolved lease. */
export function isBoundMediaReconciliationRead(candidate: EffectRecord, previous: EffectRecord, job: MediaJobRecord | undefined): boolean {
  if (!job || !eligibleEffects(candidate, previous)) return false
  const read = candidate.target
  const write = previous.target
  if (read.kind !== 'media_job_operation' || write.kind !== 'media_job_operation') return false
  if (!validTargets(read, write) || !jobAuthorizesRead(job, read, write)) return false
  return job.statusHistory.some((event) => event.runId === write.runId && event.effectId === previous.id)
}

function eligibleEffects(candidate: EffectRecord, previous: EffectRecord): boolean {
  return candidate.toolName === 'media_job_operation' && previous.toolName === 'media_job_operation'
    && previous.status === 'waiting_reconciliation'
}

function validTargets(read: MediaTarget, write: MediaTarget): boolean {
  if (!isEffectTarget(read) || !isEffectTarget(write)) return false
  if (read.operation !== 'poll' || !['submit', 'poll', 'cancel'].includes(write.operation) || read.expectedStatus !== 'running') return false
  if (write.operation === 'cancel' && write.expectedStatus !== 'cancelled') return false
  const fields = ['mediaJobId', 'externalJobId', 'projectId', 'goalId', 'workItemId', 'idempotencyKeyDigest'] as const
  return fields.every((key) => read[key] === write[key])
}

function jobAuthorizesRead(job: MediaJobRecord, read: MediaTarget, write: MediaTarget): boolean {
  if (job.providerMode !== 'remote' || !job.executionBinding?.target) return false
  const observable = job.status === 'waiting_reconciliation' || (write.operation === 'cancel' && job.status === 'running')
  if (!observable) return false
  return read.mediaJobId === job.id && read.externalJobId === job.externalJobId && read.projectId === job.projectId
    && read.goalId === job.goalId && read.workItemId === job.workItemId && read.idempotencyKeyDigest === stableValueDigest(job.idempotencyKey)
}
