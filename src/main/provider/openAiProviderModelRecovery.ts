import type { OutboundContextManifest, RoutingExpertPolicy } from '../../shared/types'
import { getProvider, listProviders, providerIsReady } from '../providers'
import { providerAllowedByRoutingExpertPolicy } from '../model/routing-expert-policy'
import { providerAllowedByOutboundContext } from '../project-workspace/outbound-context-policy'
import { resolveOpenAIProtocol, resolveProviderRuntimeTarget } from './providerRuntimeTarget'
import { pickFailoverTarget, pickProviderModelFailoverTarget, type FailureClass } from '../scheduler'
import type { OpenAIProtocol } from '../../shared/types'
import { synchronizeProviderReliabilityPolicies } from '../providerHealth'
import { evaluateNativeRecoveryTarget } from '../model/native-recovery-eligibility'
import { frozenRetryAllows, type NativeSessionRecoveryContext } from '../model/native-recovery-session'
import type { RoutingRetryReason } from '../../shared/routing-policy-types'

export interface OpenAiProviderModelRecoveryPlan {
  providerId: string
  providerName: string
  fromModel: string
  toModel: string
  routeReason: string
}

export interface OpenAiProviderFailoverPlan {
  providerId: string
  name: string
  model?: string
  fromName: string
  routeReason: string
}

export interface OpenAiProtocolRecoveryPlan {
  providerId: string
  providerName: string
  model: string
  fromProtocol: 'responses'
  toProtocol: 'chat'
  routeReason: string
}

export class OpenAiRecoveryState {
  readonly providers: Set<string>
  readonly keys = new Set<string>()
  private readonly modelsByProvider = new Map<string, Set<string>>()
  private attempts = 0

  constructor(activeProviderId?: string) {
    this.providers = new Set(activeProviderId ? [activeProviderId] : [])
  }

  models(providerId: string): Set<string> {
    let models = this.modelsByProvider.get(providerId)
    if (!models) {
      models = new Set()
      this.modelsByProvider.set(providerId, models)
    }
    return models
  }

  canRecover(providerId: string | undefined, globalEnabled: boolean, recovery?: NativeSessionRecoveryContext, nativeRetryReason?: RoutingRetryReason): boolean {
    const reliability = providerId ? getProvider(providerId)?.advancedConfig?.reliability : undefined
    return this.isEnabled(providerId, globalEnabled)
      && (!recovery?.frozenRetry || Boolean(nativeRetryReason))
      && (!recovery?.frozenRetry || (
        recovery.frozenRetry.effectivePolicy.failure.kind === 'pause'
          ? false
          : this.attempts < recovery.frozenRetry.effectivePolicy.failure.maxAdditionalAttempts
      ))
      && (reliability?.maxRetries === undefined || this.attempts < reliability.maxRetries)
  }

  isEnabled(providerId: string | undefined, globalEnabled: boolean): boolean {
    return providerId
      ? getProvider(providerId)?.advancedConfig?.reliability?.failoverEnabled ?? globalEnabled
      : globalEnabled
  }

  recordRecovery(): void {
    this.attempts += 1
  }

  get recoveryAttempts(): number { return this.attempts }
}

export async function firstSuccessfulRecovery(
  ...recoveries: Array<() => Promise<boolean>>
): Promise<boolean> {
  for (const recover of recoveries) if (await recover()) return true
  return false
}

