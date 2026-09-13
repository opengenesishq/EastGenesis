import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import type {
  EngineKind,
  OpenAIProtocol,
  Provider,
  ProviderApiKey,
  ProviderApiKeyInput,
  ProviderApiKeyUpdateInput,
  ProviderAuthMode,
  ProviderInput,
  ProviderGenerationProbeInput,
  ProviderGenerationProbeResult,
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderModelProfile,
  ProviderView
} from '../shared/types'
import { recordProbeFailure, recordProbeSuccess } from './scheduler'
import {
  normalizeProviderCredentialPolicy,
  normalizeProviderCredentialRoutingMode,
  pickNextProviderKey,
  selectProviderKey
} from './providerKeyRouting'
import { providerCredentialMetrics } from './provider/providerCredentialMetrics'
import {
  applyKeyUpdates,
  cleanKeyLabel,
  LEGACY_KEY_LABEL,
  legacyKeyId,
  normalizedProviderKeys
} from './provider/providerKeyRecords'
import {
  inspectProviderBaseUrl,
  inspectProviderCustomHeaders,
  type CredentialStorageState,
  type ProviderCredentialLease,
  type ProviderCredentialLeaseOptions,
  type ProviderCredentialLeaseScope
} from './providerCredentialBroker'
import {
  forgetProviderCredential,
  forgetProviderCredentials,
  inspectProviderCredential,
  issueEphemeralProviderCredentialLease,
  issueStoredProviderCredentialLease,
  migrateLegacyProviderCredential,
  resolveProviderCredential,
  restoreProviderCredentials,
  snapshotProviderCredentials,
  storeProviderCredential
} from './providerCredentialRuntime'
import {
  migrateProviderCredentials,
  sanitizeProviderCredentialsForRuntime
} from './provider/credentialMigration'
import {
  fetchProviderModels,
  probeProviderGenerationTarget,
  type ProviderDiagnosticsDependencies
} from './provider/providerDiagnostics'
import {
  mergeProviderPatch,
  providerCredentialBindingChanged,
  providerPatchReplacesCredentials,
  removeProviderKeys,
  resolveProviderPatchFields
} from './provider/providerUpdate'
import { normalizeBaseUrl } from './provider/providerBaseUrl'
import { normalizeProviderAuthMode } from './provider/providerAuthMode'
import { normalizeProviderAdvancedConfig, normalizeProviderAuthorization } from './provider/providerAdvancedConfig'
import { sanitizeUnsupportedProviderAuthorization } from './provider/provider-authorization-sanitization'
import {
  assertProviderCredentialInput,
  inspectCredentialHeaderNames,
  normalizedCredentialHeaderNames,
  normalizedCustomHeaders,
  providerCredentialHeaderLines,
  providerCredentialHeaders,
  resolvedProviderCredentialHeaderNames
} from './provider/providerCredentialHeaders'
import {
  ProviderStoreMutationBlockedError,
  ProviderStoreRepository
} from './provider/providerStoreRepository'
import { writeAutomaticProviderProfileBackup } from './provider/providerProfileAutoBackup'
import { persistedProviders } from './provider/providerPersistenceProjection'
import { resolveProviderEngine } from './provider/providerEngine'
import { assignProviderConnectionIdentity, type ProviderConnectionTransitionOptions } from './provider/providerConnectionIdentity'
import { EMPTY_AUTHORIZATION_POOL_DIGEST } from './provider/providerAuthorizationPoolIdentity'
import { migrateLegacyEngineRecord } from './native-engine-migration'
import { assertPreparedProviderConnections, migrateProviderConnectionIdentity, prepareProviderConnectionSet, providerConnectionStore } from './provider/providerConnectionStore'
export { persistedProviders } from './provider/providerPersistenceProjection'
export {
  PROVIDER_ENGINE_BLOCKED_UNKNOWN,
  ProviderEngineResolutionError,
  resolveProviderEngine
} from './provider/providerEngine'

export { normalizeBaseUrl } from './provider/providerBaseUrl'
export {
  assertProviderCredentialInput,
  normalizedCredentialHeaderNames,
  normalizedCustomHeaders,
  providerCredentialHeaderLines,
  providerCredentialHeaders,
  resolvedProviderCredentialHeaderNames
} from './provider/providerCredentialHeaders'
export { ProviderStoreMutationBlockedError } from './provider/providerStoreRepository'
export { normalizedProviderKeys } from './provider/providerKeyRecords'

const providerStore = new ProviderStoreRepository(
  () => app.getPath('userData'),
  {
    serialize: persistedProviders,
    migrate: migrateLoadedProviders,
    sanitize: sanitizeLoadedProvidersForRuntime
  }
)

const connectionStore = providerConnectionStore({ load, diskDigest: readProviderProfileStoreDigestStrict, digest: persistedProviderStoreDigest,
  mutate: (action, operation) => withProviderStoreMutation(action, {}, operation), replace: (providers) => providerStore.replace(providers), persist: persistUnlocked })
