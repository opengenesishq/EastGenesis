import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import McpOAuthCard from './McpOAuthCard'
import PluginCatalogPanel from './PluginCatalogPanel'

export type PluginRegistryKind = 'plugin' | 'skill' | 'agent' | 'mcp'
export type PluginRegistrySourceKind = 'project' | 'user' | 'other'
export type PluginRegistryEnabledSource = 'manifest' | 'user'
export type PluginRegistryTrustStatus = 'approved' | 'approval_required' | 'changed' | 'invalid'

export interface PluginRegistryPanelItem {
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
  version?: string
  permissions?: string[]
  managed?: boolean
  contentDigest?: string
  provenance: {
    origin: 'project_local' | 'user_local' | 'managed_local' | 'other_local'
    sourceKind: PluginRegistrySourceKind
    managed: boolean
  }
  capabilityManifest: {
    schemaVersion: 1
    capabilities: string[]
    transport?: 'stdio' | 'http' | 'unknown'
    environmentVariables?: string[]
    digest: string
  }
  trust: {
    status: PluginRegistryTrustStatus
    approvedAt?: string
    capabilityDiff: { added: string[]; removed: string[]; expanded: boolean }
    reason?: string
  }
}

export interface PluginRegistryPanelDiagnostic {
  code: string
  message: string
  path: string
}

export interface PluginRegistryPanelLabels {
  title?: string
  subtitle?: string
  loading?: string
  refresh?: string
  close?: string
  searchPlaceholder?: string
  allKinds?: string
  plugins?: string
  skills?: string
  agents?: string
  mcp?: string
  allStatuses?: string
  allSources?: string
  projectSource?: string
  userSource?: string
  otherSource?: string
  enabled?: string
  disabled?: string
  total?: string
  active?: string
  inactive?: string
  roots?: string
  diagnostics?: string
  truncated?: string
  yes?: string
  no?: string
  scanTime?: string
  selected?: string
  noSelection?: string
  empty?: string
  open?: string
  reveal?: string
  useWithAgent?: string
  dispatchAgent?: string
  enable?: string
  disable?: string
  status?: string
  stateSource?: string
  updatedAt?: string
  source?: string
  sourceRoot?: string
  path?: string
  summary?: string
}

export interface PluginRegistryPanelProps {
  items: PluginRegistryPanelItem[]
  roots?: string[]
  diagnostics?: PluginRegistryPanelDiagnostic[]
  scannedAt?: string
  truncated?: boolean
  loading?: boolean
  error?: string
  message?: string
  selectedItemId?: string
  className?: string
  labels?: PluginRegistryPanelLabels
  onRefresh?: () => void | Promise<void>
  onClose?: () => void
  onSelectItem?: (item: PluginRegistryPanelItem) => void
  onOpenItem?: (item: PluginRegistryPanelItem) => void
  onRevealItem?: (item: PluginRegistryPanelItem) => void
  onUseItem?: (item: PluginRegistryPanelItem) => void | Promise<void>
  onDispatchAgent?: (item: PluginRegistryPanelItem) => void | Promise<void>
  onToggleItem?: (item: PluginRegistryPanelItem, enabled: boolean) => void | Promise<void>
  onApproveItem?: (item: PluginRegistryPanelItem) => void | Promise<void>
  /** MCP 运行态:探测可见 mcp 条目的真实连接状态 */
  onProbeMcp?: (items: PluginRegistryPanelItem[]) => void | Promise<void>
  /** 本地安装插件，从目录复制入 EastGenesis 托管插件区。 */
  onInstall?: () => void | Promise<void>
  /** 卸载托管插件(回收站式,仅 managed 条目) */
  onUninstall?: (item: PluginRegistryPanelItem) => void | Promise<void>
  /** MCP 探测结果(id → 状态);进行中用 mcpProbing */
  mcpProbeResults?: Record<string, McpProbeStatus>
  mcpProbing?: boolean
}

