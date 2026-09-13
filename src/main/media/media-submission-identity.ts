import { createHash } from 'node:crypto'
import type { MediaJobInput, MediaJobRecord } from '../../shared/media-types'
import { MEDIA_AUTO_PROVIDER_ID } from '../../shared/media-routing-types'
import { canonicalJson, requiredText } from '../project-workspace/codec'

export function normalizeMediaIdempotencyKey(value: string): string {
  return requiredText(value, 'idempotencyKey').slice(0, 240)
}

export function mediaJobIdForKey(value: string): string {
  return `media-job:${createHash('sha256').update(normalizeMediaIdempotencyKey(value)).digest('hex').slice(0, 32)}`
}

/** Preserve original caller intent independently of the automatic target snapshot. */
export function mediaSubmissionDigest(input: MediaJobInput): string {
  const identity = { ...input, mediaProviderId: input.mediaProviderId || MEDIA_AUTO_PROVIDER_ID }
  delete identity.routingPreference
  return `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
}

export function assertMediaSubmissionReplay(job: MediaJobRecord, input: MediaJobInput): MediaJobRecord {
  const digest = job.executionBinding?.requestDigest
  const scopeMatches = job.projectId === input.projectId && job.productionId === input.productionId
    && job.shotId === input.shotId && job.dialogueCueId === input.dialogueCueId && job.capability === input.capability
  if (!scopeMatches || (digest && digest !== mediaSubmissionDigest(input))) {
    throw new Error('MediaJob idempotency identity conflict')
  }
  return job
}

export function mediaSubmissionContentDigest(input: MediaJobInput): string {
  const { idempotencyKey, providerId, mediaProviderId, model, routingPreference, ...content } = input
  return `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`
}