export const getProviderConnectionIdentity = connectionStore.identity
export const stageProviderAuthorizationPoolDigest = connectionStore.stageAuthorizationPool

export interface ProviderProfileStoreCommitOptions {
  operationId?: string
  expectedWriteDigest?: string
  credentialsToForgetAfterCommit?: string[]
}

export function readProviderProfileStoreDigestStrict(): string {
  return providerStore.readDigestStrict()
}

function withProviderStoreMutation<T>(
  action: string,
  options: { operationId?: string; expectedDiskDigest?: string; expectedWriteDigest?: string },
  mutation: () => T
): T {
  return providerStore.mutate(action, options, mutation)
}

function load(): Provider[] {
  return providerStore.load()
}

function persistUnlocked(): void {
  providerStore.persist()
}


export function migrateLoadedProviders(providers: Provider[]): { providers: Provider[]; changed: boolean } {
  const credentialMigration = migrateProviderCredentials(providers, {
    inspectCredentialHeaderNames,
    legacyKeyId,
    migrateLegacy: migrateLegacyProviderCredential,
    migrationMarker: { credentialMigrationRequired: true }
  })
  let changed = credentialMigration.changed
  const migratedProviders = credentialMigration.providers.map((provider) => {
    const migratedEngine = migrateLegacyProviderEngine(provider)
    const sanitized = sanitizeLoadedProviderAuthMode(sanitizeUnsupportedProviderAuthorization(migratedEngine))
    const defaulted = migrateProviderConnectionIdentity(provider, withDefaultProviderCredentialHeaders(sanitized))
    if (defaulted !== provider) changed = true
    return defaulted
  })
  return { providers: migratedProviders, changed }
}

function sanitizeLoadedProvidersForRuntime(providers: Provider[]): Provider[] {
  const sanitizedCredentials = sanitizeProviderCredentialsForRuntime(providers, {
    inspectCredentialHeaderNames,
    migrationMarker: { credentialMigrationRequired: true }
  })
  return sanitizedCredentials
    .map(migrateLegacyProviderEngine)
    .map(sanitizeUnsupportedProviderAuthorization)
    .map(sanitizeLoadedProviderAuthMode)
    .map(withNormalizedProviderCredentialRouting)
}

function migrateLegacyProviderEngine(provider: Provider): Provider {
  return migrateLegacyEngineRecord(provider as Provider & { engine?: string }) as Provider
}

function sanitizeLoadedProviderAuthMode(provider: Provider): Provider {
  if (provider.authMode !== 'none') return provider
  try {
    normalizeProviderAuthMode(provider.authMode, provider.baseUrl, resolveProviderEngine(provider))
    const hasDormantCredential = Boolean(provider.encryptedToken)
      || normalizedProviderKeys(provider).length > 0
      || Boolean(provider.activeKeyId)
      || provider.credentialMigrationRequired === true
    if (!hasDormantCredential) return provider
    forgetProviderCredentials(provider.id)
    return {
      ...provider,
      encryptedToken: '',
      apiKeys: [],
      activeKeyId: undefined,
      credentialMigrationRequired: false
    }
  } catch {
    return {
      ...provider,
      authMode: 'api-key',
      credentialMigrationRequired: true
    }
  }
}

/** 加密串 → 明文 token,仅在主进程注入 SDK env 时使用,不回传渲染进程 */
export function decryptToken(encrypted: string): string {
  return resolveProviderCredential(
    { providerId: '__legacy__', keyId: '__legacy__' },
    { encryptedToken: encrypted }
  ).token
}

function createApiKey(providerId: string, input: ProviderApiKeyInput, fallbackLabel: string): ProviderApiKey | null {
  const token = input.token.trim()
  if (!token) return null
  const id = randomUUID()
  const credential = storeProviderCredential({ providerId, keyId: id }, token)
  return {
    id,
    label: cleanKeyLabel(input.label, fallbackLabel),
    encryptedToken: credential.encryptedToken,
    sessionOnly: credential.sessionOnly,
    createdAt: Date.now(),
    disabled: input.disabled === true,
    policy: normalizeProviderCredentialPolicy(input.policy)
  }
}

function credentialStateFor(providerId: string, key: ProviderApiKey) {
  return inspectProviderCredential(
    { providerId, keyId: key.id },
    { encryptedToken: key.encryptedToken, sessionOnly: key.sessionOnly }
  )
}

function keyIsAvailable(providerId: string, key: ProviderApiKey): boolean {
  return credentialStateFor(providerId, key).available
}

function activeProviderKey(provider: Provider, keys = normalizedProviderKeys(provider)): ProviderApiKey | undefined {
  return providerKeyDecision(provider, keys).key
}

function providerKeyDecision(provider: Provider, keys = normalizedProviderKeys(provider)) {
  return selectProviderKey(keys, {
    activeKeyId: provider.activeKeyId?.trim(),
    routingMode: normalizeProviderCredentialRoutingMode(provider.credentialRoutingMode),
    metrics: providerCredentialMetrics(provider.id, keys),
    available: (key) => keyIsAvailable(provider.id, key)
  })
}

