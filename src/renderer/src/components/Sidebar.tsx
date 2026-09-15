import SidebarTaskList from './SidebarTaskList'
import { taskEntryCount } from './task-entry-groups'
import { memo, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import { Ellipsis, Plus, Search } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { basename, formatCost, formatTime } from '../format'
import { APP_ICON_URL, APP_NAME } from '../brand'
import { resolveBusinessLineId, resolveSelectedBusinessLine } from '../../../shared/business-line-types'
import { belongsToBusinessLine, businessLineConversationEntries, builtinLineValue } from './business-lines/business-line-sidebar'
import { requestBusinessLineTaskNavigation } from './business-lines/businessLineTaskNavigation'
import type {
  HistoryEntry,
  SessionStatus,
  TranscriptSearchResult
} from '../../../shared/types'
import type { ExperienceMode } from '../store/experience-mode'
import SessionContextMenu, { type SessionMenuItem } from './SessionContextMenu'
import SidebarProjectSections, { type SidebarProjectSort } from './SidebarProjectSections'
import { HeaderIcon } from './ChatHeaderIcons'
import { modelAttemptMatchesSnapshot } from './ModelAttemptRecoveryPanel'
import { isTaskSnapshotRecoverable } from './TaskRecoveryItem'
import { useSidebarResize } from './useSidebarResize'
import { recommendExperiencePreferences } from '../store/experience-recommendation'
import { DisclosureChevron } from './DisclosureChevron'
import SidebarVideoSections from './SidebarVideoSections'
import SidebarPrimaryAction from './SidebarPrimaryAction'
import SidebarFooter from './SidebarFooter'
import { sidebarSearchKey, sidebarVisibleCount, splitAssistantEntries } from './sidebar-mode-projection'
import { cancelOfficeIdlePrewarm } from './office/loadOffice'
import { restoreComposerFocus, SidebarPanelIcon } from './SidebarControls'
import WorkOsPrimaryNav from './WorkOsPrimaryNav'
import { requestStudioSectionNavigation, requestWorkOsNavigation, type WorkOsNavigationTarget } from './work-os-navigation'
import {
  buildSidebarProjectGroups,
  sidebarEntryPath,
  type ActiveSidebarEntry,
  type ProjectGroup,
  type SidebarEntry
} from './sidebar-project-groups'
const STATUS_LABEL_KEY: Record<SessionStatus, string> = {
  starting: 'statusStarting',
  running: 'statusRunning',
  idle: 'statusIdle',
  error: 'statusError',
  closed: 'statusClosed'
}

const SIDEBAR_COLLAPSED_WIDTH = 56
const TASK_LABEL = { zh: '任务', en: 'Tasks' }

interface EditingTarget { kind: SidebarEntry['kind']; id: string }

interface MenuState {
  x: number
  y: number
  entry: SidebarEntry
}

interface ProjectMenuState {
  x: number
  y: number
  group: ProjectGroup
}

function entryTitle(entry: SidebarEntry): string {
  return entry.kind === 'active' ? entry.meta.title : entry.history.title
}

function entryPath(entry: SidebarEntry): string {
  return sidebarEntryPath(entry)
}

function historyPath(entry: HistoryEntry): string {
  return entry.sourceCwd ?? entry.cwd
}

function normalized(value: string | undefined): string {
  return (value ?? '').toLowerCase()
}

function activateByKeyboard(e: React.KeyboardEvent, action: () => void): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  action()
}

/** 片段内高亮命中词(大小写不敏感,只标注首个命中) */
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
  experienceMode: ExperienceMode
  language: 'zh' | 'en'
  onExperienceModeChange: (mode: ExperienceMode) => void
}

function When({ values, children }: { values: boolean[]; children: React.ReactNode }): React.JSX.Element | null {
  return values.every(Boolean) ? <>{children}</> : null
}

