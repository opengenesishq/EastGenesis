import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import MessageItem, { type MessageFork, type MessageRevision } from './MessageItem'
import PermissionBar from './PermissionBar'
import Composer from './Composer'
import RewindPanel from './RewindPanel'
import StartSuggestionsPanel from './StartSuggestionsPanel'
import type { ProviderView } from '../../../shared/types'
import type { ChatItem, ToolResultInfo } from '../store'
import ChatStatusBar from './experience/ChatStatusBar'
import ChatTaskStrategyControl from './experience/ChatTaskStrategyControl'
import TaskPlanWorkbench from './experience/TaskPlanWorkbench'
import SessionModelPicker from './composer/SessionModelPicker'
import { sessionRoutingLabel } from './composer/session-routing-form'

const VIRTUAL_MESSAGE_THRESHOLD = 100
const VIRTUAL_MESSAGE_ESTIMATED_HEIGHT = 116
const VIRTUAL_MESSAGE_GAP = 14
const VIRTUAL_MESSAGE_OVERSCAN_PX = 720
const CHAT_SCALE_MIN = 0.85
const CHAT_SCALE_MAX = 1.25
const CHAT_SCALE_STEP = 0.05

interface ScrollSnapshot {
  top: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(2))))
}

function providerDisplayName(
  providerId: string,
  providers: ProviderView[],
  t: ReturnType<typeof useT>
): string {
  return providerId
    ? providers.find((provider) => provider.id === providerId)?.name ?? t('unknownProvider')
    : t('providerOfficial')
}