export function activeKeyIdFor(provider: Provider, keys: ProviderApiKey[], requestedId?: string): string | undefined {
  const activeId = requestedId?.trim() || provider.activeKeyId?.trim()
  const enabledKeys = keys.filter((key) => !key.disabled && keyIsAvailable(provider.id, key))
  return enabledKeys.find((key) => key.id === activeId)?.id ?? enabledKeys[0]?.id
}

function appendNewKeys(
  providerId: string,
  keys: ProviderApiKey[],
  additions: ProviderApiKeyInput[] | undefined
): ProviderApiKey[] {
  if (!additions || additions.length === 0) return keys
  const next = [...keys]
  for (const input of additions) {
    const key = createApiKey(providerId, input, `Key ${next.length + 1}`)
    if (key) next.push(key)
  }
  return next
}

function withPrimaryToken(keys: ProviderApiKey[], provider: Provider, patch: Partial<ProviderInput>): ProviderApiKey[] {
  const tokenWasProvided = patch.token !== undefined
  const configuredActive = keys.find((key) => key.id === provider.activeKeyId && !key.disabled)
    ?? keys.find((key) => !key.disabled)
  if (tokenWasProvided) {
    const token = patch.token?.trim() ?? ''
    if (!token) {
      for (const key of keys) forgetProviderCredential({ providerId: provider.id, keyId: key.id })
      return []
    }
    const id = configuredActive?.id ?? randomUUID()
    const credential = storeProviderCredential({ providerId: provider.id, keyId: id }, token)
    const nextKey: ProviderApiKey = {
      id,
      label: cleanKeyLabel(patch.tokenLabel ?? configuredActive?.label, LEGACY_KEY_LABEL),
      encryptedToken: credential.encryptedToken,
      sessionOnly: credential.sessionOnly,
      createdAt: configuredActive?.createdAt ?? Date.now(),
      disabled: false,
      policy: normalizeProviderCredentialPolicy(configuredActive?.policy)
    }
    if (configuredActive) return keys.map((key) => key.id === configuredActive.id ? nextKey : key)
    return [nextKey, ...keys]
  }
  if (patch.tokenLabel !== undefined && configuredActive) {
    return keys.map((key) =>
      key.id === configuredActive.id ? { ...key, label: cleanKeyLabel(patch.tokenLabel, LEGACY_KEY_LABEL) } : key
    )
  }
  return keys
}

function providerKeyCount(provider: Provider): number {
  if (providerAuthMode(provider) === 'none' || provider.credentialMigrationRequired === true) return 0
  return normalizedProviderKeys(provider).filter((key) => !key.disabled && keyIsAvailable(provider.id, key)).length
}

export function providerHasToken(provider: Provider | undefined): boolean {
  return provider ? providerKeyCount(provider) > 0 : false
}

export function providerAuthMode(
  provider: Pick<Provider, 'authMode'> | Pick<ProviderView, 'authMode'> | undefined
): ProviderAuthMode {
  return provider?.authMode === 'none' ? 'none' : 'api-key'
}

export function providerIsReady(
  provider: Pick<Provider, 'authMode'> | Pick<ProviderView, 'authMode' | 'hasToken'> | undefined
): boolean {
  if (!provider) return false
  if (providerAuthMode(provider) === 'none') return true
  return 'hasToken' in provider ? provider.hasToken : providerHasToken(provider as Provider)
}

/** 取 Provider 当前活动 API Key。只在主进程内部使用,不回传渲染进程。 */
export function decryptProviderToken(provider: Provider | undefined): string {
  return resolveProviderToken(provider).token
}

export interface ProviderTokenSelection {
  providerId?: string
  keyId?: string
  keyLabel?: string
  token: string
}

export interface ProviderCredentialLeaseSelection {
  providerId: string
  keyId?: string
  keyLabel?: string
  authMode: ProviderAuthMode
  available: boolean
  routeReason?: string
  lease?: ProviderCredentialLease
}

export function selectProviderCredential(provider: Provider | undefined): ProviderCredentialLeaseSelection {
  if (!provider) {
    return { providerId: '', authMode: 'api-key', available: false }
  }
  const authMode = providerAuthMode(provider)
  if (authMode === 'none') {
    return { providerId: provider.id, authMode, available: true }
  }
  if (provider.credentialMigrationRequired === true) {
    return { providerId: provider.id, authMode, available: false }
  }
  const decision = providerKeyDecision(provider)
  const active = decision.key
  return {
    providerId: provider.id,
    keyId: active?.id,
    keyLabel: active?.label,
    authMode,
    available: Boolean(active),
    routeReason: decision.reason
  }
}

