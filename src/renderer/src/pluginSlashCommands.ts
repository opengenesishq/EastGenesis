import type { PluginRegistryItem, PluginRegistryKind, PluginRegistrySourceKind } from '../../shared/types'

export type PluginSlashAction = 'use' | 'dispatch-agent'

export interface PluginSlashCommandDescriptor {
  id: string
  title: string
  hint: string
  searchText: string
  action: PluginSlashAction
  item: PluginRegistryItem
}

export interface PluginSlashCommandOptions {
  maxItems?: number
  includeDisabled?: boolean
}

const DEFAULT_MAX_ITEMS = 80

const KIND_PREFIX: Record<PluginRegistryKind, string> = {
  plugin: '/plugin',
  skill: '/skill',
  agent: '/agent',
  mcp: '/mcp'
}

const KIND_LABEL: Record<PluginRegistryKind, string> = {
  plugin: 'Plugin',
  skill: 'Skill',
  agent: 'Agent',
  mcp: 'MCP'
}

const SOURCE_LABEL: Record<PluginRegistrySourceKind, string> = {
  project: 'Project',
  user: 'User',
  other: 'Other'
}

export function shouldLoadPluginSlashRegistry(query: string | null): boolean {
  if (query === null) return false
  return query.trim().length >= 2
}

export function buildPluginSlashCommands(
  items: PluginRegistryItem[],
  options: PluginSlashCommandOptions = {}
): PluginSlashCommandDescriptor[] {
  const maxItems = normalizeMaxItems(options.maxItems)
  return items
    .filter((item) => options.includeDisabled || item.enabled)
    .slice()
    .sort(comparePluginSlashItems)
    .slice(0, maxItems)
    .map(toPluginSlashCommand)
}

export function pluginSlashCommandMatches(command: Pick<PluginSlashCommandDescriptor, 'searchText'>, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return command.searchText.includes(normalized)
}

function toPluginSlashCommand(item: PluginRegistryItem): PluginSlashCommandDescriptor {
  const prefix = KIND_PREFIX[item.kind]
  const source = SOURCE_LABEL[item.sourceKind ?? 'other']
  const summary = item.summary?.trim()
  const action: PluginSlashAction = item.kind === 'agent' ? 'dispatch-agent' : 'use'
  const actionLabel = action === 'dispatch-agent' ? '派发子 Agent' : '交给当前 Agent'
  const hint = [KIND_LABEL[item.kind], source, actionLabel, summary].filter(Boolean).join(' · ')
  const title = `${prefix} ${item.name}`
  const searchText = [title, hint, item.name, item.kind, item.summary, item.sourceKind, item.sourceRoot, item.path]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return {
    id: `plugin-registry:${item.kind}:${item.id}`,
    title,
    hint,
    searchText,
    action,
    item
  }
}

function comparePluginSlashItems(a: PluginRegistryItem, b: PluginRegistryItem): number {
  const sourceDelta = sourceRank(a.sourceKind) - sourceRank(b.sourceKind)
  if (sourceDelta !== 0) return sourceDelta

  const kindDelta = kindRank(a.kind) - kindRank(b.kind)
  if (kindDelta !== 0) return kindDelta

  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

function sourceRank(source: PluginRegistrySourceKind | undefined): number {
  if (source === 'project') return 0
  if (source === 'user') return 1
  return 2
}

function kindRank(kind: PluginRegistryKind): number {
  if (kind === 'plugin') return 0
  if (kind === 'skill') return 1
  if (kind === 'agent') return 2
  return 3
}

function normalizeMaxItems(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ITEMS
  return Math.max(1, Math.min(200, Math.floor(value)))
}
