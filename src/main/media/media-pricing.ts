import type { ProviderMediaPricing } from '../../shared/media-types'

export function normalizeProviderMediaPricing(value: unknown): ProviderMediaPricing | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Media pricing must be an object')
  const input = value as Record<string, unknown>
  if (input.currency !== 'USD' || !['request', 'second', 'million-characters'].includes(String(input.unit))) {
    throw new Error('Media pricing requires USD and request, second, or million-characters units')
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0 || input.amount > 1_000_000) {
    throw new Error('Media price amount must be between 0 and 1000000')
  }
  if (!['user', 'provider', 'catalog'].includes(String(input.source))) throw new Error('Media pricing source is invalid')
  const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : undefined
  return { currency: 'USD', unit: input.unit as ProviderMediaPricing['unit'], amount: input.amount,
    source: input.source as ProviderMediaPricing['source'], ...(updatedAt === undefined ? {} : { updatedAt }) }
}