export function issueProviderCredentialLease(
  provider: Provider,
  scope: ProviderCredentialLeaseScope,
  options: ProviderCredentialLeaseOptions = {},
  expectedKeyId?: string
): ProviderCredentialLeaseSelection {
  const authMode = providerAuthMode(provider)
  if (authMode === 'none') return { providerId: provider.id, authMode, available: true }
  if (provider.credentialMigrationRequired === true) {
    return { providerId: provider.id, authMode, available: false }
  }
  const keys = normalizedProviderKeys(provider)
  const requestedId = expectedKeyId?.trim()
  const decision = providerKeyDecision(provider, keys)
  const key = requestedId
    ? keys.find((candidate) => candidate.id === requestedId
      && !candidate.disabled
      && keyIsAvailable(provider.id, candidate))
    : decision.key
  const selection: ProviderCredentialLeaseSelection = {
    providerId: provider.id,
    keyId: key?.id,
    keyLabel: key?.label,
    authMode,
    available: Boolean(key),
    routeReason: requestedId ? '使用请求绑定的精确凭据' : decision.reason
  }
  if (!key) return selection
  const lease = issueStoredProviderCredentialLease(
    { providerId: provider.id, keyId: key.id },
    { encryptedToken: key.encryptedToken, sessionOnly: key.sessionOnly },
    scope,
    options
  )
  return { ...selection, lease }
}

export function issueDirectProviderCredentialLease(
  providerId: string,
  keyId: string,
  token: string,
  scope: ProviderCredentialLeaseScope,
  options: ProviderCredentialLeaseOptions = {}
): ProviderCredentialLeaseSelection {
  const lease = issueEphemeralProviderCredentialLease(
    { providerId, keyId },
    token,
    scope,
    options
  )
  return { providerId, keyId, authMode: 'api-key', available: true, lease }
}

export interface ProviderKeyRotation {
  providerId: string
  providerName: string
  fromKeyId: string
  fromKeyLabel: string
  toKeyId: string
  toKeyLabel: string
}

interface ProviderKeyRotationInput {
  providerId: string
  failedKeyId?: string
  excludedKeyIds?: ReadonlySet<string>
  reason: string
  now?: number
}

export function resolveProviderToken(provider: Provider | undefined): ProviderTokenSelection {
  if (!provider) return { token: '' }
  if (providerAuthMode(provider) === 'none' || provider.credentialMigrationRequired === true) {
    return { providerId: provider.id, token: '' }
  }
  const active = activeProviderKey(provider)
  const credential = active
    ? resolveProviderCredential(
        { providerId: provider.id, keyId: active.id },
        { encryptedToken: active.encryptedToken, sessionOnly: active.sessionOnly }
      )
    : null
  return {
    providerId: provider.id,
    keyId: active?.id,
    keyLabel: active?.label,
    token: credential?.token ?? ''
  }
}

export function markProviderKeyUsed(providerId: string, keyId: string | undefined, now = Date.now()): void {
  updateProviderKeyRuntime(providerId, keyId, (key) => ({ ...key, lastUsedAt: now }))
}

export function recordProviderKeySuccess(providerId: string, keyId: string | undefined, now = Date.now()): void {
  updateProviderKeyRuntime(providerId, keyId, (key) => {
    const next = { ...key, lastUsedAt: now }
    delete next.lastFailureAt
    delete next.lastFailureReason
    return next
  })
}

export function rotateProviderKey(input: ProviderKeyRotationInput): ProviderKeyRotation | null {
  const list = load()
  const index = list.findIndex((provider) => provider.id === input.providerId)
  if (index < 0) return null
  try {
    return withProviderStoreMutation('保存 Provider 密钥轮换状态', {},
      () => rotateProviderKeyLocked(input, list, index))
  } catch (error) {
    console.error('[agent-desk] 保存 Provider 密钥轮换状态失败:', error)
    return null
  }
}

function rotateProviderKeyLocked(
  input: ProviderKeyRotationInput, list: Provider[], index: number
): ProviderKeyRotation | null {
  const provider = list[index]
  const now = input.now ?? Date.now()
  const keys = normalizedProviderKeys(provider)
  const failedKeyId = input.failedKeyId || activeProviderKey(provider, keys)?.id
  const failed = keys.find((key) => key.id === failedKeyId)
  const marked = keys.map((key) => key.id === failedKeyId
    ? { ...key, lastFailureAt: now, lastFailureReason: input.reason.trim().slice(0, 80) }
    : key)
  const next = pickNextProviderKey(marked.filter((key) => keyIsAvailable(provider.id, key)), {
    activeKeyId: provider.activeKeyId,
    failedKeyId,
    excludedKeyIds: input.excludedKeyIds,
    routingMode: provider.credentialRoutingMode,
    metrics: providerCredentialMetrics(provider.id, marked),
    available: (key) => keyIsAvailable(provider.id, key),
    now
  })
  const nextProvider: Provider = {
    ...provider,
    apiKeys: next ? marked.map((key) => key.id === next.id ? { ...key, lastUsedAt: now } : key) : marked,
    activeKeyId: next?.id ?? provider.activeKeyId,
    encryptedToken: next?.encryptedToken ?? provider.encryptedToken
  }
  providerStore.replace([...list.slice(0, index), nextProvider, ...list.slice(index + 1)])
  try {
    persistUnlocked()
  } catch (error) {
    providerStore.replace(list)
    throw error
  }
  if (!failed || !next) return null
  return {
    providerId: provider.id, providerName: provider.name,
    fromKeyId: failed.id, fromKeyLabel: failed.label,
    toKeyId: next.id, toKeyLabel: next.label
  }
}

