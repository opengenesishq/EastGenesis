import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type {
  ProviderUsageAggregate,
  ProviderUsageBucket,
  ProviderUsageCostSource,
  ProviderUsageCostSourceSummary,
  ProviderUsageCredentialAggregate,
  ProviderUsageModelAggregate,
  ProviderUsageQuery,
  ProviderUsageRequest,
  ProviderUsageSummary,
  ResolvedImportedProviderUsageRollup
} from '../../shared/provider-usage-types'
import type { ProviderView } from '../../shared/types'
import { looksLikeProviderCredentialValue } from '../providerCredentialBroker'
import { builtinOpenAiPricingForModel, estimateProviderCostUsd, providerPricingForModel } from './providerAdvancedConfig'
import { credentialFingerprint } from './providerCredentialIdentity'

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_USAGE_ROWS = 10_000

type UsageProvider = Pick<ProviderView, 'id' | 'name' | 'advancedConfig' | 'apiKeys'>

export function summarizeProviderUsage(
  attempts: ModelAttemptRecord[],
  providers: UsageProvider[],
  query: ProviderUsageQuery = {},
  now = Date.now(),
  imported: ResolvedImportedProviderUsageRollup[] = [],
  truncated = false
): ProviderUsageSummary {
  const from = validTimestamp(query.from) ?? now - DEFAULT_WINDOW_MS
  const to = validTimestamp(query.to) ?? now
  if (to < from) throw new Error('Provider usage time range is invalid')
  const providerFilter = query.providerId?.trim()
  const modelFilter = query.model?.trim().toLowerCase()
  const keyLabelFilter = query.keyLabel?.trim().toLowerCase()
  const sourceFilter = query.source?.trim().toLowerCase()
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]))
  const filters = { from, to, providerFilter, modelFilter, keyLabelFilter, sourceFilter }
  const requests = attempts
    .filter((attempt) => matchesUsageFilters(attempt, filters))
    .map((attempt) => toUsageRequest(attempt, providerMap.get(attempt.providerId)))
    .sort((left, right) => right.startedAt - left.startedAt)
  const historical = imported.filter((rollup) => matchesImportedFilters(rollup, filters))
  const recentOffset = normalizeOffset(query.offset, requests.length)
  const recentLimit = normalizeLimit(query.limit)
  return {
    ...summarize(requests, historical, providerMap, from, to, normalizeBucketCount(query.bucketCount)),
    from,
    to,
    truncated,
    recentOffset,
    recentTotal: requests.length,
    recentHasMore: recentOffset + recentLimit < requests.length,
    recentRequests: requests.slice(recentOffset, recentOffset + recentLimit)
  }
}

function matchesImportedFilters(
  rollup: ResolvedImportedProviderUsageRollup,
  filters: {
    from: number
    to: number
    providerFilter?: string
    modelFilter?: string
    keyLabelFilter?: string
    sourceFilter?: string
  }
): boolean {
  const dayEnd = rollup.dayStartedAt + 24 * 60 * 60 * 1000
  return rollup.dayStartedAt <= filters.to
    && dayEnd > filters.from
    && (!filters.providerFilter || rollup.providerId === filters.providerFilter)
    && (!filters.modelFilter || rollup.model.toLowerCase() === filters.modelFilter)
    && !filters.keyLabelFilter
    && (!filters.sourceFilter || rollup.source.toLowerCase() === filters.sourceFilter)
}

function matchesUsageFilters(
  attempt: ModelAttemptRecord,
  filters: {
    from: number
    to: number
    providerFilter?: string
    modelFilter?: string
    keyLabelFilter?: string
    sourceFilter?: string
  }
): boolean {
  return attempt.startedAt >= filters.from
    && attempt.startedAt <= filters.to
    && (!filters.providerFilter || attempt.providerId === filters.providerFilter)
    && (!filters.modelFilter || attempt.model.toLowerCase() === filters.modelFilter)
    && (!filters.keyLabelFilter || attempt.keyLabel?.toLowerCase() === filters.keyLabelFilter)
    && (!filters.sourceFilter || attempt.protocol.toLowerCase() === filters.sourceFilter)
}