export function planOpenAiProviderModelRecovery(input: {
  recovery: NativeSessionRecoveryContext
  providerId: string
  fromModel: string
  fallbackModel?: string
  failure: FailureClass
  exclude: ReadonlySet<string>
  outboundContext?: OutboundContextManifest
  routingExpertPolicy?: RoutingExpertPolicy
  nativeRetryReason?: RoutingRetryReason
  attempt?: number
}): OpenAiProviderModelRecoveryPlan | null {
  const provider = getProvider(input.providerId)
  const providerView = listProviders().find((candidate) => candidate.id === input.providerId)
  if (!provider || providerView?.engine !== 'openai' || !providerIsReady(provider)) return null
  if (input.recovery.frozenRetry && !frozenRetryAllows({ recovery: input.recovery, providerId: input.providerId, model: input.fromModel, protocol: resolveOpenAIProtocol(resolveProviderRuntimeTarget(provider, { appId: 'openai', model: input.fromModel })) === 'responses' ? 'openai.responses' : 'openai.chat-completions', attempt: input.attempt ?? 1, refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })) return null
  const models = [...new Set(provider.models.map((model) =>
    resolveProviderRuntimeTarget(provider, { appId: 'openai', model }).model
  ))].filter((model) => {
    const target = resolveProviderRuntimeTarget(provider, { appId: 'openai', model })
    return (!input.routingExpertPolicy || providerAllowedByRoutingExpertPolicy(providerView, input.routingExpertPolicy, target))
      && providerAllowedByRoutingExpertPolicy(providerView, input.recovery.initialExpertPolicy, target)
      && providerAllowedByOutboundContext(input.outboundContext, providerView, model)
      && evaluateNativeRecoveryTarget({ ...input.recovery, provider: providerView, model }).allowed
      && (!input.recovery.frozenRetry || frozenRetryAllows({ recovery: input.recovery, providerId: input.providerId,
        model, protocol: resolveOpenAIProtocol(target) === 'responses' ? 'openai.responses' : 'openai.chat-completions',
        attempt: input.attempt ?? 1, refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined }))
  })
  const target = pickProviderModelFailoverTarget({
    providerId: input.providerId,
    models,
    desiredModel: input.fromModel,
    exclude: input.exclude,
    fallbackModel: input.recovery.frozenRetry?.effectivePolicy.selection.kind === 'preferred' ? undefined : input.fallbackModel,
    failure: input.failure
  })
  if (!target) return null
  const targetRuntime = resolveProviderRuntimeTarget(provider, { appId: 'openai', model: target.model })
  if ((input.routingExpertPolicy && !providerAllowedByRoutingExpertPolicy(providerView, input.routingExpertPolicy, targetRuntime))
    || !providerAllowedByRoutingExpertPolicy(providerView, input.recovery.initialExpertPolicy, targetRuntime)) return null
  if (input.recovery.frozenRetry && (!targetRuntime || !frozenRetryAllows({ recovery: input.recovery, providerId: input.providerId, model: target.model, protocol: resolveOpenAIProtocol(targetRuntime) === 'responses' ? 'openai.responses' : 'openai.chat-completions', attempt: input.attempt ?? 1, refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined }))) return null
  return {
    providerId: input.providerId,
    providerName: providerView.name,
    fromModel: input.fromModel,
    toModel: target.model,
    routeReason: [input.failure.label, target.preference].filter(Boolean).join(' / ')
  }
}

