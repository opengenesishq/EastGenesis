import { createHash, randomUUID } from 'node:crypto'
import type {
  EngineKind,
  Provider,
  ProviderApiKey,
  ProviderApiKeyInput,
  ProviderAuthMode,
  ProviderInput,
  ProviderView
} from '../../shared/types'
import {
  activeKeyIdFor,
  loadProviderProfileStore,
  normalizeBudget,
  persistedProviders,
  resolveProviderEngine,
  toView
} from '../providers'
import {
  forgetProviderCredential,
  forgetProviderCredentials,
  inspectProviderCredential,
  restoreProviderCredentials,
  snapshotProviderCredentials,
  storeProviderCredential
} from '../providerCredentialRuntime'
import {
  normalizeProviderCredentialPolicy,
  normalizeProviderCredentialRoutingMode
} from '../providerKeyRouting'
import {
  applyKeyUpdates,
  cleanKeyLabel,
  LEGACY_KEY_LABEL,
  normalizedProviderKeys
} from './providerKeyRecords'
import {
  mergeProviderPatch,
  providerCredentialBindingChanged,
  providerPatchReplacesCredentials,
  removeProviderKeys,
  resolveProviderPatchFields
} from './providerUpdate'
import { normalizeBaseUrl } from './providerBaseUrl'
import { prepareProviderConnectionSet } from './providerConnectionStore'
import { normalizeProviderAuthMode } from './providerAuthMode'
import { normalizeProviderAdvancedConfig, normalizeProviderAuthorization } from './providerAdvancedConfig'
import {
  assertProviderCredentialInput,
  normalizedCredentialHeaderNames,
  normalizedCustomHeaders,
  resolvedProviderCredentialHeaderNames
} from './providerCredentialHeaders'

export type AtomicProviderBatchMutation =
  | { action: 'create'; input: ProviderInput }
  | { action: 'update'; providerId: string; patch: Partial<ProviderInput> }
  | { action: 'delete'; providerId: string }

export interface AtomicProviderBatchItem {
  action: AtomicProviderBatchMutation['action']
  providerId: string
  previous?: ProviderView
  provider?: ProviderView
  addedKeyIds: string[]
}

export interface AtomicProviderBatchPreparation {
  prepared: {
    before: Provider[]
    desired: Provider[]
    beforeSnapshotDigest: string
    desiredSnapshotDigest: string
    beforeExactDigest: string
    desiredExactDigest: string
    credentialsToForgetAfterCommit: string[]
  }
  items: AtomicProviderBatchItem[]
  restoreRuntimeCredentials(): void
}

export function prepareAtomicProviderBatch(
  mutations: AtomicProviderBatchMutation[]
): AtomicProviderBatchPreparation {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new Error('Provider batch must contain at least one mutation')
  }
  const before = cloneProviderStore(loadProviderProfileStore())
  const state = {
    desired: cloneProviderStore(before),
    credentialSnapshots: new Map<string, ReturnType<typeof snapshotProviderCredentials>>(),
    touched: new Set<string>(),
    items: [] as AtomicProviderBatchItem[]
  }
  try {
    for (const mutation of mutations) applyBatchMutation(state, mutation)
  } catch (error) {
    restoreBatchCredentialSnapshots(state.credentialSnapshots)
    throw error
  }
  const replacements = new Set(mutations.flatMap((item) => item.action === 'update' && item.patch.token !== undefined ? [item.providerId] : []))
  return batchPreparation(before, state, replacements)
}

function applyBatchMutation(
  state: {
    desired: Provider[]
    credentialSnapshots: Map<string, ReturnType<typeof snapshotProviderCredentials>>
    touched: Set<string>
    items: AtomicProviderBatchItem[]
  },
  mutation: AtomicProviderBatchMutation
): void {
  if (mutation.action === 'create') return applyCreate(state, mutation.input)
  const providerId = mutation.providerId?.trim()
  if (!providerId || state.touched.has(providerId)) throw new Error('Provider batch target is invalid or duplicated')
  const index = state.desired.findIndex((provider) => provider.id === providerId)
  if (index < 0) throw new Error('Provider batch target does not exist')
  state.touched.add(providerId)
  captureCredentials(state.credentialSnapshots, providerId)
  if (mutation.action === 'delete') return applyDelete(state, index)
  applyUpdate(state, index, mutation.patch)
}

