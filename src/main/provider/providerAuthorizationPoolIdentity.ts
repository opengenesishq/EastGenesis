import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeProviderAuthorizationAccountPolicy } from './providerAuthorizationRouting'

interface PoolMember { providerId: string; service: string; accountId: string; policy: ReturnType<typeof normalizeProviderAuthorizationAccountPolicy> }
export const EMPTY_AUTHORIZATION_POOL_DIGEST = poolDigest([])

/** Read the account authority directly; a process cache cannot certify a two-file transition. */
export function readProviderAuthorizationPoolDigest(rootDir: string, providerId: string): string {
  return authorizationPoolDigests(readAuthorizationPoolDocument(rootDir)).get(providerId) ?? EMPTY_AUTHORIZATION_POOL_DIGEST
}

export function readAuthorizationPoolDocument(rootDir: string): unknown {
  const file = join(rootDir, 'provider-authorizations.json')
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Provider authorization store is invalid')
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

export function changedAuthorizationPools(before: unknown, after: unknown): Array<{ providerId: string; digest: string }> {
  const oldPools = authorizationPoolDigests(before), nextPools = authorizationPoolDigests(after)
  return [...new Set([...oldPools.keys(), ...nextPools.keys()])].flatMap((providerId) => {
    const digest = nextPools.get(providerId) ?? EMPTY_AUTHORIZATION_POOL_DIGEST
    return digest === (oldPools.get(providerId) ?? EMPTY_AUTHORIZATION_POOL_DIGEST) ? [] : [{ providerId, digest }]
  })
}

function authorizationPoolDigests(value: unknown): Map<string, string> {
  if (!Array.isArray(value)) throw new Error('Provider authorization store must be an array')
  const pools = new Map<string, PoolMember[]>(), seen = new Set<string>()
  for (const item of value) {
    const member = poolMember(item)
    if (!member) continue
    const key = JSON.stringify([member.providerId, member.service, member.accountId])
    if (seen.has(key)) throw new Error('Provider authorization pool contains duplicate identities')
    seen.add(key)
    pools.set(member.providerId, [...(pools.get(member.providerId) ?? []), member])
  }
  return new Map([...pools].map(([providerId, members]) => [providerId, poolDigest(members)]))
}

function poolMember(value: unknown): PoolMember | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider authorization member')
  const item = value as Record<string, unknown>
  // The authorization store removes unsupported services before exposing runnable accounts.
  if (item.service !== 'xai-oauth') return undefined
  if (typeof item.id !== 'string' || !item.id.trim() || typeof item.providerId !== 'string' || !item.providerId.trim()) throw new Error('Invalid provider authorization principal')
  return { providerId: item.providerId, service: item.service, accountId: item.id, policy: normalizeProviderAuthorizationAccountPolicy(item.policy) }
}

function poolDigest(members: PoolMember[]): string {
  const projection = [...members].sort((left, right) => left.service.localeCompare(right.service) || left.accountId.localeCompare(right.accountId))
    .map(({ service, accountId, policy }) => ({ service, accountId, policy }))
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex')
}
