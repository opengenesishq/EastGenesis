import type { ProviderView, RoutingExpertPolicy } from '../../shared/types'
import type { MediaCapabilityVerificationState, MediaExecutionBinding, MediaJobInput, MediaJobRecord, MediaOperation, MediaProviderProfile, MediaRoutingPreference, VideoProduction } from '../../shared/media-types'
import { estimateMediaPrice, MEDIA_AUTO_PROVIDER_ID } from '../../shared/media-routing-types'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { assertRoutingExpertTargetAllowed } from '../model/routing-expert-policy'
import { ModelRouteError } from '../model/model-route-error'
import { remainingMediaBudget } from './media-budget'

interface MediaCandidate {
  profile: MediaProviderProfile
  target?: MediaExecutionBinding['target']
  credential?: MediaExecutionBinding['credential']
  healthy: boolean
  latencyMs?: number
}

export interface MediaRouteSelectionInput {
  request: MediaJobInput
  profiles: MediaProviderProfile[]
  providers: ProviderView[]
  production: VideoProduction
  jobs: MediaJobRecord[]
  strategy: MediaRoutingPreference
  /** Business-line default used when a request does not provide a task override. */
  businessLinePreference?: MediaRoutingPreference
  requestBudgetRemainingUsd?: number
  policy?: RoutingExpertPolicy
  health: Record<string, { healthy: boolean; latencyEmaMs?: number }>
  /** High-risk callers must opt in to a verified capability evidence gate. */
  requireVerifiedCapability?: boolean
}

export function selectMediaRoute(input: MediaRouteSelectionInput): MediaExecutionBinding {
  const operation = input.request.operation ?? defaultMediaOperation(input.request.capability)
  const explicitId = input.request.mediaProviderId
  const fixed = Boolean((explicitId && explicitId !== MEDIA_AUTO_PROVIDER_ID) || input.request.providerId || input.request.model)
  const profiles = input.profiles.filter((profile) => profile.enabled && profile.operations.includes(operation)
    && matchesMediaTarget(profile, input.request, fixed))
  const candidates = profiles.flatMap((profile) => mediaCandidate(profile, input))
    .filter((candidate) => candidate.profile.verification?.state !== 'failed')
    .filter((candidate) => !input.requireVerifiedCapability || mediaCapabilityVerificationState(candidate.profile, operation) === 'verified')
    .filter((candidate) => fixed || (candidate.profile.endpointClass !== 'mock' && candidate.healthy))
    .filter((candidate) => fixed || mediaInputsAuthorized(candidate.profile, input))
  if (!candidates.length) throw new ModelRouteError('ROUTING_CAPABILITY_UNAVAILABLE', '没有可用的媒体目标，请在模型设置声明所需媒体能力和协议，或选择手动适配。')
  const eligible = budgetEligibleCandidates(candidates, input)
  const strategy = input.request.routingPreference ?? input.businessLinePreference ?? input.strategy
  const selected = [...eligible].sort((left, right) => compareMediaCandidates(left, right, strategy))[0]
  const { profile } = selected
  const considerations = [
    `已声明支持 ${operation}；协议 ${profile.endpointClass}`,
    profile.estimatedCostUsd === undefined ? '价格未知，不视为免费' : `本次估算 $${profile.estimatedCostUsd.toFixed(4)}`,
    selected.latencyMs === undefined ? '暂无该连接延迟样本' : `连接历史延迟 ${Math.round(selected.latencyMs)}ms`,
    `媒体能力验证：${mediaCapabilityVerificationState(profile, operation)}`,
    '未用文本能力评分推断画面、剧情或声音质量'
  ]
  return {
    profile,
    ...(selected.target ? { target: selected.target } : {}),
    ...(selected.credential ? { credential: selected.credential } : {}),
    decision: { mode: fixed ? 'fixed' : 'auto', strategy, mediaProviderId: profile.id,
      providerId: profile.providerId, model: selected.target?.model ?? profile.model,
      ...(input.request.businessLineId ? { businessLineId: input.request.businessLineId } : {}),
      estimatedCostUsd: profile.estimatedCostUsd, candidateCount: eligible.length,
      reason: fixed ? '使用指定媒体目标' : `${strategy} 偏好：按声明能力、连接健康、已知价格与延迟选择`,
      considerations, createdAt: Date.now() }
  }
}

/**
 * Classify media capability evidence without probing a real provider.
 * Local deterministic runtimes are intrinsically verified; remote declarations
 * remain unknown until a bounded, operation-specific probe records evidence.
 */