function applyCreate(
  state: Parameters<typeof applyBatchMutation>[0],
  input: ProviderInput
): void {
  const providerId = randomUUID()
  captureCredentials(state.credentialSnapshots, providerId)
  const provider = providerForAtomicBatch(providerId, input)
  state.desired.push(provider)
  state.items.push({
    action: 'create',
    providerId,
    provider: toView(provider),
    addedKeyIds: normalizedProviderKeys(provider).map((key) => key.id)
  })
}

function applyDelete(state: Parameters<typeof applyBatchMutation>[0], index: number): void {
  const previous = state.desired[index]
  state.desired = [...state.desired.slice(0, index), ...state.desired.slice(index + 1)]
  state.items.push({ action: 'delete', providerId: previous.id, previous: toView(previous), addedKeyIds: [] })
}

function applyUpdate(
  state: Parameters<typeof applyBatchMutation>[0],
  index: number,
  patch: Partial<ProviderInput>
): void {
  const previous = state.desired[index]
  const previousKeyIds = new Set(normalizedProviderKeys(previous).map((key) => key.id))
  const provider = providerForAtomicBatchUpdate(previous, patch)
  state.desired[index] = provider
  state.items.push({
    action: 'update',
    providerId: previous.id,
    previous: toView(previous),
    provider: toView(provider),
    addedKeyIds: normalizedProviderKeys(provider).map((key) => key.id).filter((id) => !previousKeyIds.has(id))
  })
}

function batchPreparation(
  before: Provider[],
  state: Parameters<typeof applyBatchMutation>[0],
  replacements: ReadonlySet<string>
): AtomicProviderBatchPreparation {
  state.desired = prepareProviderConnectionSet(before, state.desired, replacements)
  const credentialsToForgetAfterCommit = state.items
    .filter((item) => item.action === 'delete' || item.provider?.authMode === 'none')
    .map((item) => item.providerId)
  return {
    prepared: {
      before,
      desired: state.desired,
      beforeSnapshotDigest: providerStoreSnapshotDigest(before),
      desiredSnapshotDigest: providerStoreSnapshotDigest(state.desired),
      beforeExactDigest: providerStoreExactDigest(before),
      desiredExactDigest: providerStoreExactDigest(state.desired),
      credentialsToForgetAfterCommit
    },
    items: state.items,
    restoreRuntimeCredentials: () => restoreBatchCredentialSnapshots(state.credentialSnapshots)
  }
}

function providerForAtomicBatch(providerId: string, input: ProviderInput): Provider {
  assertProviderCredentialInput(input)
  const baseUrl = normalizeBaseUrl(input.baseUrl, input.engine ?? 'openai', input.openaiProtocol)
  const authMode = normalizeProviderAuthMode(input.authMode, baseUrl, input.engine ?? 'openai')
  assertNoAuthCredentialInput(authMode, input)
  const primary = typeof input.token === 'string' && input.token.trim()
    ? createApiKey(providerId, { label: input.tokenLabel, token: input.token }, LEGACY_KEY_LABEL)
    : null
  const apiKeys = appendNewKeys(providerId, primary ? [primary] : [], input.additionalTokens)
  const activeKeyId = apiKeys.find((key) => !key.disabled && keyIsAvailable(providerId, key))?.id
  const activeKey = apiKeys.find((key) => key.id === activeKeyId)
  return {
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
    customHeaders: normalizedCustomHeaders(input.customHeaders),
    credentialHeaderNames: resolvedProviderCredentialHeaderNames({
      authMode,
      engine: input.engine ?? 'openai',
      credentialHeaderNames: normalizedCredentialHeaderNames(input.credentialHeaderNames)
    }),
    budgetUsd: normalizeBudget(input.budgetUsd),
    openaiProtocol: input.openaiProtocol,
    note: input.note,
    authorization: normalizeProviderAuthorization(input.authorization),
    advancedConfig: normalizeProviderAdvancedConfig(input.advancedConfig),
    createdAt: Date.now()
  }
}

function providerForAtomicBatchUpdate(previous: Provider, patch: Partial<ProviderInput>): Provider {
  assertProviderCredentialInput(patch)
  const fields = resolveProviderPatchFields(previous, patch, {
    normalizedCustomHeaders,
    normalizedCredentialHeaderNames,
    normalizeBaseUrl,
    resolveProviderEngine
  })
  const nextEngine = patch.engine ?? resolveProviderEngine(previous)
  const authMode = normalizeProviderAuthMode(patch.authMode ?? previous.authMode, fields.baseUrl, nextEngine)
  assertNoAuthCredentialInput(authMode, patch)
  const apiKeys = updatedProviderKeys(previous.id, previous, patch, fields, nextEngine, authMode)
  const activeKeyId = activeKeyIdFor(previous, apiKeys, patch.activeKeyId)
  const next = mergeProviderPatch(previous, { ...patch, authMode }, fields, apiKeys, activeKeyId,
    { normalizeBudget, resolveProviderEngine })
  next.authorization = patch.authorization === undefined
    ? previous.authorization
    : normalizeProviderAuthorization(patch.authorization)
  next.advancedConfig = patch.advancedConfig === undefined
    ? previous.advancedConfig
    : normalizeProviderAdvancedConfig(patch.advancedConfig)
  return next
}

