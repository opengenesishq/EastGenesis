import { createElement, memo, Suspense, useEffect, useState } from 'react'
import type * as React from 'react'
import { createPortal } from 'react-dom'
import { Globe2, PanelBottom, PanelRight, PanelRightClose, SquareTerminal } from 'lucide-react'
import ChatView from '../ChatView'
import RoutineEditor from '../RoutineEditor'
import { HeaderIcon } from '../ChatHeaderIcons'
import { PANEL_REGISTRY, type PanelId } from './panels'
import './modern-workbench.css'
import WorkspaceBrowserPanel from './WorkspaceBrowserPanel'
import { useStore } from '../../store'
import { isShortcutCapture, matchesDesktopShortcut } from '../../desktop-keyboard'
import { useT } from '../../i18n'
import type { LayoutSettings, PluginRegistryItem, Routine, SessionMeta } from '../../../../shared/types'
import {
  deriveFirstTaskOnboardingStatus,
  deriveFirstTaskProgress,
  restartFirstTaskOnboardingCandidate,
  useFirstTaskOnboardingRecord
} from '../experience/first-task-onboarding'

type RoutineEditorState = { mode: 'create'; sessionId?: string } | { mode: 'edit'; id: string }

const SIDE_MIN_WIDTH = 320
const SIDE_MAX_WIDTH = 720
const DOCK_MIN_HEIGHT = 220
const DOCK_MAX_HEIGHT = 520

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

const workspacePanels = new Set<PanelId>(['routine', 'pluginRegistry'])

