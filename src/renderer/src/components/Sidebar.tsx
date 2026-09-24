import SidebarTaskList from './SidebarTaskList'
import { memo, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import { Bell, Ellipsis, Search } from 'lucide-react'
import { useStore } from '../store'
import { activityForSession, useActivityStore, useActivitySubscription } from '../store/activity-store'
import './studio/activity-center.css'
import { useT } from '../i18n'
import { formatCost, formatTime } from '../format'
import { APP_ICON_URL, APP_NAME } from '../brand'
import type { HistoryEntry, SessionStatus, TranscriptSearchResult } from '../../../shared/types'
import type { ExperienceMode } from '../store/experience-mode'
import SessionContextMenu, { type SessionMenuItem } from './SessionContextMenu'
import { modelAttemptMatchesSnapshot } from './ModelAttemptRecoveryPanel'
import { isTaskSnapshotRecoverable } from './TaskRecoveryItem'
import { useSidebarResize } from './useSidebarResize'
import { DisclosureChevron } from './DisclosureChevron'
import SidebarPrimaryAction from './SidebarPrimaryAction'
import SidebarFooter from './SidebarFooter'
import { restoreComposerFocus, SidebarPanelIcon } from './SidebarControls'
import type { ActiveSidebarEntry, SidebarEntry } from './sidebar-project-groups'

const STATUS_LABEL_KEY: Record<SessionStatus, string> = {
  starting: 'statusStarting',
  running: 'statusRunning',
  idle: 'statusIdle',
  error: 'statusError',
  closed: 'statusClosed'
}

const SIDEBAR_COLLAPSED_WIDTH = 56
const MAX_RECENT_TASKS = 20

interface EditingTarget { kind: SidebarEntry['kind']; id: string }

interface MenuState {
  x: number
  y: number
  entry: SidebarEntry
}

function entryTitle(entry: SidebarEntry): string {
  return entry.kind === 'active' ? entry.meta.title : entry.history.title
}

function entryPath(entry: SidebarEntry): string {
  const record = entry.kind === 'active' ? entry.meta : entry.history
  return record.sourceCwd ?? record.cwd
}

function activateByKeyboard(e: React.KeyboardEvent, action: () => void): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  action()
}

function highlightSnippet(snippet: string, query: string): React.ReactNode {
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return snippet
  return (
    <>
      {snippet.slice(0, idx)}
      <mark className="search-hit-mark">{snippet.slice(idx, idx + query.length)}</mark>
      {snippet.slice(idx + query.length)}
    </>
  )
}

interface SidebarProps {
  /** Kept for AppListView compatibility; the sidebar itself is one conversation workspace. */
  experienceMode: ExperienceMode
  language: 'zh' | 'en'
  /** Kept for AppListView compatibility; mode switching is intentionally removed. */
  onExperienceModeChange: (mode: ExperienceMode) => void
}

