import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { PluginRegistryItem } from '../../shared/types'
import type { SkillDefinition, SkillLoadDiagnostic, SkillLoadResult } from '../skill/skill-loader'
import { normalizeMcpServerConfig, type McpServerConfig } from '../mcp/mcp-client'
import { bindMcpOAuthRuntime } from '../mcp/mcp-oauth-runtime'
import {
  approvePluginRegistryItem,
  pluginRegistryItemKey,
  readPluginRegistryState,
  scanPluginRegistry,
  setPluginRegistryItemEnabled,
  writePluginRegistryState
} from '../pluginRegistry'
import { inspectPluginRegistryItemTrust } from './plugin-trust'
import {
  caogenExtensionRegistryRoots,
  isCaogenExtensionRegistryRoot
} from './caogen-extension-roots'

export interface AuthorizedMcpRuntimeConfig {
  serverId: string
  config: McpServerConfig
  publicConfig: McpServerConfig
  binding: PluginRuntimeBinding
}

export interface PluginRuntimeBinding {
  registryItemKey: string
  contentDigest: string
  capabilityDigest: string
  serverId: string
}

interface AuthorizeMcpRuntimeInput {
  projectRoot?: string
  serverId: string
  requestedConfig?: McpServerConfig
}

interface AuthorizeMcpBindingInput {
  binding: PluginRuntimeBinding
  requestedConfig?: McpServerConfig
}

const RUNTIME_SCAN_OPTIONS = {
  maxFiles: 3_000,
  maxDepth: 8,
  maxReadBytes: 1024 * 1024
} as const

let configuredUserDataRoot: string | undefined

export function configurePluginRuntimeAuthorization(userDataRoot: string): void {
  const normalized = resolve(userDataRoot)
  if (configuredUserDataRoot && configuredUserDataRoot !== normalized) {
    throw new Error('Plugin runtime authorization root is already configured')
  }
  configuredUserDataRoot = normalized
}

export function filterAuthorizedSkills(
  projectRoot: string | undefined,
  result: SkillLoadResult
): SkillLoadResult {
  const external = result.skills.filter((skill) => skill.scope !== 'builtin')
  if (external.length === 0) return result

  let view
  try {
    view = scanPluginRegistry(
      skillRegistryRoots(projectRoot),
      RUNTIME_SCAN_OPTIONS,
      readPluginRegistryState(pluginRegistryStateFile())
    )
  } catch (error) {
    return {
      ...result,
      skills: result.skills.filter((skill) => skill.scope === 'builtin'),
      diagnostics: [
        ...result.diagnostics,
        authorizationDiagnostic(
          pluginRegistryStateFileSafe(),
          `External Skills blocked because Plugin Registry authorization is unavailable: ${errorText(error)}`
        )
      ]
    }
  }

  const diagnostics = [...result.diagnostics]
  const skills = result.skills.filter((skill) => {
    if (skill.scope === 'builtin') return true
    const item = registrySkillForDefinition(view.items, skill)
    const error = runtimeItemError(item, `Skill ${skill.name}`) ?? skillSourceDriftError(skill)
    if (!error) return true
    diagnostics.push(authorizationDiagnostic(skill.sourcePath ?? skill.id, error))
    return false
  })
  return { ...result, skills, diagnostics }
}

export function authorizeSkillRuntime(
  projectRoot: string | undefined,
  skill: SkillDefinition
): PluginRegistryItem | undefined {
  if (skill.scope === 'builtin') return undefined
  const view = scanPluginRegistry(
    skillRegistryRoots(projectRoot),
    RUNTIME_SCAN_OPTIONS,
    readPluginRegistryState(pluginRegistryStateFile())
  )
  const item = registrySkillForDefinition(view.items, skill)
  const error = runtimeItemError(item, `Skill ${skill.name}`) ?? skillSourceDriftError(skill)
  if (error) throw new Error(error)
  return item
}

export function approveManagedLearningSkillRuntime(projectRoot: string, sourcePath: string): void {
  const statePath = pluginRegistryStateFile()
  const roots = skillRegistryRoots(projectRoot)
  const state = readPluginRegistryState(statePath)
  const view = scanPluginRegistry(roots, RUNTIME_SCAN_OPTIONS, state)
  const target = resolve(sourcePath)
  const matches = view.items.filter((item) =>
    item.kind === 'skill' && skillItemSourcePath(item) === target
  )
  if (matches.length !== 1) {
    throw new Error(`Learning-approved Skill is not uniquely represented in Plugin Registry: ${target}`)
  }
  // Learning approval establishes trust, but a later user disable remains authoritative.
  if (matches[0].trust.status === 'approved') return
  const approved = approvePluginRegistryItem(state, matches[0])
  const enabled = setPluginRegistryItemEnabled(approved, matches[0], true)
  writePluginRegistryState(statePath, enabled)
}