export function mediaCapabilityVerificationState(profile: MediaProviderProfile, operation: MediaOperation): MediaCapabilityVerificationState {
  if (profile.endpointClass === 'mock' || profile.endpointClass === 'local-ffmpeg') return 'verified'
  const verification = profile.verification
  if (!verification) return 'unknown'
  if (verification.state !== 'verified') return verification.state
  if (verification.operations && !verification.operations.includes(operation)) return 'unknown'
  return 'verified'
}

function mediaCandidate(profile: MediaProviderProfile, input: MediaRouteSelectionInput): MediaCandidate[] {
  const estimate = estimateMediaPrice(profile.mediaPricing, input.request) ?? profile.estimatedCostUsd
  const priced = { ...profile, estimatedCostUsd: estimate }
  if (profile.endpointClass === 'mock') return [{ profile: priced, healthy: true }]
  const provider = input.providers.find((candidate) => candidate.id === profile.providerId && candidate.ready)
  if (!provider) return []
  try {
    const target = resolveProviderRuntimeTarget(provider, { appId: 'caogen-media', model: profile.model })
    if (!target.baseUrl || !target.model || target.model !== profile.model) return []
    if (input.policy) assertRoutingExpertTargetAllowed(provider.id, target.baseUrl, input.policy)
    const credential = { authMode: provider.authMode, keyId: provider.activeKeyId }
    if (credential.authMode !== 'none' && !credential.keyId) return []
    const health = input.health[provider.id]
    return [{ profile: priced, target, credential, healthy: health?.healthy ?? true, latencyMs: health?.latencyEmaMs }]
  } catch { return [] }
}

function matchesMediaTarget(profile: MediaProviderProfile, request: MediaJobInput, fixed: boolean): boolean {
  if (!fixed) return true
  if (request.mediaProviderId && request.mediaProviderId !== MEDIA_AUTO_PROVIDER_ID && profile.id !== request.mediaProviderId) return false
  return (!request.providerId || profile.providerId === request.providerId) && (!request.model || profile.model === request.model)
}

function mediaInputsAuthorized(profile: MediaProviderProfile, input: MediaRouteSelectionInput): boolean {
  const operation = input.request.operation ?? defaultMediaOperation(input.request.capability)
  return (input.request.inputAssetIds ?? []).every((id) => {
    const asset = input.production.assets.find((item) => item.id === id)
    return asset?.egressGrants?.some((grant) => grant.mediaProviderId === profile.id && grant.assetVersion === asset.version
      && grant.operation === operation && grant.status === 'granted' && (grant.expiresAt === undefined || grant.expiresAt > Date.now()))
  })
}

function fitsMediaBudget(candidate: MediaCandidate, remaining: number | undefined): boolean {
  if (candidate.profile.endpointClass === 'mock' || remaining === undefined) return true
  return remaining > 0 && candidate.profile.estimatedCostUsd !== undefined && candidate.profile.estimatedCostUsd <= remaining
}

function compareMediaCandidates(left: MediaCandidate, right: MediaCandidate, strategy: MediaRoutingPreference): number {
  const health = Number(right.healthy) - Number(left.healthy)
  const cost = (left.profile.estimatedCostUsd ?? Infinity) - (right.profile.estimatedCostUsd ?? Infinity)
  const latency = (left.latencyMs ?? Infinity) - (right.latencyMs ?? Infinity)
  return health || (strategy === 'speed' ? latency || cost : cost || latency) || left.profile.id.localeCompare(right.profile.id)
}

export function defaultMediaOperation(capability: MediaJobInput['capability']): NonNullable<MediaJobInput['operation']> {
  if (capability === 'image') return 'image.generate'
  if (capability === 'tts') return 'speech.synthesize'
  return capability === 'synthesis' ? 'media.compose' : 'video.text-to-video'
}

function budgetEligibleCandidates(candidates: MediaCandidate[], input: MediaRouteSelectionInput): MediaCandidate[] {
  const limits = [remainingMediaBudget(input.production, input.jobs), input.requestBudgetRemainingUsd]
    .filter((value): value is number => value !== undefined)
  const remaining = limits.length ? Math.min(...limits) : undefined
  const eligible = candidates.filter((candidate) => fitsMediaBudget(candidate, remaining))
  if (!eligible.length) {
    throw new ModelRouteError(remaining === 0 ? 'ROUTING_BUDGET_EXHAUSTED' : 'ROUTING_BUDGET_UNAFFORDABLE',
      remaining === 0 ? '媒体预算已耗尽。' : '媒体候选未定价或超出剩余预算，请调整目标或预算。')
  }
  return eligible
}
