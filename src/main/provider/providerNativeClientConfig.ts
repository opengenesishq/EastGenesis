import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import initSqlJs from 'sql.js'
import type { ProviderInput, ProviderNativeClient, ProviderNativeCredentialKind } from '../../shared/types'
import { normalizeBaseUrl } from './providerBaseUrl'

export interface NativeClientCandidate {
  input: ProviderInput
  token?: string
  credentialKind: ProviderNativeCredentialKind
  sourceLabel: string
}

export interface NativeClientSnapshot {
  candidates: NativeClientCandidate[]
  source: 'environment-override' | 'user-profile'
  sourceLabel: string
  sourceDigest: string
  readDigest: () => string
}

const MAX_CONFIG_BYTES = 2 * 1024 * 1024
const nodeRequire = createRequire(__filename)

/** Parse only supported provider fields. Never execute env expansion, hooks or credential helpers. */
export function parseNativeClientConfiguration(
  client: Exclude<ProviderNativeClient, 'cc-switch'>,
  config: Record<string, unknown>,
  env: Record<string, string | undefined> = {}
): NativeClientCandidate[] {
  if (client === 'claude') {
    const values = object(config.env)
    const token = text(values.ANTHROPIC_AUTH_TOKEN) ?? text(values.ANTHROPIC_API_KEY)
      ?? text(env.ANTHROPIC_AUTH_TOKEN) ?? text(env.ANTHROPIC_API_KEY)
    const models = unique([config.model, values.ANTHROPIC_MODEL, values.ANTHROPIC_DEFAULT_OPUS_MODEL,
      values.ANTHROPIC_DEFAULT_SONNET_MODEL, values.ANTHROPIC_DEFAULT_HAIKU_MODEL])
      .filter((model) => !['sonnet', 'opus', 'haiku', 'default'].includes(model))
    const entry = candidate('Claude Code', 'anthropic', text(values.ANTHROPIC_BASE_URL) ?? text(env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com', models,
      token, Boolean(text(values.ANTHROPIC_AUTH_TOKEN) ?? text(values.ANTHROPIC_API_KEY)), 'settings.json')
    if (text(values.ANTHROPIC_AUTH_TOKEN) || (!text(values.ANTHROPIC_API_KEY) && text(env.ANTHROPIC_AUTH_TOKEN))) entry.input.credentialHeaderNames = ['authorization']
    return [entry]
  }
  if (client === 'gemini') {
    const values = object(config.env)
    const token = text(values.GEMINI_API_KEY) ?? text(values.GOOGLE_API_KEY) ?? text(env.GEMINI_API_KEY) ?? text(env.GOOGLE_API_KEY)
    const model = text(config.model) ?? text(object(config.model).name) ?? text(values.GEMINI_MODEL)
    return [candidate('Gemini CLI', 'gemini', text(values.GOOGLE_GEMINI_BASE_URL) ?? text(env.GOOGLE_GEMINI_BASE_URL)
      ?? 'https://generativelanguage.googleapis.com', model ? [model] : [], token,
      Boolean(text(values.GEMINI_API_KEY) ?? text(values.GOOGLE_API_KEY)), 'settings.json + .env')]
  }
  if (client === 'codex') {
    let codex: Record<string, unknown> = config
    try { if (typeof config.config === 'string') codex = parseToml(config.config) as Record<string, unknown> }
    catch { throw new Error('Codex 配置不是有效 TOML。') }
    const providerKey = text(codex.model_provider)
    const provider = providerKey ? object(object(codex.model_providers)[providerKey]) : codex
    const auth = object(config.auth)
    const envKey = text(provider.env_key)
    const token = text(auth.OPENAI_API_KEY) ?? text(provider.experimental_bearer_token)
      ?? (envKey && /^[A-Z][A-Z0-9_]{1,79}$/.test(envKey) ? text(env[envKey]) : undefined)
    const protocol = provider.wire_api === 'chat' || provider.wire_api === 'chat_completions' ? 'chat' : 'responses'
    const entry = candidate('Codex', 'openai', text(provider.base_url) ?? 'https://api.openai.com/v1', unique([codex.model]),
      token, Boolean(text(auth.OPENAI_API_KEY) ?? text(provider.experimental_bearer_token)), 'config.toml + auth.json')
    entry.input.openaiProtocol = protocol
    return [entry]
  }
  const auth = object(config.auth)
  const providers = { ...object(config.provider) }
  for (const id of ['openai', 'anthropic', 'google']) {
    if (!providers[id] && object(auth[id]).type === 'api') providers[id] = {}
  }
  const activeModel = text(config.model)
  return Object.entries(providers).flatMap(([id, raw]) => {
    const provider = object(raw)
    const options = object(provider.options)
    const npm = text(provider.npm)
    const engine = npm === '@ai-sdk/anthropic' || id === 'anthropic' ? 'anthropic'
      : npm === '@ai-sdk/google' || id === 'google' ? 'gemini'
        : npm === '@ai-sdk/openai' || npm === '@ai-sdk/openai-compatible' || id === 'openai' ? 'openai' : undefined
    if (!engine) return []
    const baseUrl = text(options.baseURL) ?? ({ anthropic: 'https://api.anthropic.com',
      gemini: 'https://generativelanguage.googleapis.com', openai: 'https://api.openai.com/v1' }[engine])
    const configuredToken = text(options.apiKey)
    const variable = configuredToken?.match(/^\{env:([A-Z][A-Z0-9_]{1,79})\}$/)?.[1]
    const storedAuth = object(auth[id])
    const token = variable ? text(env[variable])
      : configuredToken?.startsWith('{') ? undefined
        : configuredToken ?? (storedAuth.type === 'api' ? text(storedAuth.key) : undefined)
    const models = unique([...Object.keys(object(provider.models)),
      activeModel?.startsWith(`${id}/`) ? activeModel.slice(id.length + 1) : undefined])
    const entry = candidate(text(provider.name) ?? `OpenCode ${id}`, engine, baseUrl, models, token,
      !variable && Boolean(token), 'opencode.json + auth.json')
    if (engine === 'openai') entry.input.openaiProtocol = npm === '@ai-sdk/openai-compatible' ? 'chat' : 'responses'
    return [entry]
  })
}

export async function readNativeClientSnapshot(client: Exclude<ProviderNativeClient, 'codex'>, home: string, env: Record<string, string | undefined> = process.env): Promise<NativeClientSnapshot> {
  let files: string[]
  let source: NativeClientSnapshot['source'] = 'user-profile'
  let readCandidates: () => NativeClientCandidate[]
  if (client === 'claude') {
    const root = resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'))
    source = env.CLAUDE_CONFIG_DIR?.trim() ? 'environment-override' : source
    files = [join(root, 'settings.json')]
    readCandidates = () => parseNativeClientConfiguration('claude', readJson(files[0]), env)
  } else if (client === 'gemini') {
    const root = join(home, '.gemini')
    files = [join(root, 'settings.json'), join(root, '.env')]
    readCandidates = () => parseNativeClientConfiguration('gemini', { ...readJson(files[0]), env: parseDotEnv(readOptional(files[1])) }, env)
  } else if (client === 'opencode') {
    const root = resolve(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'))
    const data = resolve(env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'))
    const override = env.OPENCODE_CONFIG?.trim()
    source = override || env.XDG_CONFIG_HOME?.trim() || env.XDG_DATA_HOME?.trim() ? 'environment-override' : source
    const configPath = override ? resolve(override) : join(root, 'opencode', 'opencode.json')
    const jsoncPath = override ? undefined : join(root, 'opencode', 'opencode.jsonc')
    // JSONC is decoded as data; comments/trailing commas never run as JavaScript.
    files = [configPath, ...(jsoncPath ? [jsoncPath] : []), join(data, 'opencode', 'auth.json')]
    readCandidates = () => parseNativeClientConfiguration('opencode', {
      ...readJson(configPath), ...(jsoncPath ? readJson(jsoncPath) : {}), auth: readJson(files[files.length - 1])
    }, env)
  } else {
    const root = join(home, '.cc-switch')
    const databasePath = join(root, 'cc-switch.db')
    files = [databasePath]
    const databaseBytes = readBytes(databasePath, 64 * 1024 * 1024)
    const walPath = `${databasePath}-wal`
    if (existsSync(walPath) && lstatSync(walPath).size > 0) {
      throw new Error('请先退出 CC Switch，再重新扫描，以读取完整的已保存配置。')
    }
    const SQL = await initSqlJs({ locateFile: (file) => file.endsWith('.wasm') ? nodeRequire.resolve('sql.js/dist/sql-wasm.wasm') : file })
    const database = new SQL.Database(databaseBytes)
    let candidates: NativeClientCandidate[] = []
    let reparseCandidates: () => NativeClientCandidate[] = () => []
    try {
      const result = database.exec("SELECT app_type, name, settings_config, id FROM providers WHERE app_type IN ('claude', 'codex', 'gemini', 'opencode') ORDER BY is_current DESC, sort_index, name LIMIT 128")
      reparseCandidates = () => (result[0]?.values ?? []).flatMap(([kind, name, settings, id]) => {
        if (typeof settings !== 'string') return []
        const config = parseJson(settings)
        const parsed = parseNativeClientConfiguration(kind as Exclude<ProviderNativeClient, 'cc-switch'>,
          kind === 'opencode' && !config.provider ? { provider: { [String(id)]: config } } : config, env)
        return parsed.map((entry) => ({ ...entry, input: { ...entry.input, name: text(name) ?? entry.input.name }, sourceLabel: `CC Switch · ${String(kind)}` }))
      })
      candidates = reparseCandidates()
    } finally { database.close() }
    const credentialsDigest = (): string => hash(JSON.stringify(reparseCandidates().map((candidate) => candidate.token)))
    const initialDigest = hash(Buffer.concat([databaseBytes, Buffer.from(credentialsDigest())]))
    const readDigest = (): string => {
      if (existsSync(walPath) && lstatSync(walPath).size > 0) return 'database-has-pending-writes'
      return hash(Buffer.concat([readBytes(databasePath, 64 * 1024 * 1024), Buffer.from(credentialsDigest())]))
    }
    return { candidates, source, sourceLabel: 'CC Switch', sourceDigest: initialDigest, readDigest }
  }
  if (!files.some((file) => existsSync(file))) throw new Error('未找到此客户端的本机配置。')
  const readDigest = (): string => hash(JSON.stringify({ files: files.map((file) => readOptional(file)),
    // Hash the effective credential as well, since environment values may change between scan and apply.
    candidates: readCandidates() }))
  const beforeDigest = readDigest()
  const candidates = readCandidates()
  const sourceDigest = readDigest()
  if (beforeDigest !== sourceDigest) throw new Error('扫描期间本机配置发生变化，请重新扫描。')
  return { candidates, source, sourceLabel: client, sourceDigest, readDigest }
}

function candidate(name: string, engine: NonNullable<ProviderInput['engine']>, baseUrl: string, models: string[], token: string | undefined,
  inline: boolean, sourceLabel: string): NativeClientCandidate {
  return {
    input: { name, engine, baseUrl: normalizeBaseUrl(baseUrl, engine), models, authMode: 'api-key',
      credentialHeaderNames: [engine === 'anthropic' ? 'x-api-key' : engine === 'gemini' ? 'x-goog-api-key' : 'authorization'],
      advancedConfig: { schemaVersion: 1, metadata: { importedFrom: 'native-client' } } },
    token, credentialKind: token ? inline ? 'api-key' : 'environment' : 'none', sourceLabel
  }
}

function parseDotEnv(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || !['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_MODEL'].includes(match[1])) continue
    const quoted = match[2].match(/^(["'])(.*)\1\s*(?:#.*)?$/)
    result[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '').trim()
  }
  return result
}

function readBytes(file: string, limit = MAX_CONFIG_BYTES): Buffer {
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('本机配置文件格式或大小无效。')
  return readFileSync(file)
}
function readOptional(file: string): string { return existsSync(file) ? readBytes(file).toString('utf8') : '' }
function readJson(file: string): Record<string, unknown> { const value = readOptional(file); return value.trim() ? parseJson(value) : {} }
function parseJson(value: string): Record<string, unknown> {
  // Strip comments and trailing commas outside strings with a small lexical pass.
  let output = '', quoted = false, escaped = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i], next = value[i + 1]
    if (quoted) { output += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
    if (c === '"') { quoted = true; output += c; continue }
    if (c === '/' && next === '/') { while (i < value.length && value[i] !== '\n') i++; output += '\n'; continue }
    if (c === '/' && next === '*') { i += 2; while (i < value.length && !(value[i] === '*' && value[i + 1] === '/')) i++; i++; output += ' '; continue }
    output += c
  }
  let cleaned = ''; quoted = false; escaped = false
  for (let i = 0; i < output.length; i++) {
    const c = output[i]
    if (quoted) { cleaned += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
    if (c === '"') quoted = true
    if (c === ',') { let after = i + 1; while (after < output.length && /\s/.test(output[after])) after++; if (output[after] === '}' || output[after] === ']') continue }
    cleaned += c
  }
  try { return object(JSON.parse(cleaned)) } catch { throw new Error('本机客户端配置不是有效 JSON。') }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function unique(values: unknown[]): string[] { return [...new Set(values.flatMap((value) => text(value) ? [text(value)!] : []))] }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
