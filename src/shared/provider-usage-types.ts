import type { ModelAttemptOutcome, ModelAttemptStatus, ModelAttemptUsage } from './model-attempt-types'

export interface ProviderUsageQuery {
  from?: number
  to?: number
  providerId?: string
  model?: string
  /** Canonical label:<id> or sha256:<digest>; never a credential value. */
  keyLabel?: string
  /** Sanitized request protocol/adapter identifier. */
  source?: string
  limit?: number
  offset?: number
  /** Number of time buckets returned for the trend chart. */
  bucketCount?: number
}

export interface ImportedProviderUsageRollup {
  sourceProviderId: string
  providerName: string
  source: string
  model: string
  dayStartedAt: number
  requestCount: number
  successCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  averageLatencyMs?: number
}

export interface ResolvedImportedProviderUsageRollup extends ImportedProviderUsageRollup {
  providerId: string
}

export interface ProviderUsageRequest {
  attemptId: string
  providerId: string
  model: string
  /** Canonical label:<id> or sha256:<digest>; never a credential value. */
  keyLabel?: string
  /** Optional user-facing name resolved from saved non-secret Provider metadata. */
  credentialName?: string
  /** Sanitized protocol/adapter source; never contains request content or credentials. */
  source?: string
  status: ModelAttemptStatus
  outcome?: ModelAttemptOutcome
  startedAt: number
  completedAt?: number
  latencyMs?: number
  usage?: ModelAttemptUsage
  costUsd?: number
  costSource: 'reported' | 'provider-pricing' | 'builtin-pricing' | 'unpriced'
}

export type ProviderUsageCostSource = ProviderUsageRequest['costSource'] | 'imported'

export interface ProviderUsageCostSourceSummary {
  source: ProviderUsageCostSource
  requests: number
  costUsd: number
}

export interface ProviderUsageAggregate {
  id: string
  label: string
  requests: number
  succeeded: number
  failed: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  /** Cost is a partial total when unpricedRequests is nonzero; zero is not proof of free usage. */
  pricedRequests: number
  unpricedRequests: number
  costSources: ProviderUsageCostSourceSummary[]
}

export interface ProviderUsageModelAggregate extends ProviderUsageAggregate {
  providerId: string
  model: string
}

export interface ProviderUsageCredentialAggregate extends ProviderUsageAggregate {
  providerId: string
  /** Missing for local/no-auth requests and historical attempts without an identity. */
  keyLabel?: string
}

export interface ProviderUsageBucket {
  from: number
  to: number
  requests: number
  succeeded: number
  failed: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface ProviderUsageSummary {
  from: number
  to: number
  /** True when the persisted attempt scan reached its safety limit before exhausting the ledger. */
  truncated: boolean
  requests: number
  nativeRequests: number
  historicalRequests: number
  succeeded: number
  failed: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  averageLatencyMs?: number
  latencySamples: number
  pricedRequests: number
  unpricedRequests: number
  costSources: ProviderUsageCostSourceSummary[]
  requestsByProvider: ProviderUsageAggregate[]
  requestsByModel: ProviderUsageAggregate[]
  /** Connection/model pairs, retaining separate costs for same-named models. */
  requestsByProviderModel: ProviderUsageModelAggregate[]
  requestsByCredential: ProviderUsageCredentialAggregate[]
  sources: string[]
  buckets: ProviderUsageBucket[]
  recentOffset: number
  recentTotal: number
  recentHasMore: boolean
  recentRequests: ProviderUsageRequest[]
}
