import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'
import { parse as parseJson5 } from 'json5'
import type { MigrationAssetConflict, MigrationAssetRisk, MigrationAssetScope } from '../shared/types'
import {
  assetId,
  buildAsset,
  diagnostic,
  inspectMcpTarget,
  isObject,
  isSafeMcpServerName,
  MAX_MCP_SERVERS,
  MAX_MIGRATION_SOURCE_FILE_BYTES,
  mcpTarget,
  migrationTargetRoot,
  type MigrationDiagnostic
} from './migration-asset-helpers'
import { sanitizeMcpConfig } from './migration-mcp'
import { assertNoSymlinkWithin, readSafeFile, type SafeFileSnapshot } from './migration-safety'
import type { InternalMigrationAsset, JsonObject } from './migration-scan-store'

type ServerReader = (text: string) => JsonObject | undefined

interface McpEntryState {
  sanitized: ReturnType<typeof sanitizeMcpConfig>
  target: ReturnType<typeof inspectMcpTarget>
  hasRunnableTarget: boolean
  serverNameValid: boolean
  risk: MigrationAssetRisk
  conflict: MigrationAssetConflict
  importable: boolean
}

export function addJsonMcpAssets(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  addStructuredMcpAssets(agent, scope, sourcePath, sourceRoot, cwd, home, assets, diagnostics, readJsonServers)
}

export function addQwenMcpAssets(
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  addStructuredMcpAssets('Qwen Code', scope, sourcePath, sourceRoot, cwd, home, assets, diagnostics, readMcpServerMap)
}

export function addGeminiMcpAssets(
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  addStructuredMcpAssets('Gemini CLI', scope, sourcePath, sourceRoot, cwd, home, assets, diagnostics, readMcpServerMap)
}

export function addContinueYamlMcpAssets(
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  addStructuredMcpAssets('Continue', scope, sourcePath, sourceRoot, cwd, home, assets, diagnostics, readContinueYamlServers)
}

export function addContinueMcpDirectory(
  scope: MigrationAssetScope,
  directory: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(directory)) return
  try {
    assertNoSymlinkWithin(sourceRoot, directory)
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_source_not_directory')
    for (const entry of continueDirectoryEntries(directory)) {
      scanContinueDirectoryEntry(entry, scope, directory, sourceRoot, cwd, home, assets, diagnostics)
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, directory))
  }
}

export function addOpenCodeMcpAssets(
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  addStructuredMcpAssets('OpenCode', scope, sourcePath, sourceRoot, cwd, home, assets, diagnostics, (text) => {
    const parsed = parseJson5(text) as unknown
    if (!isObject(parsed)) throw new Error('migration_mcp_root_invalid')
    if (parsed.mcp === undefined) return undefined
    if (!isObject(parsed.mcp)) throw new Error('migration_mcp_servers_invalid')
    return normalizeOpenCodeMcpServers(parsed.mcp)
  })
}

export function boundedMcpEntries(servers: JsonObject): Array<[string, unknown]> {
  const entries = Object.entries(servers)
  if (entries.length > MAX_MCP_SERVERS) throw new Error('migration_mcp_server_limit')
  return entries
}

export function addMcpEntry(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  source: SafeFileSnapshot,
  serverName: string,
  configValue: unknown,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[]
): void {
  const targetPath = mcpTarget(scope, cwd, home)
  const state = mcpEntryState(scope, targetPath, serverName, configValue)
  const id = assetId(agent, 'mcp', scope, sourcePath, serverName)
  const asset = buildAsset({
    id, agent, kind: 'mcp', scope, sourcePath, source, name: serverName,
    preview: mcpPreview(state),
    targetPath,
    conflict: state.conflict,
    conflictDetail: state.target.detail,
    risk: state.risk,
    riskReasons: mcpRiskReasons(scope, state),
    ignoredFields: state.sanitized.ignoredFields,
    importable: state.importable,
    recommended: state.importable && state.risk === 'low' && state.conflict === 'none'
  })
  assets.push({
    asset,
    sourceRoot,
    sourcePath,
    targetRoot: migrationTargetRoot(scope, cwd, home),
    targetPath,
    targetFingerprint: state.target.fingerprint,
    mcpServerName: serverName,
    mcpConfig: state.sanitized.config
  })
}

function addStructuredMcpAssets(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[],
  readServers: ServerReader
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_MIGRATION_SOURCE_FILE_BYTES)
    const servers = readServers(source.bytes.toString('utf8'))
    if (!servers) return
    for (const [name, config] of boundedMcpEntries(servers)) {
      addMcpEntry(agent, scope, sourcePath, sourceRoot, source, name, config, cwd, home, assets)
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function continueDirectoryEntries(directory: string) {
  return readdirSync(directory, { withFileTypes: true, encoding: 'utf8' })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 50)
}

function scanContinueDirectoryEntry(
  entry: ReturnType<typeof continueDirectoryEntries>[number],
  scope: MigrationAssetScope,
  directory: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  const sourcePath = join(directory, entry.name)
  if (entry.isSymbolicLink()) {
    diagnostics.push(diagnostic(new Error('migration_source_symlink'), sourcePath))
    return
  }
  if (!entry.isFile() || entry.name.startsWith('.')) return
  if (entry.name.toLowerCase().endsWith('.json')) {
    addStructuredMcpAssets('Continue', scope, sourcePath, sourceRoot, cwd, home, assets, diagnostics, readContinueJsonServers)
  } else if (/\.ya?ml$/i.test(entry.name)) {
    addContinueYamlMcpAssets(scope, sourcePath, sourceRoot, cwd, home, assets, diagnostics)
  }
}

