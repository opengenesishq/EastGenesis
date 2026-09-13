import type {
  ProviderEndpointProfile,
  ProviderModelProfile,
  ProviderView
} from './types'
import {
  PROVIDER_MODEL_CAPABILITIES,
  hasDeclaredProviderModelCapability,
  type ProviderModelCapability
} from './provider-model-capability-summary'

/**
 * Evidence state for a capability card. A declaration is configuration input;
 * it becomes verified only after the bounded generation probe has validated the
 * response envelope. Missing evidence stays explicitly unknown.
 */
export type ProviderCapabilityCardState = 'verified' | 'declared' | 'unknown'
export type ProviderCapabilityVerificationState = 'verified' | 'failed' | 'unknown'

export interface ProviderCapabilityCardEndpoint {
  id: string
  protocol?: ProviderEndpointProfile['protocol']
  region?: string
  domain?: string
  permissionTags?: string[]
}

export interface ProviderCapabilityCard {
  schemaVersion: 1
  capabilityId: string
  providerId: string
  model: string
  /** Wire/runtime protocol identities available from the saved Provider config. */
  protocols: string[]
  contextWindow?: number
  /** Canonical capability buckets derived from the model declaration. */
  declaredCapabilities: ProviderModelCapability[]
  /**
   * The probe verifies generation for the model/protocol. It does not prove
   * every declared modality, so this list is intentionally scoped to text
   * generation rather than copied from declaredCapabilities.
   */
  verifiedCapabilities: ProviderModelCapability[]
  evidence: {
    state: ProviderCapabilityCardState
    verification: {
      state: ProviderCapabilityVerificationState
      scope: 'generation'
      protocol?: string
      verifiedAt?: number
    }
  }
  endpoints: ProviderCapabilityCardEndpoint[]
  pricing: {
    state: 'declared' | 'unknown'
    source?: string
    inputPerMillion?: number
    outputPerMillion?: number
    updatedAt?: number
  }
  /** Availability is derived from ProviderView.ready; it is not a health claim. */
  availability: 'available' | 'unavailable'
  observedAt?: number
}

/** Build a non-secret, read-only capability projection from saved Provider data. */
export function buildProviderCapabilityCard(
  provider: Pick<ProviderView, 'id' | 'engine' | 'openaiProtocol' | 'ready' | 'advancedConfig'>,
  profile: ProviderModelProfile
): ProviderCapabilityCard {
  const verification = profile.verification
  const verificationState: ProviderCapabilityVerificationState = verification
    ? verification.generation === 'passed' && verification.responseValidation === 'protocol-json-v1'
      ? 'verified'
      : verification.generation === 'failed' ? 'failed' : 'unknown'
    : 'unknown'
  const declaredCapabilities = PROVIDER_MODEL_CAPABILITIES.filter((capability) =>
    hasDeclaredProviderModelCapability(profile, capability)
  )
  const state: ProviderCapabilityCardState = verificationState === 'verified'
    ? 'verified'
    : declaredCapabilities.length > 0 ? 'declared' : 'unknown'
  const endpoints = (provider.advancedConfig?.endpoints ?? []).map(endpointCard)
  const protocols = protocolIdentities(provider.engine, provider.openaiProtocol, endpoints)
  const pricing = profile.pricing
  return {
    schemaVersion: 1,
    capabilityId: `provider-capability:${provider.id}:${profile.model}`,
    providerId: provider.id,
    model: profile.model,
    protocols,
    ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
    declaredCapabilities,
    // A successful generation probe proves text generation only. Keep vision,
    // image, video and audio declarations in the declared/unknown state until
    // a capability-specific verifier exists.
    verifiedCapabilities: verificationState === 'verified' ? ['text'] : [],
    evidence: {
      state,
      verification: {
        state: verificationState,
        scope: 'generation',
        ...(verification?.protocol ? { protocol: verification.protocol } : {}),
        ...(verification?.verifiedAt !== undefined ? { verifiedAt: verification.verifiedAt } : {})
      }
    },
    endpoints,
    pricing: pricing && validPricing(pricing)
      ? {
          state: 'declared',
          source: pricing.source,
          inputPerMillion: pricing.inputPerMillion,
          outputPerMillion: pricing.outputPerMillion,
          ...(pricing.updatedAt !== undefined ? { updatedAt: pricing.updatedAt } : {})
        }
      : { state: 'unknown' },
    availability: provider.ready ? 'available' : 'unavailable',
    ...(verification?.verifiedAt !== undefined ? { observedAt: verification.verifiedAt } : {})
  }
}

function endpointCard(endpoint: ProviderEndpointProfile): ProviderCapabilityCardEndpoint {
  return {
    id: endpoint.id,
    ...(endpoint.protocol ? { protocol: endpoint.protocol } : {}),
    ...(endpoint.region ? { region: endpoint.region } : {}),
    ...(endpoint.domain ? { domain: endpoint.domain } : {}),
    ...(endpoint.permissionTags?.length ? { permissionTags: [...endpoint.permissionTags] } : {})
  }
}

function protocolIdentities(
  engine: ProviderView['engine'],
  openaiProtocol: ProviderView['openaiProtocol'],
  endpoints: ProviderCapabilityCardEndpoint[]
): string[] {
  const values = new Set<string>()
  if (engine === 'anthropic') values.add('anthropic-messages')
  if (engine === 'gemini') values.add('google-generative-language')
  if (engine === 'openai') values.add(openaiProtocol === 'responses' ? 'openai-responses' : 'openai-chat-completions')
  for (const endpoint of endpoints) {
    if (endpoint.protocol === 'responses') values.add('openai-responses')
    if (endpoint.protocol === 'chat') values.add('openai-chat-completions')
  }
  return [...values].sort()
}

function validPricing(pricing: NonNullable<ProviderModelProfile['pricing']>): boolean {
  return Number.isFinite(pricing.inputPerMillion) && pricing.inputPerMillion >= 0
    && Number.isFinite(pricing.outputPerMillion) && pricing.outputPerMillion >= 0
}
