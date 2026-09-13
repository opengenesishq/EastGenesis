import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type {
  PluginCapabilityDiff,
  PluginCapabilityManifest,
  PluginRegistryItem,
  PluginRegistryProvenance,
  PluginRegistrySourceKind
} from '../../shared/types'

const MAX_CONTENT_FILES = 5_000
const MAX_CONTENT_BYTES = 50 * 1024 * 1024
const MAX_CONTENT_DEPTH = 20

interface ContentDigestState {
  kind: PluginRegistryItem['kind']
  files: number
  bytes: number
  hash: ReturnType<typeof createHash>
}

export interface PluginTrustInspection {
  contentDigest?: string
  capabilityManifest: PluginCapabilityManifest
  error?: string
}

interface PluginTrustStateOverride {
  enabled: boolean
  updatedAt: string
  approval?: {
    contentDigest: string
    capabilityDigest: string
    capabilities: string[]
    approvedAt: string
  }
}

type UntrustedPluginRegistryItem = Omit<
  PluginRegistryItem,
  'contentDigest' | 'provenance' | 'capabilityManifest' | 'trust'
>

export function projectPluginRegistryItemTrust(
  item: UntrustedPluginRegistryItem,
  sourceKind: PluginRegistrySourceKind,
  override?: PluginTrustStateOverride
): { item: PluginRegistryItem; error?: string } {
  const inspection = inspectPluginRegistryItemTrust(item)
  const approval = override?.approval
  const capabilityDiff = diffPluginCapabilities(
    approval?.capabilities,
    inspection.capabilityManifest.capabilities
  )
  const status = pluginTrustStatus(inspection, approval)
  const reason = pluginTrustReason(status, inspection.error, capabilityDiff)
  return {
    item: {
      ...item,
      sourceKind,
      enabled: status === 'approved' ? (override?.enabled ?? item.enabled) : false,
      enabledSource: override ? 'user' : 'manifest',
      ...(override ? { enabledUpdatedAt: override.updatedAt } : {}),
      ...(inspection.contentDigest ? { contentDigest: inspection.contentDigest } : {}),
      provenance: pluginRegistryProvenance(sourceKind, item.managed === true),
      capabilityManifest: inspection.capabilityManifest,
      trust: {
        status,
        capabilityDiff,
        ...(approval ? {
          approvedAt: approval.approvedAt,
          approvedContentDigest: approval.contentDigest,
          approvedCapabilityDigest: approval.capabilityDigest
        } : {}),
        ...(reason ? { reason } : {})
      }
    },
    ...(inspection.error ? { error: inspection.error } : {})
  }
}

export function diffPluginCapabilities(
  previous: string[] | undefined,
  current: string[]
): PluginCapabilityDiff {
  const before = new Set(previous ?? [])
  const after = new Set(current)
  const added = [...after].filter((capability) => !before.has(capability)).sort()
  const removed = [...before].filter((capability) => !after.has(capability)).sort()
  return { added, removed, expanded: added.length > 0 }
}

function pluginTrustStatus(
  inspection: PluginTrustInspection,
  approval: PluginTrustStateOverride['approval']
): PluginRegistryItem['trust']['status'] {
  if (!inspection.contentDigest || inspection.error) return 'invalid'
  if (!approval) return 'approval_required'
  if (approval.contentDigest !== inspection.contentDigest) return 'changed'
  if (approval.capabilityDigest !== inspection.capabilityManifest.digest) return 'changed'
  return 'approved'
}

function pluginTrustReason(
  status: PluginRegistryItem['trust']['status'],
  inspectionError: string | undefined,
  capabilityDiff: PluginCapabilityDiff
): string | undefined {
  if (status === 'invalid') return inspectionError || 'Plugin content digest is unavailable'
  if (status === 'approval_required') return 'Current content and capabilities have not been approved'
  if (status !== 'changed') return undefined
  return capabilityDiff.expanded
    ? 'Content or capabilities expanded after approval'
    : 'Content changed after approval'
}