function readJsonServers(text: string): JsonObject {
  const parsed = JSON.parse(text) as unknown
  if (!isObject(parsed)) throw new Error('migration_mcp_root_invalid')
  const servers = isObject(parsed.mcpServers) ? parsed.mcpServers : isObject(parsed.servers) ? parsed.servers : undefined
  if (!servers) throw new Error('migration_mcp_servers_missing')
  return servers
}

function readMcpServerMap(text: string): JsonObject | undefined {
  const parsed = JSON.parse(text) as unknown
  if (!isObject(parsed)) throw new Error('migration_mcp_root_invalid')
  if (parsed.mcpServers === undefined) return undefined
  if (!isObject(parsed.mcpServers)) throw new Error('migration_mcp_servers_invalid')
  return parsed.mcpServers
}

function readContinueJsonServers(text: string): JsonObject | undefined {
  const servers = readMcpServerMap(text)
  return servers ? normalizeMcpServerMap(servers, 'continue') : undefined
}

function readContinueYamlServers(text: string): JsonObject | undefined {
  const parsed = parseYaml(text, { schema: JSON_SCHEMA, json: true }) as unknown
  if (!isObject(parsed)) throw new Error('migration_mcp_root_invalid')
  if (parsed.mcpServers === undefined) return undefined
  return normalizeNamedMcpServers(parsed.mcpServers)
}

function normalizeNamedMcpServers(value: unknown): JsonObject {
  if (!Array.isArray(value)) throw new Error('migration_mcp_servers_invalid')
  if (value.length > MAX_MCP_SERVERS) throw new Error('migration_mcp_server_limit')
  const result = Object.create(null) as JsonObject
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.name !== 'string' || !isSafeMcpServerName(entry.name)) {
      throw new Error('migration_mcp_server_invalid')
    }
    const name = entry.name
    if (Object.hasOwn(result, name)) throw new Error('migration_mcp_server_duplicate')
    const normalized = normalizeMcpServer(entry, 'continue')
    delete normalized.name
    result[name] = normalized
  }
  return result
}

function normalizeMcpServerMap(servers: JsonObject, dialect: 'continue'): JsonObject {
  const result = Object.create(null) as JsonObject
  for (const [name, value] of boundedMcpEntries(servers)) {
    result[name] = isObject(value) ? normalizeMcpServer(value, dialect) : value
  }
  return result
}

function normalizeMcpServer(server: JsonObject, dialect: 'continue'): JsonObject {
  const normalized: JsonObject = { ...server }
  if (dialect === 'continue' && server.type === 'streamable-http') normalized.type = 'http'
  return normalized
}

function normalizeOpenCodeMcpServers(servers: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const [name, value] of boundedMcpEntries(servers)) {
    result[name] = isObject(value) ? normalizeOpenCodeMcpServer(value) : value
  }
  return result
}

function normalizeOpenCodeMcpServer(value: JsonObject): JsonObject {
  const normalized: JsonObject = { ...value }
  if (Array.isArray(value.command)) {
    const [command, ...args] = value.command
    normalized.command = command
    normalized.args = args
  }
  if (value.environment !== undefined) {
    normalized.env = value.environment
    delete normalized.environment
  }
  return normalized
}

function mcpEntryState(
  scope: MigrationAssetScope,
  targetPath: string,
  serverName: string,
  configValue: unknown
): McpEntryState {
  const sanitized = sanitizeMcpConfig(configValue)
  const target = inspectMcpTarget(targetPath, serverName)
  const hasRunnableTarget = typeof sanitized.config.command === 'string' || typeof sanitized.config.url === 'string'
  const serverNameValid = isSafeMcpServerName(serverName)
  const blocked = target.blocked || !hasRunnableTarget || !serverNameValid
  const risk: MigrationAssetRisk = blocked ? 'blocked' : sanitized.ignoredFields.length > 0 || scope === 'user' ? 'review' : 'low'
  const conflict: MigrationAssetConflict = blocked ? 'unsupported' : target.conflict
  return { sanitized, target, hasRunnableTarget, serverNameValid, risk, conflict, importable: !blocked && conflict !== 'duplicate' }
}

function mcpPreview(state: McpEntryState): string {
  const transport = typeof state.sanitized.config.command === 'string' ? 'stdio' : 'HTTP'
  return `${transport} MCP;保留 ${Object.keys(state.sanitized.config).length} 个安全字段;忽略 ${state.sanitized.ignoredFields.length} 个凭据或未知字段。`
}

function mcpRiskReasons(scope: MigrationAssetScope, state: McpEntryState): string[] {
  const reasons: string[] = []
  if (state.sanitized.ignoredFields.length > 0) reasons.push('凭据字段不会导入,服务可能需要重新授权')
  if (scope === 'user') reasons.push('用户级 MCP 会影响所有对话')
  if (!state.hasRunnableTarget) reasons.push('缺少可安全映射的 command 或 url')
  if (!state.serverNameValid) reasons.push('MCP 名称为空、过长或包含危险字符')
  if (state.target.blocked) reasons.push('目标 MCP 配置不可安全修改')
  return reasons
}
