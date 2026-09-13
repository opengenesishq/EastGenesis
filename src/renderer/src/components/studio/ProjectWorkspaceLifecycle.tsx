import { useCallback, useEffect, useId, useState } from 'react'
import type { ProviderAuthorizationAccountView } from '../../../../shared/provider-authorization-types'
import {
  MANAGED_PERSONAL_WORKSPACE_ID,
  type ProjectConnectorMutation,
  type ProjectResource,
  type ProjectWorkspace
} from '../../../../shared/types'
import {
  PROJECT_STATUS_LABELS,
  TEXT,
  resourceDataClass,
  resourceEgressLabel,
  resourceEgressPolicy,
  resourceKindLabel,
  resourceLocation,
  type ProjectLifecyclePanel
} from './projectWorkspaceStudioModel'
import {
  ProjectDeleteDialog,
  ProjectEditForm,
  ProjectManifestDialog,
  ProjectResourceForm
} from './ProjectWorkspaceLifecycleForms'
import { useProjectWorkspaceLifecycle } from './useProjectWorkspaceLifecycle'
import { useStore } from '../../store'
import './project-workspace-lifecycle.css'

interface Props {
  project: ProjectWorkspace
  refreshContents: () => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
}

export default function ProjectWorkspaceLifecycle({
  project,
  refreshContents,
  refreshProjects
}: Props): React.JSX.Element {
  useStore((state) => state.settings.language)
  const titleId = useId()
  const [panel, setPanel] = useState<ProjectLifecyclePanel>(null)
  const [deleteMode, setDeleteMode] = useState<'soft' | 'permanent' | null>(null)
  const closeInteraction = useCallback(() => {
    setPanel(null)
    setDeleteMode(null)
  }, [])
  const actions = useProjectWorkspaceLifecycle({
    project,
    refreshContents,
    refreshProjects,
    onMutationSuccess: closeInteraction
  })
  const systemManaged = project.id === MANAGED_PERSONAL_WORKSPACE_ID
  const busy = actions.busy !== null
  const openPanel = (next: Exclude<ProjectLifecyclePanel, null>): void => {
    actions.clearFeedback()
    setDeleteMode(null)
    setPanel((current) => current === next ? null : next)
  }
  const openDelete = (mode: 'soft' | 'permanent'): void => {
    actions.clearFeedback()
    setPanel(null)
    setDeleteMode(mode)
  }

  return (
    <section className="pws-lifecycle" aria-labelledby={titleId} aria-busy={busy} data-project-lifecycle data-project-status={project.status} data-project-revision={project.revision}>
      <header className="pws-lifecycle-header">
        <div className="pws-section-title">
          <h2 id={titleId}>{TEXT.projectSettings}</h2>
          <span className={`pws-status pws-status-${project.status}`}>{PROJECT_STATUS_LABELS[project.status]}</span>
        </div>
        <ProjectActionBar
          busy={busy}
          systemManaged={systemManaged}
          project={project}
          onArchive={() => void actions.archiveProject()}
          onDelete={() => openDelete('soft')}
          onEdit={() => openPanel('edit')}
          onExport={() => void actions.exportManifest()}
          onPurge={() => openDelete('permanent')}
          onResource={() => openPanel('resource')}
          onRestore={() => void actions.restoreProject()}
        />
      </header>

      <ProjectLifecycleContent
        actions={actions}
        busy={busy}
        deleteMode={deleteMode}
        panel={panel}
        project={project}
        systemManaged={systemManaged}
        onCloseDelete={() => setDeleteMode(null)}
        onClosePanel={() => setPanel(null)}
        onOpenResource={() => openPanel('resource')}
      />
    </section>
  )
}

type ProjectLifecycleActions = ReturnType<typeof useProjectWorkspaceLifecycle>