export function toView(p: Provider): ProviderView {
  const keys = normalizedProviderKeys(p)
  const credentialsUsable = providerAuthMode(p) !== 'none' && p.credentialMigrationRequired !== true
  const metrics = providerCredentialMetrics(p.id, keys)
  const decision = credentialsUsable ? providerKeyDecision(p, keys) : undefined
  const active = decision?.key
  const apiKeys = keys.map((key) => {
    const credential = credentialStateFor(p.id, key)
    return {
      id: key.id,
      label: key.label,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      lastFailureAt: key.lastFailureAt,
      lastFailureReason: key.lastFailureReason,
      disabled: key.disabled === true,
      active: active?.id === key.id,
      credentialStorage: providerCredentialStorage(credential.storage),
      available: credentialsUsable && credential.available,
      policy: normalizeProviderCredentialPolicy(key.policy),
      monthlySpendUsd: metrics.get(key.id)?.monthlySpendUsd ?? 0,
      balanceRemainingUsd: metrics.get(key.id)?.balanceRemainingUsd,
      routingBlockedReason: decision?.blocked.get(key.id)
    }
  })
  const keyCount = apiKeys.filter((key) => !key.disabled && key.available).length
  const credentialStorage = aggregateCredentialStorage(apiKeys.map((key) => key.credentialStorage))
  const customHeaders = inspectProviderCustomHeaders(p.customHeaders ?? '').safeValue.trim()
  const credentialHeaderNames = resolvedProviderCredentialHeaderNames(p)
  return {
    id: p.id,
    name: p.name,
    baseUrl: inspectProviderBaseUrl(p.baseUrl).safeValue,
    models: p.models,
    authMode: providerAuthMode(p),
    ready: providerAuthMode(p) === 'none' || keyCount > 0,
    engine: resolveProviderEngine(p),
    customHeaders: customHeaders || undefined,
    credentialHeaderNames,
    budgetUsd: normalizeBudget(p.budgetUsd),
    openaiProtocol: p.openaiProtocol,
    note: p.note,
    authorization: p.authorization,
    advancedConfig: p.advancedConfig,
    createdAt: p.createdAt,
    hasToken: keyCount > 0,
    keyCount,
    activeKeyId: active?.id,
    activeKeyLabel: active?.label,
    credentialRoutingMode: normalizeProviderCredentialRoutingMode(p.credentialRoutingMode),
    credentialRouteReason: decision?.reason,
    apiKeys,
    credentialStorage,
    credentialMigrationRequired: p.credentialMigrationRequired === true
  }
}

function providerCredentialStorage(storage: CredentialStorageState): ProviderView['credentialStorage'] {
  if (storage === 'missing') return 'none'
  return storage
}

function aggregateCredentialStorage(
  storages: Array<ProviderView['credentialStorage']>
): ProviderView['credentialStorage'] {
  const meaningful = [...new Set(storages.filter((storage) => storage !== 'none'))]
  if (meaningful.length === 0) return 'none'
  return meaningful.length === 1 ? meaningful[0] : 'mixed'
}

function updateProviderKeyRuntime(
  providerId: string,
  keyId: string | undefined,
  update: (key: ProviderApiKey) => ProviderApiKey
): void {
  if (!keyId) return
  const list = load()
  const index = list.findIndex((provider) => provider.id === providerId)
  if (index < 0) return
  const provider = list[index]
  const keys = normalizedProviderKeys(provider)
  if (!keys.some((key) => key.id === keyId)) return
  const apiKeys = keys.map((key) => key.id === keyId ? update(key) : key)
  const active = activeProviderKey({ ...provider, apiKeys }, apiKeys)
  const next = {
    ...provider,
    apiKeys,
    activeKeyId: active?.id,
    encryptedToken: active?.encryptedToken ?? ''
  }
  try {
    withProviderStoreMutation('保存 Provider 密钥运行状态', {}, () => {
      providerStore.replace([...list.slice(0, index), next, ...list.slice(index + 1)])
      try {
        persistUnlocked()
      } catch (error) {
        providerStore.replace(list)
        throw error
      }
    })
  } catch (error) {
    console.error('[agent-desk] 保存 Provider 密钥运行状态失败:', error)
  }
}

export function listProviders(): ProviderView[] {
  return load().map(toView)
}

export function loadProviderProfileStore(): Provider[] {
  return load()
}