export function authorizeMcpRuntimeConfig(input: AuthorizeMcpRuntimeInput): AuthorizedMcpRuntimeConfig {
  const serverId = requiredServerId(input.serverId)
  const state = readPluginRegistryState(pluginRegistryStateFile())
  const view = scanPluginRegistry(mcpRegistryRoots(input.projectRoot), RUNTIME_SCAN_OPTIONS, state)
  const matches = view.items.filter((item) => item.kind === 'mcp' && item.name === serverId)
  return authorizedMcpFromMatches(matches, serverId, input.requestedConfig)
}

export function authorizeMcpRuntimeBinding(input: AuthorizeMcpBindingInput): AuthorizedMcpRuntimeConfig {
  const binding = normalizeBinding(input.binding)
  const parsedKey = parseRegistryItemKey(binding.registryItemKey)
  if (parsedKey.kind !== 'mcp' || parsedKey.name !== binding.serverId) {
    throw new Error('MCP runtime binding does not identify the approved server')
  }
  if (!isCaogenExtensionRegistryRoot(parsedKey.sourceRoot)) {
    throw new Error('MCP runtime binding points outside EastGenesis-owned extension roots; import and approve it again')
  }
  const state = readPluginRegistryState(pluginRegistryStateFile())
  const view = scanPluginRegistry([parsedKey.sourceRoot], RUNTIME_SCAN_OPTIONS, state)
  const matches = view.items.filter((item) => pluginRegistryItemKey(item) === binding.registryItemKey)
  const authorized = authorizedMcpFromMatches(matches, binding.serverId, input.requestedConfig)
  if (
    authorized.binding.contentDigest !== binding.contentDigest ||
    authorized.binding.capabilityDigest !== binding.capabilityDigest
  ) {
    throw new Error('MCP runtime content or Capability Manifest drifted after approval')
  }
  return authorized
}

export function publicMcpRuntimeConfig(config: McpServerConfig): McpServerConfig {
  const command = config.command?.trim()
  const url = config.url?.trim()
  const transport = config.transport ?? (command ? 'stdio' : 'http')
  return {
    ...(command ? { command } : {}),
    ...(config.args?.length ? { args: [...config.args] } : {}),
    ...(url ? { url } : {}),
    transport
  }
}

function authorizedMcpFromMatches(
  matches: PluginRegistryItem[],
  serverId: string,
  requestedConfig: McpServerConfig | undefined
): AuthorizedMcpRuntimeConfig {
  const authorized = matches.filter((item) => !runtimeItemError(item, `MCP server ${serverId}`))
  if (authorized.length === 0) {
    const reason = matches.length === 0
      ? `MCP server ${serverId} is not in the current Plugin Registry scan`
      : runtimeItemError(matches[0], `MCP server ${serverId}`)
    throw new Error(reason ?? `MCP server ${serverId} is not authorized`)
  }

  const resolved = authorized.flatMap((item) => {
    const config = readMcpConfig(item)
    if (!config) return []
    const reinspection = inspectPluginRegistryItemTrust(item)
    if (
      reinspection.error || reinspection.contentDigest !== item.contentDigest ||
      reinspection.capabilityManifest.digest !== item.capabilityManifest.digest
    ) return []
    const publicConfig = publicMcpRuntimeConfig(config)
    if (requestedConfig && !samePublicMcpConfig(publicConfig, publicMcpRuntimeConfig(requestedConfig))) return []
    return [{ item, config, publicConfig }]
  })
  if (resolved.length !== 1) {
    throw new Error(
      resolved.length === 0
        ? `MCP server ${serverId} does not match its approved main-process configuration`
        : `MCP server ${serverId} is ambiguous across approved Plugin Registry entries`
    )
  }

  const { item, config, publicConfig } = resolved[0]
  if (!item.contentDigest) throw new Error(`MCP server ${serverId} has no content digest`)
  const binding = {
    registryItemKey: pluginRegistryItemKey(item),
    contentDigest: item.contentDigest,
    capabilityDigest: item.capabilityManifest.digest,
    serverId
  }
  bindMcpOAuthRuntime(config, binding)
  return {
    serverId,
    config,
    publicConfig,
    binding
  }
}

