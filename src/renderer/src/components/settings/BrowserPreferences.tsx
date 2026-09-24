import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserDownloadRecord, BrowserHistoryResult, BrowserPreferencesSnapshot, BrowserSiteRule } from '../../../../shared/browser-preferences-types'
import { useStore } from '../../store'
import BrowserExtensionSettings from './BrowserExtensionSettings'
import BrowserDebugSettings from './BrowserDebugSettings'
import './browser-preferences.css'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
export function BrowserDownloadList({ contextId }: { contextId?: string }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [items, setItems] = useState<BrowserDownloadRecord[]>([]), [error, setError] = useState('')
  const epoch = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++epoch.current
    try { const next = await window.agentDesk.listBrowserDownloads(contextId ? { contextId } : undefined); if (request === epoch.current) { setItems(next); setError('') } }
    catch (cause) { if (request === epoch.current) setError(message(cause)) }
  }, [contextId])
  useEffect(() => {
    void refresh()
    const unsubscribe = window.agentDesk.onBrowserManagementEvent(event => { if (event.kind === 'downloads' && (!contextId || !event.contextId || contextId === event.contextId)) void refresh() })
    return () => { epoch.current++; unsubscribe() }
  }, [contextId, refresh])
  const action = async (id: string, action: 'cancel' | 'reveal' | 'remove-record'): Promise<void> => {
    try { await window.agentDesk.controlBrowserDownload({ id, action }); await refresh() } catch (cause) { setError(message(cause)) }
  }
  const labels = { 'awaiting-location': zh ? '等待保存位置' : 'Choose location', progressing: zh ? '下载中' : 'Downloading', completed: zh ? '已完成' : 'Completed', cancelled: zh ? '已取消' : 'Cancelled', interrupted: zh ? '未完成' : 'Interrupted', blocked: zh ? '已阻止' : 'Blocked' }
  return <section className="browser-management-downloads">
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {!items.length && <p className="settings-hint">{zh ? '暂无下载记录。' : 'No downloads yet.'}</p>}
    {items.map(item => <article key={item.id} className="browser-management-record">
      <div><strong>{item.filename}</strong><span>{labels[item.state]} · {formatBytes(item.receivedBytes)}{item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}</span>
        <small title={item.url}>{item.url}</small>{item.error && <small className="browser-management-error">{item.error}</small>}</div>
      <div className="browser-management-record-actions">
        {['awaiting-location', 'progressing'].includes(item.state) ? <button className="btn btn-ghost btn-sm" onClick={() => void action(item.id, 'cancel')}>{zh ? '取消' : 'Cancel'}</button> : <>
          {item.state === 'completed' && <button className="btn btn-ghost btn-sm" onClick={() => void action(item.id, 'reveal')}>{zh ? '在文件夹中显示' : 'Show in folder'}</button>}
          <button className="btn btn-ghost btn-sm" onClick={() => void action(item.id, 'remove-record')}>{zh ? '移除记录' : 'Remove record'}</button>
        </>}
      </div>
    </article>)}
  </section>
}
function BrowserHistory(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [query, setQuery] = useState(''), [before, setBefore] = useState<number>(), [result, setResult] = useState<BrowserHistoryResult>()
  const [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    setBusy(true); setConfirm(false)
    void window.agentDesk.listBrowserHistory({ query, before, limit: 100 }).then(next => { if (!cancelled) { setResult(next); setError('') } })
      .catch(cause => { if (!cancelled) setError(message(cause)) }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [query, before, refresh])
  const clear = async (): Promise<void> => {
    if (!result || busy) return
    setBusy(true)
    try { await window.agentDesk.clearBrowserHistory({ clearToken: result.clearToken }); setConfirm(false); setRefresh(value => value + 1) }
    catch (cause) { setError(message(cause)); setBusy(false) }
  }
  return <section className="browser-history">
    <div className="browser-management-row">
      <input className="input" aria-label={zh ? '搜索浏览历史' : 'Search browser history'} placeholder={zh ? '搜索标题或地址' : 'Search title or URL'} value={query} onChange={event => { setQuery(event.target.value); setBefore(undefined) }} />
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{zh ? '刷新' : 'Refresh'}</button>
      <button className="btn btn-ghost btn-sm" disabled={busy || !result?.items.length} onClick={() => setConfirm(true)}>{zh ? '清除当前显示记录' : 'Clear displayed records'}</button>
    </div>
    <p className="settings-hint">{zh ? '只保存启用之后的地址和标题；地址参数、账号及片段不保留。清除只影响下方快照，不删除 Cookie、文件或任务证据。' : 'Only visits after enabling history are recorded. URL query, credentials and fragments are omitted. Clearing affects the snapshot below; cookies, files and task evidence remain.'}</p>
    {confirm && <div className="notice notice-info">{zh ? `清除下方显示的 ${result?.items.length ?? 0} 条记录？` : `Clear the ${result?.items.length ?? 0} displayed records?`} <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void clear()}>{zh ? '确认清除' : 'Confirm clear'}</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>{zh ? '取消' : 'Cancel'}</button></div>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {!result?.items.length && <p className="settings-hint">{zh ? '此范围没有浏览历史。' : 'No history in this range.'}</p>}
    {result?.items.map(item => <article className="browser-management-record" key={item.id}><div><strong>{item.title || item.url}</strong><small>{item.url}</small><span>{new Date(item.visitedAt).toLocaleString()} · {item.scopeKind === 'task' ? (zh ? '任务浏览器' : 'Task browser') : (zh ? '独立浏览器' : 'Workspace browser')}</span></div></article>)}
    <div className="browser-management-row">{before && <button className="btn btn-ghost btn-sm" onClick={() => setBefore(undefined)}>{zh ? '最新记录' : 'Latest'}</button>}{result?.nextBefore && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setBefore(result.nextBefore)}>{zh ? '更早记录' : 'Older'}</button>}</div>
  </section>
}
export default function BrowserPreferences(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [snapshot, setSnapshot] = useState<BrowserPreferencesSnapshot>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [origin, setOrigin] = useState(''), [access, setAccess] = useState<'allow' | 'block'>('block')
  const load = useCallback(async (): Promise<void> => { try { setSnapshot(await window.agentDesk.getBrowserPreferences()); setError('') } catch (cause) { setError(message(cause)) } }, [])
  useEffect(() => { void load(); return window.agentDesk.onBrowserManagementEvent(event => { if (event.kind === 'preferences') void load() }) }, [load])
  const save = async (patch: Partial<NonNullable<typeof snapshot>['preferences']>): Promise<void> => {
    if (!snapshot || busy) return
    setBusy(true); setError(''); setNotice('')
    try { const next = await window.agentDesk.saveBrowserPreferences({ expectedRevision: snapshot.revision, preferences: { ...snapshot.preferences, ...patch } }); setSnapshot(next); setNotice(zh ? '已保存并立即生效。' : 'Saved and applied immediately.') }
    catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  const updateRule = (index: number, patch?: Partial<BrowserSiteRule>): void => {
    if (!snapshot) return
    void save({ siteRules: patch ? snapshot.preferences.siteRules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) : snapshot.preferences.siteRules.filter((_rule, i) => i !== index) })
  }
  const value = snapshot?.preferences
  return <section className="browser-preferences" data-browser-preferences>
    <BrowserExtensionSettings />
    <BrowserDebugSettings />
    <p className="desktop-preference-intro">{zh ? '这些设置立即生效，适用于 EastGenesis 内置浏览器。外部 Chrome/Edge 使用自身的历史、下载和网站权限设置。' : 'Changes apply immediately to the EastGenesis embedded browser. External Chrome/Edge retain their own browser settings.'}</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="settings-hint" role="status">{notice}</p>}
    {!value ? <button className="btn btn-ghost" onClick={() => void load()}>{zh ? '载入浏览器设置' : 'Load browser settings'}</button> : <>
      <h3>{zh ? '浏览历史' : 'Browsing history'}</h3>
      <label className="browser-management-check"><input type="checkbox" disabled={busy} checked={value.recordHistory} onChange={event => void save({ recordHistory: event.target.checked })} />{zh ? '记录浏览历史（默认关闭）' : 'Record browsing history (off by default)'}</label>
      <label className="browser-management-row">{zh ? '保留时间' : 'Retention'}<select className="input" disabled={busy} value={value.retentionDays} onChange={event => void save({ retentionDays: Number(event.target.value) })}>{[7, 30, 90, 365].map(days => <option key={days} value={days}>{days} {zh ? '天' : 'days'}</option>)}</select></label>
      <BrowserHistory />
      <h3>{zh ? '下载' : 'Downloads'}</h3>
      <label className="browser-management-check"><input type="checkbox" disabled={busy} checked={value.askDownloadLocation} onChange={event => void save({ askDownloadLocation: event.target.checked })} />{zh ? '每次询问保存位置' : 'Ask where to save each download'}</label>
      <div className="browser-management-row"><input className="input" readOnly aria-label={zh ? '下载目录' : 'Download directory'} value={value.downloadDirectory} /><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { void window.agentDesk.chooseBrowserDownloadDirectory().then(path => { if (path) void save({ downloadDirectory: path }) }).catch(cause => setError(message(cause))) }}>{zh ? '选择目录' : 'Choose folder'}</button></div>
      <p className="settings-hint">{zh ? '文件完成后保存到所选位置；不会覆盖已有文件或自动打开下载内容。移除记录保留文件。' : 'Completed files are saved to your chosen location without overwriting existing files or opening them automatically. Removing a record keeps its file.'}</p>
      <BrowserDownloadList />
      <h3>{zh ? '网站规则' : 'Website rules'}</h3>
      <label className="browser-management-row">{zh ? '未列出的站点' : 'Unlisted sites'}<select className="input" disabled={busy} value={value.defaultSiteAccess} onChange={event => void save({ defaultSiteAccess: event.target.value as 'allow' | 'block' })}><option value="allow">{zh ? '允许' : 'Allow'}</option><option value="block">{zh ? '阻止' : 'Block'}</option></select></label>
      <p className="settings-hint">{zh ? '规则按协议、域名和端口精确匹配，适用于跳转、重定向、页面资源和下载。允许网站不等于授予 Agent 操作权限。' : 'Rules match scheme, host and port exactly and apply to navigation, redirects, page resources and downloads. Allowing a site does not grant Agent permissions.'}</p>
      <form className="browser-management-row" onSubmit={event => { event.preventDefault(); void save({ siteRules: [...value.siteRules, { origin: origin.trim(), access, downloads: 'inherit' }] }) }}>
        <input className="input" aria-label={zh ? '站点地址' : 'Site origin'} placeholder="https://example.com" value={origin} onChange={event => setOrigin(event.target.value)} />
        <select className="input" aria-label={zh ? '站点访问' : 'Site access'} value={access} onChange={event => setAccess(event.target.value as 'allow' | 'block')}><option value="block">{zh ? '阻止' : 'Block'}</option><option value="allow">{zh ? '允许' : 'Allow'}</option></select><button className="btn btn-ghost btn-sm" disabled={busy || !origin.trim()}>{zh ? '添加' : 'Add'}</button>
      </form>
      {value.siteRules.map((rule, index) => <div className="browser-management-rule" key={rule.origin}><span>{rule.origin}</span>
        <select className="input" aria-label={zh ? `${rule.origin} 访问` : `${rule.origin} access`} disabled={busy} value={rule.access} onChange={event => updateRule(index, { access: event.target.value as 'allow' | 'block' })}><option value="allow">{zh ? '允许访问' : 'Allow access'}</option><option value="block">{zh ? '阻止访问' : 'Block access'}</option></select>
        <select className="input" aria-label={zh ? `${rule.origin} 下载` : `${rule.origin} downloads`} disabled={busy} value={rule.downloads} onChange={event => updateRule(index, { downloads: event.target.value as BrowserSiteRule['downloads'] })}><option value="inherit">{zh ? '下载跟随访问' : 'Inherit downloads'}</option><option value="allow">{zh ? '允许下载' : 'Allow downloads'}</option><option value="block">{zh ? '阻止下载' : 'Block downloads'}</option></select>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => updateRule(index)}>{zh ? '移除' : 'Remove'}</button>
      </div>)}
    </>}
  </section>
}
function formatBytes(bytes: number): string { return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1_024)} KB` }
