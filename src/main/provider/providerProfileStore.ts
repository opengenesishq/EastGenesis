import { createHash, randomUUID } from 'node:crypto'
import type { Provider, ProviderInput, ProviderView } from '../../shared/types'
import {
  activeKeyIdFor,
  assertProviderCredentialInput,
  commitProviderProfileStore,
  loadProviderProfileStore,
  migrateLoadedProviders,
  normalizeBaseUrl,
  normalizeBudget,
  normalizedCredentialHeaderNames,
  normalizedCustomHeaders,
  normalizedProviderKeys,
  persistedProviders,
  resolvedProviderCredentialHeaderNames,
  resolveProviderEngine,
  restoreProviderProfileStoreMemory,
  toView
} from '../providers'
import { normalizeProviderAuthMode } from './providerAuthMode'
import { normalizeProviderAdvancedConfig, normalizeProviderAuthorization } from './providerAdvancedConfig'
import { assertNoDuplicateProviderProfileTargets } from './providerProfile'
import { mergeProviderPatch, resolveProviderPatchFields } from './providerUpdate'
import { prepareProviderConnectionSet } from './providerConnectionStore'

export interface ProviderProfileMutation {
  action: 'create' | 'update'
  targetProviderId?: string
  input: ProviderInput
}

export interface ProviderStoreBackupSnapshot {
  providers: Provider[]
  nonPersistentCredentialCount: number
  excludedCredentialCount: number
}

export interface PreparedProviderProfileStoreMutation {
  before: Provider[]
  desired: Provider[]
  beforeSnapshotDigest: string
  desiredSnapshotDigest: string
  beforeExactDigest: string
  desiredExactDigest: string
  credentialsToForgetAfterCommit: string[]
}

export function snapshotProviderStoreForBackup(): ProviderStoreBackupSnapshot {
  const providers = loadProviderProfileStore()
  const sanitized = sanitizeProviderStoreBackupCredentials(providers)
  return {
    providers: sanitized.providers,
    nonPersistentCredentialCount: providers.reduce(
      (count, provider) => count + normalizedProviderKeys(provider).filter((key) => key.sessionOnly === true).length,
      0
    ),
    excludedCredentialCount: sanitized.excludedCredentialCount
  }
}

export function sanitizeProviderStoreBackupCredentials(providers: Provider[]): {
  providers: Provider[]
  excludedCredentialCount: number
} {
  let excludedCredentialCount = 0
  const sanitized = persistedProviders(cloneProviders(providers)).map((provider) => {
    const keys = normalizedProviderKeys(provider)
    const providerCredentialCount = keys.length > 0 ? keys.length : Number(Boolean(provider.encryptedToken))
    excludedCredentialCount += providerCredentialCount
    return {
      ...provider,
      encryptedToken: '',
      apiKeys: [],
      activeKeyId: undefined,
      credentialMigrationRequired: provider.authMode === 'none'
        ? false
        : providerCredentialCount > 0 || provider.credentialMigrationRequired === true
    }
  })
  return { providers: cloneProviders(sanitized), excludedCredentialCount }
}

export function applyProviderProfileMutations(mutations: ProviderProfileMutation[]): ProviderView[] {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    return loadProviderProfileStore().map(toView)
  }
  return commitPreparedProviderProfileStoreMutation(prepareProviderProfileMutations(mutations))
}

export function prepareProviderProfileMutations(
  mutations: ProviderProfileMutation[]
): PreparedProviderProfileStoreMutation {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new Error('Provider Profile 操作不能为空')
  }
  const previous = cloneProviders(loadProviderProfileStore())
  const touchedTargets = new Set<string>()
  const next = [...previous]
  for (const mutation of mutations) assertProfileMutation(mutation)
  assertNoDuplicateProviderProfileTargets(mutations.map((mutation) => mutation.input))
  for (const mutation of mutations) {
    if (mutation.action === 'create') {
      next.push(providerFromProfileInput(randomUUID(), mutation.input))
      continue
    }
    applyProfileUpdate(next, mutation, touchedTargets)
  }
  return preparedStoreMutation(previous, next)
}

export function restoreProviderStoreBackup(providers: Provider[]): ProviderView[] {
  return commitPreparedProviderProfileStoreMutation(prepareProviderStoreBackupRestore(providers))
}

export function prepareProviderStoreBackupRestore(providers: Provider[]): PreparedProviderProfileStoreMutation {
  const previous = cloneProviders(loadProviderProfileStore())
  const restored = cloneProviders(providers).map(({ connectionIdentity: _identity, connectionAuthorizationPoolDigest: _poolDigest, ...provider }) => provider)
  assertProviderBackup(restored)
  const migrated = migrateLoadedProviders(restored).providers
  return preparedStoreMutation(previous, migrated)
}

