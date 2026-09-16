import { AUTO_MODEL } from '../../shared/types'
import type {
  AgentEvent,
  EngineKind,
  OutboundContextManifest,
  ProviderView,
  RoutingExpertPolicy,
  SessionMeta
} from '../../shared/types'
import type { AnthropicMessagesTarget } from './anthropicMessagesTarget'
import { providerAllowedByOutboundContext } from '../project-workspace/outbound-context-policy'
import {
  assertRoutingExpertTargetAllowed,
  providerAllowedByRoutingExpertPolicy
} from '../model/routing-expert-policy'
import type { canRotateProviderKey } from '../providerKeyRouting'
import type { rotateProviderKey } from '../providers'
import type {
  FailureClass,
  pickFailoverTarget,
  pickProviderModelFailoverTarget
} from '../scheduler'
import { synchronizeProviderReliabilityPolicies } from '../providerHealth'
import { assertNativeRecoveryTargetAllowed, evaluateNativeRecoveryTarget, filterNativeRecoveryModels } from '../model/native-recovery-eligibility'
import { frozenRetryAllows, frozenSameTargetRetryAllows, type NativeSessionRecoveryContext } from '../model/native-recovery-session'
import type { RoutingRetryReason } from '../../shared/routing-policy-types'
import { ModelRouteError } from '../model/model-route-error'

type RecoveryEvent = Extract<AgentEvent, {
  kind: 'provider-key-failover' | 'provider-model-failover' | 'failover' | 'hook-event'
}>

export interface AnthropicRecoveryState {
  triedProviders: Set<string>
  triedProviderKeys: Map<string, Set<string>>
  triedProviderModels: Map<string, Set<string>>
  attempts: number
}

interface RecoverySettings {
  failoverEnabled: boolean
  fallbackProviderId: string
  fallbackModel: string
  routingExpertPolicy: RoutingExpertPolicy
}

export interface AnthropicRecoveryResult {
  target: AnthropicMessagesTarget
  routeReason: string
  event: RecoveryEvent
  metaChanged: boolean
}

export interface AnthropicRecoveryInput {
  recovery: NativeSessionRecoveryContext
  current: AnthropicMessagesTarget
  failure: FailureClass
  settings: RecoverySettings
  providers: ProviderView[]
  meta: SessionMeta
  outboundContext?: OutboundContextManifest
  state: AnthropicRecoveryState
  resolveTarget(input: { providerId: string; model?: string }): AnthropicMessagesTarget
  canRotateProviderKey: typeof canRotateProviderKey
  rotateProviderKey: typeof rotateProviderKey
  pickFailoverTarget: typeof pickFailoverTarget
  pickProviderModelFailoverTarget: typeof pickProviderModelFailoverTarget
  engineKind?: EngineKind
  nativeRetryReason?: RoutingRetryReason
}

export function createAnthropicRecoveryState(providerId?: string): AnthropicRecoveryState {
  return {
    triedProviders: new Set(providerId ? [providerId] : []),
    triedProviderKeys: new Map(),
    triedProviderModels: new Map(),
    attempts: 0
  }
}

export function rememberAnthropicRecoveryTarget(
  state: AnthropicRecoveryState,
  target: AnthropicMessagesTarget
): void {
  if (target.keyId) attemptedValues(state.triedProviderKeys, target.providerId).add(target.keyId)
  attemptedValues(state.triedProviderModels, target.providerId).add(target.model)
}

export function recoverAnthropicTarget(input: AnthropicRecoveryInput): AnthropicRecoveryResult | undefined {
  synchronizeProviderReliabilityPolicies(input.providers)
  const provider = input.providers.find((candidate) => candidate.id === input.current.providerId)
  const reliability = provider?.advancedConfig?.reliability
  if (!isAnthropicRecoveryEnabled(input.current.providerId, input.settings.failoverEnabled, input.providers)) return undefined
  if (reliability?.maxRetries !== undefined && input.state.attempts >= reliability.maxRetries) return undefined
  if (input.recovery.frozenRetry && !input.nativeRetryReason) return undefined
  if (input.recovery.frozenRetry && input.recovery.frozenRetry.effectivePolicy.failure.kind !== 'pause'
    && input.state.attempts >= input.recovery.frozenRetry.effectivePolicy.failure.maxAdditionalAttempts) return undefined
  const recovery = recoverSameTarget(input) ?? recoverProviderKey(input) ?? recoverProviderModel(input) ?? recoverProvider(input)
  if (recovery) input.state.attempts += 1
  return recovery
}