function readMcpConfig(item: PluginRegistryItem): McpServerConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(item.path, 'utf8')) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return null
    return normalizeMcpServerConfig(parsed.mcpServers[item.name])
  } catch {
    return null
  }
}

function samePublicMcpConfig(left: McpServerConfig, right: McpServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function registrySkillForDefinition(
  items: PluginRegistryItem[],
  skill: SkillDefinition
): PluginRegistryItem | undefined {
  if (!skill.sourcePath) return undefined
  const target = resolve(skill.sourcePath)
  const matches = items.filter((item) => item.kind === 'skill' && skillItemSourcePath(item) === target)
  return matches.length === 1 ? matches[0] : undefined
}

function skillItemSourcePath(item: PluginRegistryItem): string {
  if (item.path.toLowerCase().endsWith('.md')) return resolve(item.path)
  const skillPath = resolve(item.path, 'SKILL.md')
  if (existsSync(skillPath)) return skillPath
  return resolve(item.path, `${basename(item.path)}.md`)
}

function runtimeItemError(item: PluginRegistryItem | undefined, label: string): string | undefined {
  if (!item) return `${label} is not in the current Plugin Registry scan`
  if (item.trust.status !== 'approved') {
    return `${label} blocked by Plugin Registry: ${item.trust.reason ?? item.trust.status}`
  }
  if (!item.enabled) return `${label} is disabled in Plugin Registry`
  return undefined
}

function skillSourceDriftError(skill: SkillDefinition): string | undefined {
  if (!skill.sourcePath || !skill.sourceContentDigest) return 'Skill source binding is unavailable'
  try {
    const digest = createHash('sha256').update(readFileSync(skill.sourcePath)).digest('hex')
    return digest === skill.sourceContentDigest
      ? undefined
      : `Skill ${skill.name} changed after loading; reload and approve the current bytes`
  } catch (error) {
    return `Skill ${skill.name} source cannot be revalidated: ${errorText(error)}`
  }
}

function authorizationDiagnostic(path: string, message: string): SkillLoadDiagnostic {
  return { code: 'authorization_blocked', path, message }
}

function skillRegistryRoots(projectRoot?: string): string[] {
  return uniqueExistingRoots(caogenExtensionRegistryRoots([projectRoot]))
}

function mcpRegistryRoots(projectRoot?: string): string[] {
  return uniqueExistingRoots(caogenExtensionRegistryRoots([projectRoot]))
}

function uniqueExistingRoots(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))].filter((value) => existsSync(value))
}

function pluginRegistryStateFile(): string {
  const root = configuredUserDataRoot ?? optionalUserDataRootFromEnvironment()
  if (!root) {
    throw new Error('Plugin runtime authorization root is not configured')
  }
  return join(root, 'plugin-registry-state.json')
}

function pluginRegistryStateFileSafe(): string {
  const root = configuredUserDataRoot ?? optionalUserDataRootFromEnvironment()
  return root ? join(root, 'plugin-registry-state.json') : 'plugin-registry-state.json'
}

function optionalUserDataRootFromEnvironment(): string | undefined {
  const value = process.env.CAOGEN_USER_DATA_DIR?.trim()
  return value ? resolve(value) : undefined
}

function requiredServerId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\r\n]/.test(value)) {
    throw new Error('MCP serverId is required and must be a bounded single-line name')
  }
  return value.trim()
}

function normalizeBinding(value: PluginRuntimeBinding): PluginRuntimeBinding {
  if (
    !value || typeof value.registryItemKey !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.contentDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.capabilityDigest)
  ) {
    throw new Error('MCP runtime binding is invalid')
  }
  return { ...value, serverId: requiredServerId(value.serverId) }
}

function parseRegistryItemKey(value: string): {
  kind: string
  sourceRoot: string
  path: string
  name: string
} {
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      Array.isArray(parsed) && parsed.length === 4 &&
      parsed.every((entry) => typeof entry === 'string')
    ) {
      return { kind: parsed[0], sourceRoot: resolve(parsed[1]), path: resolve(parsed[2]), name: parsed[3] }
    }
  } catch {
    // Fall through to the stable authorization error below.
  }
  throw new Error('Plugin Registry item key is invalid')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