export function commitPreparedProviderProfileStoreMutation(
  prepared: PreparedProviderProfileStoreMutation,
  operationId?: string
): ProviderView[] {
  assertPreparedStoreMutation(prepared)
  const current = cloneProviders(loadProviderProfileStore())
  const before = cloneProviders(prepared.before)
  const desired = cloneProviders(prepared.desired)
  if (providerProfileStoreDigest(before) !== prepared.beforeSnapshotDigest
    || providerProfileStoreDigest(desired) !== prepared.desiredSnapshotDigest
    || providerProfileStoreExactDigest(before) !== prepared.beforeExactDigest
    || providerProfileStoreExactDigest(desired) !== prepared.desiredExactDigest) {
    throw new Error('Provider Profile 操作计划完整性校验失败')
  }
  if (providerProfileStoreExactDigest(current) !== prepared.beforeExactDigest) {
    throw new Error('Provider 配置在操作准备后已变化，请重新开始')
  }
  const credentialsToForget = credentialsToForgetAfterCommit(before, desired)
  try {
    commitProviderProfileStore(desired, {
      operationId,
      expectedWriteDigest: operationId === undefined ? undefined : prepared.desiredSnapshotDigest,
      credentialsToForgetAfterCommit: credentialsToForget
    })
  } catch (error) {
    restoreProviderProfileStoreMemory(current)
    throw error
  }
  return desired.map(toView)
}

export function providerProfileStoreDigest(providers: Provider[]): string {
  return createHash('sha256').update(JSON.stringify(persistedProviders(providers))).digest('hex')
}

export function currentProviderProfileStoreDigest(): string {
  return providerProfileStoreDigest(loadProviderProfileStore())
}

function preparedStoreMutation(
  before: Provider[],
  desired: Provider[]
): PreparedProviderProfileStoreMutation {
  const clonedBefore = cloneProviders(before)
  const clonedDesired = cloneProviders(prepareProviderConnectionSet(before, desired))
  return {
    before: clonedBefore,
    desired: clonedDesired,
    beforeSnapshotDigest: providerProfileStoreDigest(clonedBefore),
    desiredSnapshotDigest: providerProfileStoreDigest(clonedDesired),
    beforeExactDigest: providerProfileStoreExactDigest(clonedBefore),
    desiredExactDigest: providerProfileStoreExactDigest(clonedDesired),
    credentialsToForgetAfterCommit: credentialsToForgetAfterCommit(clonedBefore, clonedDesired)
  }
}

function credentialsToForgetAfterCommit(before: Provider[], desired: Provider[]): string[] {
  const desiredIds = new Set(desired.map((provider) => provider.id))
  const providerIds = new Set(
    before.filter((provider) => !desiredIds.has(provider.id)).map((provider) => provider.id)
  )
  for (const provider of desired) {
    if (provider.authMode === 'none') providerIds.add(provider.id)
  }
  return [...providerIds]
}

function assertPreparedStoreMutation(
  prepared: PreparedProviderProfileStoreMutation
): asserts prepared is PreparedProviderProfileStoreMutation {
  if (!prepared
    || typeof prepared !== 'object'
    || !Array.isArray(prepared.before)
    || !Array.isArray(prepared.desired)
    || typeof prepared.beforeSnapshotDigest !== 'string'
    || typeof prepared.desiredSnapshotDigest !== 'string'
    || typeof prepared.beforeExactDigest !== 'string'
    || typeof prepared.desiredExactDigest !== 'string'
    || !Array.isArray(prepared.credentialsToForgetAfterCommit)) {
    throw new Error('Provider Profile 操作计划无效')
  }
}

function providerProfileStoreExactDigest(providers: Provider[]): string {
  return createHash('sha256').update(JSON.stringify(providers)).digest('hex')
}

function applyProfileUpdate(
  providers: Provider[],
  mutation: ProviderProfileMutation,
  touchedTargets: Set<string>
): void {
  const targetProviderId = mutation.targetProviderId?.trim() ?? ''
  if (!targetProviderId || touchedTargets.has(targetProviderId)) {
    throw new Error('Provider Profile 更新目标无效或重复')
  }
  const index = providers.findIndex((provider) => provider.id === targetProviderId)
  if (index < 0) throw new Error('Provider Profile 更新目标不存在')
  touchedTargets.add(targetProviderId)
  providers[index] = providerWithProfileInput(providers[index], mutation.input)
}