function ProjectLifecycleContent({
  actions,
  busy,
  deleteMode,
  onCloseDelete,
  onClosePanel,
  onOpenResource,
  panel,
  project,
  systemManaged
}: {
  actions: ProjectLifecycleActions
  busy: boolean
  deleteMode: 'soft' | 'permanent' | null
  onCloseDelete: () => void
  onClosePanel: () => void
  onOpenResource: () => void
  panel: ProjectLifecyclePanel
  project: ProjectWorkspace
  systemManaged: boolean
}): React.JSX.Element {
  const editable = project.status === 'active' && !systemManaged
  return (
    <>
      {actions.error && <div className="notice notice-error pws-lifecycle-feedback" role="alert">{actions.error}</div>}
      {actions.announcement && <div className="pws-lifecycle-feedback pws-lifecycle-success" role="status" aria-live="polite">{actions.announcement}</div>}
      {project.status !== 'active' && (
        <p className="pws-lifecycle-notice">
          {project.status === 'archived' ? TEXT.archivedProjectNotice : TEXT.deletedProjectNotice}
        </p>
      )}
      {panel === 'edit' && editable && (
        <ProjectEditForm project={project} busy={busy} onCancel={onClosePanel} onSubmit={actions.updateProject} />
      )}
      {panel === 'resource' && editable && (
        <ProjectResourceForm busy={busy} onCancel={onClosePanel} onSubmit={actions.addResource} />
      )}
      <ProjectResourceList
        busy={busy}
        editable={editable}
        resources={project.resources}
        onAdd={onOpenResource}
        onRemove={(id) => void actions.removeResource(id)}
        onConnectorMutation={(id, mutation) => void actions.mutateConnector(id, mutation)}
      />
      <ProjectKnowledgePanel
        knowledge={actions.knowledge}
        loading={actions.knowledgeLoading}
        error={actions.knowledgeError}
        onRefresh={() => void actions.refreshKnowledge()}
        search={actions.knowledgeSearch}
        searchLoading={actions.knowledgeSearchLoading}
        searchError={actions.knowledgeSearchError}
        onSearch={actions.searchKnowledge}
      />
      {deleteMode && !systemManaged && (
        <ProjectDeleteDialog
          project={project}
          permanent={deleteMode === 'permanent'}
          busy={busy}
          onCancel={onCloseDelete}
          onConfirm={deleteMode === 'permanent' ? actions.purgeProject : actions.softDeleteProject}
        />
      )}
      {actions.manifest && (
        <ProjectManifestDialog
          manifest={actions.manifest}
          projectName={project.name}
          onClose={actions.closeManifest}
          onCopy={actions.copyManifest}
        />
      )}
    </>
  )
}