function toUsageRequest(
  attempt: ModelAttemptRecord,
  provider: UsageProvider | undefined
): ProviderUsageRequest {
  const usage = attempt.usage
  const reported = typeof attempt.costUsd === 'number' && Number.isFinite(attempt.costUsd) && attempt.costUsd >= 0
    ? attempt.costUsd
    : undefined
  const configuredPricing = providerPricingForModel(provider?.advancedConfig, attempt.model)
  const pricing = configuredPricing
    ?? (attempt.protocol.startsWith('openai.') ? builtinOpenAiPricingForModel(attempt.model) : undefined)
  const priced = reported === undefined && usage
    ? estimateProviderCostUsd(pricing, {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheCreation: usage.cacheWriteTokens ?? 0
      })
    : undefined
  const costUsd = reported ?? priced
  return {
    attemptId: attempt.id,
    providerId: attempt.providerId,
    model: attempt.model,
    keyLabel: attempt.keyLabel,
    credentialName: credentialNameForAttempt(provider, attempt.keyLabel),
    source: attempt.protocol,
    status: attempt.status,
    outcome: attempt.outcome,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    latencyMs: attempt.latencyMs,
    usage,
    costUsd,
    costSource: reported !== undefined
      ? 'reported'
      : configuredPricing
        ? (priced === undefined ? 'unpriced' : 'provider-pricing')
        : priced === undefined ? 'unpriced' : 'builtin-pricing'
  }
}

function summarize(
  requests: ProviderUsageRequest[],
  historical: ResolvedImportedProviderUsageRollup[],
  providers: Map<string, UsageProvider>,
  from: number,
  to: number,
  bucketCount: number
): Omit<ProviderUsageSummary, 'from' | 'to' | 'truncated' | 'recentOffset' | 'recentTotal' | 'recentHasMore' | 'recentRequests'> {
  const providerAggregates = new Map<string, ProviderUsageAggregate>()
  const modelAggregates = new Map<string, ProviderUsageAggregate>()
  const providerModelAggregates = new Map<string, ProviderUsageModelAggregate>()
  const credentialAggregates = new Map<string, ProviderUsageCredentialAggregate>()
  const totals = emptyUsageTotals()
  for (const request of requests) {
    addUsageTotals(totals, request)
    addAggregate(providerAggregates, request.providerId, providers.get(request.providerId)?.name ?? request.providerId, request)
    addAggregate(modelAggregates, request.model, request.model, request)
    const providerModel = providerModelAggregate(providerModelAggregates, request.providerId, request.model,
      providers.get(request.providerId)?.name ?? request.providerId)
    addAggregateRecord(providerModel, request)
    addCredentialAggregate(credentialAggregates, request, providers.get(request.providerId)?.name ?? request.providerId)
  }
  for (const rollup of historical) {
    addRollupTotals(totals, rollup)
    addRollupAggregate(providerAggregates, rollup.providerId,
      providers.get(rollup.providerId)?.name ?? rollup.providerName, rollup)
    addRollupAggregate(modelAggregates, rollup.model, rollup.model, rollup)
    const providerModel = providerModelAggregate(providerModelAggregates, rollup.providerId, rollup.model,
      providers.get(rollup.providerId)?.name ?? rollup.providerName)
    addRollupRecord(providerModel, rollup)
  }
  const historicalRequests = historical.reduce((total, rollup) => total + rollup.requestCount, 0)
  return {
    requests: requests.length + historicalRequests,
    nativeRequests: requests.length,
    historicalRequests,
    succeeded: totals.succeeded,
    failed: totals.failed,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costUsd: round(totals.costUsd),
    averageLatencyMs: totals.latencySamples > 0 ? Math.round(totals.latencyMs / totals.latencySamples) : undefined,
    latencySamples: totals.latencySamples,
    pricedRequests: totals.pricedRequests,
    unpricedRequests: totals.unpricedRequests,
    costSources: summarizeCostSources(requests, historical),
    requestsByProvider: sortAggregates(providerAggregates),
    requestsByModel: sortAggregates(modelAggregates),
    requestsByProviderModel: sortAggregates(providerModelAggregates),
    requestsByCredential: sortAggregates(credentialAggregates),
    sources: [...new Set([
      ...requests.flatMap((request) => request.source ? [request.source] : []),
      ...historical.map((rollup) => rollup.source)
    ])].sort(),
    buckets: buildBuckets(requests, historical, from, to, bucketCount)
  }
}

function summarizeCostSources(
  requests: ProviderUsageRequest[],
  historical: ResolvedImportedProviderUsageRollup[]
): ProviderUsageCostSourceSummary[] {
  const order: ProviderUsageCostSource[] = [
    'reported',
    'provider-pricing',
    'builtin-pricing',
    'imported',
    'unpriced'
  ]
  const totals = new Map<ProviderUsageCostSource, ProviderUsageCostSourceSummary>(
    order.map((source) => [source, { source, requests: 0, costUsd: 0 }])
  )
  for (const request of requests) {
    const current = totals.get(request.costSource)
    if (!current) continue
    current.requests += 1
    current.costUsd += request.costUsd ?? 0
  }
  const imported = totals.get('imported')
  if (imported) {
    imported.requests = historical.reduce((total, rollup) => total + rollup.requestCount, 0)
    imported.costUsd = round(historical.reduce((total, rollup) => total + rollup.costUsd, 0))
  }
  return order.map((source) => totals.get(source)!).filter((item) => item.requests > 0)
    .map((item) => ({ ...item, costUsd: round(item.costUsd) }))
}