/** 面板展示用的 MCP 探测状态(shared McpProbeResult 的展示投影) */
export interface McpProbeStatus {
  ok: boolean
  serverName?: string
  serverVersion?: string
  latencyMs?: number
  error?: string
}

type KindFilter = PluginRegistryKind | 'all'
type StatusFilter = 'all' | 'enabled' | 'disabled'
type SourceFilter = PluginRegistrySourceKind | 'all'

const KIND_ORDER: PluginRegistryKind[] = ['plugin', 'skill', 'agent', 'mcp']
const SOURCE_ORDER: PluginRegistrySourceKind[] = ['project', 'user', 'other']

function translatedLabels(t: ReturnType<typeof useT>): Required<PluginRegistryPanelLabels> {
  return {
  title: t('pluginRegistryTitle'),
  subtitle: t('pluginRegistrySubtitle'),
  loading: t('pluginRegistryLoading'),
  refresh: t('pluginRegistryRefresh'),
  close: t('pluginRegistryClose'),
  searchPlaceholder: t('pluginRegistrySearchPlaceholder'),
  allKinds: t('pluginRegistryAllKinds'),
  plugins: 'Plugins',
  skills: 'Skills',
  agents: 'Agents',
  mcp: 'MCP',
  allStatuses: t('pluginRegistryAllStatuses'),
  allSources: t('pluginRegistryAllSources'),
  projectSource: t('pluginRegistryProjectSource'),
  userSource: t('pluginRegistryUserSource'),
  otherSource: t('pluginRegistryOtherSource'),
  enabled: t('pluginRegistryEnabled'),
  disabled: t('pluginRegistryDisabled'),
  total: t('pluginRegistryTotal'),
  active: t('pluginRegistryActive'),
  inactive: t('pluginRegistryInactive'),
  roots: t('pluginRegistryRoots'),
  diagnostics: t('pluginRegistryDiagnostics'),
  truncated: t('pluginRegistryTruncated'),
  yes: t('pluginRegistryYes'),
  no: t('pluginRegistryNo'),
  scanTime: t('pluginRegistryScanTime'),
  selected: t('pluginRegistrySelected'),
  noSelection: t('pluginRegistryNoSelection'),
  empty: t('pluginRegistryEmpty'),
  open: t('pluginRegistryOpen'),
  reveal: t('pluginRegistryReveal'),
  useWithAgent: t('pluginRegistryUseWithAgent'),
  dispatchAgent: t('pluginRegistryDispatchAgent'),
  enable: t('pluginRegistryEnable'),
  disable: t('pluginRegistryDisable'),
  status: t('pluginRegistryStatus'),
  stateSource: t('pluginRegistryStateSource'),
  updatedAt: t('pluginRegistryUpdatedAt'),
  source: t('pluginRegistrySource'),
  sourceRoot: t('pluginRegistrySourceRoot'),
  path: t('pluginRegistryPath'),
  summary: t('pluginRegistrySummary')
  }
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function mergeLabels(
  labels: PluginRegistryPanelLabels | undefined,
  t: ReturnType<typeof useT>
): Required<PluginRegistryPanelLabels> {
  return { ...translatedLabels(t), ...labels }
}

function kindLabel(kind: KindFilter, labels: Required<PluginRegistryPanelLabels>): string {
  if (kind === 'plugin') return labels.plugins
  if (kind === 'skill') return labels.skills
  if (kind === 'agent') return labels.agents
  if (kind === 'mcp') return labels.mcp
  return labels.allKinds
}

function itemKindLabel(kind: PluginRegistryKind, labels: Required<PluginRegistryPanelLabels>): string {
  return kindLabel(kind, labels)
}

function sourceLabel(source: SourceFilter | undefined, labels: Required<PluginRegistryPanelLabels>): string {
  if (source === 'project') return labels.projectSource
  if (source === 'user') return labels.userSource
  if (source === 'other') return labels.otherSource
  return labels.allSources
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase()
}

function itemMatchesQuery(item: PluginRegistryPanelItem, query: string): boolean {
  if (!query) return true
  return [item.name, item.summary, item.sourceRoot, item.path, item.kind, item.sourceKind, item.enabledSource]
    .join('\n')
    .toLowerCase()
    .includes(query)
}

function itemMatchesStatus(item: PluginRegistryPanelItem, status: StatusFilter): boolean {
  if (status === 'enabled') return item.enabled
  if (status === 'disabled') return !item.enabled
  return true
}

function itemMatchesSource(item: PluginRegistryPanelItem, source: SourceFilter): boolean {
  if (source === 'all') return true
  return (item.sourceKind ?? 'other') === source
}

function compareItems(a: PluginRegistryPanelItem, b: PluginRegistryPanelItem): number {
  return (
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.name.localeCompare(b.name) ||
    a.sourceRoot.localeCompare(b.sourceRoot) ||
    a.path.localeCompare(b.path)
  )
}

function formatScanTime(value: string | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function shortPath(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const parts = clean.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 3) return path
  return `.../${parts.slice(-3).join('/')}`
}

function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: string }): React.JSX.Element {
  return (
    <div className={cx('plugin-registry-stat', tone && `plugin-registry-stat-${tone}`)}>
      <span className="plugin-registry-stat-label">{label}</span>
      <b className="plugin-registry-stat-value">{value}</b>
    </div>
  )
}

