import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import type {
  ProviderAdvancedConfig,
  ProviderInput,
  ProviderNativeCredentialKind,
  ProviderNativeImportApplyResult,
  ProviderNativeImportBackupView,
  ProviderNativeImportDiff,
  ProviderNativeImportPreview,
  ProviderNativeImportRollbackResult,
  ProviderNativeImportWarning,
  ProviderProfileImportAction,
  ProviderRuntimeConfig,
  ProviderView
} from '../../shared/types'
import { createProvider, deleteProvider, listProviders, updateProvider } from '../providers'
import { normalizeBaseUrl } from './providerBaseUrl'

const PREVIEW_TTL_MS = 15 * 60 * 1_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_PENDING = 12
const BACKUP_KIND = 'caogen-provider-native-import-backup'
const BACKUP_VERSION = 1
const BACKUP_ID = /^[0-9TZ-]{19,40}-[0-9a-f-]{36}$/i
const IMPORTED_KEY_LABEL = 'Codex import'
const OFFICIAL_API_BASE = 'https://api.openai.com/v1'

interface ParsedCodexConfig {
  input: ProviderInput
  credentialKind: ProviderNativeCredentialKind
  credentialImportable: boolean
  token?: string
  ignoredSections: string[]
  warnings: ProviderNativeImportWarning[]
  configPresent: boolean
  authPresent: boolean
  source: ProviderNativeImportPreview['source']
  sourceDigest: string
}

interface PendingNativeImport {
  createdAt: number
  preview: ProviderNativeImportPreview
  input: ProviderInput
  token?: string
  sourceDigest: string
  providerDigest: string
}

interface NativeImportBackupDocument {
  kind: typeof BACKUP_KIND
  schemaVersion: typeof BACKUP_VERSION
  id: string
  client: 'codex'
  createdAt: string
  action: 'create' | 'update'
  providerId: string
  providerName: string
  addedKeyIds: string[]
  previous?: ProviderView
  rolledBackAt?: string
  payloadDigest: string
}

const pendingImports = new Map<string, PendingNativeImport>()

export function previewCodexNativeProviderImport(): ProviderNativeImportPreview {
  prunePendingImports()
  const parsed = parseCodexNativeConfig()
  const providers = listProviders()
  const match = matchProvider(parsed.input, providers)
  const diffs = buildDiffs(parsed, match.target)
  const canUpdate = match.conflict === 'same_provider' && Boolean(match.target)
  const defaultAction: ProviderProfileImportAction = canUpdate
    ? diffs.length > 0 ? 'update' : 'skip'
    : match.conflict === 'none' ? 'create' : 'skip'
  const previewId = randomUUID()
  const preview: ProviderNativeImportPreview = {
    previewId,
    client: 'codex',
    source: parsed.source,
    configPresent: parsed.configPresent,
    authPresent: parsed.authPresent,
    providerName: parsed.input.name,
    baseUrl: parsed.input.baseUrl,
    models: [...parsed.input.models],
    protocol: parsed.input.openaiProtocol ?? 'responses',
    runtime: parsed.input.advancedConfig?.runtime,
    credentialKind: parsed.credentialKind,
    credentialImportable: parsed.credentialImportable && !Boolean(match.target?.hasToken),
    targetProviderId: match.target?.id,
    targetProviderName: match.target?.name,
    conflict: match.conflict,
    diffs,
    ignoredSections: parsed.ignoredSections,
    warnings: [
      ...parsed.warnings,
      ...(match.target?.hasToken && parsed.credentialImportable
        ? ['existing_credential_preserved' as const]
        : [])
    ],
    defaultAction,
    allowedActions: canUpdate ? ['update', 'create', 'skip'] : ['create', 'skip'],
    expiresAt: Date.now() + PREVIEW_TTL_MS
  }
  pendingImports.set(previewId, {
    createdAt: Date.now(),
    preview,
    input: parsed.input,
    token: parsed.token,
    sourceDigest: parsed.sourceDigest,
    providerDigest: providerConfigurationDigest(providers)
  })
  return preview
}

