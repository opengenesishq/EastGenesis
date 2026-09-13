import { randomUUID } from 'node:crypto'
import type { ProviderConnectionIdentity } from '../../shared/provider-connection-identity'
import type { Provider } from '../../shared/types'
import { normalizeProviderCredentialPolicy, normalizeProviderCredentialRoutingMode } from '../providerKeyRouting'
import { normalizedProviderKeys } from './providerKeyRecords'
import { resolveProviderEngine } from './providerEngine'

export class ProviderConnectionUnavailableError extends Error {
  constructor(readonly reason: 'invalid_identity' | 'authorization_pool_pending' | 'store_diverged', message: string) { super(message) }
}
export interface ProviderConnectionTransitionOptions {
  credentialReplacement?: boolean
  /** Only the verified OAuth service may supply this, never ProviderInput or imported JSON. */
  verifiedOAuthRefresh?: { service: string; accountId: string }
  authorizationPoolDigest?: string
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/

export function readProviderConnectionIdentity(provider: Provider): ProviderConnectionIdentity {
  const value = provider.connectionIdentity
  if (!value || !UUID.test(value.generationId) || !Number.isSafeInteger(value.revision) || value.revision <= 0 ||
    !DIGEST.test(provider.connectionAuthorizationPoolDigest ?? '')) {
    throw new ProviderConnectionUnavailableError('invalid_identity', 'Provider connection identity is not durably available.')
  }
  return { generationId: value.generationId, revision: value.revision }
}

/** Compare main-owned connection meaning. Imported identity fields on next are ignored. */
export function assignProviderConnectionIdentity(previous: Provider | undefined, next: Provider, options: ProviderConnectionTransitionOptions = {}): Provider {
  const poolDigest = options.authorizationPoolDigest ?? previous?.connectionAuthorizationPoolDigest
  if (!poolDigest || !DIGEST.test(poolDigest)) throw new ProviderConnectionUnavailableError('invalid_identity', 'Provider authorization pool identity is unavailable.')
  if (!previous || previous.connectionIdentity === undefined) {
    return { ...next, connectionIdentity: { generationId: randomUUID(), revision: 1 }, connectionAuthorizationPoolDigest: poolDigest }
  }
  const identity = readProviderConnectionIdentity(previous)
  const refresh = verifiedRefresh(previous, next, options.verifiedOAuthRefresh)
  const changed = (options.credentialReplacement === true && !refresh) || poolDigest !== previous.connectionAuthorizationPoolDigest ||
    connectionProjection(previous, refresh) !== connectionProjection(next, refresh)
  if (changed && !Number.isSafeInteger(identity.revision + 1)) throw new ProviderConnectionUnavailableError('invalid_identity', 'Provider connection revision cannot advance.')
  // Probe observations belong to the connection and catalog that produced them.
  // Keep capability declarations, but discard old observations on an edit.
  const observationsChanged = changed || JSON.stringify(previous.models) !== JSON.stringify(next.models)
  const advancedConfig = observationsChanged && next.advancedConfig?.modelProfiles?.some((profile) => profile.verification)
    ? { ...next.advancedConfig, modelProfiles: next.advancedConfig.modelProfiles.map(({ verification: _verification, ...profile }) => profile) }
    : next.advancedConfig
  return { ...next, advancedConfig, connectionIdentity: { ...identity, revision: identity.revision + Number(changed) }, connectionAuthorizationPoolDigest: poolDigest }
}

export function assertProviderAuthorizationPoolReady(provider: Provider, actualDigest: string): void {
  readProviderConnectionIdentity(provider)
  if (provider.connectionAuthorizationPoolDigest !== actualDigest) {
    throw new ProviderConnectionUnavailableError('authorization_pool_pending', 'Provider authorization pool update is incomplete; retry or reconcile that update before execution.')
  }
}

function verifiedRefresh(previous: Provider, next: Provider, refresh: ProviderConnectionTransitionOptions['verifiedOAuthRefresh']): boolean {
  if (!refresh) return false
  const same = [previous, next].every((provider) => provider.authorization?.provider === refresh.service && provider.authorization.accountId === refresh.accountId)
  if (!same) throw new ProviderConnectionUnavailableError('invalid_identity', 'Verified OAuth refresh does not match the stored principal.')
  return true
}

function connectionProjection(provider: Provider, ignoreCredentialMaterial: boolean): string {
  const advanced = provider.advancedConfig
  return stableConnectionJson({
    baseUrl: provider.baseUrl, engine: resolveProviderEngine(provider), protocol: provider.openaiProtocol ?? 'responses', authMode: provider.authMode ?? 'api-key',
    customHeaders: provider.customHeaders ?? '', credentialHeaderNames: [...(provider.credentialHeaderNames ?? [])].sort(),
    endpoints: advanced?.endpoints ?? [], appBindings: advanced?.appBindings ?? {}, request: advanced?.request ?? {},
    // A profile containing only declarations/observations adds no routing alias.
    modelAliases: (advanced?.modelProfiles ?? []).filter((profile) => profile.aliases?.length).map((profile) => ({ model: profile.model, aliases: profile.aliases })),
    authorization: { method: provider.authorization?.method ?? 'api-key', service: provider.authorization?.provider ?? '',
      accountId: provider.authorization?.accountId ?? '', accountRoutingMode: provider.authorization?.accountRoutingMode ?? 'preferred' },
    credentialRoutingMode: normalizeProviderCredentialRoutingMode(provider.credentialRoutingMode),
    keys: normalizedProviderKeys(provider).map((key) => ({ id: key.id, disabled: key.disabled === true, policy: normalizeProviderCredentialPolicy(key.policy),
      ...(ignoreCredentialMaterial ? {} : { material: key.encryptedToken, sessionOnly: key.sessionOnly === true }) })).sort((left, right) => left.id.localeCompare(right.id))
  })
}

/** This representation is used only for in-memory equality, never logged or copied into a Run. */
function stableConnectionJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
  })
}