export default function ChatView(): React.JSX.Element | null {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const session = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const providers = useStore((s) => s.providers)
  const closeSession = useStore((s) => s.closeSession)
  const interrupt = useStore((s) => s.interrupt)
  const zh = useStore((s) => s.settings.language === 'zh')
  const openLatestRewindPanel = useStore((s) => s.openLatestRewindPanel)
  const openBrowserPanel = useStore((s) => s.openBrowserPanel)
  const openFilesPanel = useStore((s) => s.openFilesPanel)
  const openWorktreePanel = useStore((s) => s.openWorktreePanel)
  const openTerminalPanel = useStore((s) => s.openTerminalPanel)
  const openPluginRegistryPanel = useStore((s) => s.openPluginRegistryPanel)
  const openSubagentPanel = useStore((s) => s.openSubagentPanel)
  const openRoutinePanel = useStore((s) => s.openRoutinePanel)
  const openMemoryPanel = useStore((s) => s.openMemoryPanel)
  const allStartSuggestions = useStore((s) => s.workbench.startSuggestions)
  const ignoredStartSuggestions = useStore((s) => s.workbench.ignoredStartSuggestions)
  const laterStartSuggestions = useStore((s) => s.workbench.laterStartSuggestions)
  const startSuggestionsLoading = useStore((s) => s.workbench.startSuggestionsLoading)
  const startSuggestionsError = useStore((s) => s.workbench.startSuggestionsError)
  const memorySuggestion = useStore((s) => s.workbench.memorySuggestion)
  const refreshStartSuggestions = useStore((s) => s.refreshStartSuggestions)
  const sendStartSuggestion = useStore((s) => s.sendStartSuggestion)
  const laterStartSuggestion = useStore((s) => s.laterStartSuggestion)
  const ignoreStartSuggestion = useStore((s) => s.ignoreStartSuggestion)
  const acceptMemorySuggestion = useStore((s) => s.acceptMemorySuggestion)
  const dismissMemorySuggestion = useStore((s) => s.dismissMemorySuggestion)
  const layout = useStore((s) => s.settings.layout)
  const updateSettings = useStore((s) => s.updateSettings)
  const restoreCheckpoint = useStore((s) => s.restoreCheckpoint)
  const sendMessage = useStore((s) => s.sendMessage)
  const forkFromCheckpoint = useStore((s) => s.forkFromCheckpoint)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const scrollFrame = useRef<number | null>(null)
  const [scrollSnapshot, setScrollSnapshot] = useState<ScrollSnapshot>({ top: 0, height: 0 })
  const [moreOpen, setMoreOpen] = useState(false)
  const [modelPickerSessionId, setModelPickerSessionId] = useState<string | null>(null)
  const [startSuggestionsSessionId, setStartSuggestionsSessionId] = useState<string | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const startSuggestionsOpen = startSuggestionsSessionId === activeId

  const updateScrollSnapshot = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const next = { top: el.scrollTop, height: el.clientHeight }
    setScrollSnapshot((current) =>
      Math.abs(current.top - next.top) < 1 && Math.abs(current.height - next.height) < 1 ? current : next
    )
  }, [])

  const scheduleScrollSnapshot = useCallback((): void => {
    if (scrollFrame.current !== null) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null
      updateScrollSnapshot()
    })
  }, [updateScrollSnapshot])

  const patchLayout = useCallback(
    (patch: Partial<typeof layout>): void => {
      void updateSettings({ layout: { ...layout, ...patch } }).catch((error) => {
        console.error('[agent-desk] Failed to persist chat layout:', error)
      })
    },
    [layout, updateSettings]
  )

  const setChatScale = useCallback(
    (value: number): void => {
      patchLayout({ chatScale: clamp(value, CHAT_SCALE_MIN, CHAT_SCALE_MAX) })
    },
    [patchLayout]
  )

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (moreRef.current?.contains(event.target as Node)) return
      setMoreOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  const startSuggestions = useMemo(() => {
    if (!activeId) return []
    const now = Date.now()
    return allStartSuggestions.filter((suggestion) => {
      const key = `${activeId}:${suggestion.id}`
      return !ignoredStartSuggestions[key] && (laterStartSuggestions[key] ?? 0) <= now
    })
  }, [activeId, allStartSuggestions, ignoredStartSuggestions, laterStartSuggestions])

  const itemCount = session?.items.length ?? 0
  const streamLen = (session?.streamText.length ?? 0) + (session?.streamThinking.length ?? 0)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
      updateScrollSnapshot()
    }
  }, [itemCount, streamLen, activeId, updateScrollSnapshot])

  useEffect(() => {
    updateScrollSnapshot()
    return () => {
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current)
    }
  }, [activeId, updateScrollSnapshot])

  useEffect(() => {
    setMoreOpen(false)
    setStartSuggestionsSessionId(null)
  }, [activeId])

  useEffect(() => {
    let lastEsc = 0
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const now = Date.now()
      if (now - lastEsc < 700) {
        e.preventDefault()
        openLatestRewindPanel('shortcut')
        lastEsc = 0
        return
      }
      lastEsc = now
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openLatestRewindPanel])

  if (!session || !activeId) return null
  const { meta } = session
  const running = meta.status === 'running' || meta.status === 'starting'
  const providerName = providerDisplayName(meta.providerId, providers, t)
  const activeMemorySuggestion = memorySuggestion?.sessionId === activeId ? memorySuggestion : undefined

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    scheduleScrollSnapshot()
  }

  const reviseMessage = async (revision: MessageRevision, text: string): Promise<boolean> => {
    const current = useStore.getState()
    if (current.activeId !== activeId) throw new Error(t('messageRevisionSessionChanged'))
    const active = current.sessions[activeId]
    if (!active || active.meta.status === 'running' || active.meta.status === 'starting') {
      throw new Error(t('messageRevisionRunning'))
    }
    const preview = await restoreCheckpoint(revision.checkpointId, revision.restoreMode, true)
    if (!preview || preview.error) throw new Error(preview?.error || t('messageRevisionUnavailable'))
    if (!preview.canRewind) throw new Error(preview.note || t('messageRevisionUnavailable'))
    if (useStore.getState().activeId !== activeId) throw new Error(t('messageRevisionSessionChanged'))
    const files = preview.filesChanged?.length ?? preview.code?.filesChanged?.length ?? 0
    const events = preview.chatRemovedEntries ?? preview.chat?.removedEntries ?? 0
    if (files > 0 && !window.confirm(t('messageRevisionConfirm', { files, events }))) return false
    const restored = await restoreCheckpoint(revision.checkpointId, revision.restoreMode, false)
    if (!restored || restored.error || !restored.applied) {
      throw new Error(restored?.error || t('messageRevisionUnavailable'))
    }
    if (useStore.getState().activeId !== activeId) throw new Error(t('messageRevisionSessionChanged'))
    await sendMessage(text, activeId)
    return true
  }

  const forkMessage = (fork: MessageFork): void => {
    forkFromCheckpoint(fork.checkpointId, fork.text)
  }

  return (
    <div
      className={`chat chat-density-${layout.chatDensity}`}
      style={{ '--chat-scale': layout.chatScale } as React.CSSProperties}
    >
      <header className="chat-header drag-region">
        <div className="chat-heading">
          <div className="chat-title" title={meta.title}>
            {meta.title}
          </div>
          <div className="chat-cwd" title={meta.cwd}>
            {meta.cwd}
          </div>
        </div>
        <div className="chat-controls no-drag">
          <ChatTaskStrategyControl value={meta.taskStrategy} disabled={running} />
          <button type="button" className="btn" data-session-routing-open title={t('switchModel')}
            aria-expanded={modelPickerSessionId === activeId}
            onClick={() => setModelPickerSessionId(modelPickerSessionId === activeId ? null : activeId)}>
            {sessionRoutingLabel(meta, zh)}
          </button>
          {running && (
            <button className="btn btn-danger" onClick={() => void interrupt()}>
              {t('stop')}
            </button>
          )}
          {meta.isolated && (
            <IconButton
              icon="worktree"
              expert
              label={t('worktreeShort')}
              onClick={() => void openWorktreePanel()}
            />
          )}
          <IconButton icon="files" label={t('filesShort')} onClick={() => void openFilesPanel()} />
          <IconButton
            icon="terminal"
            expert
            label={t('terminalShort')}
            onClick={() => void openTerminalPanel()}
          />
          <IconButton
            icon="browser"
            label={t('browserShort')}
            onClick={() => void openBrowserPanel()}
          />
          <div className="header-more" ref={moreRef}>
            <button
              type="button"
              className={`icon-btn ${moreOpen ? 'icon-btn-active' : ''}`}
              aria-label={t('moreActions')}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              title={t('moreActions')}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span className="header-more-glyph">⋯</span>
            </button>
            {moreOpen && (
              <div className="header-more-menu" role="menu">
                <MenuItem
                  action="subagents"
                  icon="subagents"
                  label={t('subagentsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openSubagentPanel()
                  }}
                />
                <MenuItem
                  action="plugins"
                  icon="plugins"
                  label={t('pluginsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openPluginRegistryPanel()
                  }}
                />
                <MenuItem
                  action="routines"
                  icon="routines"
                  label={t('routinesShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    void openRoutinePanel()
                  }}
                />
                <MenuItem
                  action="start-suggestions"
                  icon="suggestions"
                  label={t('startSuggestionsShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    if (startSuggestionsOpen) {
                      setStartSuggestionsSessionId(null)
                      return
                    }
                    setStartSuggestionsSessionId(activeId)
                    void refreshStartSuggestions()
                  }}
                />
                <MenuItem
                  action="memory"
                  icon="memory"
                  label={t('memoryShort')}
                  onSelect={() => {
                    setMoreOpen(false)
                    openMemoryPanel()
                  }}
                />
                <div className="header-more-separator" role="separator" />
                <MenuItem
                  action="zoom-out"
                  disabled={layout.chatScale <= CHAT_SCALE_MIN}
                  icon="zoomOut"
                  label={t('zoomOutChat')}
                  meta={`${Math.round(layout.chatScale * 100)}%`}
                  onSelect={() => {
                    setMoreOpen(false)
                    setChatScale(layout.chatScale - CHAT_SCALE_STEP)
                  }}
                />
                <MenuItem
                  action="zoom-reset"
                  disabled={layout.chatScale === 1}
                  icon="zoomReset"
                  label={t('resetChatZoom')}
                  meta="100%"
                  onSelect={() => {
                    setMoreOpen(false)
                    setChatScale(1)
                  }}
                />
                <MenuItem
                  action="zoom-in"
                  disabled={layout.chatScale >= CHAT_SCALE_MAX}
                  icon="zoomIn"
                  label={t('zoomInChat')}
                  meta={`${Math.round(layout.chatScale * 100)}%`}
                  onSelect={() => {
                    setMoreOpen(false)
                    setChatScale(layout.chatScale + CHAT_SCALE_STEP)
                  }}
                />
                <MenuItem
                  action="density"
                  checked={layout.chatDensity === 'compact'}
                  icon="density"
                  label={t('compactChatDensity')}
                  meta={layout.chatDensity === 'compact'
                    ? t('compactChatDensityValue')
                    : t('comfortableChatDensity')}
                  onSelect={() => {
                    setMoreOpen(false)
                    patchLayout({
                      chatDensity: layout.chatDensity === 'compact' ? 'comfortable' : 'compact'
                    })
                  }}
                />
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('closeSession')}
            title={t('closeSession')}
            onClick={() => void closeSession(activeId)}
          >
            <span className="header-close-glyph">✕</span>
          </button>
        </div>
      </header>
      <TaskPlanWorkbench sessionId={activeId} strategy={meta.taskStrategy} running={running} />

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {startSuggestionsOpen && startSuggestionsLoading && (
            <div className="notice start-suggestions-chat-notice" data-start-suggestions-status="loading">
              {t('startSuggestionsLoading')}
            </div>
          )}
          {startSuggestionsOpen && startSuggestionsError && (
            <div className="notice notice-error start-suggestions-chat-notice">{startSuggestionsError}</div>
          )}
          {startSuggestionsOpen &&
            !startSuggestionsLoading &&
            !startSuggestionsError &&
            startSuggestions.length === 0 && (
              <div className="notice start-suggestions-chat-notice" data-start-suggestions-status="empty">
                {t('startSuggestionsEmpty')}
              </div>
            )}
          {startSuggestionsOpen && (
            <StartSuggestionsPanel
              suggestions={startSuggestions}
              compact
              disabled={running || startSuggestionsLoading}
              maxVisible={3}
              onSendToAgent={(suggestion) => void sendStartSuggestion(suggestion)}
              onLater={(suggestion) => laterStartSuggestion(suggestion.id)}
              onIgnore={(suggestion) => ignoreStartSuggestion(suggestion.id)}
            />
          )}
          <MessageList
            activeId={activeId}
            items={session.items}
            toolResults={session.toolResults}
            runningTools={session.runningTools}
            scrollRef={scrollRef}
            scrollSnapshot={scrollSnapshot}
            stickToBottom={stickToBottom}
            running={running}
            onRevise={reviseMessage}
            onFork={forkMessage}
          />

          {session.streamThinking && (
            <div className="thinking-stream">
              <div className="thinking-label">{t('thinkingLive')}</div>
              <div className="thinking-text">{session.streamThinking}</div>
            </div>
          )}
          {session.streamText && <div className="assistant-text streaming">{session.streamText}</div>}
          {running && !session.streamText && !session.streamThinking && (
            <div className="working-indicator">
              <span className="spinner" /> {t('agentWorking')}
            </div>
          )}
        </div>
      </div>

      <PermissionBar sessionId={activeId} requests={session.pendingPermissions} />
      {activeMemorySuggestion && (
        <div className="memory-suggestion-bar" data-memory-suggestion-bar="true">
          <div
            className="memory-suggestion-text"
            title={activeMemorySuggestion.text}
            data-memory-suggestion-text
          >
            记住这条约定? {activeMemorySuggestion.text}
          </div>
          <button
            className="btn btn-primary btn-sm"
            data-memory-suggestion-action="accept"
            onClick={acceptMemorySuggestion}
          >
            记住
          </button>
          <button
            className="btn btn-ghost btn-sm"
            data-memory-suggestion-action="dismiss"
            onClick={dismissMemorySuggestion}
          >
            忽略
          </button>
        </div>
      )}
      <ChatStatusBar meta={meta} providerName={providerName} session={session} />
      {modelPickerSessionId === activeId && <SessionModelPicker key={activeId} sessionId={activeId} onClose={() => setModelPickerSessionId(null)} />}
      <Composer running={running} onModelRequest={setModelPickerSessionId} />
      <RewindPanel />
    </div>
  )
}