export function reloadProviderProfileStoreFromDisk(): Provider[] {
  return providerStore.reload()
}

export function commitProviderProfileStore(
  providers: Provider[],
  options: ProviderProfileStoreCommitOptions = {}
): void {
  const previous = providerStore.cached()
  // Direct main-process fixtures and legacy callers may still provide records
  // from before connection identities existed. Stamp those records through the
  // same transition helper before the journal digest is checked; imported
  // identity fields are never trusted as-is.
  const desired = providers.some((provider) => provider.connectionIdentity === undefined
    || provider.connectionAuthorizationPoolDigest === undefined)
    ? prepareProviderConnectionSet(previous ?? [], providers)
    : providers
  withProviderStoreMutation('提交 Provider Profile', {
    operationId: options.operationId,
    expectedWriteDigest: options.expectedWriteDigest
  }, () => {
    assertPreparedProviderConnections(previous ?? [], desired)
    providerStore.replace(desired)
    try {
      persistUnlocked()
    } catch (error) {
      providerStore.replace(previous)
      throw error
    }
    for (const providerId of options.credentialsToForgetAfterCommit ?? []) {
      forgetProviderCredentials(providerId)
    }
  })
}

export function restoreProviderProfileStoreMemory(providers: Provider[]): void {
  providerStore.replace(providers)
}

export function forgetProviderProfileCredentials(providerId: string): void {
  forgetProviderCredentials(providerId)
}

/** 主进程内部用:取完整 Provider(含加密 token) */
export function getProvider(id: string): Provider | undefined {
  return load().find((p) => p.id === id)
}


export function createProvider(input: ProviderInput): ProviderView {
  const providerId = randomUUID()
  assertProviderCredentialInput(input)
  const customHeaders = normalizedCustomHeaders(input.customHeaders)
  const baseUrl = normalizeBaseUrl(input.baseUrl, input.engine ?? 'openai', input.openaiProtocol)
  const authMode = normalizeProviderAuthMode(input.authMode, baseUrl, input.engine ?? 'openai')
  const credentialHeaderNames = resolvedProviderCredentialHeaderNames({
    authMode,
    engine: input.engine ?? 'openai',
    credentialHeaderNames: normalizedCredentialHeaderNames(input.credentialHeaderNames)
  })
  assertNoAuthCredentialInput(authMode, input)
  const authorization = normalizeProviderAuthorization(input.authorization)
  const advancedConfig = normalizeProviderAdvancedConfig(input.advancedConfig)
  const list = load()
  const credentialSnapshot = snapshotProviderCredentials(providerId)
  return withProviderStoreMutation('创建 Provider', {}, () => {
    try {
      const primary = typeof input.token === 'string' && input.token.trim()
        ? createApiKey(providerId, { label: input.tokenLabel, token: input.token }, LEGACY_KEY_LABEL)
        : null
      const apiKeys = appendNewKeys(providerId, primary ? [primary] : [], input.additionalTokens)
      const activeKeyId = apiKeys.find((key) => !key.disabled && keyIsAvailable(providerId, key))?.id
      const activeKey = apiKeys.find((key) => key.id === activeKeyId)
      const provider: Provider = assignProviderConnectionIdentity(undefined, {
        id: providerId,
        name: input.name,
        baseUrl,
        encryptedToken: activeKey?.encryptedToken ?? '',
        apiKeys,
        activeKeyId,
        credentialRoutingMode: normalizeProviderCredentialRoutingMode(input.credentialRoutingMode),
        models: input.models,
        authMode,
        engine: input.engine ?? 'openai',
        customHeaders,
        credentialHeaderNames,
        budgetUsd: normalizeBudget(input.budgetUsd),
        openaiProtocol: input.openaiProtocol,
        note: input.note,
        authorization,
        advancedConfig,
        createdAt: Date.now()
      }, { authorizationPoolDigest: EMPTY_AUTHORIZATION_POOL_DIGEST })
      writeAutomaticProviderProfileBackup(app.getPath('userData'), 'provider-create', list, persistedProviders(list))
      providerStore.replace([...list, provider])
      persistUnlocked()
      return toView(provider)
    } catch (err) {
      providerStore.replace(list)
      restoreProviderCredentials(providerId, credentialSnapshot)
      throw err
    }
  })
}

