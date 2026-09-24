import type {
  EngineKind,
  OpenAIProtocol,
  ProviderAuthMode,
  ProviderInput,
  ProviderProfileConflictKind,
  ProviderProfileImportAction,
  ProviderProfileImportItem,
  ProviderView,
  ProviderAuthorization,
  ProviderAdvancedConfig
} from '../../shared/types'
import { normalizeBaseUrl } from './providerBaseUrl'
import { normalizeProviderAuthMode } from './providerAuthMode'
import { normalizeProviderAdvancedConfig, normalizeProviderAuthorization } from './providerAdvancedConfig'
import {
  normalizedCredentialHeaderNames,
  resolvedProviderCredentialHeaderNames
} from './providerCredentialHeaders'

const PROFILE_KIND = 'caogen-provider-profile'
const PROFILE_SCHEMA_VERSION = 1
const MAX_PROVIDERS = 100
const MAX_MODELS = 500
const CREDENTIAL_BINDING_FIELDS = new Set([
  'baseUrl', 'engine', 'openaiProtocol', 'customHeaders', 'credentialHeaderNames'
])

export interface PortableProviderProfileEntry {
  name: string
  baseUrl: string
  models: string[]
  engine: EngineKind
  customHeaders?: string
  credentialHeaderNames?: string[]
  budgetUsd?: number
  openaiProtocol?: OpenAIProtocol
  authMode?: ProviderAuthMode
  note?: string
  authorization?: ProviderAuthorization
  advancedConfig?: ProviderAdvancedConfig
}

export interface ParsedProviderProfile {
  entries: PortableProviderProfileEntry[]
  credentialFieldsIgnored: number
  warnings: string[]
}

export interface PlannedProviderProfileItem {
  view: ProviderProfileImportItem
  input: ProviderInput
}

export function renderProviderProfile(providers: ProviderView[], exportedAt = new Date().toISOString()): string {
  const document = {
    kind: PROFILE_KIND,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    exportedAt,
    providers: providers.map(portableEntryFromView)
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

export function parseProviderProfile(raw: string): ParsedProviderProfile {
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Provider Profile 文件不能超过 2 MB')
  }
  let value: unknown
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('Provider Profile 不是有效 JSON')
  }
  const root = recordValue(value)
  if (root) {
    if (root.kind !== undefined && root.kind !== PROFILE_KIND) throw new Error('Provider Profile 类型不受支持')
    if (root.schemaVersion !== undefined && root.schemaVersion !== PROFILE_SCHEMA_VERSION) {
      throw new Error('Provider Profile 版本不受支持')
    }
  }
  const source = Array.isArray(value) ? value : root?.providers
  if (!Array.isArray(source) || source.length === 0) throw new Error('Provider Profile 中没有 Provider')
  if (source.length > MAX_PROVIDERS) throw new Error(`Provider Profile 最多包含 ${MAX_PROVIDERS} 个 Provider`)

  const entries = source.map((entry, index) => parseEntry(entry, index))
  assertNoDuplicateEntries(entries)
  const credentialFieldsIgnored = countCredentialFields(value)
  return {
    entries,
    credentialFieldsIgnored,
    warnings: credentialFieldsIgnored > 0
      ? [`检测到 ${credentialFieldsIgnored} 个凭据字段；已忽略，Key 必须在 EastGenesis 中单独录入。`]
      : []
  }
}

export function planProviderProfileImport(
  entries: PortableProviderProfileEntry[],
  existing: ProviderView[]
): PlannedProviderProfileItem[] {
  return entries.map((entry, index) => {
    const input = toProviderInput(entry)
    const normalizedEntry: PortableProviderProfileEntry = {
      ...entry,
      baseUrl: input.baseUrl,
      authMode: input.authMode
    }
    const matches = matchingProviders(normalizedEntry, existing)
    const target = matches.length === 1 ? matches[0].provider : undefined
    const conflict = conflictKind(matches)
    const changedFields = target ? changedProviderFields(normalizedEntry, target) : []
    const defaultAction = defaultImportAction(target, conflict, changedFields)
    return {
      input,
      view: {
        id: `profile-${index + 1}`,
        name: normalizedEntry.name,
        baseUrl: normalizedEntry.baseUrl,
        models: [...normalizedEntry.models],
        engine: normalizedEntry.engine,
        openaiProtocol: normalizedEntry.openaiProtocol,
        authMode: normalizedEntry.authMode ?? 'api-key',
        targetProviderId: target?.id,
        targetProviderName: target?.name,
        targetKeyCount: target ? target.keyCount ?? Number(target.hasToken) : undefined,
        targetActiveKeyLabel: target?.activeKeyLabel,
        targetCredentialMigrationRequired: target?.credentialMigrationRequired === true,
        targetCredentialBindingChanged: changedFields.some((field) => CREDENTIAL_BINDING_FIELDS.has(field)),
        conflict,
        changedFields,
        defaultAction,
        allowedActions: allowedActions(conflict, target)
      }
    }
  })
}