interface MessageListProps {
  activeId: string
  items: ChatItem[]
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
  scrollRef: React.RefObject<HTMLDivElement>
  scrollSnapshot: ScrollSnapshot
  stickToBottom: React.MutableRefObject<boolean>
  running: boolean
  onRevise: (revision: MessageRevision, text: string) => Promise<boolean>
  onFork: (fork: MessageFork) => void
}

function MessageList({
  activeId,
  items,
  toolResults,
  runningTools,
  scrollRef,
  scrollSnapshot,
  stickToBottom,
  running,
  onRevise,
  onFork
}: MessageListProps): React.JSX.Element {
  const revisions = useMemo(() => messageRevisions(items, running), [items, running])
  const forks = useMemo(() => messageForks(items, running), [items, running])
  if (items.length <= VIRTUAL_MESSAGE_THRESHOLD) {
    return (
      <>
        {items.map((item) => (
          <MessageItem
            key={item.id}
            item={item}
            toolResults={toolResults}
            runningTools={runningTools}
            revision={revisions.get(item.id)}
            onRevise={onRevise}
            fork={forks.get(item.id)}
            onFork={onFork}
          />
        ))}
      </>
    )
  }

  return (
    <VirtualMessageList
      activeId={activeId}
      items={items}
      toolResults={toolResults}
      runningTools={runningTools}
      scrollRef={scrollRef}
      scrollSnapshot={scrollSnapshot}
      stickToBottom={stickToBottom}
      running={running}
      onRevise={onRevise}
      onFork={onFork}
    />
  )
}