function createApiKey(
  providerId: string,
  input: ProviderApiKeyInput,
  fallbackLabel: string
): ProviderApiKey | null {
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

function keyIsAvailable(providerId: string, key: ProviderApiKey): boolean {
  return inspectProviderCredential(
    { providerId, keyId: key.id },
    { encryptedToken: key.encryptedToken, sessionOnly: key.sessionOnly }
  ).available
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

function updatedProviderKeys(
  providerId: string,
  previous: Provider,
  patch: Partial<ProviderInput>,
  fields: ReturnType<typeof resolveProviderPatchFields>,
  nextEngine: EngineKind,
  authMode: ProviderAuthMode
): ProviderApiKey[] {
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
  if (shouldReplaceCredentialBinding(previous, bindingCandidate, patch)) {
    for (const key of apiKeys) forgetProviderCredential({ providerId, keyId: key.id })
    apiKeys = []
  }
  apiKeys = withPrimaryToken(apiKeys, previous, patch)
  apiKeys = applyKeyUpdates(apiKeys, patch.keyUpdates)
  apiKeys = removeProviderKeys(providerId, apiKeys, patch.removeKeyIds,
    (id, keyId) => forgetProviderCredential({ providerId: id, keyId }))
  return appendNewKeys(providerId, apiKeys, patch.additionalTokens)
}

function shouldReplaceCredentialBinding(
  previous: Provider,
  candidate: Provider,
  patch: Partial<ProviderInput>
): boolean {
  return providerPatchReplacesCredentials(patch)
    && (previous.credentialMigrationRequired === true
      || providerCredentialBindingChanged(previous, candidate, resolveProviderEngine))
}

function withPrimaryToken(
  keys: ProviderApiKey[],
  provider: Provider,
  patch: Partial<ProviderInput>
): ProviderApiKey[] {
  const configuredActive = keys.find((key) => key.id === provider.activeKeyId && !key.disabled)
    ?? keys.find((key) => !key.disabled)
  if (patch.token !== undefined) return replacePrimaryToken(keys, provider, patch, configuredActive)
  if (patch.tokenLabel !== undefined && configuredActive) {
    return keys.map((key) => key.id === configuredActive.id
      ? { ...key, label: cleanKeyLabel(patch.tokenLabel, LEGACY_KEY_LABEL) }
      : key)
  }
  return keys
}

function replacePrimaryToken(
  keys: ProviderApiKey[],
  provider: Provider,
  patch: Partial<ProviderInput>,
  configuredActive: ProviderApiKey | undefined
): ProviderApiKey[] {
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

function assertNoAuthCredentialInput(authMode: ProviderAuthMode, input: Partial<ProviderInput>): void {
  if (authMode !== 'none') return
  if (input.token?.trim() || input.additionalTokens?.some((item) => Boolean(item.token.trim()))) {
    throw new Error('No-auth Provider cannot accept API credentials')
  }
}

function captureCredentials(
  snapshots: Map<string, ReturnType<typeof snapshotProviderCredentials>>,
  providerId: string
): void {
  if (!snapshots.has(providerId)) snapshots.set(providerId, snapshotProviderCredentials(providerId))
}

function cloneProviderStore(providers: Provider[]): Provider[] {
  return JSON.parse(JSON.stringify(providers)) as Provider[]
}

function providerStoreSnapshotDigest(providers: Provider[]): string {
  return createHash('sha256').update(JSON.stringify(persistedProviders(providers))).digest('hex')
}

function providerStoreExactDigest(providers: Provider[]): string {
  return createHash('sha256').update(JSON.stringify(providers)).digest('hex')
}

function restoreBatchCredentialSnapshots(
  snapshots: Map<string, ReturnType<typeof snapshotProviderCredentials>>
): void {
  for (const [providerId, snapshot] of snapshots) restoreProviderCredentials(providerId, snapshot)
}
