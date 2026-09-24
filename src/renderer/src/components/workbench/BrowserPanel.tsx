import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserViewState } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { canSendToSession, isSessionBusy } from './session-send-availability'
import ResearchSearchPanel from './ResearchSearchPanel'
import BrowserTabStrip from './BrowserTabStrip'
import BrowserSiteControls from './BrowserSiteControls'
import { activeBrowserState } from '../../store/browser-tab-state'
import type { BrowserTabsSnapshot } from '../../../../shared/browser-tab-types'

function annotationLabel(note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim()
  return clean.length > 86 ? `${clean.slice(0, 85)}...` : clean
}

function annotationPrompt(item: {
  url: string
  title?: string
  note: string
  selector?: string
  boundingBox?: { x: number; y: number; width: number; height: number }
  screenshotPath?: string
  consoleErrors?: string[]
}): string {
  return [
    '请基于这个 EastGenesis 网页批注定位并修复问题。',
    '',
    `URL: ${item.url}`,
    item.title ? `标题: ${item.title}` : '',
    item.selector ? `选择器线索: ${item.selector}` : '',
    item.boundingBox
      ? `区域: x=${Math.round(item.boundingBox.x)}, y=${Math.round(item.boundingBox.y)}, w=${Math.round(item.boundingBox.width)}, h=${Math.round(item.boundingBox.height)}`
      : '',
    item.screenshotPath ? `截图文件(可用 Read 工具查看): ${item.screenshotPath}` : '',
    '',
    `用户批注: ${item.note}`,
    item.consoleErrors?.length ? `\n控制台错误:\n${item.consoleErrors.slice(-20).join('\n')}` : '',
    '',
    '请给出相关文件、修复方案，并在修改后说明如何复验。'
  ]
    .filter(Boolean)
    .join('\n')
}

type AnnotationItem = Parameters<typeof annotationPrompt>[0]
type BrowserSendState = 'idle' | 'sending' | 'sent' | 'error'