function Sidebar({
  experienceMode,
  language,
  onExperienceModeChange
}: SidebarProps): React.JSX.Element {
  const t = useT()
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const history = useStore((s) => s.history)
  const projects = useStore((s) => s.projects)
  const projectWorkspaces = useStore((s) => s.projectWorkspaces)
  const taskSnapshots = useStore((s) => s.taskSnapshots)
  const modelAttemptReconciliations = useStore((s) => s.modelAttemptReconciliations)
  const workflowAttentionWorkItems = useStore((s) => s.workflowAttentionWorkItems)
  const workflowAttentionSupervisorRuns = useStore((s) => s.workflowAttentionSupervisorRuns)
  const query = useStore((s) => s.sidebarQuery)
  const setSidebarQuery = useStore((s) => s.setSidebarQuery)
  const transcriptSearchResults = useStore((s) => s.transcriptSearchResults)
  const transcriptSearchLoading = useStore((s) => s.transcriptSearchLoading)
  const openTranscriptSearchHit = useStore((s) => s.openTranscriptSearchHit)
  const selectSession = useStore((s) => s.selectSession)
  const resumeFromHistory = useStore((s) => s.resumeFromHistory)
  const forkFromHistory = useStore((s) => s.forkFromHistory)
  const renameSession = useStore((s) => s.renameSession)
  const renameHistoryEntry = useStore((s) => s.renameHistoryEntry)
  const archiveHistory = useStore((s) => s.archiveHistory)
  const pinHistory = useStore((s) => s.pinHistory)
  const deleteHistoryEntry = useStore((s) => s.deleteHistoryEntry)
  const setShowTaskRecovery = useStore((s) => s.setShowTaskRecovery)
  const closeSession = useStore((s) => s.closeSession)
  const archiveProject = useStore((s) => s.archiveProject)
  const deleteProject = useStore((s) => s.deleteProject)
  const archiveCanonicalProject = useStore((s) => s.archiveCanonicalProject)
  const deleteCanonicalProject = useStore((s) => s.deleteCanonicalProject)
  const openProjectWorkspace = useStore((s) => s.openProjectWorkspace)
  const openNewProjectWorkspace = useStore((s) => s.openNewProjectWorkspace)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setView = useStore((s) => s.setView)
  const showNewSession = useStore((s) => s.showNewSession)
  const showTaskRecovery = useStore((s) => s.showTaskRecovery)
  const settings = useStore((s) => s.settings), selectedLine = resolveSelectedBusinessLine(settings)
  const layout = settings.layout
  const updateSettings = useStore((s) => s.updateSettings)
  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [projectSort, setProjectSort] = useState<SidebarProjectSort>('recent')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archivedProjectsOpen, setArchivedProjectsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [workOsTarget, setWorkOsTarget] = useState<WorkOsNavigationTarget>('inbox')
  const searchRef = useRef<HTMLInputElement>(null)
  const { sidebarWidth, patchLayout, startSidebarResize } = useSidebarResize(layout, updateSettings)
  const isAssistant = experienceMode === 'assistant'
  const isProject = experienceMode === 'studio'
  const isVideo = experienceMode === 'video'
  const experienceRecommendation = useMemo(() => recommendExperiencePreferences({
    settings,
    sessions: Object.values(sessions).map((session) => session.meta),
    history,
    projectCount: projectWorkspaces.filter((project) => project.status === 'active').length
  }), [history, projectWorkspaces, sessions, settings])

  const historyByActiveId = useMemo(() => {
    const map = new Map<string, HistoryEntry>()
    for (const item of history) {
      map.set(item.id, item)
      if (item.sdkSessionId) map.set(item.sdkSessionId, item)
    }
    return map
  }, [history])

  const projectNameForPath = (path: string): string =>
    projects.find((project) => project.path === path)?.name ?? basename(path)

  const projectNameForEntry = (entry: SidebarEntry): string => {
    const record = entry.kind === 'active' ? entry.meta : entry.history
    if (record.workspaceId) {
      const workspace = projectWorkspaces.find((item) => item.id === record.workspaceId)
      if (workspace) return workspace.name
    }
    return projectNameForPath(entryPath(entry))
  }

  const matchesQuery = (entry: SidebarEntry): boolean => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    const path = entryPath(entry)
    const projectName = projectNameForEntry(entry)
    const text = [entryTitle(entry), path, projectName].map(normalized).join('\n')
    return text.includes(q)
  }

  const openSdkIds = new Set(
    order.map((id) => sessions[id]?.meta.sdkSessionId).filter((id): id is string => Boolean(id))
  )
  const openSessionIds = new Set(order)
  const recoverySnapshots = taskSnapshots.filter(
    (snapshot) =>
      isTaskSnapshotRecoverable(snapshot, openSessionIds) ||
      modelAttemptReconciliations.some((reconciliation) =>
        modelAttemptMatchesSnapshot(reconciliation, snapshot)
      )
  )
  const pendingPermissionCount = Object.values(sessions)
    .reduce((total, session) => total + session.pendingPermissions.length, 0)
  const recoveryCount = recoverySnapshots.length + modelAttemptReconciliations.length +
    workflowAttentionWorkItems.length + workflowAttentionSupervisorRuns.length + pendingPermissionCount
  const activeEntries: ActiveSidebarEntry[] = order.flatMap((id) => {
    const session = sessions[id]
    if (!belongsToBusinessLine(session?.meta, selectedLine.id)) return []
    const historyEntry =
      historyByActiveId.get(id) ??
      (session.meta.sdkSessionId ? historyByActiveId.get(session.meta.sdkSessionId) : undefined)
    const entry: ActiveSidebarEntry = {
      kind: 'active' as const,
      id,
      meta: session.meta,
      pendingCount: session.pendingPermissions.length
    }
    if (historyEntry) entry.history = historyEntry
    return matchesQuery(entry) ? [entry] : []
  })

  const historyEntries = history.filter(
    (entry) => resolveBusinessLineId(entry) === selectedLine.id && !openSessionIds.has(entry.id) && !openSdkIds.has(entry.sdkSessionId)
  )
  const visibleHistoryEntries = historyEntries
    .map((entry) => ({ kind: 'history' as const, id: entry.id, history: entry }))
    .filter(matchesQuery)
  const groupedEntries = useMemo(() => {
    return buildSidebarProjectGroups({
      entries: [...activeEntries, ...visibleHistoryEntries],
      legacyProjects: projects,
      projectSort,
      query,
      unassignedLabel: t('unassignedSessions'),
      workspaces: projectWorkspaces
    })
  }, [activeEntries, projectSort, projectWorkspaces, projects, query, t, visibleHistoryEntries])

  const { projectGroups, archivedProjectGroups, unassigned, showUnassigned } = groupedEntries
  const { archived: archivedHistory, pinned: pinnedEntries, sessions: assistantSessionEntries } =
    splitAssistantEntries(businessLineConversationEntries(selectedLine, [...activeEntries, ...visibleHistoryEntries]))

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

  const showMenu = (e: React.MouseEvent, entry: SidebarEntry): void => {
    e.preventDefault()
    e.stopPropagation()
    setProjectMenu(null)
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const showButtonMenu = (e: React.MouseEvent<HTMLButtonElement>, entry: SidebarEntry): void => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setProjectMenu(null)
    setMenu({ x: rect.right - 4, y: rect.bottom + 4, entry })
  }

  const showProjectButtonMenu = (e: React.MouseEvent<HTMLButtonElement>, group: ProjectGroup): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!group.workspace && !group.legacyProject) return
    const rect = e.currentTarget.getBoundingClientRect()
    setMenu(null)
    setProjectMenu({ x: rect.right - 4, y: rect.bottom + 4, group })
  }

  const copyPath = (path: string): void => {
    void navigator.clipboard?.writeText(path).catch(() => undefined)
  }

  const menuItemsFor = (entry: SidebarEntry): SessionMenuItem[] => {
    const title = entryTitle(entry)
    const path = entryPath(entry)
    const historyEntry = entry.kind === 'history' ? entry.history : entry.history
    const items: SessionMenuItem[] = [
      { key: 'rename', label: t('rename'), onClick: () => startRename(entry) }
    ]

    if (historyEntry) {
      items.push({
        key: 'fork-conversation',
        label: t('forkConversation'),
        onClick: () => forkFromHistory(historyEntry)
      })
      items.push({
        key: 'pin',
        label: historyEntry.pinned ? t('unpinSession') : t('pinSession'),
        onClick: () => void pinHistory(historyEntry.id, !historyEntry.pinned)
      })
      items.push({
        key: 'archive',
        label: historyEntry.archived ? t('unarchiveSession') : t('archiveSession'),
        onClick: () => void archiveHistory(historyEntry.id, !historyEntry.archived)
      })
    }

    items.push({ key: 'copy-path', label: t('copyPath'), onClick: () => copyPath(path) })
    items.push({
      key: 'delete',
      label: entry.kind === 'active' ? t('closeSession') : t('delete'),
      danger: true,
      onClick: () => {
        const message =
          entry.kind === 'active'
            ? t('closeSessionConfirm', { title })
            : t('deleteHistoryConfirm', { title })
        if (!window.confirm(message)) return
        if (entry.kind === 'active') void closeSession(entry.id)
        else void deleteHistoryEntry(entry.id)
        restoreComposerFocus()
      }
    })
    return items
  }

  const projectMenuItemsFor = (group: ProjectGroup): SessionMenuItem[] => {
    if (group.kind === 'canonical' && group.workspace) {
      const project = group.workspace
      return [
        {
          key: 'archive-canonical-project',
          label: project.status === 'archived' ? t('unarchiveProject') : t('archiveProject'),
          onClick: () => void archiveCanonicalProject(project.id, project.status !== 'archived')
        },
        ...(group.path
          ? [{ key: 'copy-project-path', label: t('copyPath'), onClick: () => copyPath(group.path) }]
          : []),
        {
          key: 'delete-canonical-project',
          label: t('deleteProject'),
          danger: true,
          onClick: () => {
            if (!window.confirm(t('deleteProjectConfirm', { name: project.name }))) return
            void deleteCanonicalProject(project.id)
          }
        }
      ]
    }
    const project = group.legacyProject
    if (!project) return []
    return [
      {
        key: 'archive-project',
        label: project.archived ? t('unarchiveProject') : t('archiveProject'),
        onClick: () => void archiveProject(project.id, !project.archived)
      },
      { key: 'copy-project-path', label: t('copyPath'), onClick: () => copyPath(project.path) },
      {
        key: 'delete-project',
        label: t('deleteProject'),
        danger: true,
        onClick: () => {
          if (!window.confirm(t('deleteProjectConfirm', { name: project.name }))) return
          void deleteProject(project.id)
        }
      }
    ]
  }

  const renderTitle = (entry: SidebarEntry): React.ReactNode => {
    const isolated = entry.kind === 'active' ? entry.meta.isolated : entry.history.isolated
    const pinned = entry.kind === 'active' ? entry.history?.pinned : entry.history.pinned
    return (
      <span className="session-card-title">
        {pinned && <span className="session-pin-mark" title={t('pinned')}>★</span>}
        {isolated && (
          <span className="worktree-mark" title="Git worktree 隔离">
            ⎇
          </span>
        )}
        {entryTitle(entry)}
      </span>
    )
  }

  const renderEditingCard = (key: string): React.ReactNode => (
    <div key={key} className="session-card session-card-editing">
      <input
        className="input session-rename-input"
        value={draftTitle}
        autoFocus
        onChange={(e) => setDraftTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename()
          if (e.key === 'Escape') setEditing(null)
        }}
        onBlur={commitRename}
      />
    </div>
  )

  const renderActiveEntry = (entry: ActiveSidebarEntry): React.ReactNode => {
    if (editing?.kind === 'active' && editing.id === entry.id) return renderEditingCard(entry.id)
    const displayCwd = entryPath(entry)
    return (
      <div
        key={entry.id}
        className={`session-card ${activeId === entry.id ? 'active' : ''}`}
        data-session-id={entry.id}
        role="button"
        tabIndex={0}
        onClick={() => selectSession(entry.id)}
        onKeyDown={(e) =>
          activateByKeyboard(e, () => selectSession(entry.id))
        }
        onContextMenu={(e) => showMenu(e, entry)}
      >
        <span
          className={`status-dot status-${entry.meta.status}`}
          title={t(STATUS_LABEL_KEY[entry.meta.status])}
        />
        <span className="session-card-body">
          {renderTitle(entry)}
          <span className="session-card-sub">
            {projectNameForEntry(entry)} · {formatCost(entry.meta.costUsd)}
          </span>
        </span>
        {entry.pendingCount > 0 && (
          <span className="session-card-badge" title={t('awaitingApproval')}>
            {entry.pendingCount}
          </span>
        )}
        <button
          className="session-action session-card-more"
          title={t('moreActions')}
          aria-haspopup="menu"
          onClick={(e) => showButtonMenu(e, entry)}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      </div>
    )
  }

  const renderHistoryEntry = (entry: HistoryEntry): React.ReactNode => {
    const ref: SidebarEntry = { kind: 'history', id: entry.id, history: entry }
    if (editing?.kind === 'history' && editing.id === entry.id) return renderEditingCard(entry.id)
    const path = historyPath(entry)
    return (
      <div
        key={entry.id}
        className="session-card history-card"
        data-session-id={entry.id}
        role="button"
        tabIndex={0}
        title={t('resumeSessionTitle', { cwd: path })}
        onClick={() => void resumeFromHistory(entry)}
        onKeyDown={(e) =>
          activateByKeyboard(e, () => void resumeFromHistory(entry))
        }
        onContextMenu={(e) => showMenu(e, ref)}
      >
        <span className="history-icon">↻</span>
        <span className="session-card-body">
          {renderTitle(ref)}
          <span className="session-card-sub">
            {projectNameForEntry(ref)} · {formatTime(entry.updatedAt)}
          </span>
        </span>
        <button
          className="session-action session-card-more"
          title={t('moreActions')}
          aria-haspopup="menu"
          onClick={(e) => showButtonMenu(e, ref)}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      </div>
    )
  }

  const renderSidebarEntry = (entry: SidebarEntry): React.ReactNode =>
    entry.kind === 'active' ? renderActiveEntry(entry) : renderHistoryEntry(entry.history)

  const renderProjectGroup = (group: ProjectGroup, allowNewSession: boolean): React.ReactNode => {
    const collapsed = collapsedProjects[group.key] === true
    return (
      <div key={group.key} className="sidebar-project-group" data-project-id={group.projectId} data-project-kind={group.kind}>
        <div className="sidebar-group-row">
          <button
            className="sidebar-group-head"
            title={group.path || group.label} aria-expanded={!collapsed}
            onClick={() => setCollapsedProjects((state) => ({ ...state, [group.key]: !collapsed }))}
          >
            <DisclosureChevron expanded={!collapsed} className="sidebar-group-caret" />
            <span className="sidebar-group-title">{group.label}</span>
            <span className="sidebar-group-count">{taskEntryCount(group.entries)}</span>
          </button>
          {allowNewSession && (
            <button
              type="button"
              className="sidebar-group-new"
              aria-label={`${t('newSessionHere')}: ${group.label}`}
              title={t('newSessionHere')}
              onClick={() => {
                if (group.kind === 'canonical' && group.projectId) openProjectWorkspace(group.projectId)
                else setShowNewSession(true, group.projectId)
              }}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          )}
          {(group.workspace || group.legacyProject) && (
            <button
              type="button"
              className="sidebar-group-more"
              aria-label={t('projectActions', { name: group.label })}
              title={t('moreActions')}
              aria-haspopup="menu"
              onClick={(event) => showProjectButtonMenu(event, group)}
            >
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        {!collapsed && <SidebarTaskList entries={group.entries} activeId={activeId} renderEntry={renderSidebarEntry} />}
        {!collapsed && group.entries.length === 0 && (
          <div className="sidebar-empty sidebar-group-empty">{t('noSessions')}</div>
        )}
      </div>
    )
  }

  const renderSearchHit = (result: TranscriptSearchResult): React.ReactNode => {
    const first = result.hits[0]
    return (
      <div
        key={result.sdkSessionId}
        className="session-card search-hit-card"
        role="button"
        tabIndex={0}
        title={t('resumeSessionTitle', { cwd: result.cwd })}
        onClick={() => void openTranscriptSearchHit(result)}
        onKeyDown={(e) => activateByKeyboard(e, () => void openTranscriptSearchHit(result))}
      >
        <span className="history-icon">⌕</span>
        <span className="session-card-body">
          <span className="session-card-title">{result.title}</span>
          <span className="search-hit-snippet">
            {first ? highlightSnippet(first.snippet, query.trim()) : result.note}
          </span>
        </span>
      </div>
    )
  }

  const totalVisible = sidebarVisibleCount(experienceMode,
    [taskEntryCount(pinnedEntries), taskEntryCount(assistantSessionEntries), archivedHistory.length],
    [...projectGroups, ...archivedProjectGroups].map((group) => taskEntryCount(group.entries)))
  const archiveExpanded = archiveOpen || query.trim().length > 0
  const contentSearchActive = query.trim().length >= 2
  const searchPlaceholder = t(sidebarSearchKey(experienceMode))

  const navigateWorkOs = (target: WorkOsNavigationTarget): void => {
    setWorkOsTarget(target)
    if (target === 'settings') {
      setShowTaskRecovery(false)
      setShowSettings(true)
      return
    }
    setShowSettings(false)
    setShowTaskRecovery(false)
    setView('list')
    onExperienceModeChange('studio')
    const section = target === 'inbox' ? 'inbox' : target === 'library' ? 'team' : 'work'
    requestStudioSectionNavigation(section)
    requestWorkOsNavigation(target)
  }

  return (
    <aside
      className={`sidebar ${layout.sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      style={
        {
          '--sidebar-width': `${layout.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}px`
        } as React.CSSProperties
      }
    >
      <div className="sidebar-brand drag-region" data-brand="caogen">
        <span className="brand-mark" data-brand-logo="caogen-app-icon" aria-hidden="true">
          <img src={APP_ICON_URL} alt="" />
        </span>
        <span className="brand-name">{APP_NAME}</span>
        <button
          type="button"
          className={`sidebar-header-action no-drag ${searchOpen || query ? 'is-active' : ''}`}
          aria-label={searchPlaceholder}
          aria-expanded={searchOpen || Boolean(query)}
          title={searchPlaceholder}
          onClick={() => {
            const nextOpen = !searchOpen || Boolean(query)
            setSearchOpen(nextOpen)
            if (nextOpen) requestAnimationFrame(() => searchRef.current?.focus())
          }}
        >
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sidebar-collapse-toggle no-drag"
          aria-label={layout.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
          title={layout.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
          onClick={() => patchLayout({ sidebarCollapsed: !layout.sidebarCollapsed })}
        >
          <SidebarPanelIcon collapsed={layout.sidebarCollapsed} />
        </button>
      </div>

      <nav className="sidebar-primary-nav" aria-label={t('primaryNavigation')}>
        <SidebarPrimaryAction
          mode={experienceMode}
          newSessionActive={showNewSession}
          onNewSession={() => { setShowNewSession(true); requestBusinessLineTaskNavigation(selectedLine.id) }}
          onNewProject={openNewProjectWorkspace}
          onNewVideo={() => { onExperienceModeChange('video'); window.dispatchEvent(new Event('caogen:video-new')) }}
        />

        <When values={[isAssistant, recoveryCount > 0]}>
          <button
            type="button"
            className={`sidebar-nav-item sidebar-recovery ${showTaskRecovery ? 'is-active' : ''}`}
            aria-expanded={showTaskRecovery}
            aria-haspopup="dialog"
            data-sidebar-action="recovery-center"
            onClick={() => setShowTaskRecovery(true)}
          >
            <HeaderIcon name="recovery" />
            <span>{t('recoveryCenter')}</span>
            <strong className="sidebar-nav-badge">{recoveryCount}</strong>
          </button>
        </When>
      </nav>

      <WorkOsPrimaryNav language={language} mode={experienceMode} activeTarget={workOsTarget} onNavigate={navigateWorkOs} />

      <div className={`sidebar-search-wrap ${searchOpen || query ? 'is-open' : ''}`}>
        <input
          ref={searchRef}
          className="input sidebar-search"
          value={query}
          placeholder={searchPlaceholder}
          onFocus={() => setSearchOpen(true)}
          onChange={(e) => setSidebarQuery(e.target.value)}
        />
      </div>

      <div className="sidebar-scroll">
        <When values={[isAssistant, pinnedEntries.length > 0]}>
          <section className="sidebar-section">
            <div className="sidebar-section-title">{t('pinned')}</div>
            <SidebarTaskList entries={pinnedEntries} activeId={activeId} renderEntry={renderSidebarEntry} />
          </section>
        </When>

        {isAssistant ? (
          <section className="sidebar-section sidebar-conversations-section" data-sidebar-assistant-sessions>
            <div className="sidebar-section-title">{TASK_LABEL[language]}</div>
            <SidebarTaskList entries={assistantSessionEntries} activeId={activeId} renderEntry={renderSidebarEntry} />
            {assistantSessionEntries.length === 0 && <div className="sidebar-empty">{t('noSessions')}</div>}
          </section>
        ) : isProject ? (
        <SidebarProjectSections
          conversationCollapsed={collapsedProjects[unassigned.key] === true}
          conversationContent={unassigned.entries.map(renderSidebarEntry)}
          conversationCount={unassigned.entries.length}
          conversationEmpty={unassigned.entries.length === 0}
          conversationLabel={unassigned.label}
          forceProjectsExpanded={query.trim().length > 0}
          onCollapseAll={() => setCollapsedProjects((state) => ({
            ...state,
            ...Object.fromEntries(projectGroups.map((group) => [group.key, true]))
          }))}
          onExpandAll={() => setCollapsedProjects((state) => ({
            ...state,
            ...Object.fromEntries(projectGroups.map((group) => [group.key, false]))
          }))}
          onNewProject={openNewProjectWorkspace}
          onProjectSortChange={setProjectSort}
          onToggleConversation={() => setCollapsedProjects((state) => ({
            ...state,
            [unassigned.key]: state[unassigned.key] !== true
          }))}
          projectContent={projectGroups.map((group) => renderProjectGroup(group, true))}
          projectCount={projectGroups.length}
          projectSort={projectSort}
          showConversation={false}
        />
        ) : (
          <SidebarVideoSections active={isVideo} query={query} onNewVideo={() => { onExperienceModeChange('video'); window.dispatchEvent(new Event('caogen:video-new')) }} projects={projectWorkspaces} />
        )}

        <When values={[isAssistant, archivedHistory.length > 0]}>
          <section className="sidebar-section">
            <button className="sidebar-section-toggle" aria-expanded={archiveExpanded} onClick={() => setArchiveOpen((value) => !value)}>
              <DisclosureChevron expanded={archiveExpanded} />
              <span>{t('archived')}</span>
              <span className="sidebar-group-count">{archivedHistory.length}</span>
            </button>
            {archiveExpanded && archivedHistory.map((entry) => renderHistoryEntry(entry))}
          </section>
        </When>

        <When values={[isProject, archivedProjectGroups.length > 0]}>
          <section className="sidebar-section sidebar-archived-projects-section">
            <button
              className="sidebar-section-toggle" aria-expanded={archivedProjectsOpen || Boolean(query.trim())}
              onClick={() => setArchivedProjectsOpen((value) => !value)}
            >
              <DisclosureChevron expanded={archivedProjectsOpen || Boolean(query.trim())} />
              <span>{t('archivedProjects')}</span>
              <span className="sidebar-group-count">{archivedProjectGroups.length}</span>
            </button>
            {(archivedProjectsOpen || query.trim()) &&
              archivedProjectGroups.map((group) => renderProjectGroup(group, false))}
          </section>
        </When>
        <When values={[isAssistant, contentSearchActive]}>
          <section className="sidebar-section">
            <div className="sidebar-section-title">{t('contentSearchSection')}</div>
            {transcriptSearchResults.map((result) => renderSearchHit(result))}
            {transcriptSearchResults.length === 0 && !transcriptSearchLoading && (
              <div className="sidebar-empty">{t('contentSearchEmpty')}</div>
            )}
          </section>
        </When>

        <When values={[!isVideo, Boolean(query.trim()), totalVisible === 0, projectGroups.length === 0, archivedProjectGroups.length === 0, !showUnassigned]}>
          <div className="sidebar-empty">{t('noMatchingSessions')}</div>
        </When>
      </div>

      <SidebarFooter
        language={language}
        mode={experienceMode}
        recommendation={builtinLineValue(selectedLine, experienceRecommendation)}
        settings={settings}
        onExperienceModeChange={onExperienceModeChange}
        onOpenControlRoom={() => {
          setShowTaskRecovery(false)
          cancelOfficeIdlePrewarm()
          setView('office')
        }}
        onOpenSettings={() => setShowSettings(true)}
        onUpdateSettings={updateSettings}
      />

      <div
        className="sidebar-resize-handle no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeSidebar')}
        title={t('resizeSidebar')}
        onPointerDown={startSidebarResize}
      />

      {menu && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
      {projectMenu && (
        <SessionContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          items={projectMenuItemsFor(projectMenu.group)}
          onClose={() => setProjectMenu(null)}
        />
      )}
    </aside>
  )
}
export default memo(Sidebar)