function recoverSameTarget(input: AnthropicRecoveryInput): AnthropicRecoveryResult | undefined {
  const { current, recovery, state } = input
  if (!frozenSameTargetRetryAllows({ recovery, providerId: current.providerId, model: current.model,
    protocol: recoveryProtocol(input), attempt: state.attempts + 1,
    refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })) return undefined
  // Resolve again so a revoked/unavailable credential cannot be reused. This
  // branch precedes key rotation, which would put the single key in cooldown.
  let target: AnthropicMessagesTarget
  try {
    target = input.resolveTarget({ providerId: current.providerId, model: current.model })
    if (target.providerId !== current.providerId || target.model !== current.model || target.keyId !== current.keyId) return undefined
    assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, input.settings.routingExpertPolicy)
    assertRecoveryTarget(input, target)
    const provider = input.providers.find(item => item.id === target.providerId)
    if (!provider || !providerAllowedByOutboundContext(input.outboundContext, provider, target.model)) return undefined
  } catch { return undefined }
  const routeReason = `同一目标重试：${input.nativeRetryReason} (${state.attempts + 1})`
  return { target, routeReason, metaChanged: false, event: { kind: 'hook-event', event: 'provider-same-target-retry', detail: routeReason } }
}

export function isAnthropicRecoveryEnabled(
  providerId: string,
  globalEnabled: boolean,
  providers: ProviderView[]
): boolean {
  return providers.find((provider) => provider.id === providerId)
    ?.advancedConfig?.reliability?.failoverEnabled ?? globalEnabled
}

function recoverProviderKey(input: AnthropicRecoveryInput): AnthropicRecoveryResult | undefined {
  const { current, failure, state } = input
  if (input.recovery.frozenRetry && !frozenRetryAllows({ recovery: input.recovery, providerId: current.providerId, model: current.model, protocol: recoveryProtocol(input), attempt: state.attempts + 1, refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })) return undefined
  if (!current.keyId || !input.canRotateProviderKey(failure)) return undefined
  const triedKeyIds = attemptedValues(state.triedProviderKeys, current.providerId)
  const rotation = input.rotateProviderKey({
    providerId: current.providerId,
    failedKeyId: current.keyId,
    excludedKeyIds: triedKeyIds,
    reason: failure.label
  })
  if (!rotation || triedKeyIds.has(rotation.toKeyId)) return undefined
  let target: AnthropicMessagesTarget
  try {
    target = input.resolveTarget({ providerId: current.providerId, model: current.model })
    assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, input.settings.routingExpertPolicy)
    assertRecoveryTarget(input, target)
  } catch {
    triedKeyIds.add(rotation.toKeyId)
    return undefined
  }
  if (target.keyId !== rotation.toKeyId) {
    triedKeyIds.add(rotation.toKeyId)
    return undefined
  }
  rememberAnthropicRecoveryTarget(state, target)
  return {
    target,
    routeReason: `Provider key failover: ${failure.label}`,
    metaChanged: false,
    event: {
      kind: 'provider-key-failover',
      providerId: rotation.providerId,
      providerName: rotation.providerName,
      fromKeyId: rotation.fromKeyId,
      fromKeyLabel: rotation.fromKeyLabel,
      toKeyId: rotation.toKeyId,
      toKeyLabel: rotation.toKeyLabel,
      reason: failure.label
    }
  }
}

function recoverProviderModel(input: AnthropicRecoveryInput): AnthropicRecoveryResult | undefined {
  const { current, failure, providers, state } = input
  const provider = providers.find((candidate) =>
    candidate.id === current.providerId && candidate.engine === (input.engineKind ?? 'anthropic') && candidate.hasToken
  )
  if (!provider || !recoveryProviderAllowed(input, provider)) return undefined
  const models = resolvableModels(input, provider)
  const selected = input.pickProviderModelFailoverTarget({
    providerId: current.providerId,
    models,
    desiredModel: current.model,
    exclude: attemptedValues(state.triedProviderModels, current.providerId),
    fallbackModel: input.recovery.frozenRetry?.effectivePolicy.selection.kind === 'preferred' ? undefined : input.settings.fallbackModel,
    failure
  })
  if (!selected) return undefined
  let target: AnthropicMessagesTarget
  try {
    target = input.resolveTarget({ providerId: current.providerId, model: selected.model })
    assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, input.settings.routingExpertPolicy)
    assertRecoveryTarget(input, target)
  } catch {
    return undefined
  }
  if (input.recovery.frozenRetry && !frozenRetryAllows({ recovery: input.recovery, providerId: target.providerId, model: target.model, protocol: recoveryProtocol(input), attempt: state.attempts + 1, refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })) return undefined
  const triedModels = attemptedValues(state.triedProviderModels, current.providerId)
  if (target.model === current.model || triedModels.has(target.model)) return undefined
  rememberAnthropicRecoveryTarget(state, target)
  if (input.meta.model !== AUTO_MODEL) input.meta.model = target.model
  const routeReason = [failure.label, selected.preference].filter(Boolean).join(' / ')
  return {
    target,
    routeReason,
    metaChanged: true,
    event: {
      kind: 'provider-model-failover',
      providerId: target.providerId,
      providerName: target.providerName,
      fromModel: current.model,
      toModel: target.model,
      reason: routeReason
    }
  }
}