function useBrowserAnnotationSubmission(options: {
  activeId: string | null
  browserUrl?: string
  sendMessage(input: string): Promise<void>
  sessionStatus: Parameters<typeof isSessionBusy>[0]
}) {
  const [state, setState] = useState<BrowserSendState>('idle')
  const [error, setError] = useState('')
  const busy = isSessionBusy(options.sessionStatus)
  const canSend = canSendToSession(options.activeId, options.sessionStatus, true) && state !== 'sending'
  useEffect(() => {
    setState('idle')
    setError('')
  }, [options.activeId, options.browserUrl])
  const send = async (item: AnnotationItem): Promise<void> => {
    if (!canSend) return
    setState('sending')
    setError('')
    try {
      await options.sendMessage(annotationPrompt(item))
      setState('sent')
    } catch (cause) {
      setState('error')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return { busy, canSend, error, send, state }
}

function BrowserSendNotice({ error, state }: { error: string; state: BrowserSendState }): React.JSX.Element | null {
  const t = useT()
  if (state === 'sent') {
    return <div className="notice notice-info workspace-diff-notice">{t('browserAnnotationSentToAgent')}</div>
  }
  if (state !== 'error') return null
  return (
    <div className="notice notice-error workspace-diff-notice">
      {t('browserAnnotationSendFailed')}
      {error ? `: ${error}` : ''}
    </div>
  )
}

function BrowserPanelHeader(props: {
  browserState?: BrowserViewState
  manualTakeover: boolean
  onToggleManualTakeover(): void
}): React.JSX.Element {
  const t = useT()
  const closeBrowser = useStore((state) => state.closeBrowserPanel)
  const goBack = useStore((state) => state.browserGoBack)
  const goForward = useStore((state) => state.browserGoForward)
  const reload = useStore((state) => state.reloadBrowser)
  return (
    <header className="workspace-diff-top">
      <div>
        <div className="workspace-diff-title">{t('browserPanelTitle')}</div>
        <div className="workspace-diff-sub">{props.browserState?.title || props.browserState?.url || ''}</div>
      </div>
      <div className="workspace-diff-actions">
        <button className="btn btn-ghost btn-sm" disabled={!props.browserState?.canGoBack} onClick={() => void goBack()}>
          ←
        </button>
        <button className="btn btn-ghost btn-sm" disabled={!props.browserState?.canGoForward} onClick={() => void goForward()}>
          →
        </button>
        <button className="btn btn-ghost btn-sm" disabled={!props.browserState?.tabId} onClick={() => void reload()}>{t('refresh')}</button>
        <button
          className={`btn ${props.manualTakeover ? 'btn-primary' : 'btn-ghost'} btn-sm`}
          onClick={props.onToggleManualTakeover}
        >
          {props.manualTakeover ? '交还 Agent' : '人工接管'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void closeBrowser()}>{t('close')}</button>
      </div>
    </header>
  )
}

export default function BrowserPanel({ active = true }: { active?: boolean }): React.JSX.Element {
  const bounds = useStore(state => state.setBrowserBounds)
  useEffect(() => {
    if (!active) void bounds({ x: 0, y: 0, width: 0, height: 0 })
  }, [active, bounds])
  return <div className="browser-panel-with-connections">
    <EmbeddedBrowserPanel active={active} />
  </div>
}

function EmbeddedBrowserPanel({ active = true }: { active?: boolean }): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const {
    activePanelId, browserAnnotations,
    browserError,
    browserLoading,
    browserMessage,
    browserState,
    browserUrlDraft
  } = useStore((s) => s.workbench)
  const sessionStatus = useStore((s) => activeId ? s.sessions[activeId]?.meta.status : undefined)
  const openBrowser = useStore((s) => s.openBrowserPanel)
  const navigate = useStore((s) => s.navigateBrowser)
  const setBounds = useStore((s) => s.setBrowserBounds)
  const capture = useStore((s) => s.captureBrowserAnnotation)
  const pickElement = useStore((s) => s.pickBrowserElementAnnotation)
  const observeForAgent = useStore((s) => s.observeBrowserForAgent)
  const browserPicking = useStore((s) => s.workbench.browserPicking)
  const sendMessage = useStore((s) => s.sendMessage)
  const [urlDraft, setUrlDraft] = useState(browserUrlDraft || 'about:blank')
  const addressFocused = useRef(false)
  const addressDirty = useRef(false)
  const addressRevision = useRef(0)
  const [note, setNote] = useState('')
  const [showAnnotations, setShowAnnotations] = useState(false)
  const zh = useStore(state => state.settings.language === 'zh')
  const [manualTakeover, setManualTakeover] = useState(false)
  const noteRevision = useRef(0)
  const submission = useBrowserAnnotationSubmission({
    activeId,
    browserUrl: browserState?.url,
    sendMessage,
    sessionStatus
  })
  const viewportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (browserUrlDraft && !addressFocused.current && !addressDirty.current) setUrlDraft(browserUrlDraft)
  }, [browserUrlDraft])
  useEffect(() => {
    addressDirty.current = false
    addressFocused.current = false
    setUrlDraft(useStore.getState().workbench.browserUrlDraft || 'about:blank')
    addressRevision.current++
    noteRevision.current++
    setNote('')
  }, [activeId, browserState?.tabId, browserState?.contextEpoch])
  useEffect(() => {
    if (active && activePanelId === 'browser' && activeId && !browserState) void openBrowser()
  }, [active, activeId, activePanelId, browserState, openBrowser])
  useEffect(() => {
    const el = viewportRef.current
    if (!active || !el || !activeId || activePanelId !== 'browser') return

    let mounted = true
    const update = (): void => {
      if (!mounted) return
      const rect = el.getBoundingClientRect()
      void setBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      })
    }
    void window.agentDesk.setBrowserContextVisible(activeId, true).catch(() => undefined)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      mounted = false
      observer.disconnect()
      window.removeEventListener('resize', update)
      void window.agentDesk.setBrowserContextVisible(activeId, false).catch(() => undefined)
    }
  }, [active, activeId, activePanelId, setBounds])

  const updateTabs = useCallback((snapshot: BrowserTabsSnapshot): void => {
    const current = useStore.getState()
    if (current.activeId !== snapshot.contextId || current.showNewSession) return
    const next = activeBrowserState(snapshot)
    const changed = current.workbench.browserState?.tabId !== next.tabId || current.workbench.browserState?.selectionRevision !== next.selectionRevision
    useStore.setState({ workbench: { ...current.workbench, browserState: next, browserUrlDraft: next.url, browserLoading: next.loading,
      ...(changed ? { browserPicking: false, browserError: undefined, browserMessage: undefined } : {}) } })
  }, [])

  const submitUrl = (): void => {
    const target = urlDraft.trim()
    if (!target) return
    const revision = addressRevision.current
    void navigate(target).then(() => {
      if (useStore.getState().activeId !== activeId) return
      if (addressRevision.current !== revision) return
      if (useStore.getState().workbench.browserError) return
      addressDirty.current = false
    })
  }

  const captureSelection = async (): Promise<void> => {
    const revision = noteRevision.current
    await capture(note.trim())
    if (noteRevision.current === revision) setNote('')
  }

  return (
    <div
      className="browser-panel"
      data-browser-agent-busy={Number(submission.busy)}
      data-browser-agent-sendable={Number(submission.canSend)}
      data-browser-send-state={submission.state}
    >
      <BrowserPanelHeader
        browserState={browserState}
        manualTakeover={manualTakeover}
        onToggleManualTakeover={() => setManualTakeover((value) => !value)}
      />

      <BrowserTabStrip contextId={browserState ? activeId ?? undefined : undefined} onSnapshot={updateTabs} />
      <div className="browser-toolbar">
        <input
          className="input browser-url"
          value={urlDraft}
          placeholder={t('browserUrlPlaceholder')}
          onFocus={() => { addressFocused.current = true }}
          onBlur={() => { addressFocused.current = false }}
          onChange={(e) => { addressRevision.current++; addressDirty.current = true; setUrlDraft(e.target.value) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitUrl()
            }
          }}
        />
        <button className="btn btn-primary btn-sm" disabled={!urlDraft.trim() || !browserState?.tabId} onClick={submitUrl}>
          {browserLoading ? t('loadingDiff') : t('browserGo')}
        </button>
      </div>

      <div className="browser-assistant-toggle no-drag">
        <button className="btn btn-ghost btn-sm" aria-expanded={showAnnotations} aria-controls="browser-research-annotations" onClick={() => setShowAnnotations(value => !value)}>{showAnnotations ? (zh ? '收起研究与批注' : 'Hide research & notes') : (zh ? '研究与批注' : 'Research & notes')}{browserAnnotations.length ? ` (${browserAnnotations.length})` : ''}</button>
      </div>
      <BrowserSiteControls state={browserState} />

      {(browserError || browserMessage) && (
        <div className={`notice ${browserError ? 'notice-error' : 'notice-info'} workspace-diff-notice`}>
          {browserError || browserMessage}
        </div>
      )}
      <BrowserSendNotice error={submission.error} state={submission.state} />
      {manualTakeover && (
        <div className="notice notice-info workspace-diff-notice browser-manual-takeover">
          人工接管中：你可以直接操作页面；需要 Agent 继续自动化时点击“交还 Agent”。
        </div>
      )}

      <div className={`browser-body ${showAnnotations ? 'has-assistant-sidebar' : 'browser-page-full-width'}`}>
        <div className="browser-viewport" ref={viewportRef}>
          {!browserState && <div className="browser-placeholder">{t('browserStarting')}</div>}
          {browserState && !browserState.tabId && <div className="browser-placeholder">点击 + 新建标签页</div>}
        </div>
        <aside id="browser-research-annotations" className="browser-annotations" hidden={!showAnnotations}>
          {activeId && <ResearchSearchPanel key={activeId} sessionId={activeId} />}
          <div className="browser-annotation-editor">
            <textarea
              className="input browser-note"
              value={note}
              placeholder={t('browserNotePlaceholder')}
              onChange={(e) => { noteRevision.current++; setNote(e.target.value) }}
            />
            <div className="browser-annotation-actions">
              <button className="btn btn-primary btn-sm" disabled={!browserState?.tabId} onClick={() => void captureSelection()}>
                {t('browserCapture')}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={browserPicking || !browserState?.tabId}
                title={t('browserPickHint')}
                onClick={() => {
                  const revision = noteRevision.current
                  void pickElement(note.trim()).then(() => { if (noteRevision.current === revision) setNote('') })
                }}
              >
                {browserPicking ? t('browserPicking') : t('browserPickElement')}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                title={t('browserObserveHint')}
                disabled={!browserState?.tabId}
                onClick={() => void observeForAgent()}
              >
                {t('browserObserve')}
              </button>
            </div>
          </div>
          <div className="browser-annotation-list">
            {browserAnnotations.length === 0 ? (
              <div className="workspace-diff-empty">{t('browserNoAnnotations')}</div>
            ) : (
              browserAnnotations.map((item) => (
                <div key={item.id} className="browser-annotation-item" title={item.url}>
                  <div className="browser-annotation-note">{annotationLabel(item.note)}</div>
                  <div className="browser-annotation-url">{item.title || item.url}</div>
                  <button
                    className="btn btn-ghost btn-sm browser-annotation-send"
                    disabled={!submission.canSend}
                    onClick={() => void submission.send(item)}
                  >
                    {submission.state === 'sending' ? t('browserAnnotationSending') : t('sendToAgent')}
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
