import { useEffect, useRef, useState } from 'react'
import { Download, Settings2, ShieldCheck } from 'lucide-react'
import type { BrowserViewState } from '../../../../shared/browser-operation-types'
import type { BrowserSiteState } from '../../../../shared/browser-preferences-types'
import { useStore } from '../../store'
import { targetForBrowserState } from '../../store/browser-tab-state'
import { BrowserDownloadList } from '../settings/BrowserPreferences'

export default function BrowserSiteControls({ state }: { state?: BrowserViewState }): React.JSX.Element {
  const zh = useStore(value => value.settings.language === 'zh'), openSettings = useStore(value => value.setShowSettings)
  const [panel, setPanel] = useState<'site' | 'downloads'>(), [site, setSite] = useState<BrowserSiteState>(), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const target = targetForBrowserState(state), identity = target ? JSON.stringify(target) : ''
  const current = useRef(identity); current.current = identity
  useEffect(() => { setSite(undefined); setError(''); setBusy(false); setPanel(undefined) }, [identity])
  useEffect(() => window.agentDesk.onBrowserManagementEvent(event => { if (event.kind === 'preferences') setRevision(value => value + 1) }), [])
  useEffect(() => {
    if (panel !== 'site' || !target) return
    let cancelled = false
    void window.agentDesk.getBrowserSiteState(target).then(value => { if (!cancelled) { setSite(value); setError('') } }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [identity, panel, revision])
  const save = async (rule: 'allow' | 'block' | 'inherit'): Promise<void> => {
    if (!site || busy) return
    setBusy(true); setError('')
    try { await window.agentDesk.setCurrentBrowserSiteRule({ target: site.target, expectedRevision: site.preferencesRevision, rule }); if (current.current === identity) setRevision(value => value + 1) }
    catch (cause) { if (current.current === identity) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current.current === identity) setBusy(false) }
  }
  return <div className="browser-site-controls no-drag">
    <div className="browser-site-controls-bar"><button className="btn btn-ghost btn-sm" disabled={!target} onClick={() => setPanel(value => value === 'site' ? undefined : 'site')}><ShieldCheck size={12} />{zh ? '网站规则' : 'Site rules'}</button><button className="btn btn-ghost btn-sm" disabled={!state?.sessionId} onClick={() => setPanel(value => value === 'downloads' ? undefined : 'downloads')}><Download size={12} />{zh ? '下载' : 'Downloads'}</button><button className="btn btn-ghost btn-sm" onClick={() => openSettings(true, 'browser')}><Settings2 size={12} />{zh ? '浏览器设置' : 'Browser settings'}</button></div>
    {panel && <div className="browser-site-controls-content">
      {panel === 'downloads' && state && <BrowserDownloadList key={state.sessionId} contextId={state.sessionId} />}
      {panel === 'site' && <>{error && <p className="notice notice-error" role="alert">{error}</p>}{site?.origin ? <><div className="settings-hint">{site.origin} · {site.access === 'allow' ? (zh ? '允许访问' : 'Allowed') : (zh ? '已阻止' : 'Blocked')} · {site.downloads === 'allow' ? (zh ? '允许下载' : 'Downloads allowed') : (zh ? '禁止下载' : 'Downloads blocked')}</div><div className="browser-management-row"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save('allow')}>{zh ? '允许此站点' : 'Allow site'}</button><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save('block')}>{zh ? '阻止此站点' : 'Block site'}</button><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save('inherit')}>{zh ? '使用默认规则' : 'Use default'}</button></div></> : !error && <p className="settings-hint">{zh ? '打开 http(s) 网页后可管理此站点。' : 'Open an HTTP(S) page to manage its rule.'}</p>}</>}
    </div>}
  </div>
}
