import { createHash } from 'node:crypto'
import { MEDIA_AUTO_PROVIDER_ID } from '../../../shared/media-routing-types'
import { MEDIA_AGENT_OPERATIONS } from '../../../shared/media-tool-contract'
import type { MediaJobInput } from '../../../shared/media-types'
import type { MediaAgentOrigin } from '../../../shared/media-agent-types'

export function mediaToolIdentity(origin: MediaAgentOrigin, purpose: 'production' | 'job'): string {
  return `media-agent:${purpose}:${createHash('sha256').update(`${origin.sessionId}\0${origin.toolUseId}\0${purpose}`).digest('hex')}`
}

export function mediaToolSubmission(args: Record<string, unknown>, origin: MediaAgentOrigin): MediaJobInput {
  assertMediaToolKeys(args, ['productionId', 'shotId', 'operation', 'mediaProviderId', 'prompt', 'inputAssetIds', 'voice', 'parameters', 'routingPreference'])
  const operation = mediaToolText(args.operation, 'operation', 80)
  if (!MEDIA_AGENT_OPERATIONS.some((candidate) => candidate === operation)) throw new Error('Unsupported media operation')
  const assets = args.inputAssetIds
  if (assets !== undefined && (!Array.isArray(assets) || assets.length > 16 || assets.some((item) => typeof item !== 'string' || !item.trim()))) {
    throw new Error('inputAssetIds must contain at most 16 owned asset IDs')
  }
  const strategy = args.routingPreference
  if (strategy !== undefined && !['balanced', 'quality', 'cost', 'speed'].includes(String(strategy))) throw new Error('Invalid media routing preference')
  return {
    projectId: origin.workspaceId, businessLineId: origin.businessLineId,
    productionId: mediaToolText(args.productionId, 'productionId', 240),
    shotId: optionalText(args.shotId, 'shotId'),
    capability: operation.startsWith('image.') ? 'image' : operation.startsWith('video.') ? 'video' : 'tts',
    operation: operation as MediaJobInput['operation'], idempotencyKey: mediaToolIdentity(origin, 'job'),
    mediaProviderId: optionalText(args.mediaProviderId, 'mediaProviderId') ?? MEDIA_AUTO_PROVIDER_ID,
    prompt: mediaToolText(args.prompt, 'prompt', 20000), voice: optionalText(args.voice, 'voice'),
    inputAssetIds: assets as string[] | undefined, parameters: mediaToolParameters(args.parameters),
    routingPreference: strategy as MediaJobInput['routingPreference']
  }
}

export function assertMediaToolKeys(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('Media tool contains unsupported or caller-owned fields')
}
export function mediaToolText(value: unknown, label: string, limit = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} is required and must be within ${limit} characters`)
  return value.trim()
}
function optionalText(value: unknown, label: string): string | undefined { return value === undefined ? undefined : mediaToolText(value, label) }
function mediaToolParameters(value: unknown): MediaJobInput['parameters'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid media parameters')
  const parameters = value as Record<string, unknown>
  assertMediaToolKeys(parameters, ['durationSeconds', 'aspectRatio', 'quality'])
  const durationSeconds = parameters.durationSeconds
  if (durationSeconds !== undefined && (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 60)) throw new Error('Media duration must be between 1 and 60 seconds')
  if (parameters.aspectRatio !== undefined && !['1:1', '16:9', '9:16', '4:3', '3:4'].includes(String(parameters.aspectRatio))) throw new Error('Invalid media aspect ratio')
  if (parameters.quality !== undefined && !['draft', 'standard', 'high'].includes(String(parameters.quality))) throw new Error('Invalid media quality')
  return { durationSeconds: durationSeconds as number | undefined,
    aspectRatio: optionalText(parameters.aspectRatio, 'aspectRatio') as NonNullable<MediaJobInput['parameters']>['aspectRatio'],
    quality: parameters.quality as NonNullable<MediaJobInput['parameters']>['quality'] }
}