export function inspectPluginRegistryItemTrust(
  item: Pick<PluginRegistryItem, 'kind' | 'name' | 'path' | 'permissions'>
): PluginTrustInspection {
  const capabilities = capabilityProjection(item)
  try {
    return {
      contentDigest: digestRegistryContent(item),
      capabilityManifest: capabilities
    }
  } catch (error) {
    return {
      capabilityManifest: capabilities,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function pluginRegistryProvenance(
  sourceKind: PluginRegistrySourceKind,
  managed: boolean
): PluginRegistryProvenance {
  return {
    origin: managed
      ? 'managed_local'
      : sourceKind === 'project'
        ? 'project_local'
        : sourceKind === 'user'
          ? 'user_local'
          : 'other_local',
    sourceKind,
    managed
  }
}

function digestRegistryContent(
  item: Pick<PluginRegistryItem, 'kind' | 'name' | 'path'>
): string {
  const root = resolve(item.path)
  const state: ContentDigestState = {
    kind: item.kind,
    files: 0,
    bytes: 0,
    hash: createHash('sha256')
  }
  state.hash.update('caogen-plugin-content-v1\0', 'utf8')
  state.hash.update(item.kind, 'utf8')
  state.hash.update('\0', 'utf8')
  if (item.kind === 'mcp') {
    state.hash.update(item.name, 'utf8')
    state.hash.update('\0', 'utf8')
    appendMcpServerConfig(root, item.name, state)
    return `sha256:${state.hash.digest('hex')}`
  }
  appendPath(root, root, 0, state)
  return `sha256:${state.hash.digest('hex')}`
}

function appendMcpServerConfig(path: string, name: string, state: ContentDigestState): void {
  const info = lstatSync(path)
  if (!info.isFile()) throw new Error('MCP config path is not a regular file')
  if (info.size > MAX_CONTENT_BYTES) throw new Error(`content size exceeds ${MAX_CONTENT_BYTES} bytes`)
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const root = objectValue(parsed)
  const servers = objectValue(root?.mcpServers)
  if (!servers || !Object.hasOwn(servers, name)) throw new Error(`MCP config does not contain server ${name}`)
  const body = stableJson(servers[name])
  state.files = 1
  state.bytes = Buffer.byteLength(body, 'utf8')
  state.hash.update(`MCP\0${name}\0${state.bytes}\0`, 'utf8')
  state.hash.update(body, 'utf8')
  state.hash.update('\0', 'utf8')
}

function appendPath(root: string, target: string, depth: number, state: ContentDigestState): void {
  if (depth > MAX_CONTENT_DEPTH) throw new Error(`content depth exceeds ${MAX_CONTENT_DEPTH}`)
  const info = lstatSync(target)
  const path = relative(root, target).replace(/\\/g, '/') || basename(root)
  if (info.isSymbolicLink()) {
    const link = readlinkSync(target)
    state.hash.update(`L\0${path}\0${link}\0`, 'utf8')
    return
  }
  if (info.isDirectory()) {
    state.hash.update(`D\0${path}\0`, 'utf8')
    for (const entry of readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (itemKindIgnoresEntry(state, entry.name, entry.isFile())) continue
      appendPath(root, join(target, entry.name), depth + 1, state)
    }
    return
  }
  if (!info.isFile()) throw new Error(`unsupported content entry: ${path}`)
  state.files += 1
  state.bytes += info.size
  if (state.files > MAX_CONTENT_FILES) throw new Error(`content file count exceeds ${MAX_CONTENT_FILES}`)
  if (state.bytes > MAX_CONTENT_BYTES) throw new Error(`content size exceeds ${MAX_CONTENT_BYTES} bytes`)
  const bytes = readFileSync(target)
  state.hash.update(`F\0${path}\0${bytes.byteLength}\0`, 'utf8')
  state.hash.update(bytes)
  state.hash.update('\0', 'utf8')
}

function itemKindIgnoresEntry(state: ContentDigestState, name: string, isFile: boolean): boolean {
  return state.kind === 'skill' && isFile && name === 'skill-feedback.json'
}

function capabilityProjection(
  item: Pick<PluginRegistryItem, 'kind' | 'name' | 'path' | 'permissions'>
): PluginCapabilityManifest {
  const capabilities = new Set<string>(['content:read'])
  let transport: PluginCapabilityManifest['transport']
  let environmentVariables: string[] | undefined

  if (item.kind === 'plugin') capabilities.add('plugin:load')
  if (item.kind === 'skill') capabilities.add('skill:invoke')
  if (item.kind === 'agent') capabilities.add('agent:dispatch')
  if (item.kind === 'mcp') {
    capabilities.add('mcp:connect')
    const projection = readMcpCapabilityProjection(item.path, item.name)
    transport = projection.transport
    environmentVariables = projection.environmentVariables
    capabilities.add(transport === 'stdio' ? 'process:spawn' : transport === 'http' ? 'network:connect' : 'transport:unknown')
    for (const name of environmentVariables ?? []) capabilities.add(`environment:${name}`)
  }
  for (const permission of item.permissions ?? []) capabilities.add(`declared:${permission}`)

  const sortedCapabilities = [...capabilities].sort()
  const body = {
    schemaVersion: 1 as const,
    capabilities: sortedCapabilities,
    ...(transport ? { transport } : {}),
    ...(environmentVariables && environmentVariables.length > 0 ? { environmentVariables } : {})
  }
  return {
    ...body,
    digest: `sha256:${createHash('sha256').update(stableJson(body)).digest('hex')}`
  }
}

function readMcpCapabilityProjection(
  path: string,
  name: string
): { transport: NonNullable<PluginCapabilityManifest['transport']>; environmentVariables?: string[] } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const servers = objectValue(raw.mcpServers)
    const config = servers ? objectValue(servers[name]) : undefined
    if (!config) return { transport: 'unknown' }
    const explicit = stringValue(config.transport)?.toLowerCase()
    const transport = typeof config.command === 'string'
      ? 'stdio'
      : typeof config.url === 'string' || explicit === 'http' || explicit === 'sse' || explicit === 'streamable-http'
        ? 'http'
        : 'unknown'
    const env = objectValue(config.env)
    const environmentVariables = env
      ? Object.keys(env).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).sort().slice(0, 100)
      : undefined
    return { transport, ...(environmentVariables?.length ? { environmentVariables } : {}) }
  } catch {
    return { transport: 'unknown' }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
