import { randomUUID } from 'node:crypto'
import {
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
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  PluginRegistryDiagnostic,
  PluginRegistryItem,
  PluginRegistryKind,
  PluginRegistryScanOptions,
  PluginRegistrySourceKind,
  PluginRegistryView
} from '../shared/types'
import { projectPluginRegistryItemTrust } from './plugin/plugin-trust'
import { caogenExtensionHome, caogenUserExtensionRoot, isAllowedCaogenExtensionRoot } from './plugin/caogen-extension-roots'

export type {
  PluginRegistryDiagnostic,
  PluginRegistryItem,
  PluginRegistryKind,
  PluginRegistryScanOptions,
  PluginRegistrySourceKind,
  PluginRegistryView
} from '../shared/types'

type DiscoveredPluginRegistryItem = Omit<
  PluginRegistryItem,
  'contentDigest' | 'provenance' | 'capabilityManifest' | 'trust'
>

export interface PluginRegistryStateEntry {
  enabled: boolean
  updatedAt: string
  approval?: {
    contentDigest: string
    capabilityDigest: string
    capabilities: string[]
    approvedAt: string
  }
}

export interface PluginRegistryState {
  version: 2
  items: Record<string, PluginRegistryStateEntry>
}

interface ScanLimits {
  maxFiles: number
  maxDepth: number
  maxReadBytes: number
}

interface ScanContext {
  diagnostics: PluginRegistryDiagnostic[]
  countedFiles: Set<string>
  limits: ScanLimits
  truncated: boolean
}

type JsonObject = Record<string, unknown>

const DEFAULT_MAX_FILES = 1000
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_READ_BYTES = 256 * 1024
const IGNORED_DIRS = new Set(['.git', 'node_modules'])
const MCP_CONFIG_NAMES = new Set(['mcp.json'])
const SUMMARY_CHARS = 180

export function scanPluginRegistry(
  roots: string[],
  options: PluginRegistryScanOptions = {},
  state: PluginRegistryState = emptyPluginRegistryState()
): PluginRegistryView {
  const limits = normalizeLimits(options)
  const ctx: ScanContext = {
    diagnostics: [],
    countedFiles: new Set(),
    limits,
    truncated: false
  }
  const sourceRoots = normalizeRoots(roots).filter(isAllowedCaogenExtensionRoot)
  const items: DiscoveredPluginRegistryItem[] = []

  for (const sourceRoot of sourceRoots) {
    if (!isDirectory(sourceRoot)) {
      addDiagnostic(ctx, 'root_missing', sourceRoot, 'Plugin registry root does not exist or is not a directory.')
      continue
    }

    scanPluginManifest(sourceRoot, items, ctx)
    scanStandaloneSkillRoot(sourceRoot, items, ctx)
    scanSkills(sourceRoot, items, ctx)
    scanAgents(sourceRoot, items, ctx)
    scanManagedPluginPackages(sourceRoot, items, ctx)
    scanMcpConfigs(sourceRoot, items, ctx)
  }

  const discoveredItems = dedupeItems(items)
  // 托管标记:位于 managedRoot 下的条目可被 EastGenesis 卸载(回收站式)
  if (options.managedRoot) {
    const root = resolve(options.managedRoot)
    for (const item of discoveredItems) {
      const rel = relative(root, resolve(item.path))
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) item.managed = true
    }
  }
  const mergedItems = applyPluginRegistryState(discoveredItems, state, ctx).sort(compareItems)

  return {
    roots: sourceRoots,
    items: mergedItems,
    diagnostics: ctx.diagnostics,
    limits: {
      maxFiles: limits.maxFiles,
      maxDepth: limits.maxDepth
    },
    scannedAt: new Date().toISOString(),
    truncated: ctx.truncated
  }
}

export function emptyPluginRegistryState(): PluginRegistryState {
  return { version: 2, items: {} }
}

export function readPluginRegistryState(path: string): PluginRegistryState {
  try {
    return normalizePluginRegistryState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return emptyPluginRegistryState()
  }
}