export function applyCodexNativeProviderImport(
  previewId: string,
  action: ProviderProfileImportAction
): ProviderNativeImportApplyResult {
  prunePendingImports()
  const pending = pendingImports.get(previewId.trim())
  if (!pending) throw new Error('Codex import preview expired; scan the native configuration again')
  if (!pending.preview.allowedActions.includes(action) || action === 'skip') {
    throw new Error('Codex import action is not applicable')
  }
  if (parseCodexNativeConfig().sourceDigest !== pending.sourceDigest) {
    pendingImports.delete(previewId)
    throw new Error('Codex configuration changed after preview; scan it again before applying')
  }
  const beforeProviders = listProviders()
  if (providerConfigurationDigest(beforeProviders) !== pending.providerDigest) {
    pendingImports.delete(previewId)
    throw new Error('CaoGen Provider configuration changed after preview; scan it again before applying')
  }

  const operationId = randomUUID()
  let provider: ProviderView
  let backup: ProviderNativeImportBackupView
  if (action === 'create') {
    provider = createProvider(nativeCreateInput(pending))
    try {
      backup = writeNativeBackup({ operationId, action, provider, addedKeyIds: provider.apiKeys?.map((key) => key.id) ?? [] })
    } catch (error) {
      deleteProvider(provider.id)
      throw error
    }
  } else {
    const target = requireTarget(pending.preview.targetProviderId, beforeProviders)
    const beforeKeyIds = new Set(target.apiKeys?.map((key) => key.id) ?? [])
    provider = updateProvider(target.id, nativeUpdateInput(pending, target))
    const addedKeyIds = (provider.apiKeys ?? []).map((key) => key.id).filter((id) => !beforeKeyIds.has(id))
    try {
      backup = writeNativeBackup({ operationId, action, provider, previous: target, addedKeyIds })
    } catch (error) {
      restoreUpdatedProvider(target, addedKeyIds)
      throw error
    }
  }
  pendingImports.delete(previewId)
  return { operationId, action, provider, providers: listProviders(), backup }
}