function VirtualMessageList({
  activeId,
  items,
  toolResults,
  runningTools,
  scrollRef,
  scrollSnapshot,
  stickToBottom,
  running,
  onRevise,
  onFork
}: MessageListProps): React.JSX.Element {
  const revisions = useMemo(() => messageRevisions(items, running), [items, running])
  const forks = useMemo(() => messageForks(items, running), [items, running])
  const listRef = useRef<HTMLDivElement>(null)
  const sizeById = useRef(new Map<string, number>())
  const heightFrame = useRef<number | null>(null)
  const [heightVersion, setHeightVersion] = useState(0)
  const [listTop, setListTop] = useState(0)

  const scheduleHeightVersion = useCallback((): void => {
    if (heightFrame.current !== null) return
    heightFrame.current = window.requestAnimationFrame(() => {
      heightFrame.current = null
      setHeightVersion((value) => value + 1)
    })
  }, [])

  const measureListTop = useCallback((): void => {
    const scrollEl = scrollRef.current
    const listEl = listRef.current
    if (!scrollEl || !listEl) return
    const scrollRect = scrollEl.getBoundingClientRect()
    const listRect = listEl.getBoundingClientRect()
    const nextTop = listRect.top - scrollRect.top + scrollEl.scrollTop
    setListTop((current) => (Math.abs(current - nextTop) < 1 ? current : nextTop))
  }, [scrollRef])

  useEffect(() => {
    sizeById.current.clear()
    scheduleHeightVersion()
    setListTop(0)
    return () => {
      if (heightFrame.current !== null) window.cancelAnimationFrame(heightFrame.current)
    }
  }, [activeId, scheduleHeightVersion])

  useEffect(() => {
    const liveIds = new Set(items.map((item) => item.id))
    let changed = false
    for (const id of sizeById.current.keys()) {
      if (liveIds.has(id)) continue
      sizeById.current.delete(id)
      changed = true
    }
    if (changed) scheduleHeightVersion()
  }, [items, scheduleHeightVersion])

  useLayoutEffect(() => {
    measureListTop()
  }, [items.length, measureListTop, scrollSnapshot.height])

  useEffect(() => {
    const scrollEl = scrollRef.current
    const listEl = listRef.current
    if (!scrollEl || !listEl) return
    const observer = new ResizeObserver(measureListTop)
    observer.observe(scrollEl)
    observer.observe(listEl)
    window.addEventListener('resize', measureListTop)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measureListTop)
    }
  }, [measureListTop, scrollRef])

  const handleMeasure = useCallback(
    (id: string, height: number): void => {
      const previous = sizeById.current.get(id)
      if (previous !== undefined && Math.abs(previous - height) < 1) return
      sizeById.current.set(id, height)
      scheduleHeightVersion()
      if (stickToBottom.current) {
        window.requestAnimationFrame(() => {
          const scrollEl = scrollRef.current
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
        })
      }
    },
    [scheduleHeightVersion, scrollRef, stickToBottom]
  )

  const sizes = useMemo(
    () => items.map((item) => sizeById.current.get(item.id) ?? VIRTUAL_MESSAGE_ESTIMATED_HEIGHT),
    [heightVersion, items]
  )
  const offsets = useMemo(() => {
    const values = new Array<number>(sizes.length + 1)
    values[0] = 0
    for (let i = 0; i < sizes.length; i++) values[i + 1] = values[i] + sizes[i]
    return values
  }, [sizes])

  const totalHeight = offsets[offsets.length - 1] ?? 0
  const visibleTop = Math.max(0, scrollSnapshot.top - listTop - VIRTUAL_MESSAGE_OVERSCAN_PX)
  const visibleBottom = Math.min(
    totalHeight,
    scrollSnapshot.top - listTop + scrollSnapshot.height + VIRTUAL_MESSAGE_OVERSCAN_PX
  )
  const startIndex = Math.max(0, findVirtualIndex(offsets, visibleTop) - 1)
  const endIndex = Math.min(items.length, findVirtualIndex(offsets, visibleBottom) + 1)
  const visibleItems = items.slice(startIndex, endIndex)

  return (
    <div
      ref={listRef}
      className="chat-virtual-list"
      style={{ height: totalHeight }}
      data-virtualized-messages="true"
      data-total-messages={items.length}
      data-visible-messages={visibleItems.length}
    >
      {visibleItems.map((item, visibleOffset) => {
        const index = startIndex + visibleOffset
        return (
          <VirtualMessageRow
            key={item.id}
            item={item}
            top={offsets[index] ?? 0}
            onMeasure={handleMeasure}
            toolResults={toolResults}
            runningTools={runningTools}
            revision={revisions.get(item.id)}
            onRevise={onRevise}
            fork={forks.get(item.id)}
            onFork={onFork}
          />
        )
      })}
    </div>
  )
}