function Sidebar({ experienceMode, language, onExperienceModeChange }: SidebarProps): React.JSX.Element {
  const t = useT()
  useActivitySubscription()
  // AppListView still owns the legacy mode state. Reading it here avoids making
  // the sidebar a mode switcher while preserving the existing component contract.
  void experienceMode
  void onExperienceModeChange

  const activitySnapshot = useActivityStore(state => state.snapshot)
  const activityError = useActivityStore(state => state.error)
  const markActivity = (sessionId: string, read: boolean): void => {
    const state = useActivityStore.getState()
    const item = activityForSession(state.snapshot, sessionId)
    if (state.snapshot && item) void state.mark(state.snapshot.snapshotId, [item], read).catch(() => undefined)
  }

  const order = useStore(state => state.order)
  const sessions = useStore(state => state.sessions)
  const activeId = useStore(state => state.activeId)
  const history = useStore(state => state.history)
  const taskSnapshots = useStore(state => state.taskSnapshots)
  const modelAttemptReconciliations = useStore(state => state.modelAttemptReconciliations)
  const workflowAttentionWorkItems = useStore(state => state.workflowAttentionWorkItems)
  const workflowAttentionSupervisorRuns = useStore(state => state.workflowAttentionSupervisorRuns)
  const query = useStore(state => state.sidebarQuery)
  const setSidebarQuery = useStore(state => state.setSidebarQuery)
  const transcriptSearchResults = useStore(state => state.transcriptSearchResults)
  const transcriptSearchLoading = useStore(state => state.transcriptSearchLoading)
  const openTranscriptSearchHit = useStore(state => state.openTranscriptSearchHit)
  const selectSession = useStore(state => state.selectSession)
  const resumeFromHistory = useStore(state => state.resumeFromHistory)
  const forkFromHistory = useStore(state => state.forkFromHistory)
  const renameSession = useStore(state => state.renameSession)
  const renameHistoryEntry = useStore(state => state.renameHistoryEntry)
  const archiveHistory = useStore(state => state.archiveHistory)
  const pinHistory = useStore(state => state.pinHistory)
  const deleteHistoryEntry = useStore(state => state.deleteHistoryEntry)
  const setShowTaskRecovery = useStore(state => state.setShowTaskRecovery)
  const closeSession = useStore(state => state.closeSession)
  const setShowNewSession = useStore(state => state.setShowNewSession)
  const setShowSettings = useStore(state => state.setShowSettings)
  const showNewSession = useStore(state => state.showNewSession)
  const showTaskRecovery = useStore(state => state.showTaskRecovery)
  const settings = useStore(state => state.settings)
  const updateSettings = useStore(state => state.updateSettings)
  const layout = settings.layout

  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [showAllRecent, setShowAllRecent] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const { sidebarWidth, patchLayout, startSidebarResize } = useSidebarResize(layout, updateSettings)

  const historyByActiveId = useMemo(() => {
    const map = new Map<string, HistoryEntry>()
    for (const item of history) {
      map.set(item.id, item)
      if (item.sdkSessionId) map.set(item.sdkSessionId, item)
    }
    return map
  }, [history])

  const activeEntries: ActiveSidebarEntry[] = order.flatMap((id) => {
    const session = sessions[id]
    if (!session) return []
    const historyEntry = historyByActiveId.get(id) ??
      (session.meta.sdkSessionId ? historyByActiveId.get(session.meta.sdkSessionId) : undefined)
    return [{
      kind: 'active' as const,
      id,
      meta: session.meta,
      history: historyEntry,
      pendingCount: session.pendingPermissions.length
    }]
  })

  const openSessionIds = new Set(order)
  const openSdkIds = new Set(order.map(id => sessions[id]?.meta.sdkSessionId).filter((id): id is string => Boolean(id)))
  const allEntries = useMemo<SidebarEntry[]>(() => {
    const historical = history
      .filter(entry => !openSessionIds.has(entry.id) && !openSdkIds.has(entry.sdkSessionId))
      .map(entry => ({ kind: 'history' as const, id: entry.id, history: entry }))
    return [...activeEntries, ...historical].filter((entry) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      const record = entry.kind === 'active' ? entry.meta : entry.history
      return `${entryTitle(entry)}\n${entryPath(entry)}\n${record.cwd}`.toLowerCase().includes(q)
    })
  }, [activeEntries, history, openSdkIds, openSessionIds, query])

  const liveEntries = allEntries.filter(entry => entry.kind === 'active' || !entry.history.archived)
  const archivedEntries = allEntries.filter((entry): entry is Extract<SidebarEntry, { kind: 'history' }> => entry.kind === 'history' && Boolean(entry.history.archived))
  const pinnedEntries = liveEntries.filter(entry => Boolean(entry.history?.pinned))
  const recentEntries = liveEntries.filter(entry => !entry.history?.pinned)
  const visibleRecentEntries = query.trim() || showAllRecent ? recentEntries : recentEntries.slice(0, MAX_RECENT_TASKS)

  const recoverySnapshots = taskSnapshots.filter(snapshot =>
    isTaskSnapshotRecoverable(snapshot, openSessionIds) ||
    modelAttemptReconciliations.some(reconciliation => modelAttemptMatchesSnapshot(reconciliation, snapshot))
  )
  const pendingPermissionCount = Object.values(sessions)
    .reduce((total, session) => total + session.pendingPermissions.length, 0)
  const recoveryCount = recoverySnapshots.length + modelAttemptReconciliations.length +
    workflowAttentionWorkItems.length + workflowAttentionSupervisorRuns.length + pendingPermissionCount

  const startRename = (entry: SidebarEntry): void => {
    setEditing({ kind: entry.kind, id: entry.id })
    setDraftTitle(entryTitle(entry))
    setMenu(null)
  }

  const commitRename = (): void => {
    const target = editing
    const title = draftTitle.trim()
    setEditing(null)
    if (!target || !title) return
    if (target.kind === 'active') void renameSession(target.id, title)
    else void renameHistoryEntry(target.id, title)
  }

  const showMenu = (event: React.MouseEvent, entry: SidebarEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, entry })
  }

  const showButtonMenu = (event: React.MouseEvent<HTMLButtonElement>, entry: SidebarEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.right - 4, y: rect.bottom + 4, entry })
  }

  const copyPath = (path: string): void => {
    void navigator.clipboard?.writeText(path).catch(() => undefined)
  }

  const menuItemsFor = (entry: SidebarEntry): SessionMenuItem[] => {
    const title = entryTitle(entry)
    const path = entryPath(entry)
    const historyEntry = entry.kind === 'history' ? entry.history : entry.history
    const items: SessionMenuItem[] = [{ key: 'rename', label: t('rename'), onClick: () => startRename(entry) }]
    const activity = activityForSession(activitySnapshot, entry.id)
    if (activity) items.push({
      key: 'activity-read',
      label: language === 'zh' ? (activity.unread ? '标记已读' : '标记未读') : (activity.unread ? 'Mark read' : 'Mark unread'),
      onClick: () => markActivity(entry.id, activity.unread)
    })
    if (historyEntry) {
      items.push({ key: 'fork-conversation', label: t('forkConversation'), onClick: () => forkFromHistory(historyEntry) })
      items.push({ key: 'pin', label: historyEntry.pinned ? t('unpinSession') : t('pinSession'), onClick: () => void pinHistory(historyEntry.id, !historyEntry.pinned) })
      items.push({ key: 'archive', label: historyEntry.archived ? t('unarchiveSession') : t('archiveSession'), onClick: () => void archiveHistory(historyEntry.id, !historyEntry.archived) })
    }
    items.push({ key: 'copy-path', label: t('copyPath'), onClick: () => copyPath(path) })
    items.push({
      key: 'delete',
      label: entry.kind === 'active' ? t('closeSession') : t('delete'),
      danger: true,
      onClick: () => {
        const message = entry.kind === 'active' ? t('closeSessionConfirm', { title }) : t('deleteHistoryConfirm', { title })
        if (!window.confirm(message)) return
        if (entry.kind === 'active') void closeSession(entry.id)
        else void deleteHistoryEntry(entry.id)
        restoreComposerFocus()
      }
    })
    return items
  }

  const openHistoryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      const current = useStore.getState().sessions
      const exact = current[entry.id]
      if (exact && exact.meta.status !== 'closed') {
        selectSession(exact.meta.id)
        return
      }
      const candidates = Object.values(current).filter(item => item.meta.status !== 'closed' && entry.sdkSessionId && item.meta.sdkSessionId === entry.sdkSessionId)
      if (candidates.length > 1) throw new Error('这条历史对应多个运行，请从活动中心选择具体任务。')
      if (candidates.length === 1) selectSession(candidates[0].meta.id)
      else await resumeFromHistory(entry)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : (language === 'zh' ? '任务暂时无法打开，请刷新后重试。' : 'This task could not be opened. Refresh and try again.'))
    }
  }

  const renderTitle = (entry: SidebarEntry): React.ReactNode => {
    const pinned = entry.kind === 'active' ? entry.history?.pinned : entry.history.pinned
    return (
      <span className="session-card-title">
        {activityForSession(activitySnapshot, entry.id)?.unread && <span className="sidebar-unread-dot" title={language === 'zh' ? '未读' : 'Unread'}>●</span>}
        {pinned && <span className="session-pin-mark" title={t('pinned')}>★</span>}
        {entryTitle(entry)}
      </span>
    )
  }

  const renderEditingCard = (key: string): React.ReactNode => (
    <div key={key} className="session-card session-card-editing">
      <input className="input session-rename-input" value={draftTitle} autoFocus onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter') commitRename()
        if (event.key === 'Escape') setEditing(null)
      }} onBlur={commitRename} />
    </div>
  )

  const renderActiveEntry = (entry: ActiveSidebarEntry): React.ReactNode => {
    if (editing?.kind === 'active' && editing.id === entry.id) return renderEditingCard(entry.id)
    return (
      <div key={entry.id} className={`session-card ${activeId === entry.id ? 'active' : ''}`} data-session-id={entry.id} role="button" tabIndex={0}
        onClick={() => { selectSession(entry.id); markActivity(entry.id, true) }}
        onKeyDown={(event) => activateByKeyboard(event, () => { selectSession(entry.id); markActivity(entry.id, true) })}
        onContextMenu={(event) => showMenu(event, entry)}>
        <span className={`status-dot status-${entry.meta.status}`} title={t(STATUS_LABEL_KEY[entry.meta.status])} />
        <span className="session-card-body">{renderTitle(entry)}<span className="session-card-sub">{formatCost(entry.meta.costUsd)}</span></span>
        {entry.pendingCount > 0 && <span className="session-card-badge" title={t('awaitingApproval')}>{entry.pendingCount}</span>}
        <button className="session-action session-card-more" title={t('moreActions')} aria-haspopup="menu" onClick={(event) => showButtonMenu(event, entry)}><Ellipsis size={16} aria-hidden="true" /></button>
      </div>
    )
  }

  const renderHistoryEntry = (entry: HistoryEntry): React.ReactNode => {
    const ref: SidebarEntry = { kind: 'history', id: entry.id, history: entry }
    if (editing?.kind === 'history' && editing.id === entry.id) return renderEditingCard(entry.id)
    return (
      <div key={entry.id} className="session-card history-card" data-session-id={entry.id} role="button" tabIndex={0}
        title={t('resumeSessionTitle', { cwd: entry.sourceCwd ?? entry.cwd })}
        onClick={() => void openHistoryEntry(entry)}
        onKeyDown={(event) => activateByKeyboard(event, () => void openHistoryEntry(entry))}
        onContextMenu={(event) => showMenu(event, ref)}>
        <span className="history-icon">↻</span>
        <span className="session-card-body">{renderTitle(ref)}<span className="session-card-sub">{formatTime(entry.updatedAt)}</span></span>
        <button className="session-action session-card-more" title={t('moreActions')} aria-haspopup="menu" onClick={(event) => showButtonMenu(event, ref)}><Ellipsis size={16} aria-hidden="true" /></button>
      </div>
    )
  }

  const renderSidebarEntry = (entry: SidebarEntry): React.ReactNode => entry.kind === 'active' ? renderActiveEntry(entry) : renderHistoryEntry(entry.history)

  const renderSearchHit = (result: TranscriptSearchResult): React.ReactNode => {
    const first = result.hits[0]
    return (
      <div key={result.sdkSessionId} className="session-card search-hit-card" role="button" tabIndex={0} title={t('resumeSessionTitle', { cwd: result.cwd })}
        onClick={() => void openTranscriptSearchHit(result)} onKeyDown={(event) => activateByKeyboard(event, () => void openTranscriptSearchHit(result))}>
        <span className="history-icon">⌕</span>
        <span className="session-card-body"><span className="session-card-title">{result.title}</span><span className="search-hit-snippet">{first ? highlightSnippet(first.snippet, query.trim()) : result.note}</span></span>
      </div>
    )
  }

  const archiveExpanded = archiveOpen || query.trim().length > 0
  const contentSearchActive = query.trim().length >= 2
  const searchPlaceholder = language === 'zh' ? '搜索任务与对话' : 'Search tasks and conversations'

  return (
    <aside className={`sidebar ${layout.sidebarCollapsed ? 'sidebar-collapsed' : ''}`} style={{ '--sidebar-width': `${layout.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}px` } as React.CSSProperties}>
      <div className="sidebar-brand drag-region" data-brand="eastgenesis">
        <span className="brand-mark" data-brand-logo="eastgenesis-app-icon" aria-hidden="true"><img src={APP_ICON_URL} alt="" /></span><span className="brand-name">{APP_NAME}</span>
        <button type="button" className={`sidebar-header-action no-drag ${searchOpen || query ? 'is-active' : ''}`} aria-label={searchPlaceholder} aria-expanded={searchOpen || Boolean(query)} title={searchPlaceholder}
          onClick={() => { const nextOpen = !searchOpen || Boolean(query); setSearchOpen(nextOpen); if (nextOpen) requestAnimationFrame(() => searchRef.current?.focus()) }}><Search size={15} strokeWidth={1.8} aria-hidden="true" /></button>
        <button type="button" className="sidebar-collapse-toggle no-drag" aria-label={layout.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')} title={layout.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')} onClick={() => patchLayout({ sidebarCollapsed: !layout.sidebarCollapsed })}><SidebarPanelIcon collapsed={layout.sidebarCollapsed} /></button>
      </div>

      <nav className="sidebar-primary-nav" aria-label={language === 'zh' ? '主导航' : 'Primary navigation'} onClickCapture={() => useActivityStore.getState().setVisible(false)}>
        <SidebarPrimaryAction newSessionActive={showNewSession} onNewSession={() => { useStore.getState().closePanel(); setShowNewSession(true) }} />
        <button type="button" className="sidebar-nav-item" data-sidebar-action="activity" onClick={() => useActivityStore.getState().setVisible(true)}><Bell size={16} aria-hidden="true" /><span>{language === 'zh' ? '活动' : 'Activity'}</span>{Boolean(activitySnapshot?.unreadCount) && <strong className="sidebar-nav-badge">{activitySnapshot!.unreadCount}</strong>}</button>
        {recoveryCount > 0 && <button type="button" className={`sidebar-nav-item sidebar-recovery ${showTaskRecovery ? 'is-active' : ''}`} aria-expanded={showTaskRecovery} aria-haspopup="dialog" data-sidebar-action="recovery-center" onClick={() => setShowTaskRecovery(true)}><span aria-hidden="true">↻</span><span>{t('recoveryCenter')}</span><strong className="sidebar-nav-badge">{recoveryCount}</strong></button>}
      </nav>

      {activityError && <div className="activity-sidebar-error" role="alert">{language === 'zh' ? '活动未更新：' : 'Activity: '}{activityError}<button type="button" className="btn btn-ghost btn-sm" onClick={() => void useActivityStore.getState().refresh()}>{language === 'zh' ? '重试' : 'Retry'}</button></div>}
      {statusMessage && <div className="sidebar-empty" role="status">{statusMessage}<button type="button" className="btn btn-ghost btn-sm" onClick={() => setStatusMessage('')}>{language === 'zh' ? '关闭' : 'Dismiss'}</button></div>}
      <div className={`sidebar-search-wrap ${searchOpen || query ? 'is-open' : ''}`}><input ref={searchRef} className="input sidebar-search" value={query} placeholder={searchPlaceholder} onFocus={() => setSearchOpen(true)} onChange={(event) => setSidebarQuery(event.target.value)} /></div>

      <div className="sidebar-scroll">
        {pinnedEntries.length > 0 && <section className="sidebar-section"><div className="sidebar-section-title">{t('pinned')}</div><SidebarTaskList entries={pinnedEntries} activeId={activeId} renderEntry={renderSidebarEntry} /></section>}
        <section className="sidebar-section sidebar-conversations-section" data-sidebar-assistant-sessions>
          <div className="sidebar-section-title">{language === 'zh' ? '最近任务' : 'Recent tasks'}</div>
          <SidebarTaskList entries={visibleRecentEntries} activeId={activeId} renderEntry={renderSidebarEntry} />
          {recentEntries.length === 0 && <div className="sidebar-empty">{query ? (language === 'zh' ? '没有匹配的任务' : 'No matching tasks') : t('noSessions')}</div>}
          {recentEntries.length > MAX_RECENT_TASKS && !query.trim() && <button type="button" className="sidebar-section-toggle sidebar-see-all" aria-expanded={showAllRecent} onClick={() => setShowAllRecent(value => !value)}><span>{showAllRecent ? (language === 'zh' ? '收起任务' : 'Show less') : `${language === 'zh' ? '查看全部任务' : 'Show all tasks'} · ${recentEntries.length}`}</span></button>}
        </section>

        {archivedEntries.length > 0 && <section className="sidebar-section"><button className="sidebar-section-toggle" aria-expanded={archiveExpanded} onClick={() => setArchiveOpen(value => !value)}><DisclosureChevron expanded={archiveExpanded} /><span>{t('archived')}</span><span className="sidebar-group-count">{archivedEntries.length}</span></button>{archiveExpanded && archivedEntries.map(entry => renderHistoryEntry(entry.history))}</section>}
        {contentSearchActive && <section className="sidebar-section"><div className="sidebar-section-title">{t('contentSearchSection')}</div>{transcriptSearchResults.map(renderSearchHit)}{transcriptSearchResults.length === 0 && !transcriptSearchLoading && <div className="sidebar-empty">{t('contentSearchEmpty')}</div>}</section>}
      </div>

      <SidebarFooter language={language} settings={settings} onOpenSettings={() => setShowSettings(true, 'general')} />
      <div className="sidebar-resize-handle no-drag" role="separator" aria-orientation="vertical" aria-label={t('resizeSidebar')} title={t('resizeSidebar')} onPointerDown={startSidebarResize} />
      {menu && <SessionContextMenu x={menu.x} y={menu.y} items={menuItemsFor(menu.entry)} onClose={() => setMenu(null)} />}
    </aside>
  )
}

export default memo(Sidebar)