export function listProviderNativeImportBackups(): ProviderNativeImportBackupView[] {
  const root = backupRoot()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const backup = readBackup(join(root, name))
        return backup.rolledBackAt ? [] : [backupView(backup)]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function rollbackProviderNativeImportBackup(backupId: string): ProviderNativeImportRollbackResult {
  const id = backupId.trim()
  if (!BACKUP_ID.test(id)) throw new Error('Native Provider import backup id is invalid')
  const filePath = join(backupRoot(), `${id}.json`)
  const backup = readBackup(filePath)
  if (backup.rolledBackAt) throw new Error('Native Provider import backup was already rolled back')
  if (backup.action === 'create') {
    const current = listProviders().find((provider) => provider.id === backup.providerId)
    if (!current) throw new Error('Imported Provider no longer exists')
    deleteProvider(backup.providerId)
  } else {
    if (!backup.previous) throw new Error('Native Provider import backup is incomplete')
    restoreUpdatedProvider(backup.previous, backup.addedKeyIds)
  }
  const rolledBack = withDigest({ ...withoutDigest(backup), rolledBackAt: new Date().toISOString() })
  writeAtomicJson(filePath, rolledBack, false)
  return { operationId: randomUUID(), restoredBackupId: id, providers: listProviders() }
}

function parseCodexNativeConfig(): ParsedCodexConfig {
  const source = process.env.CODEX_HOME?.trim() ? 'environment-override' : 'user-profile'
  const root = resolve(process.env.CODEX_HOME?.trim() || join(app.getPath('home'), '.codex'))
  const configPath = join(root, 'config.toml')
  const authPath = join(root, 'auth.json')
  const configPresent = existsSync(configPath)
  const authPresent = existsSync(authPath)
  if (!configPresent && !authPresent) throw new Error('Codex configuration was not found')
  const configText = configPresent ? readRegularFile(configPath) : ''
  const authText = authPresent ? readRegularFile(authPath) : ''
  let config: Record<string, unknown> = {}
  let auth: Record<string, unknown> = {}
  try {
    if (configText.trim()) config = record(parseToml(configText)) ?? {}
  } catch (error) {
    throw new Error(`Codex config.toml is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    if (authText.trim()) auth = record(JSON.parse(authText)) ?? {}
  } catch {
    throw new Error('Codex auth.json is invalid JSON')
  }

  const providerKey = stringValue(config.model_provider)
  const providers = record(config.model_providers)
  const providerTable = providerKey && providers ? record(providers[providerKey]) : undefined
  const active = providerTable ?? config
  const model = stringValue(config.model)
  const protocol = wireProtocol(stringValue(active.wire_api) ?? stringValue(config.wire_api))
  const authCredential = stringValue(auth.OPENAI_API_KEY)
  const inlineCredential = stringValue(active.experimental_bearer_token) ?? stringValue(config.experimental_bearer_token)
  const envKey = safeEnvironmentKey(stringValue(active.env_key))
  const environmentCredential = envKey ? stringValue(process.env[envKey]) : undefined
  const token = authCredential ?? inlineCredential ?? environmentCredential
  const credentialKind: ProviderNativeCredentialKind = authCredential || inlineCredential
    ? 'api-key'
    : environmentCredential ? 'environment' : 'none'
  const rawBaseUrl = stringValue(active.base_url) ?? stringValue(config.base_url)
    ?? OFFICIAL_API_BASE
  const baseUrl = normalizeBaseUrl(rawBaseUrl, 'openai', protocol)
  const runtime = codexRuntime(config)
  const providerName = stringValue(active.name) ?? (providerKey ? `Codex ${providerKey}` : 'Codex')
  const ignoredSections = Object.keys(config)
    .filter((key) => !new Set([
      'model_provider', 'model_providers', 'model', 'model_reasoning_effort', 'model_verbosity',
      'disable_response_storage', 'service_tier', 'temperature', 'top_p', 'max_output_tokens',
      'parallel_tool_calls', 'base_url', 'wire_api', 'experimental_bearer_token'
    ]).has(key))
    .sort()
  const warnings: ProviderNativeImportWarning[] = []
  if (!token) warnings.push('credential_missing')
  if (ignoredSections.length > 0) warnings.push('ignored_sections')
  const advancedConfig: ProviderAdvancedConfig | undefined = runtime
    ? { schemaVersion: 1, runtime, metadata: { importedFrom: 'codex-native' } }
    : { schemaVersion: 1, metadata: { importedFrom: 'codex-native' } }
  return {
    input: {
      name: providerName,
      baseUrl,
      models: model ? [model] : [],
      engine: 'openai',
      openaiProtocol: protocol,
      authMode: 'api-key',
      credentialHeaderNames: ['authorization'],
      advancedConfig
    },
    credentialKind,
    credentialImportable: Boolean(token),
    token,
    ignoredSections,
    warnings,
    configPresent,
    authPresent,
    source,
    sourceDigest: createHash('sha256').update(configText).update('\0').update(authText).digest('hex')
  }
}

function codexRuntime(config: Record<string, unknown>): ProviderRuntimeConfig | undefined {
  const reasoningEffort = enumValue(config.model_reasoning_effort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const)
  const verbosity = enumValue(config.model_verbosity, ['low', 'medium', 'high'] as const)
  const serviceTier = enumValue(config.service_tier, ['auto', 'default', 'flex', 'priority'] as const)
  const disableStorage = booleanValue(config.disable_response_storage)
  const runtime: ProviderRuntimeConfig = {
    reasoningEffort,
    verbosity,
    temperature: rangedNumber(config.temperature, 0, 2),
    topP: rangedNumber(config.top_p, 0, 1),
    maxOutputTokens: positiveInteger(config.max_output_tokens),
    parallelToolCalls: booleanValue(config.parallel_tool_calls),
    storeResponses: disableStorage === undefined ? undefined : !disableStorage,
    serviceTier
  }
  return Object.values(runtime).some((value) => value !== undefined) ? runtime : undefined
}

function nativeCreateInput(pending: PendingNativeImport): ProviderInput {
  return {
    ...pending.input,
    ...(pending.token ? { token: pending.token, tokenLabel: IMPORTED_KEY_LABEL } : {})
  }
}

function nativeUpdateInput(pending: PendingNativeImport, target: ProviderView): Partial<ProviderInput> {
  const importCredential = Boolean(pending.token) && !target.hasToken
  return {
    name: target.name,
    baseUrl: pending.input.baseUrl,
    models: pending.input.models.length > 0 ? pending.input.models : target.models,
    engine: 'openai',
    openaiProtocol: pending.input.openaiProtocol,
    authMode: target.authMode,
    credentialHeaderNames: target.credentialHeaderNames,
    advancedConfig: mergeAdvancedConfig(target.advancedConfig, pending.input.advancedConfig ?? undefined),
    ...(importCredential ? { token: pending.token, tokenLabel: IMPORTED_KEY_LABEL } : {})
  }
}

function mergeAdvancedConfig(
  current: ProviderAdvancedConfig | undefined,
  incoming: ProviderAdvancedConfig | undefined
): ProviderAdvancedConfig {
  return {
    schemaVersion: 1,
    ...(current ?? {}),
    ...(incoming ?? {}),
    runtime: { ...(current?.runtime ?? {}), ...(incoming?.runtime ?? {}) },
    metadata: { ...(current?.metadata ?? {}), ...(incoming?.metadata ?? {}) }
  }
}

function matchProvider(input: ProviderInput, providers: ProviderView[]): {
  target?: ProviderView
  conflict: ProviderNativeImportPreview['conflict']
} {
  const exact = providers.filter((provider) =>
    normalizedUrl(provider.baseUrl) === normalizedUrl(input.baseUrl)
      && provider.engine === 'openai'
      && (provider.openaiProtocol ?? 'responses') === (input.openaiProtocol ?? 'responses'))
  if (exact.length === 1) return { target: exact[0], conflict: 'same_provider' }
  if (exact.length > 1) return { conflict: 'ambiguous' }
  const byName = providers.filter((provider) => provider.name.trim().toLowerCase() === input.name.trim().toLowerCase())
  if (byName.length === 1) return { target: byName[0], conflict: 'name' }
  if (byName.length > 1) return { conflict: 'ambiguous' }
  return { conflict: 'none' }
}

function buildDiffs(parsed: ParsedCodexConfig, target: ProviderView | undefined): ProviderNativeImportDiff[] {
  if (!target) {
    return [
      { field: 'name', incoming: parsed.input.name },
      { field: 'baseUrl', incoming: parsed.input.baseUrl },
      { field: 'models', incoming: parsed.input.models.join(', ') || '-' },
      { field: 'protocol', incoming: parsed.input.openaiProtocol ?? 'responses' },
      { field: 'runtime', incoming: runtimeSummary(parsed.input.advancedConfig?.runtime) },
      { field: 'credential', incoming: parsed.credentialKind }
    ]
  }
  const diffs: ProviderNativeImportDiff[] = []
  addDiff(diffs, 'baseUrl', target.baseUrl, parsed.input.baseUrl)
  addDiff(diffs, 'models', target.models.join(', ') || '-', parsed.input.models.join(', ') || target.models.join(', ') || '-')
  addDiff(diffs, 'protocol', target.openaiProtocol ?? 'responses', parsed.input.openaiProtocol ?? 'responses')
  const mergedRuntime = { ...(target.advancedConfig?.runtime ?? {}), ...(parsed.input.advancedConfig?.runtime ?? {}) }
  addDiff(diffs, 'runtime', runtimeSummary(target.advancedConfig?.runtime), runtimeSummary(mergedRuntime))
  if (parsed.credentialImportable && !target.hasToken) {
    diffs.push({ field: 'credential', current: 'not configured', incoming: parsed.credentialKind })
  }
  return diffs
}

function addDiff(
  diffs: ProviderNativeImportDiff[],
  field: ProviderNativeImportDiff['field'],
  current: string,
  incoming: string
): void {
  if (current !== incoming) diffs.push({ field, current, incoming })
}

function restoreUpdatedProvider(previous: ProviderView, addedKeyIds: string[]): ProviderView {
  return updateProvider(previous.id, {
    name: previous.name,
    baseUrl: previous.baseUrl,
    models: previous.models,
    engine: previous.engine,
    authMode: previous.authMode,
    customHeaders: previous.customHeaders ?? '',
    credentialHeaderNames: previous.credentialHeaderNames,
    budgetUsd: previous.budgetUsd,
    openaiProtocol: previous.openaiProtocol,
    note: previous.note ?? '',
    advancedConfig: previous.advancedConfig ?? null,
    removeKeyIds: addedKeyIds,
    activeKeyId: previous.activeKeyId
  })
}

function writeNativeBackup(input: {
  operationId: string
  action: 'create' | 'update'
  provider: ProviderView
  previous?: ProviderView
  addedKeyIds: string[]
}): ProviderNativeImportBackupView {
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`
  const document = withDigest({
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_VERSION,
    id,
    client: 'codex' as const,
    createdAt,
    action: input.action,
    providerId: input.provider.id,
    providerName: input.provider.name,
    addedKeyIds: [...input.addedKeyIds],
    previous: input.previous
  })
  writeAtomicJson(join(backupRoot(), `${id}.json`), document, true)
  return backupView(document)
}

function readBackup(filePath: string): NativeImportBackupDocument {
  const value = JSON.parse(readRegularFile(filePath, true)) as Partial<NativeImportBackupDocument>
  if (value.kind !== BACKUP_KIND || value.schemaVersion !== BACKUP_VERSION || typeof value.id !== 'string'
    || !BACKUP_ID.test(value.id) || basename(filePath, '.json') !== value.id
    || (value.action !== 'create' && value.action !== 'update') || typeof value.payloadDigest !== 'string'
    || typeof value.providerId !== 'string' || typeof value.providerName !== 'string'
    || !Array.isArray(value.addedKeyIds)) {
    throw new Error('Native Provider import backup is invalid')
  }
  const document = value as NativeImportBackupDocument
  const { payloadDigest, ...payload } = document
  if (digest(payload) !== payloadDigest) throw new Error('Native Provider import backup integrity check failed')
  return document
}

function backupView(document: NativeImportBackupDocument): ProviderNativeImportBackupView {
  return {
    id: document.id,
    client: document.client,
    createdAt: document.createdAt,
    action: document.action,
    providerId: document.providerId,
    providerName: document.providerName,
    addedCredentialCount: document.addedKeyIds.length
  }
}

function writeAtomicJson(filePath: string, value: NativeImportBackupDocument, exclusive: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    const descriptor = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    if (exclusive && existsSync(filePath)) throw new Error('Native Provider import backup already exists')
    renameSync(temp, filePath)
    if (process.platform !== 'win32') chmodSync(filePath, 0o600)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
}

function readRegularFile(filePath: string, backup = false): string {
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
    throw new Error(backup ? 'Native Provider import backup is invalid' : 'Codex configuration file is invalid')
  }
  return readFileSync(filePath, 'utf8')
}

function backupRoot(): string {
  return join(app.getPath('userData'), 'provider-native-import-backups')
}

function providerConfigurationDigest(providers: ProviderView[]): string {
  return digest(providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models,
    engine: provider.engine,
    authMode: provider.authMode,
    customHeaders: provider.customHeaders,
    credentialHeaderNames: provider.credentialHeaderNames,
    budgetUsd: provider.budgetUsd,
    openaiProtocol: provider.openaiProtocol,
    note: provider.note,
    authorization: provider.authorization,
    advancedConfig: provider.advancedConfig,
    activeKeyId: provider.activeKeyId,
    keys: provider.apiKeys?.map((key) => ({ id: key.id, label: key.label, disabled: key.disabled }))
  })))
}

