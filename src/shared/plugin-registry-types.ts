export type PluginRegistryKind = 'plugin' | 'skill' | 'agent' | 'mcp'
export type PluginRegistrySourceKind = 'project' | 'user' | 'other'
export type PluginRegistryEnabledSource = 'manifest' | 'user'
export type PluginRegistryTrustStatus = 'approved' | 'approval_required' | 'changed' | 'invalid'

export interface PluginCapabilityManifest {
  schemaVersion: 1
  capabilities: string[]
  transport?: 'stdio' | 'http' | 'unknown'
  /** Names only. Values from MCP configuration never cross into Renderer. */
  environmentVariables?: string[]
  digest: string
}

export interface PluginCapabilityDiff {
  added: string[]
  removed: string[]
  expanded: boolean
}

export interface PluginRegistryTrustView {
  status: PluginRegistryTrustStatus
  approvedAt?: string
  approvedContentDigest?: string
  approvedCapabilityDigest?: string
  capabilityDiff: PluginCapabilityDiff
  reason?: string
}

export interface PluginRegistryProvenance {
  origin: 'project_local' | 'user_local' | 'managed_local' | 'other_local'
  sourceKind: PluginRegistrySourceKind
  managed: boolean
}

export interface PluginRegistryItem {
  id: string
  name: string
  kind: PluginRegistryKind
  sourceKind?: PluginRegistrySourceKind
  sourceRoot: string
  path: string
  enabled: boolean
  enabledSource?: PluginRegistryEnabledSource
  enabledUpdatedAt?: string
  summary?: string
  /** Manifest or frontmatter version, when declared. */
  version?: string
  /** Declared permissions or capabilities only; not runtime verification. */
  permissions?: string[]
  /** Entries under the CaoGen-managed plugin root may be uninstalled. */
  managed?: boolean
  /** SHA-256 over raw file bytes or a canonical, symlink-safe directory walk. */
  contentDigest?: string
  provenance: PluginRegistryProvenance
  capabilityManifest: PluginCapabilityManifest
  trust: PluginRegistryTrustView
}

export interface PluginRegistryDiagnostic {
  code:
    | 'root_missing'
    | 'read_failed'
    | 'json_parse_failed'
    | 'json_shape_invalid'
    | 'max_files_reached'
    | 'digest_failed'
  message: string
  path: string
}

export interface PluginRegistryView {
  roots: string[]
  items: PluginRegistryItem[]
  diagnostics: PluginRegistryDiagnostic[]
  limits: { maxFiles: number; maxDepth: number }
  scannedAt: string
  truncated: boolean
}

export interface PluginRegistryScanOptions {
  maxFiles?: number
  maxDepth?: number
  maxReadBytes?: number
  managedRoot?: string
}

export interface PluginRegistryRevealResult {
  ok: boolean
  path?: string
  error?: string
}

export interface PluginRegistrySetEnabledResult {
  ok: boolean
  item?: PluginRegistryItem
  error?: string
}

export interface PluginRegistryTrustMutationResult {
  ok: boolean
  item?: PluginRegistryItem
  error?: string
}

export interface McpProbeResult {
  id: string
  ok: boolean
  transport: 'stdio' | 'http' | 'unknown'
  serverName?: string
  serverVersion?: string
  latencyMs?: number
  error?: string
}