export function updateProvider(id: string, patch: Partial<ProviderInput>): ProviderView { return updateProviderConnection(id, patch) }
export function updateProviderForVerifiedOAuthRefresh(id: string, patch: Partial<ProviderInput>, principal: { service: string; accountId: string }): ProviderView {
  return updateProviderConnection(id, patch, { verifiedOAuthRefresh: principal })
}
function updateProviderConnection(id: string, patch: Partial<ProviderInput>, identityOptions: ProviderConnectionTransitionOptions = {}): ProviderView {
  const list = load()
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1) throw new Error('Provider 不存在')
  assertProviderCredentialInput(patch)
  const prev = list[idx]
  const fields = resolveProviderPatchFields(prev, patch, {
    normalizedCustomHeaders,
    normalizedCredentialHeaderNames,
    normalizeBaseUrl,
    resolveProviderEngine
  })
  const nextEngine = patch.engine ?? resolveProviderEngine(prev)
  const authorization = patch.authorization === undefined
    ? prev.authorization
    : normalizeProviderAuthorization(patch.authorization)
  const advancedConfig = patch.advancedConfig === undefined
    ? prev.advancedConfig
    : normalizeProviderAdvancedConfig(patch.advancedConfig)
  const authMode = normalizeProviderAuthMode(patch.authMode ?? prev.authMode, fields.baseUrl, nextEngine)
  assertNoAuthCredentialInput(authMode, patch)
  const credentialSnapshot = snapshotProviderCredentials(id)
  return withProviderStoreMutation('更新 Provider', {}, () => {
    try {
      const apiKeys = updatedProviderKeys(id, prev, patch, fields, nextEngine, authMode)
      const activeKeyId = activeKeyIdFor(prev, apiKeys, patch.activeKeyId)
      const next = mergeProviderPatch(prev, { ...patch, authMode }, fields, apiKeys, activeKeyId,
        { normalizeBudget, resolveProviderEngine })
      next.authorization = authorization
      next.advancedConfig = advancedConfig
      const identified = assignProviderConnectionIdentity(prev, next, { ...identityOptions, credentialReplacement: patch.token !== undefined })
      const view = toView(identified)
      const nextList = [...list.slice(0, idx), identified, ...list.slice(idx + 1)]
      if (persistedProviderStoreDigest(list) === persistedProviderStoreDigest(nextList)) { providerStore.replace(nextList); return view }
      writeAutomaticProviderProfileBackup(app.getPath('userData'), 'provider-update', list, persistedProviders(list))
      providerStore.replace(nextList)
      persistUnlocked()
      return view
    } catch (err) {
      providerStore.replace(list)
      restoreProviderCredentials(id, credentialSnapshot)
      throw err
    }
  })
}

function updatedProviderKeys(providerId: string, previous: Provider, patch: Partial<ProviderInput>,
  fields: ReturnType<typeof resolveProviderPatchFields>, nextEngine: EngineKind,
  authMode: ProviderAuthMode): ProviderApiKey[] {
  let apiKeys = authMode === 'none' ? [] : normalizedProviderKeys(previous)
  if (authMode === 'none') forgetProviderCredentials(providerId)
  const bindingCandidate: Provider = {
    ...previous,
    baseUrl: fields.baseUrl,
    engine: nextEngine,
    customHeaders: fields.customHeaders,
    credentialHeaderNames: fields.credentialHeaderNames,
    openaiProtocol: patch.openaiProtocol ?? previous.openaiProtocol
  }
  if (providerPatchReplacesCredentials(patch) && (previous.credentialMigrationRequired === true
    || providerCredentialBindingChanged(previous, bindingCandidate, resolveProviderEngine))) {
    for (const key of apiKeys) forgetProviderCredential({ providerId, keyId: key.id })
    apiKeys = []
  }
  apiKeys = withPrimaryToken(apiKeys, previous, patch)
  apiKeys = applyKeyUpdates(apiKeys, patch.keyUpdates)
  apiKeys = removeProviderKeys(providerId, apiKeys, patch.removeKeyIds,
    (id, keyId) => forgetProviderCredential({ providerId: id, keyId }))
  return appendNewKeys(providerId, apiKeys, patch.additionalTokens)
}

export function normalizeBudget(value: unknown): number {
  if (value === undefined || value === null) return 0
  const budget = Number(value)
  return Number.isFinite(budget) && budget > 0 ? budget : 0
}

export function deleteProvider(id: string): void {
  const list = load()
  if (!list.some((provider) => provider.id === id)) return
  withProviderStoreMutation('删除 Provider', {}, () => {
    const next = list.filter((p) => p.id !== id)
    writeAutomaticProviderProfileBackup(app.getPath('userData'), 'provider-delete', list, persistedProviders(list))
    providerStore.replace(next)
    try {
      persistUnlocked()
    } catch (err) {
      providerStore.replace(list)
      throw err
    }
    forgetProviderCredentials(id)
  })
}

/**
 * 用 API key 拉取模型列表。按多个候选端点依次尝试,兼容不同厂商布局:
 * - Anthropic 兼容:{base}/v1/models
 * - OpenAI 风格 / 部分厂商(如 DeepSeek):{base}/models
 * - base 含 /anthropic 子路径时(如 https://api.deepseek.com/anthropic),
 *   模型列表常在根域:{root}/v1/models、{root}/models
 * 所有安全候选都会被探测。单个路径返回 401/403 不能证明密钥错误，因为部分网关会对
 * 不存在的路径返回鉴权错误；只有汇总所有候选后才给出分类诊断。
 */
