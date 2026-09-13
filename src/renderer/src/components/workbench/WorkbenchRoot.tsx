import { createElement, memo, Suspense, useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { PanelRightClose } from 'lucide-react'
import ChatView from '../ChatView'
import RoutineEditor from '../RoutineEditor'
import { HeaderIcon, type HeaderIconName } from '../ChatHeaderIcons'
import { PANEL_REGISTRY, type PanelId } from './panels'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import type { LayoutSettings, PluginRegistryItem, Routine, SessionMeta } from '../../../../shared/types'
import {
  deriveFirstTaskOnboardingStatus,
  deriveFirstTaskProgress,
  restartFirstTaskOnboardingCandidate,
  useFirstTaskOnboardingRecord
} from '../experience/first-task-onboarding'

type RoutineEditorState = { mode: 'create' } | { mode: 'edit'; id: string }

const SIDE_MIN_WIDTH = 320
const SIDE_MAX_WIDTH = 720
const DOCK_MIN_HEIGHT = 220
const DOCK_MAX_HEIGHT = 520

type DeskToolKey = 'review' | 'terminal' | 'browser' | 'files' | 'sideChat' | 'memory'

interface DeskToolItem {
  key: DeskToolKey
  icon: HeaderIconName
  label: string
  active: boolean
  onSelect: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function startWorkbenchSideResize(
  event: React.PointerEvent<HTMLDivElement>,
  sideWidth: number,
  setSideWidth: (width: number) => void,
  patchLayout: (patch: Partial<LayoutSettings>) => void
): void {
  event.preventDefault()
  const gutter = event.currentTarget
  try {
    gutter.setPointerCapture(event.pointerId)
  } catch {
    // Electron/CDP 合成指针可能不支持捕获;window 级监听仍可完成拖拽。
  }
  const startX = event.clientX
  const startWidth = sideWidth
  let nextWidth = startWidth
  const move = (moveEvent: PointerEvent): void => {
    nextWidth = clamp(startWidth - (moveEvent.clientX - startX), SIDE_MIN_WIDTH, SIDE_MAX_WIDTH)
    setSideWidth(nextWidth)
  }
  const stop = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    if (gutter.hasPointerCapture(event.pointerId)) gutter.releasePointerCapture(event.pointerId)
    document.body.classList.remove('is-resizing-layout')
    patchLayout({ workbenchSideWidth: nextWidth })
  }
  document.body.classList.add('is-resizing-layout')
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
}

function startWorkbenchDockResize(
  event: React.PointerEvent<HTMLDivElement>,
  dockHeight: number,
  setDockHeight: (height: number) => void,
  patchLayout: (patch: Partial<LayoutSettings>) => void
): void {
  event.preventDefault()
  const gutter = event.currentTarget
  try {
    gutter.setPointerCapture(event.pointerId)
  } catch {
    // Synthetic pointers can miss capture; window listeners still preserve the drag.
  }
  const startY = event.clientY
  const startHeight = dockHeight
  let nextHeight = startHeight
  const move = (moveEvent: PointerEvent): void => {
    nextHeight = clamp(startHeight - (moveEvent.clientY - startY), DOCK_MIN_HEIGHT, DOCK_MAX_HEIGHT)
    setDockHeight(nextHeight)
  }
  const stop = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    if (gutter.hasPointerCapture(event.pointerId)) gutter.releasePointerCapture(event.pointerId)
    document.body.classList.remove('is-resizing-layout')
    patchLayout({ workbenchDockHeight: nextHeight })
  }
  document.body.classList.add('is-resizing-layout')
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
}

function workbenchDimensions(sideWidth: number, dockHeight: number): React.CSSProperties {
  return {
    '--workbench-side-width': `${sideWidth}px`,
    '--workbench-dock-height': `${dockHeight}px`
  } as React.CSSProperties
}