function ProjectKnowledgePanel({
  error,
  knowledge,
  loading,
  onRefresh,
  onSearch,
  search,
  searchError,
  searchLoading
}: {
  error: string
  knowledge: ProjectLifecycleActions['knowledge']
  loading: boolean
  onRefresh: () => void
  onSearch: (query: string) => Promise<void>
  search: ProjectLifecycleActions['knowledgeSearch']
  searchError: string
  searchLoading: boolean
}): React.JSX.Element {
  const titleId = useId()
  const [query, setQuery] = useState('')
  const submitSearch = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSearch(query)
  }
  return (
    <div className="pws-knowledge" aria-labelledby={titleId} aria-busy={loading}>
      <div className="pws-resources-header">
        <div className="pws-section-title"><h3 id={titleId}>{localized('项目知识', 'Project knowledge')}</h3><span>{knowledge ? knowledge.sources.length + knowledge.connectors.length : 0}</span></div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading} data-project-action="refresh-knowledge">{loading ? localized('读取中...', 'Loading...') : localized('刷新预览', 'Refresh preview')}</button>
      </div>
      {error && <p className="pws-lifecycle-feedback notice notice-error" role="alert">{error}</p>}
      {!error && !knowledge && !loading && <p className="pws-muted pws-resource-empty">{localized('暂无可读知识源', 'No readable knowledge sources')}</p>}
      {knowledge && (
        <>
          <p className="pws-knowledge-meta">{localized('策略', 'Policy')} {knowledge.policyDigest.slice(0, 19)} · revision {knowledge.projectRevision}</p>
          <form className="pws-knowledge-search" onSubmit={submitSearch} aria-label={localized('搜索项目知识', 'Search project knowledge')}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={localized('搜索项目知识文件', 'Search project knowledge files')}
              aria-label={localized('搜索项目知识文件', 'Search project knowledge files')}
              maxLength={512}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={searchLoading || !query.trim()} data-project-action="search-knowledge">
              {searchLoading ? localized('搜索中...', 'Searching...') : localized('搜索', 'Search')}
            </button>
          </form>
          {searchError && <p className="pws-lifecycle-feedback notice notice-error" role="alert">{searchError}</p>}
          {search && (
            <div className="pws-knowledge-search-results" role="region" aria-label={localized('知识搜索结果', 'Knowledge search results')}>
              <p className="pws-knowledge-meta">“{search.query}” · {localized(`${search.results.length} 个命中`, `${search.results.length} matches`)} · {new Date(search.searchedAt).toLocaleTimeString(locale())}</p>
              {search.connectorErrors.length > 0 && (
                <p className="pws-knowledge-meta" role="status">{localized(`${search.connectorErrors.length} 个连接器未参与搜索：`, `${search.connectorErrors.length} connectors were excluded from search: `)}{search.connectorErrors.map((item) => `${item.resourceId} (${item.reason})`).join(', ')}</p>
              )}
              {search.results.length === 0 ? <p className="pws-muted pws-resource-empty">{localized('没有匹配的本地知识文件', 'No local knowledge files matched')}</p> : (
                <div className="pws-knowledge-list" role="list">
                  {search.results.map((result) => (
                    <div className="pws-knowledge-row" key={result.evidenceId} role="listitem" data-knowledge-evidence-id={result.evidenceId}>
                      <span className="pws-knowledge-kind">{localized('引用', 'Citation')}</span>
                      <span className="pws-resource-copy">
                        <strong>{basenameForDisplay(result.path)}</strong>
                        <small>{result.snippet}</small>
                        <small>{result.version.slice(0, 19)} · Evidence {result.evidenceId.slice(-16)}</small>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {knowledge.sources.length > 0 && (
            <div className="pws-knowledge-list" role="list" aria-label={localized('本地知识文件', 'Local knowledge files')}>
              {knowledge.sources.map((source) => (
                <div className="pws-knowledge-row" key={`${source.resourceId}:${source.path}`} role="listitem" data-knowledge-resource-id={source.resourceId}>
                  <span className="pws-knowledge-kind">{localized('本地', 'Local')}</span>
                  <span className="pws-resource-copy">
                    <strong>{basenameForDisplay(source.path)}</strong>
                    <small>{source.bytes} bytes · sha256:{source.digest.slice(0, 12)} · {new Date(source.modifiedAt).toLocaleDateString(locale())}{source.truncated ? localized(' · 已截断', ' · Truncated') : ''}</small>
                  </span>
                </div>
              ))}
            </div>
          )}
          {knowledge.connectors.length > 0 && (
            <div className="pws-knowledge-list" role="list" aria-label={localized('项目连接器知识源', 'Project connector knowledge sources')}>
              {knowledge.connectors.map((connector) => (
                <div className="pws-knowledge-row" key={connector.resourceId} role="listitem" data-knowledge-connector-id={connector.resourceId}>
                  <span className="pws-knowledge-kind">{localized('连接器', 'Connector')}</span>
                  <span className="pws-resource-copy">
                    <strong>{connector.label}</strong>
                    <small>
                      {connector.connectorId ?? 'generic'} · {connector.available ? localized('可用', 'Available') : connector.reason ?? localized('不可用', 'Unavailable')} · refresh:{connector.refresh.status}
                      {connector.autoRefresh?.intervalMs ? ` · ${localized('自动', 'Auto')}:${autoRefreshLabel(connector.autoRefresh.intervalMs)}${connector.autoRefresh.nextAt ? `/${new Date(connector.autoRefresh.nextAt).toLocaleString(locale())}` : ''}` : ''}
                      {' · '}cache:{connector.cache.status}{connector.cache.bytes !== undefined ? `/${connector.cache.bytes} bytes` : ''}
                      {connector.revocation ? ` · revocation:${connector.revocation.status}/${connector.revocation.pausedRunIds.length} runs` : ''}
                      {connector.refresh.latestCitation ? ` · ${connector.refresh.latestCitation.version}` : ''}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function basenameForDisplay(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function ProjectActionBar({
  busy,
  systemManaged,
  onArchive,
  onDelete,
  onEdit,
  onExport,
  onPurge,
  onResource,
  onRestore,
  project
}: {
  busy: boolean
  systemManaged: boolean
  onArchive: () => void
  onDelete: () => void
  onEdit: () => void
  onExport: () => void
  onPurge: () => void
  onResource: () => void
  onRestore: () => void
  project: ProjectWorkspace
}): React.JSX.Element {
  return (
    <div className="pws-lifecycle-actions" aria-label={TEXT.projectSettings}>
      {project.status === 'active' && <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} disabled={busy || systemManaged} data-project-action="edit">{TEXT.editProject}</button>}
      {project.status === 'active' && <button type="button" className="btn btn-ghost btn-sm" onClick={onResource} disabled={busy || systemManaged} data-project-action="add-resource">{TEXT.addResource}</button>}
      {project.status === 'active' && <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive} disabled={busy || systemManaged} data-project-action="archive">{TEXT.archiveProject}</button>}
      {project.status !== 'active' && <button type="button" className="btn btn-primary btn-sm" onClick={onRestore} disabled={busy || systemManaged} data-project-action="restore">{TEXT.restoreProject}</button>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onExport} disabled={busy} data-project-action="export">{TEXT.exportManifest}</button>
      {project.status !== 'deleted' && <button type="button" className="btn btn-danger btn-sm" onClick={onDelete} disabled={busy || systemManaged} data-project-action="soft-delete">{TEXT.deleteProject}</button>}
      {project.status === 'deleted' && <button type="button" className="btn btn-danger btn-sm" onClick={onPurge} disabled={busy || systemManaged} data-project-action="purge">{TEXT.purgeProject}</button>}
    </div>
  )
}

function ProjectResourceList({
  busy,
  editable,
  onAdd,
  onRemove,
  onConnectorMutation,
  resources
}: {
  busy: boolean
  editable: boolean
  onAdd: () => void
  onRemove: (id: string) => void
  onConnectorMutation: (id: string, mutation: ProjectConnectorMutation) => void
  resources: ProjectResource[]
}): React.JSX.Element {
  const titleId = useId()
  return (
    <div className="pws-resources" aria-labelledby={titleId}>
      <div className="pws-resources-header">
        <div className="pws-section-title"><h3 id={titleId}>{TEXT.resources}</h3><span>{resources.length}</span></div>
        {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={onAdd} disabled={busy} data-project-action="add-resource-inline">{TEXT.addResource}</button>}
      </div>
      {resources.length === 0 ? <p className="pws-muted pws-resource-empty">{TEXT.noResources}</p> : (
        <div className="pws-resource-list" role="list">
          {resources.map((resource) => <ProjectResourceRow key={resource.id} resource={resource} busy={busy} editable={editable} onRemove={onRemove} onConnectorMutation={onConnectorMutation} />)}
        </div>
      )}
    </div>
  )
}

function ProjectResourceRow({
  busy,
  editable,
  onConnectorMutation,
  onRemove,
  resource
}: {
  busy: boolean
  editable: boolean
  onConnectorMutation: (id: string, mutation: ProjectConnectorMutation) => void
  onRemove: (id: string) => void
  resource: ProjectResource
}): React.JSX.Element {
  const label = resource.label || resourceLocation(resource) || resource.id
  const kind = resource.kind === 'directory' && resource.metadata?.resourceType === 'repository'
    ? 'repository'
    : resource.kind
  const connector = resource.connector
  const lifecycle = connector?.lifecycle ?? { enabled: true, refresh: { status: 'idle' as const } }
  const connectorAvailable = connector?.authorization.status === 'active' && lifecycle.enabled
  const supportsRead = connector?.dataDirection === 'read' || connector?.dataDirection === 'bidirectional'
  const [bindingOpen, setBindingOpen] = useState(false)
  const [accounts, setAccounts] = useState<Array<{ providerId: string; account: ProviderAuthorizationAccountView }>>([])
  const [selectedBinding, setSelectedBinding] = useState('')
  useEffect(() => {
    if (!bindingOpen) return
    let cancelled = false
    void window.agentDesk.listProviders().then(async (providers) => {
      const groups = await Promise.all(providers.map(async (provider) => {
        try {
          const listed = await window.agentDesk.listProviderAuthorizationAccounts(provider.id)
          return listed.map((account) => ({ providerId: provider.id, account }))
        } catch { return [] }
      }))
      if (!cancelled) setAccounts(groups.flat())
    }).catch(() => { if (!cancelled) setAccounts([]) })
    return () => { cancelled = true }
  }, [bindingOpen])
  const submitBinding = (): void => {
    const [providerId, accountId] = selectedBinding.split('/', 2)
    const match = accounts.find((entry) => entry.providerId === providerId && entry.account.id === accountId)
    if (!match || match.account.requiresReauth) return
    onConnectorMutation(resource.id, {
      kind: 'bind_authorization',
      principalId: match.account.id,
      credentialRef: `oauth:${providerId}/${match.account.id}`,
      subject: connector?.authorization.subject
    })
    setBindingOpen(false)
  }
  return (
    <div
      className="pws-resource-row"
      role="listitem"
      data-project-resource-id={resource.id}
      data-project-resource-kind={kind}
      data-resource-data-class={resourceDataClass(resource)}
      data-resource-egress-policy={resourceEgressPolicy(resource)}
      data-connector-authorization={resource.connector?.authorization.status}
      data-connector-direction={resource.connector?.dataDirection}
    >
      <span className="pws-resource-kind">{resourceKindLabel(resource)}</span>
      <span className="pws-resource-copy">
        <strong>{label}</strong>
        <small>{resourceLocation(resource)}</small>
        {resource.connector && (
          <small>
            {resource.connector.connectorId ?? 'generic'} · v{resource.connector.version} · {resource.connector.dataDirection} · {resource.connector.authorization.subject}
            {' · '}{resource.connector.authorization.status} · {lifecycle.enabled ? 'enabled' : 'disabled'} · refresh:{lifecycle.refresh.status}
            {lifecycle.autoRefresh?.intervalMs ? ` · ${localized('自动', 'Auto')}:${autoRefreshLabel(lifecycle.autoRefresh.intervalMs)}${lifecycle.autoRefresh.nextAt ? `/${new Date(lifecycle.autoRefresh.nextAt).toLocaleString(locale())}` : ''}` : ` · ${localized('自动:关闭', 'Auto:off')}`}
            {' · '}cache:{lifecycle.cache?.status ?? 'empty'}{lifecycle.cache?.bytes !== undefined ? `/${lifecycle.cache.bytes} bytes` : ''}
            {lifecycle.revocation ? ` · revocation:${lifecycle.revocation.status}/${lifecycle.revocation.pausedRunIds.length} runs` : ''}
            {lifecycle.refresh.latestCitation && ` · ${lifecycle.refresh.latestCitation.version} · ${new Date(lifecycle.refresh.latestCitation.retrievedAt).toLocaleDateString(locale())}`}
          </small>
        )}
      </span>
      <span className={`pws-resource-egress pws-resource-egress-${resourceEgressPolicy(resource)}`}>
        {resourceDataClass(resource)} · {resourceEgressLabel(resource)}
      </span>
      {editable && connector && (
        <span className="pws-resource-controls" aria-label={localized(`${label} 连接器控制`, `Connector controls for ${label}`)}>
          {supportsRead && connectorAvailable && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onConnectorMutation(resource.id, { kind: 'request_refresh' })} disabled={busy || lifecycle.refresh.status === 'requested' || lifecycle.refresh.status === 'running'} data-resource-action="refresh">{localized('刷新', 'Refresh')}</button>}
          {supportsRead && (
            <select
              className="select"
              value={lifecycle.autoRefresh?.intervalMs ?? 0}
              onChange={(event) => onConnectorMutation(resource.id, { kind: 'set_auto_refresh', intervalMs: Number(event.target.value) as 0 | 900_000 | 3_600_000 | 21_600_000 | 86_400_000 })}
              disabled={busy}
              aria-label={localized(`${label} 自动刷新周期`, `Auto-refresh interval for ${label}`)}
              data-resource-action="auto-refresh"
            >
              <option value={0}>{localized('自动刷新:关闭', 'Auto-refresh: off')}</option>
              <option value={900_000}>{localized('每 15 分钟', 'Every 15 minutes')}</option>
              <option value={3_600_000}>{localized('每 1 小时', 'Every hour')}</option>
              <option value={21_600_000}>{localized('每 6 小时', 'Every 6 hours')}</option>
              <option value={86_400_000}>{localized('每 24 小时', 'Every 24 hours')}</option>
            </select>
          )}
          {(lifecycle.cache?.status === 'ready' || lifecycle.cache?.status === 'purge_failed') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onConnectorMutation(resource.id, { kind: 'purge_cache' })} disabled={busy} data-resource-action="purge-cache">{localized('清缓存', 'Clear cache')}</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onConnectorMutation(resource.id, { kind: 'set_enabled', enabled: !lifecycle.enabled })} disabled={busy || (lifecycle.enabled === false && connector.authorization.status !== 'active')} data-resource-action="toggle-enabled">{lifecycle.enabled ? localized('停用', 'Disable') : localized('启用', 'Enable')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onConnectorMutation(resource.id, { kind: 'set_authorization', status: connector.authorization.status === 'active' ? 'revoked' : 'active' })} disabled={busy} data-resource-action="toggle-authorization">{connector.authorization.status === 'active' ? localized('撤销授权', 'Revoke authorization') : localized('恢复授权', 'Restore authorization')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBindingOpen((value) => !value)} disabled={busy} data-resource-action="bind-authorization">{localized('更换账户', 'Change account')}</button>
        </span>
      )}
      {editable && connector && bindingOpen && (
        <span className="pws-resource-binding" data-resource-action="bind-authorization-form">
          <select className="select" value={selectedBinding} onChange={(event) => setSelectedBinding(event.target.value)} aria-label={localized(`${label} 授权账户`, `Authorized account for ${label}`)}>
            <option value="">{localized('选择已授权账户', 'Select an authorized account')}</option>
            {accounts.map(({ providerId, account }) => (
              <option key={`${providerId}/${account.id}`} value={`${providerId}/${account.id}`} disabled={account.requiresReauth}>
                {account.label} · {providerId}{account.requiresReauth ? localized(' · 需要重新授权', ' · Reauthorization required') : ''}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary btn-sm" onClick={submitBinding} disabled={busy || !selectedBinding}>{localized('绑定', 'Bind')}</button>
        </span>
      )}
      {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(resource.id)} disabled={busy} aria-label={TEXT.removeResource(label)} data-resource-action="remove">{localized('移除', 'Remove')}</button>}
    </div>
  )
}

function autoRefreshLabel(intervalMs: number): string {
  if (intervalMs === 900_000) return localized('15 分钟', '15 minutes')
  if (intervalMs === 3_600_000) return localized('1 小时', '1 hour')
  if (intervalMs === 21_600_000) return localized('6 小时', '6 hours')
  if (intervalMs === 86_400_000) return localized('24 小时', '24 hours')
  return localized('关闭', 'Off')
}

function locale(): string {
  return useStore.getState().settings.language === 'zh' ? 'zh-CN' : 'en-US'
}

function localized(chinese: string, english: string): string {
  return useStore.getState().settings.language === 'en' ? english : chinese
}
