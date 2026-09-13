import type { MediaCapability, MediaOperation, MediaProviderProfile } from './media-types'
import type { MediaAgentOrigin } from './media-agent-types'
import type { ProviderConnectionIdentity } from './provider-connection-identity'

export const MEDIA_AUTO_PROVIDER_ID = 'media-provider:auto'
export type MediaRoutingPreference = 'balanced' | 'quality' | 'speed' | 'cost'

export interface MediaExecutionTarget {
  baseUrl: string
  model: string
  protocol?: 'chat' | 'responses'
  endpointId?: string
  appBindingId?: string
  accountId?: string
  /** Main-owned opaque Provider connection generation captured before submission. */
  connectionIdentity?: ProviderConnectionIdentity
}

/** Immutable media route captured before the first billable submission (legacy digest). */
export interface MediaFrozenRouteV1 {
  schemaVersion: 1
  executionDomain: 'media'
  capability: MediaCapability
  operation: MediaOperation
  mediaProviderId: string
  providerId?: string
  model?: string
  /** Canonical business line that supplied the routing preference. Optional for legacy V1 records. */
  businessLineId?: string
  endpointClass: MediaProviderProfile['endpointClass']
  target?: MediaExecutionTarget
  decisionDigest: string
  frozenAt: number
}

/** Current frozen route. V2 covers the complete non-secret binding snapshot. */
export interface MediaFrozenRouteV2 extends Omit<MediaFrozenRouteV1, 'schemaVersion' | 'decisionDigest'> {
  schemaVersion: 2
  decisionDigest: string
}

export type MediaFrozenRoute = MediaFrozenRouteV1 | MediaFrozenRouteV2

/** Media charges use declared media units, never text token prices. */
export interface ProviderMediaPricing {
  currency: 'USD'
  unit: 'request' | 'second' | 'million-characters'
  amount: number
  source: 'user' | 'provider' | 'catalog'
  updatedAt?: number
}

export interface MediaRouteDecision {
  mode: 'auto' | 'fixed'
  strategy: MediaRoutingPreference
  mediaProviderId: string
  providerId?: string
  model?: string
  /** Canonical business line whose preference participated in this decision. */
  businessLineId?: string
  estimatedCostUsd?: number
  candidateCount: number
  reason: string
  considerations: string[]
  createdAt: number
}

/** Non-secret execution identity captured before any billable submission. */
export interface MediaExecutionBinding {
  budgetReservationId?: string
  agentOrigin?: MediaAgentOrigin
  requestDigest?: string
  contentDigest?: string
  credential?: { authMode: 'api-key' | 'none'; keyId?: string }
  /** Route selection and target are immutable after the first submission. */
  frozenRoute?: MediaFrozenRoute
  profile: MediaProviderProfile
  target?: MediaExecutionTarget
  decision: MediaRouteDecision
}

export function estimateMediaPrice(
  pricing: ProviderMediaPricing | undefined,
  input: { capability?: string; prompt?: string; parameters?: { durationSeconds?: number } }
): number | undefined {
  if (!pricing) return undefined
  if (pricing.unit === 'request') return pricing.amount
  if (pricing.unit === 'second') {
    // Speech duration is not known before synthesis; never assume five seconds.
    if (input.capability !== 'video') return undefined
    const duration = input.parameters?.durationSeconds
    return pricing.amount * (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= 3600 ? duration : 5)
  }
  return pricing.amount * Array.from(input.prompt ?? '').length / 1_000_000
}
