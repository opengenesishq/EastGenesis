import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PluginCatalogApi, PluginCatalogEntry, PluginCatalogPreparationView, PluginCatalogView } from '../../../../shared/plugin-catalog-types'
import { useStore } from '../../store'
import './plugin-catalog.css'

const api = (): PluginCatalogApi => window.agentDesk as typeof window.agentDesk & PluginCatalogApi
const packageKey = (row: PluginCatalogEntry): string => `${row.sourceId}:${row.id}`
const bytes = (value: number): string => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`
export default function PluginCatalogPanel({ onInstalled }: { onInstalled?: () => void | Promise<void> }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [view, setView] = useState<PluginCatalogView>({ sources: [], entries: [], preparations: [] })
  const [query, setQuery] = useState(''), [sourceId, setSourceId] = useState(''), [kind, setKind] = useState('')
  const [selectedKey, setSelectedKey] = useState(''), [version, setVersion] = useState('')
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(''), [loading, setLoading] = useState(true)
  const [acknowledged, setAcknowledged] = useState(''), [overwrite, setOverwrite] = useState(false)
  const alive = useRef(true), reading = useRef(0), operating = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++reading.current, next = await api().getPluginCatalog()
    if (alive.current && sequence === reading.current) { setView(next); setLoading(false) }
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh().catch(cause => { if (alive.current) { setError(String(cause)); setLoading(false) } })
    return () => { alive.current = false; reading.current++ }
  }, [refresh])
  const pending = view.preparations.some(row => row.state === 'downloading' || row.state === 'installing')
  useEffect(() => {
    if (!pending) return
    // Poll only local journal state. A timer never downloads or installs anything.
    const timer = window.setInterval(() => void refresh().catch(cause => { if (alive.current) setError(String(cause)) }), 1000)
    return () => window.clearInterval(timer)
  }, [pending, refresh])
  const act = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    if (operating.current) return
    operating.current = true; setBusy(label); setError('')
    try { await action(); if (alive.current) await refresh() }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { operating.current = false; if (alive.current) setBusy('') }
  }
  const packages = useMemo(() => {
    const unique = new Map<string, PluginCatalogEntry>(), search = query.trim().toLocaleLowerCase()
    for (const entry of view.entries) if ((!sourceId || entry.sourceId === sourceId) && (!kind || entry.kind === kind)
      && (!search || `${entry.name} ${entry.id} ${entry.summary}`.toLocaleLowerCase().includes(search)) && !unique.has(packageKey(entry))) unique.set(packageKey(entry), entry)
    return [...unique.values()]
  }, [view.entries, query, sourceId, kind])
  const selected = packages.find(entry => packageKey(entry) === selectedKey) ?? packages[0]
  const releases = selected ? view.entries.filter(entry => packageKey(entry) === packageKey(selected)) : []
  const entry = releases.find(entry => entry.release.version === version) ?? releases[0]
  const rows = entry ? view.preparations.filter(row => row.selection.sourceId === entry.sourceId && row.selection.packageId === entry.id) : []
  const preview = rows.find(row => row.state === 'ready' && row.selection.version === entry?.release.version && row.selection.archiveSha256 === entry?.release.archiveSha256)
  const choose = (key: string): void => { setSelectedKey(key); setVersion(''); setAcknowledged(''); setOverwrite(false) }
  const prepare = (): void => { if (entry) void act(zh ? '下载到准备区…' : 'Downloading for review…', () => api().prepareCatalogPlugin({ sourceId: entry.sourceId, packageId: entry.id, version: entry.release.version, archiveSha256: entry.release.archiveSha256, snapshotDigest: entry.snapshotDigest })) }
  const install = (row: PluginCatalogPreparationView): void => {
    if (!row.preview) return
    void act(zh ? '正在安装…' : 'Installing…', async () => {
      const result = await api().installCatalogPlugin({ id: row.id, previewDigest: row.preview!.digest, overwrite })
      if (result.state === 'installed') await onInstalled?.()
      if (result.state === 'waiting_reconciliation') await useStore.getState().refreshTaskSnapshots()
      if (alive.current) { setAcknowledged(''); setOverwrite(false) }
    })
  }
  const reconcile = (row: PluginCatalogPreparationView): void => { void act(zh ? '核对原安装…' : 'Reconciling original installation…', async () => {
    const result = await api().reconcileCatalogPlugin(row.id)
    if (result.state === 'installed') await onInstalled?.()
    if (result.state === 'waiting_reconciliation') await useStore.getState().refreshTaskSnapshots()
  }) }
  return <section className="plugin-catalog" data-plugin-catalog aria-label={zh ? '自定义插件目录' : 'Custom plugin catalogs'}>
    <details className="plugin-catalog-sources" data-catalog-sources open={!view.sources.length}>
      <summary>{zh ? '目录源' : 'Catalog sources'} · {view.sources.length}</summary>
      <p>{zh ? '添加你信任的公开 HTTPS JSON 目录；保存后点击刷新读取。下载包须同源，安装前可查看固定版本、摘要及能力。' : 'Add a public HTTPS JSON catalog you trust, then refresh it. Packages must use the same origin. Review a fixed version, digest and capabilities before installing.'}</p>
      <form onSubmit={event => { event.preventDefault(); void act(zh ? '保存目录源…' : 'Saving source…', async () => { await api().addPluginCatalogSource({ name, url }); if (alive.current) { setName(''); setUrl('') } }) }}>
        <input className="input" data-catalog-source-name aria-label={zh ? '目录源名称' : 'Source name'} placeholder={zh ? '目录源名称' : 'Source name'} value={name} maxLength={120} onChange={event => setName(event.target.value)} disabled={Boolean(busy)} required />
        <input className="input" data-catalog-source-url type="url" aria-label={zh ? 'HTTPS 目录地址' : 'HTTPS catalog URL'} placeholder="https://" value={url} maxLength={2048} onChange={event => setUrl(event.target.value)} disabled={Boolean(busy)} required />
        <button className="btn btn-primary btn-sm" data-catalog-add-source disabled={Boolean(busy) || !name.trim() || !url.trim()}>{zh ? '添加目录源' : 'Add source'}</button>
      </form>
      {view.sources.map(source => <article key={source.id} data-catalog-source={source.id}>
        <div><strong>{source.name}</strong><code>{source.url}</code><small>{source.fetchedAt ? `${zh ? '上次成功获取' : 'Last fetched'} · ${new Date(source.fetchedAt).toLocaleString()}` : zh ? '尚未获取' : 'Not fetched'}{!source.enabled && (zh ? ' · 已停用' : ' · Disabled')}</small>
          {source.error && <p role="status">{source.error}{source.snapshotDigest && (zh ? '（显示上次成功缓存）' : ' (showing the last successful cache)')}</p>}</div>
        <div className="plugin-catalog-buttons">
          <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !source.enabled} onClick={() => void act(zh ? '正在获取目录…' : 'Fetching catalog…', () => api().refreshPluginCatalogSource(source.id))}>{zh ? '刷新目录' : 'Refresh catalog'}</button>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void act(zh ? '更新目录源…' : 'Updating source…', () => api().setPluginCatalogSourceEnabled(source.id, !source.enabled))}>{source.enabled ? zh ? '停用' : 'Disable' : zh ? '启用' : 'Enable'}</button>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void act(zh ? '移除目录源…' : 'Removing source…', () => api().removePluginCatalogSource(source.id))}>{zh ? '移除源' : 'Remove source'}</button>
        </div>
      </article>)}
    </details>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {busy && <p role="status">{busy}</p>}
    <div className="plugin-catalog-search">
      <input className="input" data-catalog-search value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索名称、说明…' : 'Search names and descriptions…'} aria-label={zh ? '搜索插件目录' : 'Search catalogs'} />
      <select className="select" value={sourceId} onChange={event => setSourceId(event.target.value)} aria-label={zh ? '目录源筛选' : 'Filter source'}><option value="">{zh ? '全部源' : 'All sources'}</option>{view.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
      <select className="select" value={kind} onChange={event => setKind(event.target.value)} aria-label={zh ? '插件类别' : 'Plugin kind'}><option value="">{zh ? '全部类别' : 'All kinds'}</option>{['plugin', 'skill', 'agent', 'mcp'].map(value => <option key={value} value={value}>{value}</option>)}</select>
    </div>
    <div className="plugin-catalog-body">
      <div className="plugin-catalog-list">
        {packages.map(item => <button type="button" key={packageKey(item)} className={packageKey(item) === packageKey(selected!) ? 'active' : ''} data-catalog-package={item.id} onClick={() => choose(packageKey(item))}>
          <strong>{item.name}</strong><span>{item.summary}</span><small>{item.kind} · {item.sourceName}</small>
        </button>)}
        {!packages.length && <p className="plugin-registry-empty" data-catalog-empty={!view.sources.length ? 'no-sources' : 'no-matches'}>{loading ? zh ? '读取本地目录缓存…' : 'Reading local catalog cache…' : !view.sources.length ? zh ? '尚未添加目录源。添加一个 HTTPS 目录后，可搜索与安装其中的插件。' : 'No catalog sources. Add an HTTPS catalog to discover packages.' : zh ? '暂无匹配项。可刷新已启用的源或调整搜索。' : 'No matches. Refresh enabled sources or adjust the search.'}</p>}
      </div>
      <aside className="plugin-catalog-detail" data-catalog-detail>
        {entry ? <>
          <h3>{entry.name}</h3><p>{entry.summary}</p><small>{zh ? '来源' : 'Source'} · {entry.sourceName}</small><code>{entry.sourceUrl}</code>
          <label>{zh ? '固定版本' : 'Fixed version'}<select className="select" data-catalog-version value={entry.release.version} onChange={event => { setVersion(event.target.value); setAcknowledged(''); setOverwrite(false) }}>{releases.map(item => <option key={item.release.version} value={item.release.version}>{item.release.version}</option>)}</select></label>
          <p>{bytes(entry.release.archiveBytes)} · SHA-256</p><code>{entry.release.archiveSha256}</code>
          {entry.changedVersion && <p className="notice notice-warning">{zh ? '目录中此版本的包摘要曾变化。请核对这次下载的内容。' : 'This version’s package digest changed in the catalog. Review the new contents.'}</p>}
          {entry.release.description && <p className="plugin-catalog-description">{entry.release.description}</p>}
          <button className="btn btn-primary btn-sm" data-catalog-prepare disabled={Boolean(busy) || rows.some(row => ['downloading', 'installing', 'waiting_reconciliation'].includes(row.state))} onClick={prepare}>{zh ? '下载并预览安装' : 'Download and review installation'}</button>
          {preview?.preview && <section className="plugin-catalog-preview" data-catalog-preview={preview.id}>
            <h4>{zh ? '安装预览' : 'Installation preview'}</h4><code>{preview.preview.targetPath}</code>
            <p>{preview.preview.files} {zh ? '个文件' : 'files'} · {bytes(preview.preview.bytes)}</p>
            {preview.preview.items.map((item, index) => <div key={`${item.kind}:${item.name}:${index}`}><strong>{item.name} · {item.kind}</strong><p>{item.version ? `${zh ? '包内版本' : 'Manifest version'}: ${item.version}` : zh ? '包内未声明版本，以目录固定版本记录来源。' : 'No manifest version; provenance uses the catalog version.'}</p><code>{item.contentDigest}</code><p>{item.capabilities.join(' · ') || (zh ? '未声明额外能力' : 'No additional declared capabilities')}</p></div>)}
            <p>{zh ? '安装不会自动批准或启动插件。安装后在“已安装”审核当前内容与能力。' : 'Installation does not approve or launch the package. Review its content and capabilities in Installed.'}</p>
            <label className="plugin-catalog-check"><input type="checkbox" checked={acknowledged === preview.preview.digest} onChange={event => setAcknowledged(event.target.checked ? preview.preview!.digest : '')} />{zh ? '已核对固定版本、目标目录、内容摘要与能力。' : 'I reviewed the version, destination, content digests and capabilities.'}</label>
            {preview.preview.overwrite && <label className="plugin-catalog-check"><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />{zh ? '允许覆盖上述同名插件，旧目录移入原回收站。' : 'Replace this existing package and move its old directory to the managed trash.'}</label>}
            <div className="plugin-catalog-buttons"><button className="btn btn-primary btn-sm" data-catalog-install disabled={Boolean(busy) || acknowledged !== preview.preview.digest || preview.preview.overwrite && !overwrite} onClick={() => install(preview)}>{zh ? '确认安装此版本' : 'Install this reviewed version'}</button>
              <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void act(zh ? '取消准备…' : 'Cancelling…', () => api().cancelCatalogPluginPreparation(preview.id))}>{zh ? '取消准备' : 'Cancel preparation'}</button></div>
          </section>}
        </> : <p>{zh ? '选择一个插件查看来源、版本和安装内容。' : 'Select a package to view its source, versions and installation contents.'}</p>}
      </aside>
    </div>
    {view.preparations.length > 0 && <section className="plugin-catalog-history"><h4>{zh ? '下载与安装记录' : 'Download and installation history'}</h4>
      {view.preparations.slice(0, 30).map(row => <article key={row.id} data-catalog-preparation={row.id} data-catalog-state={row.state}>
        <div><strong>{row.name} · {row.selection.version}</strong><span>{stateLabel(row.state, zh)}</span><small>{new Date(row.updatedAt).toLocaleString()}</small>{row.error && <p role="status">{row.error}</p>}<details><summary>{zh ? '原操作记录' : 'Original operation'}</summary><code>{row.operationId}</code><code>{row.sourceUrl}</code><code>{row.selection.archiveSha256}</code></details></div>
        {row.state === 'downloading' && <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void act(zh ? '取消下载…' : 'Cancelling download…', () => api().cancelCatalogPluginPreparation(row.id))}>{zh ? '取消' : 'Cancel'}</button>}
        {row.state === 'waiting_reconciliation' && <div className="plugin-catalog-buttons"><button className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => reconcile(row)}>{zh ? '核对原安装' : 'Reconcile original installation'}</button><button className="btn btn-ghost btn-sm" onClick={() => useStore.getState().setShowTaskRecovery(true)}>{zh ? '打开恢复面板' : 'Open recovery'}</button></div>}
      </article>)}
    </section>}
  </section>
}
function stateLabel(state: PluginCatalogPreparationView['state'], zh: boolean): string {
  const labels = { downloading: ['下载准备中', 'Downloading'], ready: ['等待确认安装', 'Ready for review'], installing: ['安装中', 'Installing'], installed: ['已安装，按原审核规则启用', 'Installed; existing approval rules apply'], waiting_reconciliation: ['原安装结果待核对', 'Installation needs reconciliation'], failed: ['未完成', 'Not completed'], cancelled: ['已取消', 'Cancelled'], reverted: ['安装已撤销', 'Installation reverted'] }
  return labels[state][zh ? 0 : 1]
}