export function planOpenAiProviderFailover(input: {
  recovery: NativeSessionRecoveryContext
  currentProviderId: string
  currentModel: string
  fallbackProviderId?: string
  fallbackModel?: string
  failure: FailureClass
  currentProtocol: OpenAIProtocol
  exclude: Set<string>
  outboundContext?: OutboundContextManifest
  routingExpertPolicy?: RoutingExpertPolicy
  nativeRetryReason?: RoutingRetryReason
  attempt?: number
}): OpenAiProviderFailoverPlan | null {
  if (!input.failure.switchable) return null
  if (input.recovery.frozenRetry && !input.nativeRetryReason) return null
  const providers = listProviders()
  synchronizeProviderReliabilityPolicies(providers)
  const candidates = providers
    .filter((provider) => provider.engine === 'openai' && provider.baseUrl.trim() && providerIsReady(provider))
    .map((provider) => {
      const sourceModels = provider.models.length > 0 ? provider.models : [input.currentModel]
      const models = [...new Set(sourceModels.flatMap((model) => {
        try {
          const target = resolveProviderRuntimeTarget(provider, { appId: 'openai', model })
          if (resolveOpenAIProtocol(target) !== input.currentProtocol) return []
          if (input.routingExpertPolicy && !providerAllowedByRoutingExpertPolicy(provider, input.routingExpertPolicy, target)) return []
          if (!providerAllowedByRoutingExpertPolicy(provider, input.recovery.initialExpertPolicy, target)) return []
          if (!providerAllowedByOutboundContext(input.outboundContext, provider, target.model)) return []
          if (!evaluateNativeRecoveryTarget({ ...input.recovery, provider, model: target.model }).allowed) return []
          if (input.recovery.frozenRetry && !frozenRetryAllows({ recovery: input.recovery, providerId: provider.id, model: target.model,
            protocol: resolveOpenAIProtocol(target) === 'responses' ? 'openai.responses' : 'openai.chat-completions', attempt: input.attempt ?? 1,
            refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })) return []
          return target.model ? [target.model] : []
        } catch {
          return []
        }
      }))]
      return { id: provider.id, name: provider.name, models }
    })
    .filter((provider) => provider.models.length > 0)
  const target = pickFailoverTarget({
    candidates,
    exclude: input.exclude,
    desiredModel: input.currentModel,
    fallbackProviderId: input.recovery.frozenRetry?.effectivePolicy.selection.kind === 'preferred' ? undefined : input.fallbackProviderId,
    fallbackModel: input.recovery.frozenRetry?.effectivePolicy.selection.kind === 'preferred' ? undefined : input.fallbackModel
  })
  const selectedProvider = target && providers.find((provider) => provider.id === target.providerId)
  if (!target?.model || !selectedProvider || !evaluateNativeRecoveryTarget({ ...input.recovery, provider: selectedProvider, model: target.model }).allowed) return null
  const targetRuntime = resolveProviderRuntimeTarget(selectedProvider, { appId: 'openai', model: target.model })
  if ((input.routingExpertPolicy && !providerAllowedByRoutingExpertPolicy(selectedProvider, input.routingExpertPolicy, targetRuntime))
    || !providerAllowedByRoutingExpertPolicy(selectedProvider, input.recovery.initialExpertPolicy, targetRuntime)) return null
  if (input.recovery.frozenRetry && !frozenRetryAllows({ recovery: input.recovery, providerId: target.providerId, model: target.model, protocol: resolveOpenAIProtocol(targetRuntime) === 'responses' ? 'openai.responses' : 'openai.chat-completions', attempt: input.attempt ?? 1, refusal: { outcome: input.nativeRetryReason! } })) return null
  return {
    ...target,
    fromName: providers.find((provider) => provider.id === input.currentProviderId)?.name ??
      input.currentProviderId ?? 'Current Provider',
    routeReason: [input.failure.label, target.preference].filter(Boolean).join(' / ')
  }
}

export function planOpenAiProtocolRecovery(input: {
  recovery?: NativeSessionRecoveryContext
  providerId: string
  model: string
  currentProtocol: OpenAIProtocol
  failure: FailureClass
  routingExpertPolicy?: RoutingExpertPolicy
  nativeRetryReason?: RoutingRetryReason
  attempt?: number
}): OpenAiProtocolRecoveryPlan | null {
  if (input.currentProtocol !== 'responses' || input.failure.kind !== 'protocol_unavailable') return null
  const provider = getProvider(input.providerId)
  const providerView = listProviders().find((candidate) => candidate.id === input.providerId)
  if (!provider || providerView?.engine !== 'openai' || !providerIsReady(provider)) return null
  const target = resolveProviderRuntimeTarget(provider, { appId: 'openai', model: input.model })
  if (resolveOpenAIProtocol(target) !== 'responses') return null
  if (input.routingExpertPolicy && !providerAllowedByRoutingExpertPolicy(providerView, input.routingExpertPolicy, target)) return null
  if (input.recovery && !providerAllowedByRoutingExpertPolicy(providerView, input.recovery.initialExpertPolicy, target)) return null
  if (input.recovery && !frozenRetryAllows({ recovery: input.recovery, providerId: input.providerId, model: target.model || input.model, protocol: 'openai.chat-completions', attempt: input.attempt ?? 1, refusal: input.nativeRetryReason ? { outcome: input.nativeRetryReason } : undefined })) return null
  return {
    providerId: input.providerId,
    providerName: providerView.name,
    model: target.model || input.model,
    fromProtocol: 'responses',
    toProtocol: 'chat',
    routeReason: `${input.failure.label} / Responses → Chat Completions`
  }
}