export function writePluginRegistryState(path: string, state: PluginRegistryState): void {
  const directory = dirname(path)
  const temporary = join(directory, `.plugin-registry.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(
      descriptor,
      `${JSON.stringify(normalizePluginRegistryState(state), null, 2)}\n`,
      'utf8'
    )
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    syncPluginRegistryDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* canonical state remains authoritative */ }
    }
    throw error
  }
}

function syncPluginRegistryDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // The file is fsynced; some filesystems reject directory fsync.
  }
}

export function setPluginRegistryItemEnabled(
  state: PluginRegistryState,
  item: PluginRegistryItem,
  enabled: boolean,
  now: Date = new Date()
): PluginRegistryState {
  return {
    version: 2,
    items: {
      ...normalizePluginRegistryState(state).items,
      [pluginRegistryItemKey(item)]: {
        ...normalizePluginRegistryState(state).items[pluginRegistryItemKey(item)],
        enabled,
        updatedAt: now.toISOString()
      }
    }
  }
}

export function approvePluginRegistryItem(
  state: PluginRegistryState,
  item: PluginRegistryItem,
  now: Date = new Date()
): PluginRegistryState {
  if (!item.contentDigest || item.trust.status === 'invalid') {
    throw new Error(item.trust.reason || 'Plugin content digest is unavailable')
  }
  const normalized = normalizePluginRegistryState(state)
  const key = pluginRegistryItemKey(item)
  const approvedAt = now.toISOString()
  return {
    version: 2,
    items: {
      ...normalized.items,
      [key]: {
        enabled: normalized.items[key]?.enabled ?? true,
        updatedAt: normalized.items[key]?.updatedAt ?? approvedAt,
        approval: {
          contentDigest: item.contentDigest,
          capabilityDigest: item.capabilityManifest.digest,
          capabilities: [...item.capabilityManifest.capabilities],
          approvedAt
        }
      }
    }
  }
}

export function pluginRegistryItemKey(
  item: Pick<PluginRegistryItem, 'kind' | 'sourceRoot' | 'path' | 'name'>
): string {
  return JSON.stringify([item.kind, resolve(item.sourceRoot), resolve(item.path), item.name])
}

function applyPluginRegistryState(
  items: DiscoveredPluginRegistryItem[],
  state: PluginRegistryState,
  ctx: ScanContext
): PluginRegistryItem[] {
  const normalized = normalizePluginRegistryState(state)
  return items.map((item) => {
    const override = normalized.items[pluginRegistryItemKey(item)]
    const sourceKind = sourceKindForRoot(item.sourceRoot)
    const projected = projectPluginRegistryItemTrust(item, sourceKind, override)
    if (projected.error) addDiagnostic(ctx, 'digest_failed', item.path, projected.error)
    return projected.item
  })
}

function sourceKindForRoot(sourceRoot: string): PluginRegistrySourceKind {
  const root = resolve(sourceRoot)
  const userRoot = caogenUserExtensionRoot()

  if (root === userRoot || isInsidePath(userRoot, root)) return 'user'
  if (root.split(/[\\/]+/).includes('.caogen')) return 'project'
  return 'other'
}

function isInsidePath(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && rel !== '..')
}

function normalizePluginRegistryState(value: unknown): PluginRegistryState {
  if (!isJsonObject(value)) return emptyPluginRegistryState()
  const items: Record<string, PluginRegistryStateEntry> = {}
  if (isJsonObject(value.items)) {
    for (const [key, entry] of Object.entries(value.items)) {
      if (!isJsonObject(entry) || typeof entry.enabled !== 'boolean') continue
      const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
        ? entry.updatedAt
        : new Date(0).toISOString()
      const approval = normalizeApproval(entry.approval)
      items[key] = { enabled: entry.enabled, updatedAt, ...(approval ? { approval } : {}) }
    }
  }
  return { version: 2, items }
}

function normalizeApproval(value: unknown): PluginRegistryStateEntry['approval'] | undefined {
  if (!isJsonObject(value)) return undefined
  if (!isSha256(value.contentDigest) || !isSha256(value.capabilityDigest)) return undefined
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((entry) => typeof entry === 'string')) return undefined
  if (typeof value.approvedAt !== 'string' || !value.approvedAt.trim()) return undefined
  return {
    contentDigest: value.contentDigest,
    capabilityDigest: value.capabilityDigest,
    capabilities: [...new Set(value.capabilities)].sort(),
    approvedAt: value.approvedAt
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function scanStandaloneSkillRoot(sourceRoot: string, items: DiscoveredPluginRegistryItem[], ctx: ScanContext): void {
  if (basename(sourceRoot) !== 'skills' && !existsSync(join(sourceRoot, 'SKILL.md'))) return
  visitSkillDir(sourceRoot, sourceRoot, 0, items, ctx)
  if (basename(sourceRoot) !== 'skills') return
  for (const entry of readDir(sourceRoot, ctx)) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md' || entry.name === 'SKILL.md') continue
    const path = join(sourceRoot, entry.name)
    const text = readTextFile(path, ctx)
    if (text === null) continue
    const meta = extractTextMetadata(text)
    const name = meta.name ?? basename(entry.name, extname(entry.name))
    items.push({
      id: makeId('skill', sourceRoot, path, name),
      name,
      kind: 'skill',
      sourceRoot,
      path,
      enabled: true,
      summary: meta.summary,
      version: meta.version
    })
  }
}

function scanPluginManifest(sourceRoot: string, items: DiscoveredPluginRegistryItem[], ctx: ScanContext): void {
  const manifest = readFirstExistingText(
    [join(sourceRoot, '.caogen-plugin', 'plugin.json'), join(sourceRoot, 'plugin.json')],
    ctx
  )
  if (!manifest) return

  const parsed = parseJson(manifest.path, manifest.text, ctx)
  if (!parsed) return

  const meta = extractJsonMetadata(parsed)
  const name = meta.name ?? basename(sourceRoot)
  items.push({
    id: makeId('plugin', sourceRoot, sourceRoot, name),
    name,
    kind: 'plugin',
    sourceRoot,
    path: sourceRoot,
    enabled: inferEnabled(parsed),
    summary: meta.summary ?? pluginVersionSummary(parsed),
    version: cleanOneLine(firstString(parsed.version)),
    permissions: extractDeclaredPermissions(parsed)
  })
}

function readFirstExistingText(paths: string[], ctx: ScanContext): { path: string; text: string } | null {
  for (const path of paths) {
    const text = readTextFile(path, ctx)
    if (text !== null) return { path, text }
  }
  return null
}

function scanSkills(sourceRoot: string, items: DiscoveredPluginRegistryItem[], ctx: ScanContext): void {
  const skillsDir = join(sourceRoot, 'skills')
  if (!isDirectory(skillsDir)) return
  visitSkillDir(sourceRoot, skillsDir, 0, items, ctx)
}

function visitSkillDir(
  sourceRoot: string,
  dir: string,
  depth: number,
  items: DiscoveredPluginRegistryItem[],
  ctx: ScanContext
): void {
  const skillPath = join(dir, 'SKILL.md')
  const skillText = readTextFile(skillPath, ctx)

  if (skillText !== null) {
    const meta = extractTextMetadata(skillText)
    const name = meta.name ?? basename(dir)
    items.push({
      id: makeId('skill', sourceRoot, dir, name),
      name,
      kind: 'skill',
      sourceRoot,
      path: dir,
      enabled: true,
      summary: meta.summary,
      version: meta.version
    })
    return
  }

  if (depth >= ctx.limits.maxDepth || ctx.truncated) return

  for (const entry of readDir(dir, ctx)) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue
    visitSkillDir(sourceRoot, join(dir, entry.name), depth + 1, items, ctx)
    if (ctx.truncated) return
  }
}

function scanAgents(sourceRoot: string, items: DiscoveredPluginRegistryItem[], ctx: ScanContext): void {
  const agentsDir = join(sourceRoot, 'agents')
  if (!isDirectory(agentsDir)) return

  walkFiles(agentsDir, 0, ctx, (filePath, name) => {
    const ext = extname(name).toLowerCase()
    if (ext !== '.md' && ext !== '.json') return

    const text = readTextFile(filePath, ctx)
    if (text === null) return

    const fallbackName = basename(name, ext)
    const parsed = ext === '.json' ? parseJson(filePath, text, ctx) : null
    const meta = parsed ? extractJsonMetadata(parsed) : extractTextMetadata(text)
    items.push({
      id: makeId('agent', sourceRoot, filePath, meta.name ?? fallbackName),
      name: meta.name ?? fallbackName,
      kind: 'agent',
      sourceRoot,
      path: filePath,
      enabled: inferEnabled(parsed),
      summary: meta.summary
    })
  })
}

function scanManagedPluginPackages(
  sourceRoot: string,
  items: DiscoveredPluginRegistryItem[],
  ctx: ScanContext
): void {
  if (basename(sourceRoot) !== '.caogen') return
  const pluginsRoot = join(sourceRoot, 'plugins')
  if (!isDirectory(pluginsRoot)) return
  for (const entry of readDir(pluginsRoot, ctx)) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue
    const pluginRoot = join(pluginsRoot, entry.name)
    scanPluginManifest(pluginRoot, items, ctx)
    scanStandaloneSkillRoot(pluginRoot, items, ctx)
    scanSkills(pluginRoot, items, ctx)
    scanAgents(pluginRoot, items, ctx)
  }
}

function scanMcpConfigs(sourceRoot: string, items: DiscoveredPluginRegistryItem[], ctx: ScanContext): void {
  const seen = new Set<string>()
  const scanRoots = basename(sourceRoot) === '.caogen'
    ? [join(sourceRoot, 'mcp'), join(sourceRoot, 'plugins')]
    : [sourceRoot]
  for (const root of scanRoots) {
    if (!isDirectory(root)) continue
    walkFiles(root, 0, ctx, (filePath, name) => {
      if (!MCP_CONFIG_NAMES.has(name)) return
      scanMcpConfigFile(sourceRoot, filePath, items, ctx, seen)
    })
  }
}

function scanMcpConfigFile(
  sourceRoot: string,
  filePath: string,
  items: DiscoveredPluginRegistryItem[],
  ctx: ScanContext,
  seen: Set<string>
): void {
  const normalized = resolve(filePath)
  if (seen.has(normalized)) return
  seen.add(normalized)

  const text = readTextFile(normalized, ctx)
  if (text === null) return

  const parsed = parseJson(normalized, text, ctx)
  if (!parsed) return

  const servers = parsed.mcpServers
  if (servers === undefined) return
  if (!isJsonObject(servers)) {
    addDiagnostic(ctx, 'json_shape_invalid', normalized, 'MCP config has a non-object mcpServers field.')
    return
  }

  for (const [name, config] of Object.entries(servers)) {
    items.push({
      id: makeId('mcp', sourceRoot, normalized, name),
      name,
      kind: 'mcp',
      sourceRoot,
      path: normalized,
      enabled: inferEnabled(config),
      summary: describeMcpServer(config),
      permissions: mcpEnvKeyPermissions(config)
    })
  }
}

function walkFiles(
  dir: string,
  depth: number,
  ctx: ScanContext,
  visit: (filePath: string, name: string) => void
): void {
  if (depth > ctx.limits.maxDepth || ctx.truncated) return

  for (const entry of readDir(dir, ctx)) {
    if (IGNORED_DIRS.has(entry.name)) continue

    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < ctx.limits.maxDepth) walkFiles(fullPath, depth + 1, ctx, visit)
    } else if (entry.isFile()) {
      if (!countFile(fullPath, ctx)) return
      visit(fullPath, entry.name)
    }

    if (ctx.truncated) return
  }
}

function readTextFile(path: string, ctx: ScanContext): string | null {
  if (!existsSync(path)) return null
  let size = 0
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return null
    size = stat.size
  } catch (err) {
    addDiagnostic(ctx, 'read_failed', path, messageFromError(err))
    return null
  }

  if (!countFile(path, ctx)) return null
  if (size > ctx.limits.maxReadBytes) {
    addDiagnostic(ctx, 'read_failed', path, `File exceeds maxReadBytes (${ctx.limits.maxReadBytes}).`)
    return null
  }

  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    addDiagnostic(ctx, 'read_failed', path, messageFromError(err))
    return null
  }
}

function readDir(dir: string, ctx: ScanContext): Dirent<string>[] {
  try {
    return readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    addDiagnostic(ctx, 'read_failed', dir, messageFromError(err))
    return []
  }
}

function parseJson(path: string, text: string, ctx: ScanContext): JsonObject | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (isJsonObject(parsed)) return parsed
    addDiagnostic(ctx, 'json_shape_invalid', path, 'JSON root is not an object.')
    return null
  } catch (err) {
    addDiagnostic(ctx, 'json_parse_failed', path, messageFromError(err))
    return null
  }
}

function extractTextMetadata(text: string): { name?: string; summary?: string; version?: string } {
  const frontmatter = parseFrontmatter(text)
  const name = firstString(frontmatter.name, frontmatter.title)
  const summary = firstString(frontmatter.description, frontmatter.summary) ?? firstMarkdownSummary(text)
  return {
    name: cleanOneLine(name),
    summary: cleanOneLine(summary),
    version: cleanOneLine(firstString(frontmatter.version))
  }
}

/**
 * 从 plugin manifest 提取"声明的"权限/能力清单(permissions/allowedTools/
 * capabilities 的字符串数组)。仅 manifest 自述,未经运行时验证 —— UI 已如实标注。
 */
function extractDeclaredPermissions(obj: JsonObject): string[] | undefined {
  const out: string[] = []
  for (const key of ['permissions', 'allowedTools', 'capabilities'] as const) {
    const value = obj[key]
    if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string' && v.trim()) out.push(v.trim().slice(0, 60))
    }
  }
  return out.length > 0 ? out.slice(0, 20) : undefined
}

function extractJsonMetadata(obj: JsonObject): { name?: string; summary?: string } {
  const pluginInterface = isJsonObject(obj.interface) ? obj.interface : undefined
  return {
    name: cleanOneLine(firstString(pluginInterface?.displayName, obj.name, obj.title, obj.id)),
    summary: cleanOneLine(
      firstString(pluginInterface?.shortDescription, pluginInterface?.longDescription, obj.description, obj.summary)
    )
  }
}

function parseFrontmatter(text: string): JsonObject {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}

  const meta: JsonObject = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---') break
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    meta[match[1]] = stripYamlQuotes(match[2])
  }
  return meta
}

function firstMarkdownSummary(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  let inFrontmatter = lines[0]?.trim() === '---'

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) continue
    if (inFrontmatter) {
      if (i > 0 && line === '---') inFrontmatter = false
      continue
    }
    if (line === '---' || line.startsWith('#')) continue
    return line
  }

  return undefined
}

/** MCP 声明的环境变量名(只取名字,绝不取值)作为权限提示 */
function mcpEnvKeyPermissions(config: unknown): string[] | undefined {
  if (!isJsonObject(config) || !isJsonObject(config.env)) return undefined
  const keys = Object.keys(config.env).filter(Boolean).slice(0, 20)
  return keys.length > 0 ? keys.map((k) => `环境变量: ${k}`) : undefined
}

function describeMcpServer(config: unknown): string | undefined {
  if (!isJsonObject(config)) return undefined
  if (typeof config.command === 'string') return 'transport: stdio'
  if (typeof config.url === 'string') return 'transport: http'
  const transport = cleanOneLine(firstString(config.transport))?.toLowerCase()
  return transport ? `transport: ${transport}` : 'transport: unknown'
}

function pluginVersionSummary(config: JsonObject): string | undefined {
  const version = cleanOneLine(firstString(config.version))
  return version ? `version: ${version}` : undefined
}

function inferEnabled(config: unknown): boolean {
  if (!isJsonObject(config)) return true
  if (config.enabled === false) return false
  if (config.disabled === true) return false
  return true
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function cleanOneLine(value: string | undefined): string | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.length > SUMMARY_CHARS ? `${cleaned.slice(0, SUMMARY_CHARS - 1)}…` : cleaned
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function countFile(path: string, ctx: ScanContext): boolean {
  const normalized = resolve(path)
  if (ctx.countedFiles.has(normalized)) return true
  if (ctx.countedFiles.size >= ctx.limits.maxFiles) {
    if (!ctx.truncated) {
      addDiagnostic(ctx, 'max_files_reached', normalized, `File scan limit reached (${ctx.limits.maxFiles}).`)
    }
    ctx.truncated = true
    return false
  }
  ctx.countedFiles.add(normalized)
  return true
}

function addDiagnostic(
  ctx: ScanContext,
  code: PluginRegistryDiagnostic['code'],
  path: string,
  message: string
): void {
  ctx.diagnostics.push({ code, path, message })
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeLimits(options: PluginRegistryScanOptions): ScanLimits {
  return {
    maxFiles: positiveInt(options.maxFiles, DEFAULT_MAX_FILES),
    maxDepth: positiveInt(options.maxDepth, DEFAULT_MAX_DEPTH),
    maxReadBytes: positiveInt(options.maxReadBytes, DEFAULT_MAX_READ_BYTES)
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.max(1, Math.floor(value))
}

function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const root of roots) {
    const expanded = expandHome(root.trim())
    if (!expanded) continue
    const resolved = resolve(expanded)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    normalized.push(resolved)
  }

  return normalized
}

function expandHome(path: string): string {
  if (path === '~') return caogenExtensionHome()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(caogenExtensionHome(), path.slice(2))
  return path
}

function makeId(kind: PluginRegistryKind, sourceRoot: string, path: string, name: string): string {
  const rel = relative(sourceRoot, path) || basename(path) || name
  return `${kind}:${slug(rel)}:${slug(name)}`
}

function slug(value: string): string {
  const normalized = value.replace(/[\\/]+/g, '/').replace(/[^A-Za-z0-9._/-]+/g, '-')
  const compact = normalized.replace(/-+/g, '-').replace(/^-|-$/g, '')
  return compact.slice(0, 160) || 'item'
}

function dedupeItems(items: DiscoveredPluginRegistryItem[]): DiscoveredPluginRegistryItem[] {
  const seen = new Set<string>()
  const unique: DiscoveredPluginRegistryItem[] = []

  for (const item of items) {
    const key = `${item.kind}\0${item.sourceRoot}\0${item.path}\0${item.name}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }

  return unique
}

function compareItems(a: PluginRegistryItem, b: PluginRegistryItem): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name) ||
    a.sourceRoot.localeCompare(b.sourceRoot) ||
    a.path.localeCompare(b.path)
  )
}