function resizeWorkbenchFromKeyboard(
  event: React.KeyboardEvent<HTMLDivElement>,
  current: number,
  orientation: 'horizontal' | 'vertical',
  min: number,
  max: number,
  apply: (value: number) => void
): void {
  const step = event.shiftKey ? 40 : 16
  let next: number | null = null
  if (event.key === 'Home') next = min
  else if (event.key === 'End') next = max
  else if (orientation === 'vertical' && event.key === 'ArrowLeft') next = current + step
  else if (orientation === 'vertical' && event.key === 'ArrowRight') next = current - step
  else if (orientation === 'horizontal' && event.key === 'ArrowUp') next = current + step
  else if (orientation === 'horizontal' && event.key === 'ArrowDown') next = current - step
  if (next === null) return
  event.preventDefault()
  apply(clamp(next, min, max))
}

function WorkbenchRoot(): React.JSX.Element {
  const t = useT()
  const [routineEditor, setRoutineEditor] = useState<RoutineEditorState | null>(null)
  const activeId = useStore((s) => s.activeId)
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const activePanelId = useStore((s) => s.workbench.activePanelId)
  const mountedPanels = useStore((s) => s.workbench.mountedPanels)
  const layout = useStore((s) => s.settings.layout)
  const updateSettings = useStore((s) => s.updateSettings)
  const openPanel = useStore((s) => s.openPanel)
  const closePanel = useStore((s) => s.closePanel)
  const togglePanel = useStore((s) => s.togglePanel)
  const pluginRegistry = useStore((s) => s.workbench.pluginRegistry)
  const pluginRegistryLoading = useStore((s) => s.workbench.pluginRegistryLoading)
  const pluginRegistryError = useStore((s) => s.workbench.pluginRegistryError)
  const pluginRegistryMessage = useStore((s) => s.workbench.pluginRegistryMessage)
  const selectedPluginRegistryItemId = useStore((s) => s.workbench.selectedPluginRegistryItemId)
  const subagentBusy = useStore((s) => s.workbench.subagentBusy)
  const subagentError = useStore((s) => s.workbench.subagentError)
  const subagentMessage = useStore((s) => s.workbench.subagentMessage)
  const lastSubagentDispatch = useStore((s) => s.workbench.lastSubagentDispatch)
  const taskDagExecution = useStore((s) =>
    s.activeId ? s.sessions[s.activeId]?.taskDagExecution : undefined
  )
  const routines = useStore((s) => s.workbench.routines)
  const routineRuns = useStore((s) => s.workbench.routineRuns)
  const routineLoading = useStore((s) => s.workbench.routineLoading)
  const routineError = useStore((s) => s.workbench.routineError)
  const routineMessage = useStore((s) => s.workbench.routineMessage)
  const selectedRoutineId = useStore((s) => s.workbench.selectedRoutineId)
  const memoryInitialForm = useStore((s) => s.workbench.memoryInitialForm)
  const refreshPluginRegistryPanel = useStore((s) => s.refreshPluginRegistryPanel)
  const closePluginRegistryPanel = useStore((s) => s.closePluginRegistryPanel)
  const selectPluginRegistryItem = useStore((s) => s.selectPluginRegistryItem)
  const revealPluginRegistryItem = useStore((s) => s.revealPluginRegistryItem)
  const togglePluginRegistryItem = useStore((s) => s.togglePluginRegistryItem)
  const approvePluginRegistryItem = useStore((s) => s.approvePluginRegistryItem)
  const sendPluginRegistryItemToAgent = useStore((s) => s.sendPluginRegistryItemToAgent)
  const dispatchPluginAgent = useStore((s) => s.dispatchPluginAgent)
  const probeMcpRuntime = useStore((s) => s.probeMcpRuntime)
  const installPluginFromLocal = useStore((s) => s.installPluginFromLocal)
  const uninstallManagedPlugin = useStore((s) => s.uninstallManagedPlugin)
  const mcpProbeResults = useStore((s) => s.workbench.mcpProbeResults)
  const mcpProbing = useStore((s) => s.workbench.mcpProbing)
  const closeSubagentPanel = useStore((s) => s.closeSubagentPanel)
  const dispatchSubagentText = useStore((s) => s.dispatchSubagentText)
  const decomposeAndDispatchTaskDag = useStore((s) => s.decomposeAndDispatchTaskDag)
  const selectSession = useStore((s) => s.selectSession)
  const refreshRoutinePanel = useStore((s) => s.refreshRoutinePanel)
  const closeRoutinePanel = useStore((s) => s.closeRoutinePanel)
  const selectRoutine = useStore((s) => s.selectRoutine)
  const toggleRoutine = useStore((s) => s.toggleRoutine)
  const markRoutineRun = useStore((s) => s.markRoutineRun)
  const deleteRoutine = useStore((s) => s.deleteRoutine)
  const closeMemoryPanel = useStore((s) => s.closeMemoryPanel)
  const [sideWidth, setSideWidth] = useState(clamp(layout.workbenchSideWidth, SIDE_MIN_WIDTH, SIDE_MAX_WIDTH))
  const [dockHeight, setDockHeight] = useState(clamp(layout.workbenchDockHeight, DOCK_MIN_HEIGHT, DOCK_MAX_HEIGHT))
  useEffect(() => {
    setSideWidth(clamp(layout.workbenchSideWidth, SIDE_MIN_WIDTH, SIDE_MAX_WIDTH))
  }, [layout.workbenchSideWidth])
  useEffect(() => {
    setDockHeight(clamp(layout.workbenchDockHeight, DOCK_MIN_HEIGHT, DOCK_MAX_HEIGHT))
  }, [layout.workbenchDockHeight])
  const patchLayout = (patch: Partial<LayoutSettings>): void => {
    void updateSettings({ layout: { ...layout, ...patch } }).catch((error) => {
      console.error('[agent-desk] Failed to persist workbench layout:', error)
    })
  }

  const collapseSidePanel = (): void => {
    closePanel()
  }
  const toggleSidePanel = (): void => {
    if (sideOpen) {
      closePanel()
      return
    }
    openPanel('diff')
  }
  const toggleSummaryPanel = (): void => {
    togglePanel('result')
  }
  const closeRoutineEditor = (): void => {
    setRoutineEditor(null)
    void refreshRoutinePanel()
  }
  const selectedRoutine = routineEditor?.mode === 'edit'
    ? (routines.find((routine) => routine.id === routineEditor.id) as Routine | undefined)
    : undefined
  const childSessions = activeId
    ? order
        .map((id) => sessions[id]?.meta)
        .filter((meta): meta is SessionMeta => Boolean(meta && meta.parentSessionId === activeId))
    : []
  const childResults = activeId ? sessions[activeId]?.childResults ?? {} : {}
  const terminalOpen = activePanelId === 'terminal'
  const sideOpen = activePanelId !== null && !terminalOpen
  const deskTools: DeskToolItem[] = [
    {
      key: 'review',
      icon: 'review',
      label: t('deskReview'),
      active: activePanelId === 'diff' || activePanelId === 'worktree',
      onSelect: () => openPanel('diff')
    },
    {
      key: 'terminal',
      icon: 'terminal',
      label: t('deskTerminal'),
      active: activePanelId === 'terminal',
      onSelect: () => openPanel('terminal')
    },
    {
      key: 'browser',
      icon: 'browser',
      label: t('deskBrowser'),
      active: activePanelId === 'browser',
      onSelect: () => openPanel('browser')
    },
    {
      key: 'files',
      icon: 'files',
      label: t('deskFiles'),
      active: activePanelId === 'files' || activePanelId === 'preview',
      onSelect: () => openPanel('files')
    },
    {
      key: 'sideChat',
      icon: 'subagents',
      label: t('deskSideChat'),
      active: activePanelId === 'subagent',
      onSelect: () => openPanel('subagent')
    },
    {
      key: 'memory',
      icon: 'memory',
      label: t('memoryShort'),
      active: activePanelId === 'memory',
      onSelect: () => openPanel('memory')
    }
  ]

  const renderPanelContent = (id: PanelId): Record<string, unknown> => {
    switch (id) {
      case 'result':
        return { sessionId: activeId, standalone: false }
      case 'pluginRegistry':
        return {
          items: pluginRegistry?.items ?? [],
          roots: pluginRegistry?.roots,
          diagnostics: pluginRegistry?.diagnostics,
          scannedAt: pluginRegistry?.scannedAt,
          truncated: pluginRegistry?.truncated,
          loading: pluginRegistryLoading,
          error: pluginRegistryError,
          message: pluginRegistryMessage,
          selectedItemId: selectedPluginRegistryItemId,
          onRefresh: refreshPluginRegistryPanel,
          onClose: closePluginRegistryPanel,
          onSelectItem: (item: { id: string }) => selectPluginRegistryItem(item.id),
          onUseItem: (item: PluginRegistryItem) => void sendPluginRegistryItemToAgent(item),
          onDispatchAgent: (item: PluginRegistryItem) => void dispatchPluginAgent(item),
          onRevealItem: (item: PluginRegistryItem) => void revealPluginRegistryItem(item),
          onToggleItem: (item: PluginRegistryItem, enabled: boolean) => void togglePluginRegistryItem(item, enabled),
          onApproveItem: (item: PluginRegistryItem) => void approvePluginRegistryItem(item),
          onProbeMcp: (items: PluginRegistryItem[]) => void probeMcpRuntime(items),
          onInstall: () => void installPluginFromLocal(),
          onUninstall: (item: PluginRegistryItem) => void uninstallManagedPlugin(item),
          mcpProbeResults,
          mcpProbing
        }
      case 'subagent':
        return {
          childSessions,
          childResults,
          busy: subagentBusy,
          error: subagentError,
          message: subagentMessage,
          lastResult: lastSubagentDispatch,
          dagExecution: taskDagExecution,
          onClose: closeSubagentPanel,
          onSelectChild: selectSession,
          onDispatch: dispatchSubagentText,
          onDecomposeAndDispatch: decomposeAndDispatchTaskDag
        }
      case 'routine':
        return {
          routines,
          runs: routineRuns,
          loading: routineLoading,
          error: routineError,
          message: routineMessage,
          selectedRoutineId,
          subtitle: '本地持久化 · 定时执行已启用',
          cloudSchedulingNote: 'Routine 在本机定时执行；云端托管定时尚未接入。',
          onAddRoutine: () => setRoutineEditor({ mode: 'create' }),
          onRefresh: refreshRoutinePanel,
          onClose: closeRoutinePanel,
          onSelectRoutine: (routine: Routine) => selectRoutine(routine.id),
          onEditRoutine: (routine: Routine) => setRoutineEditor({ mode: 'edit', id: routine.id }),
          onDeleteRoutine: (routine: Routine) => {
            if (window.confirm(`删除 Routine「${routine.name}」?`)) void deleteRoutine(routine.id)
          },
          onToggleRoutine: (routine: Routine, enabled: boolean) => void toggleRoutine(routine.id, enabled),
          onRunRoutine: (routine: Routine) => void markRoutineRun(routine.id)
        }
      case 'memory':
        return activeId
          ? { sessionId: activeId, initialForm: memoryInitialForm, onClose: closeMemoryPanel }
          : {}
      default:
        return {}
    }
  }

  return (
    <div
      className={`workbench ${sideOpen ? 'workbench-split' : ''} ${terminalOpen ? 'workbench-dock-open' : ''}`}
      style={workbenchDimensions(sideWidth, dockHeight)}
    >
      <DeskControlRail
        sideOpen={sideOpen}
        summaryOpen={activePanelId === 'result'}
        tools={deskTools}
        onToggleSummary={toggleSummaryPanel}
        onToggleSidePanel={toggleSidePanel}
      />
      <section className="workbench-pane workbench-primary">
        <section className="workbench-chat">
          <FirstTaskWorkbenchStatus />
          <ChatView />
        </section>
        <div
          className="workbench-dock-gutter no-drag"
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-valuemin={DOCK_MIN_HEIGHT}
          aria-valuemax={DOCK_MAX_HEIGHT}
          aria-valuenow={dockHeight}
          aria-label={t('resizeToolPanel')}
          title={t('resizeToolPanel')}
          onPointerDown={(event) => startWorkbenchDockResize(event, dockHeight, setDockHeight, patchLayout)}
          onKeyDown={(event) => resizeWorkbenchFromKeyboard(
            event, dockHeight, 'horizontal', DOCK_MIN_HEIGHT, DOCK_MAX_HEIGHT,
            (value) => { setDockHeight(value); patchLayout({ workbenchDockHeight: value }) }
          )}
          style={{ display: terminalOpen ? undefined : 'none' }}
        />
        <section
          className="workbench-pane workbench-bottom-dock"
          style={{ display: terminalOpen ? 'flex' : 'none' }}
          data-workbench-terminal-dock
        >
          <Suspense fallback={<div className="workbench-panel-loading" />}>
            {PANEL_REGISTRY.filter((def) => def.id === 'terminal').map((def) => {
              const isActive = activePanelId === def.id
              const isMounted = mountedPanels.has(def.id)
              if (!isActive && !isMounted) return null
              const Component = def.component
              return (
                <div
                  key={def.id}
                  className="workbench-panel"
                  style={{ display: isActive ? 'flex' : 'none' }}
                  aria-hidden={!isActive}
                >
                  {createElement(Component, renderPanelContent(def.id))}
                </div>
              )
            })}
          </Suspense>
        </section>
      </section>
      <WorkbenchSidePanel
        activePanelId={activePanelId}
        open={sideOpen}
        sideWidth={sideWidth}
        onCollapse={collapseSidePanel}
        onPointerDown={(event) => startWorkbenchSideResize(event, sideWidth, setSideWidth, patchLayout)}
        onResize={(value) => { setSideWidth(value); patchLayout({ workbenchSideWidth: value }) }}
      >
        <Suspense fallback={<div className="workbench-panel-loading" />}>
          {PANEL_REGISTRY.filter((def) => def.id !== 'terminal').map((def) => {
            const isActive = activePanelId === def.id
            const isMounted = mountedPanels.has(def.id)
            if (!isActive && !isMounted) return null
            const Component = def.component
            return (
              <div
                key={def.id}
                className="workbench-panel"
                style={{ display: isActive ? 'flex' : 'none' }}
                aria-hidden={!isActive}
              >
                {createElement(Component, renderPanelContent(def.id))}
              </div>
            )
          })}
        </Suspense>
      </WorkbenchSidePanel>
      {routineEditor && (routineEditor.mode === 'create' || selectedRoutine) && (
        <RoutineEditor
          routine={routineEditor.mode === 'edit' ? selectedRoutine : null}
          onClose={closeRoutineEditor}
        />
      )}
    </div>
  )
}

