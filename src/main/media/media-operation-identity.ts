import { createHash } from 'node:crypto'
import { stableValueDigest } from '../task/tool-idempotency'
import type { CanonicalSystemOperationContext } from '../task/system-operation-context'
import type { MediaJobOperationTarget } from './media-job-effect-target'
import type { MediaJobCanonicalBinding } from './media-store'

export function mediaTarget(input: {
  context: CanonicalSystemOperationContext
  operationId: string
  operation: MediaJobOperationTarget['operation']
  mediaJobId: string
  externalJobId: string
  idempotencyKey: string
  expectedStatus: MediaJobOperationTarget['expectedStatus']
  artifactId?: string
  evidenceId?: string
  acceptanceId?: string
}): MediaJobOperationTarget {
  return {
    kind: 'media_job_operation',
    operation: input.operation,
    mediaJobId: input.mediaJobId,
    externalJobId: input.externalJobId,
    idempotencyKeyDigest: stableValueDigest(input.idempotencyKey),
    projectId: input.context.projectId,
    goalId: input.context.goalId,
    workItemId: input.context.workItemId,
    runId: `operation:${input.operationId}`,
    expectedStatus: input.expectedStatus,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
    ...(input.acceptanceId ? { acceptanceId: input.acceptanceId } : {})
  }
}

export function binding(
  context: CanonicalSystemOperationContext,
  runId: string,
  effectId: string
): MediaJobCanonicalBinding {
  return { goalId: context.goalId, workItemId: context.workItemId, runId, effectId, businessLineId: context.businessLineId }
}

export function outputIdentities(jobId: string): Pick<MediaJobOperationTarget, 'artifactId' | 'evidenceId' | 'acceptanceId'> {
  const value = bindingDigest(jobId)
  return {
    artifactId: `artifact:media-output:${value}`,
    evidenceId: `evidence:media-output:${value}`,
    acceptanceId: `acceptance:media-output:${value}`
  }
}

export function localOutputIdentities(
  prefix: string,
  value: string
): Pick<MediaJobOperationTarget, 'artifactId' | 'evidenceId' | 'acceptanceId'> {
  return {
    artifactId: `artifact:${prefix}:${value}`,
    evidenceId: `evidence:${prefix}:${value}`,
    acceptanceId: `acceptance:${prefix}:${value}`
  }
}

export function operationIdFor(jobId: string, operation: string, sequence: number): string {
  return `media-${operation}-${bindingDigest(`${jobId}\0${sequence}`)}`
}

export function bindingDigest(value: string): string {
  return createHash('sha256').update(`caogen.media-runtime.v1\0${value}`).digest('hex').slice(0, 32)
}