function WorkbenchRoot({ active = true, children }: { active?: boolean; children?: React.ReactNode }): React.JSX.Element {
  const t = useT()
  const [routineEditor, setRoutineEditor] = useState<RoutineEditorState | null>(null)
  const [sideLauncherOpen, setSideLauncherOpen] = useState(false)
  const [layoutControlsSlot, setLayoutControlsSlot] = useState<HTMLElement | null>(null)
  useEffect(() => { setLayoutControlsSlot(document.getElementById('workbench-layout-controls-slot')) }, [])
  const zh = useStore((s) => s.settings.language === 'zh')
  const activeId = useStore((s) => s.activeId)
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const activePanelId = useStore((s) => s.workbench.activePanelId)
  const mountedPanels = useStore((s) => s.workbench.mountedPanels)
  const terminalDockOpen = useStore((s) => s.workbench.terminalDockOpen)
  const layout = useStore((s) => s.settings.layout)
  const updateSettings = useStore((s) => s.updateSettings)
  const openPanel = useStore((s) => s.openPanel)
  const closePanel = useStore((s) => s.closePanel)
  const openTerminalPanel = useStore((s) => s.openTerminalPanel)
  const closeTerminalPanel = useStore((s) => s.closeTerminalPanel)
  const welcome = Boolean(children)
  useEffect(() => {
    const openForSession = (event: Event): void => {
      if (!active || welcome) return
      const id = (event as CustomEvent<unknown>).detail
      if (typeof id !== 'string') return
      const meta = useStore.getState().sessions[id]?.meta
      if (!meta || meta.status === 'closed') return
      setRoutineEditor({ mode: 'create', sessionId: id })
    }
    window.addEventListener('caogen:routine-for-session', openForSession)
    return () => window.removeEventListener('caogen:routine-for-session', openForSession)
  }, [active, welcome])
  useEffect(() => {
    if (!welcome) return
    const panel = useStore.getState().workbench.activePanelId
    // A new task starts from a clean canvas. Persisted panels (especially
    // routines/plugins from the previous task) belong to the old context and
    // must not occupy the first screen. They remain available from the panel
    // launcher after the user explicitly opens them.
    if (panel) useStore.getState().closePanel()
    setSideLauncherOpen(false)
  }, [welcome])
  const selectWorkPanel = (id: PanelId): void => {
    if (!welcome || workspacePanels.has(id)) { openPanel(id); return }
    // New-task panels must not operate on whichever task was selected previously.
    useStore.setState((state) => ({ workbench: { ...state.workbench, activePanelId: id } }))
  }
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
  const memoryInitialScope = useStore((s) => s.workbench.memoryInitialScope)
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
    setSideLauncherOpen(false)
    if (activePanelId && activePanelId !== 'terminal') closePanel()
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
  const terminalOpen = terminalDockOpen || activePanelId === 'terminal'
  const sideOpen = sideLauncherOpen || (activePanelId !== null && activePanelId !== 'terminal')
  const toggleTerminal = (): void => {
    if (terminalOpen) closeTerminalPanel()
    else {
      useStore.setState((state) => ({ workbench: { ...state.workbench, terminalScope: children ? 'workspace' : 'task' } }))
      void openTerminalPanel()
    }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isShortcutCapture(event.target) || !matchesDesktopShortcut(event, 'toggleTerminal', useStore.getState().settings.desktopShortcuts) || !active) return
      event.preventDefault()
      const state = useStore.getState()
      if (state.workbench.terminalDockOpen || state.workbench.activePanelId === 'terminal') state.closeTerminalPanel()
      else {
        useStore.setState((current) => ({ workbench: { ...current.workbench, terminalScope: children ? 'workspace' : 'task' } }))
        void state.openTerminalPanel()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [active, children])

  const renderPanelContent = (id: PanelId): Record<string, unknown> => {
    switch (id) {
      case 'terminal':
        return { workspaceMode: Boolean(children), active }
      case 'browser':
        return { active: active && !welcome && activePanelId === 'browser' }
      case 'execution':
        return { sessionId: activeId, active: active && !welcome && activePanelId === 'execution' }
      case 'sources':
        return { sessionId: activeId, active: active && !welcome && activePanelId === 'sources' }
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
      case 'sidechat':
        return { sourceSessionId: activeId, active: active && !welcome && activePanelId === 'sidechat' }
      case 'routine':
        return {
          routines,
          runs: routineRuns,
          loading: routineLoading,
          error: routineError,
          message: routineMessage,
          selectedRoutineId,
          onAddRoutine: () => setRoutineEditor({ mode: 'create' }),
          onRefresh: refreshRoutinePanel,
          onClose: closeRoutinePanel,
          onSelectRoutine: (routine: Routine) => selectRoutine(routine.id),
          onSelectAllRoutines: () => selectRoutine(null),
          onOpenSession: selectSession,
          onEditRoutine: (routine: Routine) => setRoutineEditor({ mode: 'edit', id: routine.id }),
          onDeleteRoutine: (routine: Routine) => {
            if (window.confirm(`删除 Routine「${routine.name}」?`)) void deleteRoutine(routine.id)
          },
          onToggleRoutine: (routine: Routine, enabled: boolean) => void toggleRoutine(routine.id, enabled),
          onRunRoutine: (routine: Routine) => void markRoutineRun(routine.id)
        }
      case 'memory':
        return activeId
          ? { sessionId: activeId, initialForm: memoryInitialForm, initialScope: memoryInitialScope, onClose: closeMemoryPanel }
          : {}
      default:
        return {}
    }
  }

  const layoutControls = active ? <div className="workbench-layout-controls no-drag">
    <button type="button" className={`icon-btn${terminalOpen ? ' icon-btn-active' : ''}`} aria-label={zh ? '切换底部面板' : 'Toggle bottom panel'} title={zh ? '切换底部面板 · ⌘J / Ctrl+J' : 'Toggle bottom panel · ⌘J / Ctrl+J'} aria-pressed={Boolean(terminalOpen)} onClick={toggleTerminal}><PanelBottom size={17} /></button>
    <button type="button" className={`icon-btn${sideOpen ? ' icon-btn-active' : ''}`} aria-label={zh ? '切换右侧面板' : 'Toggle side panel'} title={zh ? '切换右侧面板' : 'Toggle side panel'} aria-pressed={sideOpen} onClick={() => sideOpen ? collapseSidePanel() : setSideLauncherOpen(true)}><PanelRight size={17} /></button>
  </div> : null
  return (
    <div
      className={`workbench modern-workbench ${sideOpen ? 'workbench-split' : ''} ${terminalOpen ? 'workbench-dock-open' : ''}`}
      style={workbenchDimensions(sideWidth, dockHeight)}
      data-workbench-welcome={children ? "true" : undefined}
      data-layout-hosted={layoutControlsSlot ? 'true' : undefined}
    >
      {layoutControlsSlot ? createPortal(layoutControls, layoutControlsSlot) : layoutControls}
      <div className="workbench-main-row">
      <section className="workbench-pane workbench-primary">
        <section className="workbench-chat">
          {children ?? <><FirstTaskWorkbenchStatus /><ChatView /></>}
        </section>
      </section>
      <WorkbenchSidePanel
        activePanelId={activePanelId}
        open={sideOpen}
        sideWidth={sideWidth}
        onCollapse={collapseSidePanel}
        onSelect={selectWorkPanel}
        onPointerDown={(event) => startWorkbenchSideResize(event, sideWidth, setSideWidth, patchLayout)}
        onResize={(value) => { setSideWidth(value); patchLayout({ workbenchSideWidth: value }) }}
      >
        {(activePanelId === null || activePanelId === 'terminal') && <div className="workbench-panel-launcher">
          <button type="button" onClick={() => selectWorkPanel('browser')}><Globe2 size={17} /><span>{zh ? '浏览器' : 'Browser'}</span></button>
          <button type="button" onClick={toggleTerminal}><SquareTerminal size={17} /><span>{zh ? '终端' : 'Terminal'}</span></button>
        </div>}
        <div className="workbench-panel" style={{ display: welcome && activePanelId === 'browser' ? 'flex' : 'none' }}>
          <WorkspaceBrowserPanel active={active && welcome && activePanelId === 'browser'} />
        </div>
        {welcome && activePanelId && activePanelId !== 'terminal' && activePanelId !== 'browser' && !workspacePanels.has(activePanelId) && <WelcomePanelEmpty panelId={activePanelId} zh={zh} />}
        <Suspense fallback={<div className="workbench-panel-loading" />}>
          {PANEL_REGISTRY.filter((def) => def.id !== 'terminal').map((def) => {
            const isActive = (!welcome || workspacePanels.has(def.id)) && activePanelId === def.id
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
      </div>
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
              const isActive = terminalOpen
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

      {routineEditor && (routineEditor.mode === 'create' || selectedRoutine) && (
        <RoutineEditor
          routine={routineEditor.mode === 'edit' ? selectedRoutine : null}
          initialSessionId={routineEditor.mode === 'create' ? routineEditor.sessionId : undefined}
          onClose={closeRoutineEditor}
        />
      )}
    </div>
  )
}

function WelcomePanelEmpty({ panelId, zh }: { panelId: PanelId; zh: boolean }): React.JSX.Element {
  const copy: Record<string, { title: string; detail: string; icon: 'files' | 'review' | 'summary' }> = {
    execution: {
      title: zh ? '执行' : 'Run',
      detail: zh ? '提交一项任务后，这里会显示计划、当前步骤和需要你处理的权限。' : 'Submit a task to see its plan, current step, and approvals here.',
      icon: 'summary'
    },
    result: {
      title: zh ? '结果' : 'Result',
      detail: zh ? '完成一项任务后，这里会集中显示产物、验证记录和交付入口。' : 'Finish a task to see its artifacts, verification, and delivery actions here.',
      icon: 'summary'
    },
    sources: {
      title: zh ? '资料' : 'Sources',
      detail: zh ? '提交任务并添加资料后，这里会显示本次任务使用的来源。' : 'Submit a task and add sources to see the context used for it here.',
      icon: 'files'
    },
    files: {
      title: zh ? '文件' : 'Files',
      detail: zh ? '开始任务后，在这里打开当前任务的文件。' : 'Start a task to open its files here.',
      icon: 'files'
    },
    diff: {
      title: zh ? '差异' : 'Diff',
      detail: zh ? '开始任务后，在这里查看当前任务的修改。' : 'Start a task to review its changes here.',
      icon: 'review'
    },
    preview: {
      title: zh ? '预览' : 'Preview',
      detail: zh ? '任务产生可预览产物后，这里会显示预览。' : 'A preview appears here when the task produces a previewable artifact.',
      icon: 'files'
    },
    worktree: {
      title: zh ? '工作树' : 'Worktree',
      detail: zh ? '选择项目并开始任务后，这里会显示工作树状态。' : 'Choose a project and start a task to see its worktree state here.',
      icon: 'review'
    }
  }
  const value = copy[panelId] ?? copy.files
  return <div className="workbench-panel-empty">
    <HeaderIcon name={value.icon} />
    <strong>{value.title}</strong>
    <p>{value.detail}</p>
  </div>
}

function WorkbenchSidePanel({
  activePanelId,
  open,
  sideWidth,
  onCollapse,
  onSelect,
  onPointerDown,
  onResize,
  children
}: {
  activePanelId: PanelId | null
  open: boolean
  sideWidth: number
  onCollapse: () => void
  onSelect: (id: PanelId) => void
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
        {activePanelId && activePanelId !== 'terminal' && <WorkbenchPanelTabs activePanelId={activePanelId} onSelect={onSelect} onClose={onCollapse} />}
        <div className="workbench-side-content">{children}</div>
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

function WorkbenchPanelTabs({ activePanelId, onSelect, onClose }: {
  activePanelId: PanelId | null
  onSelect: (id: PanelId) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const zh = useStore((state) => state.settings.language === 'zh')
  const tabs: Array<{ id: PanelId; label: string; icon: 'files' | 'review' | 'browser' | 'summary' }> = [
    { id: 'execution', label: zh ? '执行' : 'Run', icon: 'summary' },
    { id: 'result', label: zh ? '结果' : 'Result', icon: 'summary' },
    { id: 'sources', label: zh ? '资料' : 'Sources', icon: 'files' },
    { id: 'files', label: zh ? '文件' : 'Files', icon: 'files' },
    { id: 'diff', label: zh ? '差异' : 'Diff', icon: 'review' },
    { id: 'browser', label: zh ? '浏览器' : 'Browser', icon: 'browser' }
  ]
  const activeTab = activePanelId === 'preview' ? 'files' : activePanelId === 'worktree' ? 'diff' : activePanelId
  const current = PANEL_REGISTRY.find((panel) => panel.id === activePanelId)
  return <header className="workbench-panel-tabs no-drag">
    <div role="tablist" aria-label={zh ? '工作面板' : 'Workspace panels'}>
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab"
        id={`workbench-tab-${tab.id}`} aria-selected={activeTab === tab.id}
        tabIndex={activeTab === tab.id || (!tabs.some((item) => item.id === activeTab) && index === 0) ? 0 : -1}
        onClick={() => onSelect(tab.id)} onKeyDown={(event) => {
          const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
          if (nextIndex < 0) return
          event.preventDefault(); onSelect(tabs[nextIndex].id)
          requestAnimationFrame(() => document.getElementById(`workbench-tab-${tabs[nextIndex].id}`)?.focus())
        }}><HeaderIcon name={tab.icon} /><span>{tab.label}</span></button>)}
    </div>
    {current && !tabs.some((tab) => tab.id === activeTab) && <span className="workbench-current-panel">{t(current.titleKey)}</span>}
    <button type="button" className="icon-btn workbench-panel-close" aria-label={t('collapseToolPanel')} title={t('collapseToolPanel')} onClick={onClose}>
      <PanelRightClose size={15} aria-hidden="true" />
    </button>
  </header>
}