interface VirtualMessageRowProps {
  item: ChatItem
  top: number
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
  onMeasure: (id: string, height: number) => void
  revision?: MessageRevision
  onRevise: (revision: MessageRevision, text: string) => Promise<boolean>
  fork?: MessageFork
  onFork: (fork: MessageFork) => void
}

function VirtualMessageRow({
  item,
  top,
  toolResults,
  runningTools,
  onMeasure,
  revision,
  onRevise,
  fork,
  onFork
}: VirtualMessageRowProps): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = rowRef.current
    if (!node) return
    const measure = (): void => {
      onMeasure(item.id, Math.ceil(node.getBoundingClientRect().height) + VIRTUAL_MESSAGE_GAP)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [item.id, onMeasure])

  return (
    <div ref={rowRef} className="chat-virtual-row" style={{ transform: `translateY(${top}px)` }}>
      <MessageItem
        item={item}
        toolResults={toolResults}
        runningTools={runningTools}
        revision={revision}
        onRevise={onRevise}
        fork={fork}
        onFork={onFork}
      />
    </div>
  )
}

function findVirtualIndex(offsets: number[], target: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((offsets[mid] ?? 0) < target) low = mid + 1
    else high = mid
  }
  return low
}

interface IconButtonProps {
  expert?: boolean
  icon: HeaderIconName
  label: string
  onClick: () => void
}