function recoverProvider(input: AnthropicRecoveryInput): AnthropicRecoveryResult | undefined {
  const { current, failure, providers, state } = input
  if (!failure.switchable) return undefined
  const candidates = providers
    .filter((provider) => provider.engine === (input.engineKind ?? 'anthropic') && provider.hasToken)
    .filter((provider) => recoveryProviderAllowed(input, provider))
    .filter((provider) => providerAllowedByOutboundContext(
      input.outboundContext,
      provider,
      current.model
    ))
    .map((provider) => ({ id: provider.id, name: provider.name, models: resolvableModels(input, provider) }))
    .filter((provider) => provider.models.length > 0)
  const selected = input.pickFailoverTarget({
    candidates,
    exclude: state.triedProviders,
    desiredModel: current.model,
    fallbackProviderId: input.recovery.frozenRetry?.effectivePolicy.selection.kind === 'preferred' ? undefined : input.settings.fallbackProviderId,
    fallbackModel: input.recovery.frozenRetry?.effectivePolicy.selection.kind === 'preferred' ? undefined : input.settings.fallbackModel
  })
  if (!selected || state.triedProviders.has(selected.providerId)) return undefined
  state.triedProviders.add(selected.providerId)
  let target: AnthropicMessagesTarget
  try {
    target = input.resolveTarget({ providerId: selected.providerId, model: selected.model })
    assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, input.settings.routingExpertPolicy)
    assertRecoveryTarget(input, target)
  } catch {
    return undefined
  }
  if (input.recovery.frozenRetry && !frozenRetryAllows({ recovery: input.recovery, providerId: target.providerId, model: target.model, protocol: recoveryProtocol(input), attempt: state.attempts + 1, refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })) return undefined
  input.meta.providerId = target.providerId
  if (input.meta.model !== AUTO_MODEL) input.meta.model = target.model
  rememberAnthropicRecoveryTarget(state, target)
  const routeReason = [failure.label, selected.preference].filter(Boolean).join(' / ')
  return {
    target,
    routeReason,
    metaChanged: true,
    event: {
      kind: 'failover',
      fromProviderId: current.providerId,
      toProviderId: target.providerId,
      fromName: current.providerName,
      toName: target.providerName,
      model: target.model,
      reason: routeReason
    }
  }
}

function resolvableModels(input: AnthropicRecoveryInput, provider: ProviderView): string[] {
  return filterNativeRecoveryModels({ ...input.recovery, provider })
    .map((model) => {
      try {
        return input.resolveTarget({ providerId: provider.id, model }).model
      } catch {
        return ''
      }
    })
    .filter((model) => model && providerAllowedByOutboundContext(input.outboundContext, provider, model)
      && evaluateNativeRecoveryTarget({ ...input.recovery, provider, model }).allowed
      && (!input.recovery.frozenRetry || frozenRetryAllows({ recovery: input.recovery, providerId: provider.id,
        model, protocol: recoveryProtocol(input), attempt: input.state.attempts + 1,
        refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })))
}

function recoveryProtocol(input: Pick<AnthropicRecoveryInput, 'engineKind'>): 'anthropic.messages' | 'google.generative-language' {
  return input.engineKind === 'gemini' ? 'google.generative-language' : 'anthropic.messages'
}

function assertRecoveryTarget(input: AnthropicRecoveryInput, target: AnthropicMessagesTarget): void {
  assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, input.recovery.initialExpertPolicy)
  const provider = input.providers.find((item) => item.id === target.providerId)
  if (!provider) throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '故障备用连接已不存在。')
  assertNativeRecoveryTargetAllowed({ ...input.recovery, provider, model: target.model })
}

function recoveryProviderAllowed(input: AnthropicRecoveryInput, provider: ProviderView): boolean {
  return providerAllowedByRoutingExpertPolicy(provider, input.settings.routingExpertPolicy)
    && providerAllowedByRoutingExpertPolicy(provider, input.recovery.initialExpertPolicy)
}

function attemptedValues(store: Map<string, Set<string>>, providerId: string): Set<string> {
  let values = store.get(providerId)
  if (!values) {
    values = new Set()
    store.set(providerId, values)
  }
  return values
}