function WorkbenchSidePanel({
  activePanelId,
  open,
  sideWidth,
  onCollapse,
  onPointerDown,
  onResize,
  children
}: {
  activePanelId: PanelId | null
  open: boolean
  sideWidth: number
  onCollapse: () => void
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onResize: (value: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="workbench-side-gutter no-drag" role="separator" tabIndex={0} aria-orientation="vertical"
        aria-valuemin={SIDE_MIN_WIDTH} aria-valuemax={SIDE_MAX_WIDTH} aria-valuenow={sideWidth}
        aria-label={t('resizeToolPanel')} title={t('resizeToolPanel')} onPointerDown={onPointerDown}
        onKeyDown={(event) => resizeWorkbenchFromKeyboard(
          event, sideWidth, 'vertical', SIDE_MIN_WIDTH, SIDE_MAX_WIDTH, onResize
        )}
        style={{ display: open ? undefined : 'none' }}
      >
        <button type="button" className="workbench-side-collapse" aria-label={t('collapseToolPanel')}
          title={t('collapseToolPanel')} onPointerDown={(event) => event.stopPropagation()} onClick={onCollapse}>
          <PanelRightClose size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>
      <section className={`workbench-pane workbench-side ${activePanelId === 'files' ? 'workbench-side-files' : ''}`}
        style={{ display: open ? 'flex' : 'none' }}>
        {children}
      </section>
    </>
  )
}

function FirstTaskWorkbenchStatus(): React.JSX.Element | null {
  const t = useT()
  const onboardingRecord = useFirstTaskOnboardingRecord()
  const activeId = useStore((s) => s.activeId)
  const candidateSession = useStore((s) =>
    onboardingRecord.candidateSessionId
      ? s.sessions[onboardingRecord.candidateSessionId]
      : undefined
  )
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const activeFirstTask = Boolean(
    activeId &&
    activeId === onboardingRecord.candidateSessionId &&
    !onboardingRecord.completedAt
  )

  if (!activeFirstTask) return null
  if (candidateSession?.meta.status === 'error') {
    return (
      <div className="first-task-recovery" role="alert" data-first-task-recovery>
        <div>
          <strong>{t('firstTaskFailedTitle')}</strong>
          <span>{t('firstTaskFailedDetail')}</span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!activeId) return
            restartFirstTaskOnboardingCandidate(activeId)
            setShowNewSession(true)
          }}
        >
          {t('firstTaskRestart')}
        </button>
      </div>
    )
  }

  const firstTaskStatus = deriveFirstTaskOnboardingStatus({
    record: onboardingRecord,
    providersHydrated: true,
    computeAvailable: true,
    activatingLocal: false,
    sessionStatus: candidateSession?.meta.status
  })
  const firstTaskProgress = deriveFirstTaskProgress(firstTaskStatus, onboardingRecord)

  return (
    <div className="first-task-workbench-progress" role="status" data-first-task-status={firstTaskStatus}>
      <strong>{t(firstTaskStatus === 'reviewing_result' ? 'firstTaskReviewing' : 'firstTaskRunning')}</strong>
      <div className="first-task-progress" aria-label={t('firstTaskProgressRun')}>
        <span className={firstTaskProgress.compute}>{t('firstTaskProgressCompute')}</span>
        <span className={firstTaskProgress.task}>{t('firstTaskProgressRun')}</span>
        <span className={firstTaskProgress.result}>{t('firstTaskProgressResult')}</span>
        <span className={firstTaskProgress.acceptance}>{t('firstTaskProgressAcceptance')}</span>
      </div>
    </div>
  )
}