function prunePendingImports(): void {
  const expired = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingImports) if (pending.createdAt < expired) pendingImports.delete(id)
  while (pendingImports.size >= MAX_PENDING) {
    const first = pendingImports.keys().next().value as string | undefined
    if (!first) break
    pendingImports.delete(first)
  }
}

function requireTarget(id: string | undefined, providers: ProviderView[]): ProviderView {
  const target = id ? providers.find((provider) => provider.id === id) : undefined
  if (!target) throw new Error('Codex import target Provider is unavailable')
  return target
}

function wireProtocol(value: string | undefined): 'responses' | 'chat' {
  return value === 'chat' || value === 'chat_completions' ? 'chat' : 'responses'
}

function runtimeSummary(runtime: ProviderRuntimeConfig | undefined): string {
  const values = Object.entries(runtime ?? {}).filter(([, value]) => value !== undefined)
  return values.length ? values.map(([key, value]) => `${key}=${String(value)}`).join(', ') : '-'
}

function safeEnvironmentKey(value: string | undefined): string | undefined {
  return value && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) && /(?:API_?KEY|TOKEN|CREDENTIAL)/.test(value) ? value : undefined
}

function normalizedUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function rangedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function enumValue<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.includes(value as T) ? value as T : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function withDigest<T extends Omit<NativeImportBackupDocument, 'payloadDigest'>>(value: T): NativeImportBackupDocument {
  return { ...value, payloadDigest: digest(value) }
}

function withoutDigest(value: NativeImportBackupDocument): Omit<NativeImportBackupDocument, 'payloadDigest'> {
  const { payloadDigest: _payloadDigest, ...payload } = value
  return payload
}
