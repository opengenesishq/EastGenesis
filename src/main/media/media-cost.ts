import { MEDIA_SCHEMA_VERSION, type MediaCostRecord, type MediaProviderProfile } from '../../shared/media-types'

export function normalizeMediaCost(value: unknown, fallback: 'settled' | 'unavailable', observedAt: number): MediaCostRecord {
  const cost = value && typeof value === 'object' ? value as Partial<MediaCostRecord> : undefined
  if (validCost(cost)) {
    const receiptDigest = typeof cost.receiptDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(cost.receiptDigest) ? cost.receiptDigest : undefined
    return { ...cost, schemaVersion: MEDIA_SCHEMA_VERSION,
      estimatedUsd: cost.status === 'unavailable' ? undefined : cost.estimatedUsd,
      observedAt: Number.isFinite(cost.observedAt) ? cost.observedAt : observedAt,
      ...(receiptDigest ? { receiptDigest } : {}) }
  }
  return fallback === 'settled' ? localMediaCost('mock_zero', observedAt) : unavailableCost(observedAt)
}

function validCost(cost: Partial<MediaCostRecord> | undefined): cost is MediaCostRecord {
  if (!cost || cost.currency !== 'USD') return false
  if (cost.estimatedUsd !== undefined && !validMoney(cost.estimatedUsd)) return false
  if (cost.actualUsd !== undefined && !validMoney(cost.actualUsd)) return false
  if (cost.status !== 'unavailable' && cost.estimatedUsd === undefined && cost.actualUsd === undefined) return false
  return ['estimated', 'settled', 'unavailable'].includes(String(cost.status))
    && ['non_billable_local', 'mock_zero', 'catalog_estimate', 'provider_reported'].includes(String(cost.source))
}

export function localMediaCost(source: 'non_billable_local' | 'mock_zero', observedAt = Date.now()): MediaCostRecord {
  return { schemaVersion: MEDIA_SCHEMA_VERSION, currency: 'USD', estimatedUsd: 0, actualUsd: 0, status: 'settled', source, billable: false, observedAt }
}

export function providerEstimatedCost(provider: MediaProviderProfile | undefined, observedAt: number): MediaCostRecord {
  return provider?.estimatedCostUsd === undefined ? unavailableCost(observedAt)
    : { schemaVersion: MEDIA_SCHEMA_VERSION, currency: 'USD', estimatedUsd: provider.estimatedCostUsd,
      status: 'estimated', source: 'catalog_estimate', billable: true, observedAt }
}

function unavailableCost(observedAt: number): MediaCostRecord {
  return { schemaVersion: MEDIA_SCHEMA_VERSION, currency: 'USD', status: 'unavailable', source: 'catalog_estimate', billable: true, observedAt }
}

export function validMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
}