function IconButton({ expert = false, icon, label, onClick }: IconButtonProps): React.JSX.Element {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} data-expert-control={expert || undefined} onClick={onClick}>
      <HeaderIcon name={icon} />
    </button>
  )
}

interface MenuItemProps {
  action: string
  checked?: boolean
  disabled?: boolean
  icon: HeaderIconName
  label: string
  meta?: string
  onSelect: () => void
}

function messageRevisions(items: ChatItem[], running: boolean): Map<string, MessageRevision> {
  const revisions = new Map<string, MessageRevision>()
  if (running) return revisions
  for (const item of items) {
    if (item.kind !== 'user' || !item.checkpointId || !item.text.trim() || item.attachments?.length) continue
    revisions.set(item.id, {
      checkpointId: item.checkpointId,
      restoreMode: item.checkpointScope === 'chat' ? 'chat' : 'both',
      kind: 'edit',
      text: item.text
    })
  }
  const assistantIndex = items.findLastIndex((item) => item.kind === 'assistant')
  if (assistantIndex < 0) return revisions
  if (items.slice(assistantIndex + 1).some((item) => item.kind === 'user')) return revisions
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'user') continue
    const source = revisions.get(item.id)
    if (source) {
      revisions.set(items[assistantIndex].id, { ...source, kind: 'regenerate' })
    }
    break
  }
  return revisions
}

function messageForks(items: ChatItem[], running: boolean): Map<string, MessageFork> {
  const forks = new Map<string, MessageFork>()
  if (running) return forks
  for (const item of items) {
    if (item.kind !== 'user' || !item.checkpointId || !item.text.trim() || item.attachments?.length) continue
    forks.set(item.id, { checkpointId: item.checkpointId, text: item.text })
  }
  return forks
}

function MenuItem({ action, checked, disabled = false, icon, label, meta, onSelect }: MenuItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="header-more-item"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      disabled={disabled}
      data-header-action={action}
      onClick={onSelect}
    >
      <HeaderIcon name={icon} />
      <span>{label}</span>
      {meta && <small>{meta}</small>}
      {checked !== undefined && <span className="header-more-check" aria-hidden="true">{checked ? '✓' : ''}</span>}
    </button>
  )
}
