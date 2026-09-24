import { useEffect, useRef, useState } from 'react'
import { Globe2, LoaderCircle, Plus, X } from 'lucide-react'
import { browserTabTarget, type BrowserTabsSnapshot } from '../../../../shared/browser-tab-types'
import { useStore } from '../../store'
import './browser-tabs.css'

export default function BrowserTabStrip({ contextId, onSnapshot }: {
  contextId?: string
  onSnapshot(snapshot: BrowserTabsSnapshot): void
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [snapshot, setSnapshot] = useState<BrowserTabsSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const latest = useRef<BrowserTabsSnapshot>()
  const currentContext = useRef(contextId); currentContext.current = contextId
  const callback = useRef(onSnapshot); callback.current = onSnapshot
  const accept = (next: BrowserTabsSnapshot): void => {
    if (next.contextId !== currentContext.current) return
    const previous = latest.current
    if (previous?.contextEpoch === next.contextEpoch && previous.revision > next.revision) return
    latest.current = next; setSnapshot(next); callback.current(next)
  }
  useEffect(() => {
    let cancelled = false, receivedEvent = false
    latest.current = undefined; setSnapshot(undefined); setError(''); setBusy(false)
    if (!contextId) return
    const unsubscribe = window.agentDesk.onBrowserTabsEvent(next => {
      if (!cancelled && next.contextId === contextId) { receivedEvent = true; accept(next) }
    })
    void window.agentDesk.listBrowserTabs(contextId).then(next => {
      if (!cancelled && !receivedEvent) accept(next)
    }).catch(cause => { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)) })
    return () => { cancelled = true; unsubscribe() }
  }, [contextId])
  const run = async (operation: () => Promise<BrowserTabsSnapshot>): Promise<void> => {
    const id = contextId, epoch = latest.current?.contextEpoch
    if (busy || !id) return
    setBusy(true); setError('')
    try { const next = await operation(); if (currentContext.current === id && latest.current?.contextEpoch === epoch) accept(next) }
    catch (cause) { if (currentContext.current === id) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (currentContext.current === id) setBusy(false) }
  }
  return <div className="browser-tabs-container no-drag">
    <div className="browser-tabs-strip" aria-label={zh ? '浏览器标签' : 'Browser tabs'}>
      <div className="browser-tabs-list" role="tablist">
        {snapshot?.tabs.map(tab => <div className={`browser-tab ${snapshot.activeTabId === tab.tabId ? 'is-active' : ''}`} key={tab.tabId}>
          <button role="tab" aria-selected={snapshot.activeTabId === tab.tabId} disabled={busy} title={tab.url}
            onClick={() => { const target = browserTabTarget(snapshot, tab.tabId); if (target) void run(() => window.agentDesk.selectBrowserTab(target)) }}>
            {tab.loading ? <LoaderCircle size={13} className="browser-tab-loading" /> : <Globe2 size={13} />}
            <span>{tab.title || (tab.url === 'about:blank' ? (zh ? '新标签页' : 'New tab') : tab.url)}</span>
          </button>
          <button className="browser-tab-close" disabled={busy} aria-label={zh ? `关闭 ${tab.title || '标签'}` : `Close ${tab.title || 'tab'}`}
            onClick={() => { const target = browserTabTarget(snapshot, tab.tabId); if (target) void run(() => window.agentDesk.closeBrowserTab(target)) }}><X size={12} /></button>
        </div>)}
      </div>
      <button className="icon-btn browser-tab-add" disabled={busy || !snapshot || snapshot.tabs.length >= 20} aria-label={zh ? '新建标签' : 'New tab'} title={zh ? '新建标签' : 'New tab'}
        onClick={() => void run(async () => {
          const result = await window.agentDesk.createBrowserTab(contextId!, { contextEpoch: snapshot!.contextEpoch })
          if (!result.ok) throw new Error(result.error)
          return result.state
        })}><Plus size={15} /></button>
    </div>
    {error && <div className="notice notice-error browser-tabs-error" role="alert">{error}</div>}
  </div>
}