function emptyUsageTotals() {
  return {
    succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costUsd: 0, latencyMs: 0, latencySamples: 0, pricedRequests: 0, unpricedRequests: 0
  }
}

function addUsageTotals(totals: ReturnType<typeof emptyUsageTotals>, request: ProviderUsageRequest): void {
  if (request.status === 'succeeded') totals.succeeded += 1
  if (request.status === 'failed' || request.status === 'cancelled') totals.failed += 1
  totals.inputTokens += request.usage?.inputTokens ?? 0
  totals.outputTokens += request.usage?.outputTokens ?? 0
  totals.cacheReadTokens += request.usage?.cacheReadTokens ?? 0
  totals.cacheWriteTokens += request.usage?.cacheWriteTokens ?? 0
  if (typeof request.latencyMs === 'number' && Number.isFinite(request.latencyMs) && request.latencyMs >= 0) {
    totals.latencyMs += request.latencyMs
    totals.latencySamples += 1
  }
  if (request.costUsd === undefined) totals.unpricedRequests += 1
  else {
    totals.pricedRequests += 1
    totals.costUsd += request.costUsd
  }
}

function addRollupTotals(
  totals: ReturnType<typeof emptyUsageTotals>,
  rollup: ResolvedImportedProviderUsageRollup
): void {
  totals.succeeded += rollup.successCount
  totals.failed += rollup.requestCount - rollup.successCount
  totals.inputTokens += rollup.inputTokens
  totals.outputTokens += rollup.outputTokens
  totals.cacheReadTokens += rollup.cacheReadTokens
  totals.cacheWriteTokens += rollup.cacheWriteTokens
  totals.pricedRequests += rollup.requestCount
  totals.costUsd += rollup.costUsd
  if (rollup.averageLatencyMs !== undefined && rollup.requestCount > 0) {
    totals.latencyMs += rollup.averageLatencyMs * rollup.requestCount
    totals.latencySamples += rollup.requestCount
  }
}

function addCredentialAggregate(
  target: Map<string, ProviderUsageCredentialAggregate>,
  request: ProviderUsageRequest,
  providerName: string
): void {
  const identity = request.keyLabel ?? 'none'
  const id = `${request.providerId}:${identity}`
  const credential = request.credentialName ?? displayCredentialIdentity(request.keyLabel)
  const current = target.get(id) ?? {
    id,
    providerId: request.providerId,
    keyLabel: request.keyLabel,
    label: `${providerName} / ${credential}`,
    requests: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0, pricedRequests: 0, unpricedRequests: 0, costSources: []
  }
  addAggregateRecord(current, request)
  target.set(id, current)
}

function buildBuckets(
  requests: ProviderUsageRequest[],
  historical: ResolvedImportedProviderUsageRollup[],
  from: number,
  to: number,
  bucketCount: number
): ProviderUsageBucket[] {
  const span = Math.max(1, to - from)
  const bucketSize = span / bucketCount
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    from: Math.round(from + index * bucketSize),
    to: Math.round(index === bucketCount - 1 ? to : from + (index + 1) * bucketSize),
    requests: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }))
  for (const request of requests) {
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((request.startedAt - from) / bucketSize)))
    const bucket = buckets[index]
    bucket.requests += 1
    if (request.status === 'succeeded') bucket.succeeded += 1
    if (request.status === 'failed' || request.status === 'cancelled') bucket.failed += 1
    bucket.inputTokens += request.usage?.inputTokens ?? 0
    bucket.outputTokens += request.usage?.outputTokens ?? 0
    bucket.cacheReadTokens += request.usage?.cacheReadTokens ?? 0
    bucket.cacheWriteTokens += request.usage?.cacheWriteTokens ?? 0
    bucket.costUsd += request.costUsd ?? 0
  }
  for (const rollup of historical) {
    const at = Math.max(from, Math.min(to, rollup.dayStartedAt + 12 * 60 * 60 * 1000))
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((at - from) / bucketSize)))
    const bucket = buckets[index]
    bucket.requests += rollup.requestCount
    bucket.succeeded += rollup.successCount
    bucket.failed += rollup.requestCount - rollup.successCount
    bucket.inputTokens += rollup.inputTokens
    bucket.outputTokens += rollup.outputTokens
    bucket.cacheReadTokens += rollup.cacheReadTokens
    bucket.cacheWriteTokens += rollup.cacheWriteTokens
    bucket.costUsd += rollup.costUsd
  }
  return buckets.map((bucket) => ({ ...bucket, costUsd: round(bucket.costUsd) }))
}