export default memo(WorkbenchRoot)

interface DeskControlRailProps {
  sideOpen: boolean
  summaryOpen: boolean
  tools: DeskToolItem[]
  onToggleSummary: () => void
  onToggleSidePanel: () => void
}

function DeskControlRail({
  sideOpen,
  summaryOpen,
  tools,
  onToggleSummary,
  onToggleSidePanel
}: DeskControlRailProps): React.JSX.Element {
  const t = useT()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!drawerOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (drawerRef.current?.contains(event.target as Node)) return
      setDrawerOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [drawerOpen])

  useEffect(() => {
    if (!drawerOpen) return
    requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
  }, [drawerOpen])

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Escape') {
      setDrawerOpen(false)
      triggerRef.current?.focus()
      return
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    if (items.length === 0) return
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <aside className="desk-rail no-drag" aria-label={t('deskRailLabel')}>
      <button
        type="button"
        className={`desk-rail-button ${summaryOpen ? 'desk-rail-button-active' : ''}`}
        aria-label={t('toggleDeskSummary')}
        title={t('toggleDeskSummary')}
        onClick={onToggleSummary}
      >
        <HeaderIcon name="summary" />
      </button>

      <div className="desk-rail-drawer-anchor" ref={drawerRef}>
        <button
          ref={triggerRef}
          type="button"
          className={`desk-rail-button ${drawerOpen ? 'desk-rail-button-active' : ''}`}
          aria-label={t('openDeskTools')}
          aria-haspopup="menu"
          aria-expanded={drawerOpen}
          title={t('openDeskTools')}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <HeaderIcon name="tools" />
        </button>
        {drawerOpen && (
          <div className="desk-tool-drawer" role="menu" aria-label={t('deskToolDrawer')}
            onKeyDown={handleMenuKeyDown}>
            {tools.map((tool) => (
              <button
                key={tool.key}
                type="button"
                className={`desk-tool-item ${tool.active ? 'desk-tool-item-active' : ''}`}
                role="menuitem"
                onClick={() => {
                  triggerRef.current?.focus()
                  setDrawerOpen(false)
                  tool.onSelect()
                }}
              >
                <HeaderIcon name={tool.icon} />
                <span>{tool.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className={`desk-rail-button ${sideOpen ? 'desk-rail-button-active' : ''}`}
        aria-label={sideOpen ? t('hideDeskPanel') : t('showDeskPanel')}
        title={sideOpen ? t('hideDeskPanel') : t('showDeskPanel')}
        onClick={onToggleSidePanel}
      >
        <HeaderIcon name="panel" />
      </button>
    </aside>
  )
}