function portableEntryFromView(provider: ProviderView): PortableProviderProfileEntry {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: [...provider.models],
    engine: provider.engine,
    authMode: provider.authMode,
    customHeaders: provider.customHeaders,
    credentialHeaderNames: provider.credentialHeaderNames,
    budgetUsd: provider.budgetUsd || undefined,
    openaiProtocol: provider.openaiProtocol,
    note: provider.note,
    authorization: provider.authorization,
    advancedConfig: provider.advancedConfig
  }
}

function parseEntry(value: unknown, index: number): PortableProviderProfileEntry {
  const entry = recordValue(value)
  if (!entry) throw new Error(`第 ${index + 1} 个 Provider 不是对象`)
  const name = boundedRequiredString(entry.name, 120, `第 ${index + 1} 个 Provider 名称`)
  const baseUrl = boundedOptionalString(entry.baseUrl, 2048, `Provider ${name} Base URL`) ?? ''
  const models = uniqueStrings(entry.models, MAX_MODELS, 240, `Provider ${name} 模型`)
  const engine = engineValue(entry.engine)
  const openaiProtocol = protocolValue(entry.openaiProtocol)
  const authMode = authModeValue(entry.authMode)
  const authorization = normalizeProviderAuthorization(entry.authorization)
  const advancedConfig = normalizeProviderAdvancedConfig(entry.advancedConfig)
  return {
    authorization,
    advancedConfig,
    name,
    baseUrl,
    models,
    engine,
    authMode,
    customHeaders: boundedOptionalString(entry.customHeaders, 8_000, `Provider ${name} 自定义请求头`),
    credentialHeaderNames: uniqueStrings(entry.credentialHeaderNames, 8, 80, `Provider ${name} 凭据头`),
    budgetUsd: budgetValue(entry.budgetUsd),
    openaiProtocol,
    note: boundedOptionalString(entry.note, 1_000, `Provider ${name} 备注`)
  }
}

function toProviderInput(entry: PortableProviderProfileEntry): ProviderInput {
  const baseUrl = normalizeBaseUrl(entry.baseUrl, entry.engine, entry.openaiProtocol)
  const authMode = normalizeProviderAuthMode(entry.authMode, baseUrl, entry.engine)
  return {
    authorization: normalizeProviderAuthorization(entry.authorization),
    advancedConfig: normalizeProviderAdvancedConfig(entry.advancedConfig),
    name: entry.name,
    baseUrl,
    models: [...entry.models],
    engine: entry.engine,
    authMode,
    customHeaders: entry.customHeaders,
    credentialHeaderNames: entry.credentialHeaderNames,
    budgetUsd: entry.budgetUsd,
    openaiProtocol: entry.openaiProtocol,
    note: entry.note
  }
}

function matchingProviders(
  entry: PortableProviderProfileEntry,
  providers: ProviderView[]
): Array<{ provider: ProviderView; byName: boolean; byTarget: boolean }> {
  const name = normalizedName(entry.name)
  const target = normalizedTarget(entry)
  return providers.flatMap((provider) => {
    const byName = normalizedName(provider.name) === name
    const byTarget = Boolean(target) && normalizedTarget(provider) === target
    return byName || byTarget ? [{ provider, byName, byTarget }] : []
  })
}

function conflictKind(
  matches: Array<{ provider: ProviderView; byName: boolean; byTarget: boolean }>
): ProviderProfileConflictKind {
  if (matches.length === 0) return 'none'
  if (matches.length !== 1) return 'ambiguous'
  if (matches[0].byName && matches[0].byTarget) return 'same_provider'
  return matches[0].byName ? 'name' : 'target'
}

function defaultImportAction(
  target: ProviderView | undefined,
  conflict: ProviderProfileConflictKind,
  changedFields: string[]
): ProviderProfileImportAction {
  if (conflict === 'ambiguous' || conflict === 'name') return 'skip'
  if (!target) return 'create'
  return changedFields.length === 0 ? 'skip' : 'update'
}

function allowedActions(
  conflict: ProviderProfileConflictKind,
  target: ProviderView | undefined
): ProviderProfileImportAction[] {
  if (conflict === 'ambiguous' || conflict === 'name') return ['skip', 'create']
  return target ? ['update', 'create', 'skip'] : ['create', 'skip']
}