function providerFromProfileInput(providerId: string, input: ProviderInput): Provider {
  const fields = normalizedProfileFields(input)
  return {
    id: providerId,
    name: input.name.trim(),
    baseUrl: fields.baseUrl,
    encryptedToken: '',
    apiKeys: [],
    credentialRoutingMode: input.credentialRoutingMode ?? 'preferred',
    models: [...input.models],
    authMode: fields.authMode,
    engine: fields.engine,
    customHeaders: fields.customHeaders,
    credentialHeaderNames: fields.credentialHeaderNames,
    budgetUsd: normalizeBudget(input.budgetUsd),
    openaiProtocol: input.openaiProtocol,
    note: input.note?.trim() || undefined,
    authorization: normalizeProviderAuthorization(input.authorization),
    advancedConfig: normalizeProviderAdvancedConfig(input.advancedConfig),
    createdAt: Date.now()
  }
}

function providerWithProfileInput(provider: Provider, input: ProviderInput): Provider {
  const nextEngine = input.engine ?? resolveProviderEngine(provider)
  const replaceOptionalConfiguration = { replaceOptionalConfiguration: true }
  const fields = resolveProviderPatchFields(provider, input, {
    normalizedCustomHeaders,
    normalizedCredentialHeaderNames,
    normalizeBaseUrl,
    resolveProviderEngine
  }, replaceOptionalConfiguration)
  const authMode = normalizeProviderAuthMode(input.authMode ?? provider.authMode, fields.baseUrl, nextEngine)
  const keys = authMode === 'none' ? [] : normalizedProviderKeys(provider)
  const activeKeyId = activeKeyIdFor(provider, keys)
  const next = mergeProviderPatch(provider, { ...input, authMode }, fields, keys, activeKeyId, {
    normalizeBudget,
    resolveProviderEngine
  }, replaceOptionalConfiguration)
  next.authorization = input.authorization === undefined
    ? provider.authorization
    : normalizeProviderAuthorization(input.authorization)
  next.advancedConfig = input.advancedConfig === undefined
    ? provider.advancedConfig
    : normalizeProviderAdvancedConfig(input.advancedConfig)
  return next
}

function normalizedProfileFields(input: ProviderInput): {
  baseUrl: string
  authMode: Provider['authMode']
  engine: NonNullable<Provider['engine']>
  customHeaders?: string
  credentialHeaderNames?: string[]
} {
  const engine = input.engine ?? 'openai'
  const baseUrl = normalizeBaseUrl(input.baseUrl, engine, input.openaiProtocol)
  const authMode = normalizeProviderAuthMode(input.authMode, baseUrl, engine)
  return {
    baseUrl,
    authMode,
    engine,
    customHeaders: normalizedCustomHeaders(input.customHeaders),
    credentialHeaderNames: resolvedProviderCredentialHeaderNames({
      authMode,
      engine,
      credentialHeaderNames: normalizedCredentialHeaderNames(input.credentialHeaderNames)
    })
  }
}

function assertProfileMutation(mutation: ProviderProfileMutation): void {
  if (!mutation || (mutation.action !== 'create' && mutation.action !== 'update')) {
    throw new Error('Provider Profile 操作无效')
  }
  const input = mutation.input
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('Provider Profile 名称不能为空')
  if (!Array.isArray(input.models)) throw new Error('Provider Profile 模型列表无效')
  if (hasCredentialMutation(input)) throw new Error('Provider Profile 不接受凭据字段')
  assertProviderCredentialInput(input)
  normalizedProfileFields(input)
}

function hasCredentialMutation(input: ProviderInput): boolean {
  return input.token !== undefined
    || input.additionalTokens !== undefined
    || input.keyUpdates !== undefined
    || input.removeKeyIds !== undefined
    || input.activeKeyId !== undefined
}

function assertProviderBackup(providers: Provider[]): void {
  if (!Array.isArray(providers) || providers.length > 1_000) throw new Error('Provider 备份无效')
  const ids = new Set<string>()
  for (const provider of providers) {
    if (!validBackupProvider(provider) || ids.has(provider.id)) throw new Error('Provider 备份内容无效')
    ids.add(provider.id)
  }
}

function validBackupProvider(provider: Provider): boolean {
  return Boolean(provider)
    && typeof provider.id === 'string'
    && Boolean(provider.id.trim())
    && typeof provider.name === 'string'
    && Boolean(provider.name.trim())
    && typeof provider.baseUrl === 'string'
    && Array.isArray(provider.models)
    && Number.isFinite(provider.createdAt)
}

function cloneProviders(providers: Provider[]): Provider[] {
  return JSON.parse(JSON.stringify(providers)) as Provider[]
}