export async function fetchModels(opts: ProviderModelFetchInput): Promise<ProviderModelFetchResult> {
  return fetchProviderModels(opts, providerDiagnosticsDependencies)
}

export async function probeProviderGeneration(
  opts: ProviderGenerationProbeInput
): Promise<ProviderGenerationProbeResult> {
  const providerId = opts.providerId?.trim()
  // Explicit credentials may target an unsaved editor draft even when a saved
  // providerId is supplied. Such a request cannot verify the saved connection.
  const initial = providerId && !opts.token?.trim() ? getProvider(providerId) : undefined
  const model = opts.model.trim()
  const target = initial && probeModelProfiles(initial).find((profile) => matchesProbeModel(profile, model))
  const identity = target && initial ? getProviderConnectionIdentity(initial.id) : undefined
  const initialModels = initial ? JSON.stringify(initial.models) : undefined
  const probeKey = target && initial ? JSON.stringify([initial.id, target.model]) : undefined
  const attempt = Symbol('provider-generation-probe')
  if (probeKey) pendingGenerationVerifications.set(probeKey, attempt)
  try {
    const result = await probeProviderGenerationTarget(opts, providerDiagnosticsDependencies)
    if (!initial || !target || !identity || !probeKey) return result
    const provider = getProvider(initial.id)
    if (!provider || JSON.stringify(provider.models) !== initialModels
      || pendingGenerationVerifications.get(probeKey) !== attempt) throw staleGenerationProbeError()
    const currentIdentity = getProviderConnectionIdentity(provider.id)
    if (currentIdentity.generationId !== identity.generationId || currentIdentity.revision !== identity.revision) {
      throw staleGenerationProbeError()
    }
    const profiles = probeModelProfiles(provider).map((profile) =>
      profile.model === target.model && matchesProbeModel(profile, model)
        ? { ...profile, verification: {
          generation: result.ok ? 'passed' as const : 'failed' as const,
          outcome: result.outcome,
          protocol: result.protocol,
          responseValidation: result.responseValidation,
          verifiedAt: Date.now()
        } }
        : profile)
    updateProvider(provider.id, { advancedConfig: { ...(provider.advancedConfig ?? { schemaVersion: 1 }), modelProfiles: profiles } })
    return result
  } finally {
    if (probeKey && pendingGenerationVerifications.get(probeKey) === attempt) pendingGenerationVerifications.delete(probeKey)
  }
}

const pendingGenerationVerifications = new Map<string, symbol>()

function matchesProbeModel(profile: ProviderModelProfile, model: string): boolean {
  return profile.model === model || profile.aliases?.includes(model) === true
}

function probeModelProfiles(provider: Provider): ProviderModelProfile[] {
  const profiles = provider.advancedConfig?.modelProfiles ?? []
  return [...profiles, ...provider.models.filter((model) => !profiles.some((profile) => matchesProbeModel(profile, model))).map((model) => ({ model }))]
}

function staleGenerationProbeError(): Error {
  return new Error('探测期间 Provider 配置或验证请求已变化；本次结果未保存，请使用当前配置重新验证。')
}

const providerDiagnosticsDependencies: ProviderDiagnosticsDependencies = {
  getProvider,
  providerAuthMode,
  decryptProviderToken,
  selectedKey: (provider) => providerKeyDecision(provider).key,
  recordProbeSuccess,
  recordProbeFailure
}

function persistedProviderStoreDigest(providers: Provider[]): string {
  return createHash('sha256').update(JSON.stringify(persistedProviders(providers))).digest('hex')
}

function withNormalizedProviderCredentialRouting(provider: Provider): Provider {
  const credentialRoutingMode = normalizeProviderCredentialRoutingMode(provider.credentialRoutingMode)
  const sourceKeys = Array.isArray(provider.apiKeys) ? provider.apiKeys : []
  let changed = provider.credentialRoutingMode !== credentialRoutingMode
  const apiKeys = sourceKeys.map((key) => {
    const policy = normalizeProviderCredentialPolicy(key?.policy)
    if (JSON.stringify(key?.policy) === JSON.stringify(policy)) return key
    changed = true
    return { ...key, policy }
  })
  return changed ? { ...provider, credentialRoutingMode, apiKeys } : provider
}

function withDefaultProviderCredentialHeaders(provider: Provider): Provider {
  if (provider.authMode === 'none' || inspectCredentialHeaderNames(provider.credentialHeaderNames).names.length > 0) {
    return provider
  }
  return {
    ...provider,
    credentialHeaderNames: resolvedProviderCredentialHeaderNames(provider)
  }
}

function assertNoAuthCredentialInput(
  authMode: ProviderAuthMode,
  input: Partial<ProviderInput>
): void {
  if (authMode !== 'none') return
  if (input.token?.trim() || input.additionalTokens?.some((item) => Boolean(item.token.trim()))) {
    throw new Error('无需密钥的 Provider 不接受 API Key；请清空凭据后重试')
  }
}