function changedProviderFields(entry: PortableProviderProfileEntry, provider: ProviderView): string[] {
  const entryCredentialHeaderNames = resolvedProviderCredentialHeaderNames({
    authMode: entry.authMode ?? 'api-key',
    engine: entry.engine,
    credentialHeaderNames: normalizedCredentialHeaderNames(entry.credentialHeaderNames)
  })
  const providerCredentialHeaderNames = resolvedProviderCredentialHeaderNames(provider)
  const pairs: Array<[string, unknown, unknown]> = [
    ['name', entry.name, provider.name],
    ['baseUrl', entry.baseUrl, provider.baseUrl],
    ['models', entry.models, provider.models],
    ['engine', entry.engine, provider.engine],
    ['authMode', entry.authMode ?? 'api-key', provider.authMode ?? 'api-key'],
    ['customHeaders', entry.customHeaders ?? '', provider.customHeaders ?? ''],
    ['credentialHeaderNames', entryCredentialHeaderNames, providerCredentialHeaderNames],
    ['budgetUsd', entry.budgetUsd ?? 0, provider.budgetUsd ?? 0],
    ['openaiProtocol', entry.openaiProtocol ?? '', provider.openaiProtocol ?? ''],
    ['note', entry.note ?? '', provider.note ?? ''],
    ['authorization', entry.authorization ?? null, provider.authorization ?? null],
    ['advancedConfig', entry.advancedConfig ?? null, provider.advancedConfig ?? null]
  ]
  return pairs.filter(([, next, current]) => JSON.stringify(next) !== JSON.stringify(current)).map(([name]) => name)
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizedProviderProfileTarget(
  provider: Pick<PortableProviderProfileEntry, 'baseUrl' | 'openaiProtocol'> & {
    engine?: EngineKind
  }
): string {
  const engine = provider.engine ?? 'openai'
  const baseUrl = normalizeBaseUrl(provider.baseUrl, engine, provider.openaiProtocol)
  if (!baseUrl) return ''
  let canonicalUrl = baseUrl.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(canonicalUrl)
    parsed.protocol = parsed.protocol.toLowerCase()
    parsed.hostname = parsed.hostname.toLowerCase()
    canonicalUrl = parsed.toString().replace(/\/+$/, '')
  } catch {
    // normalizeBaseUrl already rejects invalid non-empty URLs. Keep the fallback
    // case-sensitive so a future engine-owned endpoint is never over-matched.
  }
  return `${engine}\n${provider.openaiProtocol ?? ''}\n${canonicalUrl}`
}

export function assertNoDuplicateProviderProfileTargets(
  entries: Array<Pick<PortableProviderProfileEntry, 'name' | 'baseUrl' | 'openaiProtocol'> & { engine?: EngineKind }>
): void {
  const names = new Set<string>()
  const targets = new Set<string>()
  for (const entry of entries) {
    const name = normalizedName(entry.name)
    if (names.has(name)) throw new Error(`Provider Profile 中名称重复: ${entry.name}`)
    names.add(name)
    const target = normalizedProviderProfileTarget(entry)
    if (target && targets.has(target)) throw new Error(`Provider Profile 中目标重复: ${entry.name}`)
    if (target) targets.add(target)
  }
}

function normalizedTarget(
  provider: Pick<PortableProviderProfileEntry, 'baseUrl' | 'engine' | 'openaiProtocol'>
): string {
  return normalizedProviderProfileTarget(provider)
}

function assertNoDuplicateEntries(entries: PortableProviderProfileEntry[]): void {
  assertNoDuplicateProviderProfileTargets(entries)
}

function countCredentialFields(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countCredentialFields(item), 0)
  const record = recordValue(value)
  if (!record) return 0
  let count = 0
  for (const [key, child] of Object.entries(record)) {
    if (key !== 'credentialHeaderNames' && /(?:api.?key|token|secret|password|encrypted|credentialValue)/i.test(key)) {
      count += 1
      continue
    }
    count += countCredentialFields(child)
  }
  return count
}

function engineValue(value: unknown): EngineKind {
  if (value === undefined) return 'openai'
  if (value === 'claude') return 'anthropic'
  if (value === 'openai' || value === 'anthropic' || value === 'gemini') return value
  throw new Error('Provider 执行引擎不受支持')
}

function protocolValue(value: unknown): OpenAIProtocol | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'responses' || value === 'chat') return value
  throw new Error('Provider OpenAI 协议不受支持')
}

function authModeValue(value: unknown): ProviderAuthMode | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'api-key' || value === 'none') return value
  throw new Error('Provider 鉴权方式不受支持')
}

function budgetValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const budget = Number(value)
  if (!Number.isFinite(budget) || budget < 0 || budget > 1_000_000) throw new Error('Provider 预算无效')
  return budget || undefined
}

function uniqueStrings(value: unknown, limit: number, maxLength: number, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  if (value.length > limit) throw new Error(`${label}最多 ${limit} 项`)
  const output: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label}只能包含字符串`)
    const text = item.trim()
    if (!text || text.length > maxLength) throw new Error(`${label}包含无效内容`)
    if (seen.has(text)) continue
    seen.add(text)
    output.push(text)
  }
  return output
}

function boundedRequiredString(value: unknown, maxLength: number, label: string): string {
  const text = boundedOptionalString(value, maxLength, label)
  if (!text) throw new Error(`${label}不能为空`)
  return text
}

function boundedOptionalString(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  const text = value.trim()
  if (text.length > maxLength) throw new Error(`${label}过长`)
  return text || undefined
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