function addAggregate(
  target: Map<string, ProviderUsageAggregate>,
  id: string,
  label: string,
  request: ProviderUsageRequest
): void {
  const current = target.get(id) ?? {
    id,
    label,
    requests: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0, pricedRequests: 0, unpricedRequests: 0, costSources: []
  }
  addAggregateRecord(current, request)
  target.set(id, current)
}

function addAggregateRecord(current: ProviderUsageAggregate, request: ProviderUsageRequest): void {
  current.requests += 1
  if (request.status === 'succeeded') current.succeeded += 1
  if (request.status === 'failed' || request.status === 'cancelled') current.failed += 1
  current.inputTokens += request.usage?.inputTokens ?? 0
  current.outputTokens += request.usage?.outputTokens ?? 0
  current.cacheReadTokens += request.usage?.cacheReadTokens ?? 0
  current.cacheWriteTokens += request.usage?.cacheWriteTokens ?? 0
  addAggregateCost(current, request.costSource, 1, request.costUsd)
}

function addRollupAggregate(
  target: Map<string, ProviderUsageAggregate>,
  id: string,
  label: string,
  rollup: ResolvedImportedProviderUsageRollup
): void {
  const current = target.get(id) ?? {
    id, label, requests: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, pricedRequests: 0, unpricedRequests: 0, costSources: []
  }
  addRollupRecord(current, rollup)
  target.set(id, current)
}

function addRollupRecord(current: ProviderUsageAggregate, rollup: ResolvedImportedProviderUsageRollup): void {
  current.requests += rollup.requestCount
  current.succeeded += rollup.successCount
  current.failed += rollup.requestCount - rollup.successCount
  current.inputTokens += rollup.inputTokens
  current.outputTokens += rollup.outputTokens
  current.cacheReadTokens += rollup.cacheReadTokens
  current.cacheWriteTokens += rollup.cacheWriteTokens
  addAggregateCost(current, 'imported', rollup.requestCount, rollup.costUsd)
}

function sortAggregates<T extends ProviderUsageAggregate>(values: Map<string, T>): T[] {
  return [...values.values()].sort((left, right) => right.costUsd - left.costUsd || right.requests - left.requests)
    .map((value) => ({ ...value, costUsd: round(value.costUsd),
      costSources: value.costSources.map((source) => ({ ...source, costUsd: round(source.costUsd) })) }))
}

function addAggregateCost(current: ProviderUsageAggregate, source: ProviderUsageCostSource, requests: number, costUsd: number | undefined): void {
  if (costUsd === undefined) current.unpricedRequests += requests
  else { current.pricedRequests += requests; current.costUsd += costUsd }
  let costSource = current.costSources.find((item) => item.source === source)
  if (!costSource) { costSource = { source, requests: 0, costUsd: 0 }; current.costSources.push(costSource) }
  costSource.requests += requests
  costSource.costUsd += costUsd ?? 0
}

function providerModelAggregate(target: Map<string, ProviderUsageModelAggregate>, providerId: string, model: string, providerName: string): ProviderUsageModelAggregate {
  const id = JSON.stringify([providerId, model])
  let current = target.get(id)
  if (!current) {
    current = { id, providerId, model, label: `${providerName} / ${model}`, requests: 0, succeeded: 0, failed: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
      pricedRequests: 0, unpricedRequests: 0, costSources: [] }
    target.set(id, current)
  }
  return current
}

function credentialNameForAttempt(provider: UsageProvider | undefined, keyLabel: string | undefined): string | undefined {
  if (!provider || !keyLabel) return undefined
  const key = provider.apiKeys?.find((candidate) => credentialFingerprint(provider.id, candidate.id) === keyLabel)
  return safeCredentialName(key?.label)
}

function safeCredentialName(value: string | undefined): string | undefined {
  const name = value?.trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return undefined
  if (looksLikeProviderCredentialValue(name) || /(?:token|secret|password|credential)\s*[:=]/i.test(name)) return undefined
  if (/^[A-Za-z0-9_./+=-]{32,}$/.test(name)) return undefined
  return name
}

function displayCredentialIdentity(keyLabel: string | undefined): string {
  if (!keyLabel) return 'No credential'
  if (keyLabel.startsWith('label:')) return keyLabel.slice('label:'.length)
  if (keyLabel.startsWith('sha256:')) return `SHA-256 ${keyLabel.slice(7, 15)}...${keyLabel.slice(-4)}`
  return 'Unknown credential'
}

function normalizeLimit(value: unknown): number {
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_USAGE_ROWS) : 100
}

function normalizeBucketCount(value: unknown): number {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 4 ? Math.min(count, 168) : 24
}

function normalizeOffset(value: unknown, total: number): number {
  const offset = Number(value)
  return Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, total) : 0
}

function validTimestamp(value: unknown): number | undefined {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
