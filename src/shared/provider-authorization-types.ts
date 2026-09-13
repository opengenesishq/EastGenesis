import type { ProviderCredentialRoutingMode, ProviderCredentialStorage, ProviderView } from './types'

export type ProviderAuthorizationService = 'xai-oauth'

export type ProviderAuthorizationMethod = 'api-key' | 'oauth' | 'device-code' | 'none'
export type ProviderAuthorizationStatus = 'unconfigured' | 'authorized' | 'expired' | 'revoked' | 'error'

export interface ProviderAuthorization {
  schemaVersion: 1
  method: ProviderAuthorizationMethod
  status: ProviderAuthorizationStatus
  provider?: ProviderAuthorizationService
  accountId?: string
  accountLabel?: string
  expiresAt?: number
  lastAuthenticatedAt?: number
  lastErrorCode?: string
  accountRoutingMode?: ProviderCredentialRoutingMode
}

export interface ProviderAuthorizationAccountPolicy {
  enabled: boolean
  /** Lower values are selected first. */
  priority: number
  /** A zero reserve disables the remaining-quota constraint. */
  minimumQuotaRemainingPercent: number
  /** Block this account when no current quota observation is available. */
  requireKnownQuota: boolean
  failureCooldownMinutes: number
}

export interface ProviderAuthorizationAccountPolicyUpdate {
  accountId: string
  policy: Partial<ProviderAuthorizationAccountPolicy>
}

export type ProviderAuthorizationMutation =
  | { kind: 'routing-mode'; mode: ProviderCredentialRoutingMode }
  | { kind: 'account-policy'; policy: Partial<ProviderAuthorizationAccountPolicy> }

export type ProviderAuthorizationAccountRoutingState = 'selected' | 'available' | 'blocked'

export interface ProviderAuthorizationAccountView {
  id: string
  providerId: string
  service: ProviderAuthorizationService
  label: string
  authenticatedAt: number
  updatedAt: number
  bound: boolean
  requiresReauth: boolean
  credentialStorage: ProviderCredentialStorage
  policy: ProviderAuthorizationAccountPolicy
  lastFailureAt?: number
  /** Last non-secret quota observation, persisted across restarts. */
  lastQuota?: ProviderAuthorizationQuotaView
  quota?: ProviderAuthorizationQuotaView
  routingState?: ProviderAuthorizationAccountRoutingState
  routingReason?: string
}

export interface ProviderAuthorizationRoutingUpdate {
  mode: ProviderCredentialRoutingMode
}

export interface ProviderDeviceAuthorizationView {
  flowId: string
  providerId: string
  service: ProviderAuthorizationService
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalSeconds: number
}

export interface ProviderQuickDeviceAuthorizationView {
  flowId: string
  service: ProviderAuthorizationService
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalSeconds: number
}

export type ProviderAuthorizationPollResult =
  | { status: 'pending'; nextPollAt: number }
  | { status: 'authorized'; account: ProviderAuthorizationAccountView; provider: ProviderView }

export type ProviderQuickAuthorizationPollResult = ProviderAuthorizationPollResult

export type ProviderAuthorizationQuotaStatus = 'ready' | 'expired' | 'unavailable'

export interface ProviderAuthorizationQuotaTierView {
  name: string
  utilization: number
  windowSeconds?: number
  resetsAt?: number
}

export interface ProviderAuthorizationQuotaView {
  providerId: string
  accountId: string
  status: ProviderAuthorizationQuotaStatus
  tiers: ProviderAuthorizationQuotaTierView[]
  queriedAt: number
  errorCode?: string
}
