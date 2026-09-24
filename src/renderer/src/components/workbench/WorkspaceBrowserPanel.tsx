import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe2, RotateCw } from 'lucide-react'
import type { BrowserStateActionResult, BrowserViewState } from '../../../../shared/types'
import { useStore } from '../../store'
import BrowserTabStrip from './BrowserTabStrip'
import BrowserSiteControls from './BrowserSiteControls'
import { activeBrowserState, sameBrowserSelection, targetForBrowserState } from '../../store/browser-tab-state'
import type { BrowserTabsSnapshot, BrowserTabTarget } from '../../../../shared/browser-tab-types'

// The native workspace browser is shared by a window. Serialize transitions so a
// late cleanup from an old React instance cannot close the newly opened view.
let browserLifecycle: Promise<unknown> = Promise.resolve()
function enqueueBrowserLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const pending = browserLifecycle.then(operation)
  browserLifecycle = pending.catch(() => undefined)
  return pending
}

/** User-operated browser owned by this window; it never creates or borrows a chat task. */
export default function WorkspaceBrowserPanel({ active }: { active: boolean }): React.JSX.Element {
  const zh = useStore((state) => state.settings.language === 'zh')
  const [state, setState] = useState<BrowserViewState>()
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scope = useRef<string>()
  const [contextId, setContextId] = useState<string>()
  const currentState = useRef(state); currentState.current = state
  const activeRef = useRef(active); activeRef.current = active
  const viewport = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const addressDirty = useRef(false)
  const addressRevision = useRef(0)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setBusy(true); setError(''); setState(undefined)
    void enqueueBrowserLifecycle(async () => {
      if (cancelled) return
      const result = await window.agentDesk.openWorkspaceBrowser()
      if (!result.ok) throw new Error(result.error)
      if (cancelled) { await window.agentDesk.setBrowserContextVisible(result.state.sessionId, false); return }
      scope.current = result.state.sessionId
      setContextId(result.state.sessionId)
      setState(result.state)
      await window.agentDesk.setBrowserContextVisible(result.state.sessionId, true)
      if (!addressDirty.current) setAddress(result.state.url === 'about:blank' ? '' : result.state.url)
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (!cancelled) setBusy(false) })
    return () => {
      cancelled = true
      const id = scope.current
      if (id) void enqueueBrowserLifecycle(() => window.agentDesk.setBrowserContextVisible(id, false)).catch(() => undefined)
    }
  }, [active])

  const updateTabs = useCallback((snapshot: BrowserTabsSnapshot): void => {
    if (snapshot.contextId !== scope.current || !activeRef.current) return
    const next = activeBrowserState(snapshot), previous = currentState.current
    const changed = previous?.tabId !== next.tabId || previous?.contextEpoch !== next.contextEpoch || previous?.selectionRevision !== next.selectionRevision
    currentState.current = next; setState(next)
    if (changed) { addressDirty.current = false; addressRevision.current++; setBusy(false); setError('') }
    if (changed || (!addressDirty.current && document.activeElement !== input.current)) setAddress(next.url === 'about:blank' ? '' : next.url)
  }, [])
  useEffect(() => window.agentDesk.onBrowserEvent(event => {
    if (activeRef.current && event.sessionId === scope.current && event.kind === 'error') setError(event.message)
  }), [])

  const updateBounds = useCallback((): void => {
    const id = scope.current
    if (!active || !id || !viewport.current) return
    const rect = viewport.current.getBoundingClientRect()
    const blank = !state?.url || state.url === 'about:blank'
    void window.agentDesk.setBrowserBounds(id, { x: rect.x, y: rect.y, width: blank ? 0 : rect.width, height: blank ? 0 : rect.height })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [active, state?.url, state?.sessionId])
  useEffect(() => {
    const element = viewport.current
    if (!active || !element) return
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(element)
    window.addEventListener('resize', updateBounds)
    return () => { observer.disconnect(); window.removeEventListener('resize', updateBounds) }
  }, [active, updateBounds])

  const run = async (operation: (id: string, target: BrowserTabTarget) => Promise<BrowserStateActionResult<BrowserViewState>>): Promise<void> => {
    const id = scope.current
    const target = targetForBrowserState(currentState.current)
    if (!id || !target || busy || !activeRef.current) return
    const current = (): boolean => activeRef.current && scope.current === id && sameBrowserSelection(currentState.current, target)
    const submittedRevision = addressRevision.current
    setBusy(true); setError('')
    try {
      const result = await operation(id, target)
      if (!result.ok) throw new Error(result.error)
      if (!current()) return
      setState(result.state); currentState.current = result.state
      if (addressRevision.current === submittedRevision) {
        addressDirty.current = false
        setAddress(result.state.url === 'about:blank' ? '' : result.state.url)
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) setBusy(false) }
  }
  const navigate = (): void => {
    const value = address.trim()
    if (!value) return
    const url = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
    void run((id, target) => window.agentDesk.navigateBrowser(id, url, target))
  }

  return <section className="workspace-browser-panel">
    <BrowserTabStrip contextId={contextId} onSnapshot={updateTabs} />
    <form className="workspace-browser-toolbar no-drag" onSubmit={(event) => { event.preventDefault(); navigate() }}>
      <button type="button" className="icon-btn" disabled={busy || !state?.canGoBack} aria-label={zh ? '后退' : 'Back'} title={zh ? '后退' : 'Back'} onClick={() => void run((id, target) => window.agentDesk.browserGoBack(id, target))}><ArrowLeft size={14} /></button>
      <button type="button" className="icon-btn" disabled={busy || !state?.canGoForward} aria-label={zh ? '前进' : 'Forward'} title={zh ? '前进' : 'Forward'} onClick={() => void run((id, target) => window.agentDesk.browserGoForward(id, target))}><ArrowRight size={14} /></button>
      <button type="button" className="icon-btn" disabled={busy || !state || state.url === 'about:blank'} aria-label={zh ? '刷新' : 'Reload'} title={zh ? '刷新' : 'Reload'} onClick={() => void run((id, target) => window.agentDesk.reloadBrowser(id, target))}><RotateCw size={14} /></button>
      <input ref={input} className="input" aria-label={zh ? '网址' : 'Website address'} placeholder={zh ? '输入网址' : 'Enter a website address'} value={address} onChange={(event) => { addressDirty.current = true; addressRevision.current += 1; setAddress(event.target.value) }} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button className="btn btn-ghost btn-sm" disabled={busy || !state?.tabId || !address.trim()}>{zh ? '打开' : 'Go'}</button>
    </form>
    <BrowserSiteControls state={state} />
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <div ref={viewport} className="workspace-browser-viewport">
      {(!state?.url || state.url === 'about:blank') && <div className="workbench-panel-empty"><Globe2 size={25} /><strong>{zh ? '浏览器' : 'Browser'}</strong><p>{state && !state.tabId ? (zh ? '点击 + 新建标签页' : 'Click + to open a tab') : (zh ? '输入网址，开始浏览。' : 'Enter a website address to start browsing.')}</p></div>}
    </div>
  </section>
}
