import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, FolderOpen, Globe2, RefreshCw } from 'lucide-react'
import type { LocalSiteCatalog, LocalSitePublication, LocalSiteView } from '../../../shared/local-site-catalog-types'
import { useStore } from '../store'
import { useLocalSitesNavigation } from '../store/local-sites-navigation'
import { trackLocalSitePreview } from '../components/workbench/local-site-preview-lifecycle'
import './local-sites.css'

export default function LocalSitesPage({ active = true }: { active?: boolean }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh'), activeId = useStore(state => state.activeId)
  const sessions = useStore(state => state.sessions)
  const navigationError = useLocalSitesNavigation(state => state.error)
  const [catalog, setCatalog] = useState<LocalSiteCatalog>({ sites: [], warnings: [] })
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [query, setQuery] = useState(''), [project, setProject] = useState('')
  const [registering, setRegistering] = useState(false), [sessionId, setSessionId] = useState(activeId ?? '')
  const [path, setPath] = useState('dist'), [name, setName] = useState('')
  const alive = useRef(true), revision = useRef(0)
  const tr = (cn: string, en: string): string => zh ? cn : en
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++revision.current
    setLoading(true)
    try { const result = await window.agentDesk.listLocalSites(); if (alive.current && current === revision.current) { setCatalog(result); setReadError('') } }
    catch (cause) { if (alive.current && current === revision.current) setReadError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current && current === revision.current) setLoading(false) }
  }, [])
  useEffect(() => {
    alive.current = active
    if (!active) return
    void refresh()
    const timer = setInterval(() => { void refresh() }, 15000)
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { alive.current = false; revision.current++; clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [active, refresh])
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError(''); useLocalSitesNavigation.getState().setError('')
    try { await operation() } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (alive.current) setError(message)
      else useLocalSitesNavigation.getState().setError(message)
    }
    finally { if (alive.current) setBusy(false) }
  }
  const open = async (site: LocalSiteView, mode: 'task' | 'preview' | 'deployments'): Promise<void> => {
    const originalSelection = useStore.getState().activeId
    const target = await window.agentDesk.resolveLocalSite(site.id, site.revision)
    await useStore.getState().syncSession(target.sessionId)
    if (!alive.current || useStore.getState().activeId !== originalSelection) return
    // Refresh after async hydration. Navigation never resumes an archived task under a new identity.
    await window.agentDesk.resolveLocalSite(site.id, site.revision)
    if (!alive.current || useStore.getState().activeId !== originalSelection) return
    const preview = mode === 'preview' ? await window.agentDesk.previewLocalSite(site.id, site.revision) : undefined
    let keepPreview = false
    try {
      if (!alive.current || useStore.getState().activeId !== originalSelection) return
      const state = useStore.getState()
      if (!state.sessions[target.sessionId] || state.sessions[target.sessionId].meta.status === 'closed') throw new Error(tr('原任务已不可用。', 'The original task is unavailable.'))
      state.selectSession(target.sessionId); state.setShowSettings(false); state.setShowNewSession(false); state.setView('list')
      if (preview) trackLocalSitePreview(target.sessionId)
      await useStore.getState().openFilesPanel()
      if (useStore.getState().activeId !== target.sessionId) return
      if (mode === 'deployments' || target.kind === 'directory') useLocalSitesNavigation.getState().openTaskSites(target.sessionId)
      else { useLocalSitesNavigation.getState().openTaskFiles(target.sessionId); await useStore.getState().openFile(target.path) }
      if (!preview || useStore.getState().activeId !== target.sessionId || useStore.getState().workbench.activePanelId !== 'files') return
      await useStore.getState().openBrowserPanel(preview.localUrl)
      keepPreview = useStore.getState().activeId === target.sessionId
    } finally { if (preview && !keepPreview) await window.agentDesk.stopLocalSitePreview(target.sessionId, preview.id) }
  }
  const register = async (): Promise<void> => {
    await window.agentDesk.registerLocalSite({ sessionId, path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) })
    if (!alive.current) return
    setRegistering(false); setName(''); await refresh()
  }
  const projects = [...new Map(catalog.sites.map(site => [site.owner.workspaceId ?? site.owner.cwd, site.owner.cwd])).entries()]
  const needle = query.trim().toLocaleLowerCase()
  const filtered = catalog.sites.filter(site => (!project || project === (site.owner.workspaceId ?? site.owner.cwd)) &&
    (!needle || [site.name, site.sourcePath, site.owner.cwd, site.taskTitle, site.lastConfirmedDeployment?.url].some(value => value?.toLocaleLowerCase().includes(needle))))
  return <section className="local-sites-page" data-local-sites-page>
    <header className="local-sites-heading"><div><h1><Globe2 size={23} />{tr('站点', 'Sites')}</h1><p>{tr('本机登记的网站，以及原任务的发布记录。', 'Websites registered on this computer and deployment records from their original tasks.')}</p></div>
      <div className="local-sites-actions"><button type="button" className="btn btn-ghost" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={14} />{tr('刷新', 'Refresh')}</button>
        <button type="button" className="btn btn-primary" onClick={() => { setSessionId(activeId ?? ''); setRegistering(value => !value) }}>{tr('登记站点', 'Register site')}</button></div></header>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {readError && <p className="notice notice-error" role="alert">{readError}</p>}
    {navigationError && <p className="notice notice-error" role="alert">{navigationError}<button type="button" className="btn btn-ghost btn-sm" onClick={() => useLocalSitesNavigation.getState().setError('')}>{tr('关闭', 'Dismiss')}</button></p>}
    {catalog.warnings.map(warning => <p key={warning} className="notice notice-warning" role="status">{warning}</p>)}
    {registering && <form className="local-site-registration" onSubmit={event => { event.preventDefault(); void run(register) }}>
      <label>{tr('所属任务', 'Original task')}<select value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">{tr('选择任务', 'Select task')}</option>
        {Object.values(sessions).filter(session => session.meta.status !== 'closed' && !session.meta.sideChat).map(session => <option key={session.meta.id} value={session.meta.id}>{session.meta.title}</option>)}</select></label>
      <label>{tr('HTML 文件或构建目录', 'HTML file or build directory')}<input value={path} onChange={event => setPath(event.target.value)} placeholder="dist / report.html" /></label>
      <label>{tr('名称（可选）', 'Name (optional)')}<input value={name} maxLength={160} onChange={event => setName(event.target.value)} /></label>
      <p>{tr('路径相对所选任务目录；静态目录需要 index.html。登记不会发布网站。', 'Paths are relative to the selected task. Static directories need index.html. Registration does not publish a website.')}</p>
      <button type="submit" className="btn btn-primary" disabled={busy || !sessionId || !path.trim()}>{busy ? tr('处理中…', 'Working…') : tr('登记', 'Register')}</button>
    </form>}
    <div className="local-sites-filters"><input aria-label={tr('搜索站点', 'Search sites')} placeholder={tr('搜索名称、任务、目录或链接', 'Search name, task, directory or URL')} value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label={tr('筛选项目', 'Filter project')} value={project} onChange={event => setProject(event.target.value)}><option value="">{tr('全部项目与目录', 'All projects and directories')}</option>{projects.map(([id, cwd]) => <option key={id} value={id}>{cwd}</option>)}</select>
      <span>{filtered.length} / {catalog.sites.length}</span></div>
    {!filtered.length && <div className="local-sites-empty"><Globe2 size={32} /><h2>{loading ? tr('正在读取本机站点…', 'Reading local sites…') : catalog.sites.length ? tr('没有匹配的站点', 'No matching sites') : tr('还没有登记站点', 'No registered sites yet')}</h2><p>{tr('从 HTML 编辑器打开本地预览会自动登记，也可以在这里选择原任务和目录。', 'Opening a local preview from the HTML editor registers it automatically. You can also select a task and directory here.')}</p></div>}
    <div className="local-sites-grid">{filtered.map(site => <article key={site.id} className="local-site-card" data-local-site={site.id}>
      <div className="local-site-title">{site.kind === 'html' ? <FileCode2 size={20} /> : <FolderOpen size={20} />}<h2>{site.name}</h2><span>{site.kind === 'html' ? 'HTML' : tr('静态目录', 'Static directory')}</span></div>
      <p className="local-site-task">{site.taskTitle}</p><code className="local-site-path">{site.owner.cwd}<br />{site.sourcePath}</code>
      {site.unavailableReason && <p className="notice" role="status">{site.unavailableReason}</p>}
      <div className="local-site-publication"><strong>{tr('最后确认发布', 'Last confirmed deployment')}</strong>{site.lastConfirmedDeployment ? <><span>{site.lastConfirmedDeployment.targetName} · {new Date(site.lastConfirmedDeployment.startedAt).toLocaleString()}</span><code>{site.lastConfirmedDeployment.url}</code></> : <span>{tr('暂无确认的发布记录', 'No confirmed deployment')}</span>}</div>
      {site.latestOperation && <p>{tr('最新操作：', 'Latest operation: ')}{publicationLabel(site.latestOperation, zh)}</p>}
      {site.unresolvedOperations > 0 && <p className="notice notice-warning">{tr(`${site.unresolvedOperations} 项操作正在执行或等待核对；以上历史链接不代表当前线上状态。`, `${site.unresolvedOperations} operations are running or need reconciliation. The historical URL does not prove the current hosted state.`)}</p>}
      <div className="local-sites-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy || site.availability !== 'available'} onClick={() => void run(() => open(site, 'preview'))}>{tr('本地预览', 'Local preview')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || site.availability !== 'available'} onClick={() => void run(() => open(site, 'task'))}>{tr('继续原任务', 'Open original task')}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || site.availability !== 'available'} onClick={() => void run(() => open(site, 'deployments'))}>{tr('发布记录与管理', 'Deployment records')}</button></div>
    </article>)}</div>
  </section>
}
function publicationLabel(operation: LocalSitePublication, zh: boolean): string {
  const action = operation.action === 'deploy' ? (zh ? '发布' : 'Deploy') : (zh ? '回滚' : 'Rollback')
  const status = ({ executing: ['执行中', 'Running'], confirmed: ['适配器已确认', 'Confirmed by adapter'], not_started: ['未执行', 'Not started'], needs_reconciliation: ['待核对', 'Needs reconciliation'] })[operation.status][zh ? 0 : 1]
  return `${action} · ${status}`
}