function MetaRow({
  label,
  children,
  mono = false
}: {
  label: string
  children: ReactNode
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="plugin-registry-meta-row">
      <span className="plugin-registry-meta-label">{label}</span>
      <span className={cx('plugin-registry-meta-value', mono && 'plugin-registry-mono')}>{children}</span>
    </div>
  )
}

export default function PluginRegistryPanel({
  items,
  roots = [],
  diagnostics = [],
  scannedAt,
  truncated = false,
  loading = false,
  error,
  message,
  selectedItemId,
  className,
  labels: labelOverrides,
  onRefresh,
  onClose,
  onSelectItem,
  onOpenItem,
  onRevealItem,
  onUseItem,
  onDispatchAgent,
  onToggleItem,
  onApproveItem,
  onProbeMcp,
  onInstall,
  onUninstall,
  mcpProbeResults = {},
  mcpProbing = false
}: PluginRegistryPanelProps): React.JSX.Element {
  const t = useT()
  const labels = mergeLabels(labelOverrides, t)
  const zh = useStore(state => state.settings.language === 'zh')
  const [surface, setSurface] = useState<'installed' | 'catalog'>('installed')
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [localSelectedId, setLocalSelectedId] = useState<string | undefined>()

  const stats = useMemo(() => {
    const byKind: Record<PluginRegistryKind, number> = { plugin: 0, skill: 0, agent: 0, mcp: 0 }
    const bySource: Record<PluginRegistrySourceKind, number> = { project: 0, user: 0, other: 0 }
    let enabled = 0

    for (const item of items) {
      byKind[item.kind] += 1
      bySource[item.sourceKind ?? 'other'] += 1
      if (item.enabled) enabled += 1
    }

    return {
      byKind,
      bySource,
      enabled,
      disabled: items.length - enabled,
      total: items.length
    }
  }, [items])

  const visibleItems = useMemo(() => {
    const normalizedQuery = normalizeSearch(query)
    return items
      .filter((item) => kindFilter === 'all' || item.kind === kindFilter)
      .filter((item) => itemMatchesStatus(item, statusFilter))
      .filter((item) => itemMatchesSource(item, sourceFilter))
      .filter((item) => itemMatchesQuery(item, normalizedQuery))
      .slice()
      .sort(compareItems)
  }, [items, kindFilter, query, sourceFilter, statusFilter])

  const selectedItem = useMemo(() => {
    const id = selectedItemId ?? localSelectedId
    return items.find((item) => item.id === id) ?? visibleItems[0]
  }, [items, localSelectedId, selectedItemId, visibleItems])

  const selectItem = (item: PluginRegistryPanelItem): void => {
    setLocalSelectedId(item.id)
    onSelectItem?.(item)
  }

  return (
    <div className={cx('plugin-registry-panel', className)}>
      <header className="plugin-registry-header">
        <div className="plugin-registry-heading">
          <div className="plugin-registry-title">{labels.title}</div>
          <div className="plugin-registry-subtitle">{labels.subtitle}</div>
        </div>
        <div className="plugin-registry-actions">
          {onInstall && (
            <button
              className="btn btn-ghost btn-sm"
              title={t('pluginRegistryInstallHint')}
              onClick={() => void onInstall()}
            >
              {t('pluginRegistryInstall')}
            </button>
          )}
          {onProbeMcp && stats.byKind.mcp > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={mcpProbing}
              title={t('pluginRegistryProbeMcpHint')}
              onClick={() => void onProbeMcp(items.filter((item) => item.kind === 'mcp'))}
            >
              {mcpProbing ? t('pluginRegistryProbingMcp') : t('pluginRegistryProbeMcp')}
            </button>
          )}
          {onRefresh && (
            <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void onRefresh()}>
              {loading ? labels.loading : labels.refresh}
            </button>
          )}
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              {labels.close}
            </button>
          )}
        </div>
      </header>

      <nav className="plugin-registry-surfaces" aria-label={zh ? '插件目录视图' : 'Plugin catalog views'}>
        <button className="btn btn-ghost btn-sm" data-plugin-surface="installed" aria-pressed={surface === 'installed'} onClick={() => setSurface('installed')}>{zh ? '已安装' : 'Installed'}</button>
        <button className="btn btn-ghost btn-sm" data-plugin-surface="catalog" aria-pressed={surface === 'catalog'} onClick={() => setSurface('catalog')}>{zh ? '发现' : 'Discover'}</button>
      </nav>
      {surface === 'catalog' ? <PluginCatalogPanel onInstalled={onRefresh} /> : <>

      {error && <div className="notice notice-error plugin-registry-notice">{error}</div>}
      {message && <div className="notice notice-info plugin-registry-notice">{message}</div>}

      <section className="plugin-registry-summary" aria-label={labels.status}>
        <StatCard label={labels.total} value={stats.total} />
        <StatCard label={labels.plugins} value={stats.byKind.plugin} />
        <StatCard label={labels.skills} value={stats.byKind.skill} />
        <StatCard label={labels.agents} value={stats.byKind.agent} />
        <StatCard label={labels.mcp} value={stats.byKind.mcp} />
        <StatCard label={labels.active} value={stats.enabled} tone="enabled" />
        <StatCard label={labels.inactive} value={stats.disabled} tone="disabled" />
        <StatCard label={t('pluginRegistryPendingApproval')} value={items.filter((item) => item.trust.status !== 'approved').length} tone="disabled" />
      </section>

      <section className="plugin-registry-toolbar">
        <input
          className="input plugin-registry-search"
          value={query}
          placeholder={labels.searchPlaceholder}
          aria-label={labels.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="plugin-registry-filter-group" role="group" aria-label={t('pluginRegistryKindFilter')}>
          {(['all', ...KIND_ORDER] as KindFilter[]).map((kind) => (
            <button
              type="button"
              key={kind}
              className={cx('plugin-registry-filter', kindFilter === kind && 'plugin-registry-filter-active')}
              aria-pressed={kindFilter === kind}
              onClick={() => setKindFilter(kind)}
            >
              {kindLabel(kind, labels)}
              <span className="plugin-registry-filter-count">
                {kind === 'all' ? stats.total : stats.byKind[kind]}
              </span>
            </button>
          ))}
        </div>
        <div className="plugin-registry-filter-group" role="group" aria-label={t('pluginRegistryStatusFilter')}>
          {(['all', 'enabled', 'disabled'] as StatusFilter[]).map((status) => (
            <button
              type="button"
              key={status}
              className={cx('plugin-registry-filter', statusFilter === status && 'plugin-registry-filter-active')}
              aria-pressed={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {status === 'enabled'
                ? labels.enabled
                : status === 'disabled'
                  ? labels.disabled
                  : labels.allStatuses}
            </button>
          ))}
        </div>
        <div className="plugin-registry-filter-group" role="group" aria-label={t('pluginRegistrySourceFilter')}>
          {(['all', ...SOURCE_ORDER] as SourceFilter[]).map((source) => (
            <button
              type="button"
              key={source}
              className={cx('plugin-registry-filter', sourceFilter === source && 'plugin-registry-filter-active')}
              aria-pressed={sourceFilter === source}
              onClick={() => setSourceFilter(source)}
            >
              {sourceLabel(source, labels)}
              <span className="plugin-registry-filter-count">
                {source === 'all' ? stats.total : stats.bySource[source]}
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="plugin-registry-body">
        <section className="plugin-registry-list" aria-label={labels.title}>
          {loading && visibleItems.length === 0 ? (
            <div className="plugin-registry-empty">{labels.loading}</div>
          ) : visibleItems.length === 0 ? (
            <div className="plugin-registry-empty">{labels.empty}</div>
          ) : (
            visibleItems.map((item) => <PluginRegistryRow
              key={item.id}
              item={item}
              selected={selectedItem?.id === item.id}
              labels={labels}
              probe={item.kind === 'mcp' ? mcpProbeResults[item.id] : undefined}
              onSelect={selectItem}
              actions={{ onOpenItem, onRevealItem, onUseItem, onDispatchAgent, onToggleItem, onApproveItem }}
            />)
          )}
        </section>

        <aside className="plugin-registry-status-panel">
          <SelectedPluginCard
            item={selectedItem}
            labels={labels}
            actions={{ onUseItem, onDispatchAgent, onApproveItem, onUninstall }}
          />
          {selectedItem?.kind === 'mcp' && <McpOAuthCard key={selectedItem.id} item={selectedItem} />}

          <section className="plugin-registry-card">
            <h3 className="plugin-registry-card-title">{labels.status}</h3>
            <MetaRow label={labels.roots}>{roots.length}</MetaRow>
            <MetaRow label={labels.diagnostics}>{diagnostics.length}</MetaRow>
            <MetaRow label={labels.truncated}>{truncated ? labels.yes : labels.no}</MetaRow>
            <MetaRow label={labels.scanTime}>{formatScanTime(scannedAt)}</MetaRow>
            {roots.length > 0 && (
              <div className="plugin-registry-path-list">
                {roots.map((root) => (
                  <code key={root} className="plugin-registry-path-chip" title={root}>
                    {shortPath(root)}
                  </code>
                ))}
              </div>
            )}
          </section>

          {diagnostics.length > 0 && (
            <section className="plugin-registry-card">
              <h3 className="plugin-registry-card-title">{labels.diagnostics}</h3>
              <div className="plugin-registry-diagnostics">
                {diagnostics.slice(0, 8).map((diagnostic, index) => (
                  <div key={`${diagnostic.code}-${diagnostic.path}-${index}`} className="plugin-registry-diagnostic">
                    <span className="plugin-registry-diagnostic-code">{diagnostic.code}</span>
                    <span className="plugin-registry-diagnostic-message">{diagnostic.message}</span>
                    <code className="plugin-registry-diagnostic-path" title={diagnostic.path}>
                      {shortPath(diagnostic.path)}
                    </code>
                  </div>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
      </>}
    </div>
  )
}

type PluginRowActions = Pick<PluginRegistryPanelProps,
  'onOpenItem' | 'onRevealItem' | 'onUseItem' | 'onDispatchAgent' | 'onToggleItem' | 'onApproveItem'>

function PluginRegistryRow({ item, selected, labels, probe, onSelect, actions }: {
  item: PluginRegistryPanelItem
  selected: boolean
  labels: Required<PluginRegistryPanelLabels>
  probe?: McpProbeStatus
  onSelect: (item: PluginRegistryPanelItem) => void
  actions: PluginRowActions
}): React.JSX.Element {
  return <article className={cx('plugin-registry-row', selected && 'plugin-registry-row-active')}>
    <button type="button" className="plugin-registry-row-main" title={item.path} onClick={() => onSelect(item)}>
      <span className={cx('plugin-registry-kind', `plugin-registry-kind-${item.kind}`)}>{itemKindLabel(item.kind, labels)}</span>
      <span className="plugin-registry-row-content">
        <span className="plugin-registry-row-name">{item.name}<McpProbeBadge status={probe} /></span>
        <span className="plugin-registry-row-summary">
          <span className={cx('plugin-registry-source', `plugin-registry-source-${item.sourceKind ?? 'other'}`)}>{sourceLabel(item.sourceKind ?? 'other', labels)}</span>
          {item.summary || shortPath(item.path)}
        </span>
      </span>
      <span className={cx('plugin-registry-status-dot', item.enabled ? 'plugin-registry-status-enabled' : 'plugin-registry-status-disabled')} aria-label={item.enabled ? labels.enabled : labels.disabled} />
    </button>
    <PluginRegistryRowActions item={item} labels={labels} actions={actions} />
  </article>
}

function McpProbeBadge({ status }: { status?: McpProbeStatus }): React.JSX.Element | null {
  const t = useT()
  if (!status) return null
  const title = status.ok
    ? [status.serverName && `server: ${status.serverName} ${status.serverVersion ?? ''}`, status.latencyMs !== undefined && `${status.latencyMs}ms`].filter(Boolean).join(' · ')
    : status.error
  return <span className={cx('plugin-registry-probe', status.ok ? 'plugin-registry-probe-ok' : 'plugin-registry-probe-fail')} title={title}>
    {status.ok ? `✓ ${t('pluginRegistryMcpConnected')}${status.latencyMs !== undefined ? ` ${status.latencyMs}ms` : ''}` : `✕ ${t('pluginRegistryMcpFailed')}`}
  </span>
}

function PluginRegistryRowActions({ item, labels, actions }: { item: PluginRegistryPanelItem; labels: Required<PluginRegistryPanelLabels>; actions: PluginRowActions }): React.JSX.Element | null {
  if (!Object.values(actions).some(Boolean)) return null
  return <div className="plugin-registry-row-actions">
    <PluginRegistryPrimaryActions item={item} labels={labels} actions={actions} />
    <PluginRegistryStateActions item={item} labels={labels} actions={actions} />
  </div>
}

function PluginRegistryPrimaryActions({ item, labels, actions }: { item: PluginRegistryPanelItem; labels: Required<PluginRegistryPanelLabels>; actions: PluginRowActions }): React.JSX.Element {
  const { onOpenItem, onRevealItem, onUseItem, onDispatchAgent } = actions
  const executable = item.enabled && item.trust.status === 'approved'
  return <>
    {onOpenItem && <button className="btn btn-ghost btn-sm" onClick={() => onOpenItem(item)}>{labels.open}</button>}
    {onRevealItem && <button className="btn btn-ghost btn-sm" onClick={() => onRevealItem(item)}>{labels.reveal}</button>}
    {onUseItem && <button className="btn btn-primary btn-sm" disabled={!executable} onClick={() => void onUseItem(item)}>{labels.useWithAgent}</button>}
    {onDispatchAgent && item.kind === 'agent' && <button className="btn btn-primary btn-sm" disabled={!executable} onClick={() => void onDispatchAgent(item)}>{labels.dispatchAgent}</button>}
  </>
}

function PluginRegistryStateActions({ item, labels, actions }: { item: PluginRegistryPanelItem; labels: Required<PluginRegistryPanelLabels>; actions: PluginRowActions }): React.JSX.Element {
  const t = useT()
  const { onToggleItem, onApproveItem } = actions
  return <>
    {onToggleItem && <button className="btn btn-ghost btn-sm" onClick={() => void onToggleItem(item, !item.enabled)}>{item.enabled ? labels.disable : labels.enable}</button>}
    {onApproveItem && item.trust.status !== 'approved' && item.trust.status !== 'invalid' && <button className="btn btn-primary btn-sm" onClick={() => void onApproveItem(item)}>{item.trust.status === 'changed' ? t('pluginRegistryReapprove') : t('pluginRegistryApprove')}</button>}
  </>
}

type SelectedPluginActions = Pick<PluginRegistryPanelProps, 'onUseItem' | 'onDispatchAgent' | 'onApproveItem' | 'onUninstall'>

function SelectedPluginCard({ item, labels, actions }: { item?: PluginRegistryPanelItem; labels: Required<PluginRegistryPanelLabels>; actions: SelectedPluginActions }): React.JSX.Element {
  return <section className="plugin-registry-card">
    <h3 className="plugin-registry-card-title">{labels.selected}</h3>
    {item ? <>
      <div className="plugin-registry-selected-head">
        <span className={cx('plugin-registry-kind', `plugin-registry-kind-${item.kind}`)}>{itemKindLabel(item.kind, labels)}</span>
        <strong className="plugin-registry-selected-name">{item.name}</strong>
      </div>
      <SelectedPluginMetadata item={item} labels={labels} />
      <PluginCapabilityList item={item} />
      <PluginPermissionList permissions={item.permissions} />
      <SelectedPluginActionButtons item={item} labels={labels} actions={actions} />
    </> : <div className="plugin-registry-empty plugin-registry-empty-tight">{labels.noSelection}</div>}
  </section>
}

function SelectedPluginMetadata({ item, labels }: { item: PluginRegistryPanelItem; labels: Required<PluginRegistryPanelLabels> }): React.JSX.Element {
  const t = useT()
  return <>
    <MetaRow label={labels.status}><span className={cx('plugin-registry-badge', item.enabled ? 'plugin-registry-badge-enabled' : 'plugin-registry-badge-disabled')}>{item.enabled ? labels.enabled : labels.disabled}</span></MetaRow>
    <MetaRow label={labels.stateSource}>{item.enabledSource === 'user' ? t('pluginRegistryUserOverride') : t('pluginRegistryManifest')}</MetaRow>
    {item.enabledUpdatedAt && <MetaRow label={labels.updatedAt}>{formatScanTime(item.enabledUpdatedAt)}</MetaRow>}
    <MetaRow label={labels.source}>{sourceLabel(item.sourceKind ?? 'other', labels)}</MetaRow>
    <MetaRow label={labels.sourceRoot} mono>{item.sourceRoot}</MetaRow>
    <MetaRow label={labels.path} mono>{item.path}</MetaRow>
    <MetaRow label={labels.summary}>{item.summary || '-'}</MetaRow>
    <MetaRow label={t('pluginRegistryVersion')}>{item.version || t('pluginRegistryUndeclared')}</MetaRow>
    <MetaRow label={t('pluginRegistryProvenance')}>{item.provenance.origin}</MetaRow>
    <MetaRow label={t('pluginRegistryContentDigest')} mono>{item.contentDigest || t('pluginRegistryUnavailable')}</MetaRow>
    <MetaRow label={t('pluginRegistryTrustStatus')}><span className={cx('plugin-registry-badge', item.trust.status === 'approved' ? 'plugin-registry-badge-enabled' : 'plugin-registry-badge-disabled')}>{trustStatusLabel(item.trust.status, t)}</span></MetaRow>
    {item.capabilityManifest.transport && <MetaRow label={t('pluginRegistryTransport')}>{item.capabilityManifest.transport}</MetaRow>}
    {item.capabilityManifest.environmentVariables?.length ? <MetaRow label={t('pluginRegistryEnvironmentVariables')}>{item.capabilityManifest.environmentVariables.join(', ')}</MetaRow> : null}
  </>
}

function PluginCapabilityList({ item }: { item: PluginRegistryPanelItem }): React.JSX.Element {
  const t = useT()
  const diff = item.trust.capabilityDiff
  return <div className="plugin-registry-perms">
    <div className="plugin-registry-perms-label">{t('pluginRegistryCapabilities')}</div>
    <div className="plugin-registry-perm-tags">{item.capabilityManifest.capabilities.map((capability) => <span key={capability} className="plugin-registry-perm-tag">{capability}</span>)}</div>
    {(diff.added.length > 0 || diff.removed.length > 0) && <div className="plugin-registry-perms-hint">
      {t('pluginRegistryCapabilitiesAdded')} {diff.added.join(', ') || '-'}; {t('pluginRegistryCapabilitiesRemoved')} {diff.removed.join(', ') || '-'}
    </div>}
  </div>
}

function PluginPermissionList({ permissions }: { permissions?: string[] }): React.JSX.Element {
  const t = useT()
  return <div className="plugin-registry-perms">
    <div className="plugin-registry-perms-label">{t('pluginRegistryPermissions')}</div>
    {permissions?.length ? <>
      <div className="plugin-registry-perm-tags">{permissions.map((permission) => <span key={permission} className="plugin-registry-perm-tag" title={permission}>{permission}</span>)}</div>
      <div className="plugin-registry-perms-hint">{t('pluginRegistryPermissionsHint')}</div>
    </> : <div className="plugin-registry-perms-hint">{t('pluginRegistryPermissionsEmpty')}</div>}
  </div>
}

function SelectedPluginActionButtons({ item, labels, actions }: { item: PluginRegistryPanelItem; labels: Required<PluginRegistryPanelLabels>; actions: SelectedPluginActions }): React.JSX.Element {
  const t = useT()
  const executable = item.enabled && item.trust.status === 'approved'
  const { onUseItem, onDispatchAgent, onApproveItem, onUninstall } = actions
  const uninstall = (): void => {
    if (onUninstall && window.confirm(t('pluginRegistryUninstallConfirm', { name: item.name }))) void onUninstall(item)
  }
  return <>
    {onUseItem && <button className="btn btn-primary btn-sm plugin-registry-use-selected" disabled={!executable} onClick={() => void onUseItem(item)}>{labels.useWithAgent}</button>}
    {onDispatchAgent && item.kind === 'agent' && <button className="btn btn-primary btn-sm plugin-registry-use-selected" disabled={!executable} onClick={() => void onDispatchAgent(item)}>{labels.dispatchAgent}</button>}
    {onApproveItem && item.trust.status !== 'approved' && item.trust.status !== 'invalid' && <button className="btn btn-primary btn-sm plugin-registry-use-selected" onClick={() => void onApproveItem(item)}>{item.trust.status === 'changed' ? t('pluginRegistryReapproveCurrent') : t('pluginRegistryApproveCurrent')}</button>}
    {onUninstall && item.managed && <button className="btn btn-danger btn-sm plugin-registry-use-selected" title={t('pluginRegistryUninstallHint')} onClick={uninstall}>{t('pluginRegistryUninstall')}</button>}
  </>
}

function trustStatusLabel(status: PluginRegistryTrustStatus, t: ReturnType<typeof useT>): string {
  if (status === 'approved') return t('pluginRegistryTrustApproved')
  if (status === 'changed') return t('pluginRegistryTrustChanged')
  if (status === 'invalid') return t('pluginRegistryTrustInvalid')
  return t('pluginRegistryTrustPending')
}
