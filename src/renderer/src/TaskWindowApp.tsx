import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Pin, PinOff } from 'lucide-react'
import { useStore } from './store'
import { useThemeEffect } from './theme'
import WorkbenchRoot from './components/workbench/WorkbenchRoot'
import WelcomeView from './components/WelcomeView'
import CommandPalette from './components/CommandPalette'
import { ExperienceProjectionProvider } from './components/experience/ExperienceProjection'
import type { TaskWindowState } from '../../shared/task-window-types'
import './task-window.css'
import { requestConversationFind } from './components/conversation-find'
import type { MenuCommand } from '../../shared/types'
import { desktopMenuCommand } from './desktop-keyboard'

const SettingsPage = lazy(() => import('./components/SettingsModal'))

/** A second view of the same Session, with its own navigation and unsent draft. */
export default function TaskWindowApp({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [windowState, setWindowState] = useState<TaskWindowState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const zh = useStore((state) => state.settings.language === 'zh')
  const session = useStore((state) => state.sessions[sessionId])
  const showNewSession = useStore((state) => state.showNewSession)
  const showSettings = useStore((state) => state.showSettings)
  const showCommandPalette = useStore((state) => state.showCommandPalette)
  useThemeEffect()

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.agentDesk.onTaskWindowState(setWindowState)
    void (async () => {
      const context = await window.agentDesk.getTaskWindowState()
      if (context.sessionId !== sessionId) throw new Error('任务窗口身份不匹配。')
      if (cancelled) return
      setWindowState(context)
      useStore.setState({ activeId: sessionId, view: 'list', showNewSession: false })
      await useStore.getState().init()
      if (cancelled) return
      useStore.getState().selectSession(sessionId)
      setLoading(false)
    })().catch((cause) => { if (!cancelled) { setError(errorText(cause)); setLoading(false) } })
    // A child task or a fork opens another window; this window retains its task.
    const stopNavigation = useStore.subscribe((state) => {
      if (!state.hydrated || state.activeId === sessionId) return
      const nextId = state.activeId
      useStore.setState({ activeId: sessionId, showNewSession: false })
      if (state.sessions[sessionId] && state.sessions[sessionId].meta.status !== 'closed' && nextId && state.sessions[nextId]) {
        void window.agentDesk.openTaskWindow(nextId).catch((cause) => setError(errorText(cause)))
      }
    })
    return () => { cancelled = true; unsubscribe(); stopNavigation() }
  }, [sessionId])

  const handleMenuCommand = useCallback((command: MenuCommand): void => {
    const state = useStore.getState()
    if (command.type === 'settings') { state.setShowSettings(true); return }
    if (command.type === 'new-session') { state.setShowSettings(false); state.setShowNewSession(true); return }
    if (command.type === 'command-palette') { state.setShowCommandPalette(true); return }
    if (command.type === 'open-search' && requestConversationFind()) return
    if (command.type === 'select-session') {
      const id = state.order[command.index]
      if (id && id !== sessionId) void window.agentDesk.openTaskWindow(id).catch((cause) => setError(errorText(cause)))
      return
    }
    void window.agentDesk.showTaskInMainWindow(sessionId).catch((cause) => setError(errorText(cause)))
  }, [sessionId])
  useEffect(() => window.agentDesk.onMenuCommand(handleMenuCommand), [handleMenuCommand])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const command = desktopMenuCommand(event, useStore.getState().settings.desktopShortcuts)
      if (!command) return
      event.preventDefault()
      if (command === 'searchTasks') { void window.agentDesk.showTaskInMainWindow(sessionId).catch((cause) => setError(errorText(cause))); return }
      handleMenuCommand(command)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleMenuCommand, sessionId])

  const pin = async (): Promise<void> => {
    try { setWindowState(await window.agentDesk.setTaskWindowAlwaysOnTop(!windowState?.alwaysOnTop)); setError('') }
    catch (cause) { setError(errorText(cause)) }
  }
  const openMain = async (): Promise<void> => {
    try { await window.agentDesk.showTaskInMainWindow(sessionId); setError('') }
    catch (cause) { setError(errorText(cause)) }
  }
  const available = windowState?.available && session && session.meta.status !== 'closed'
  return <div className="app task-window-app" data-task-window-session={sessionId}>
    <header className="task-window-toolbar drag-region">
      <span>{zh ? '独立任务窗口' : 'Task window'}</span>
      <div className="no-drag">
        <button className="btn btn-ghost btn-sm" type="button" data-task-window-main onClick={() => void openMain()} disabled={!available}>
          <ArrowLeft size={14} />{zh ? '在主窗口查看' : 'Show in main window'}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" data-task-window-pin aria-pressed={windowState?.alwaysOnTop ?? false} onClick={() => void pin()} disabled={!windowState}>
          {windowState?.alwaysOnTop ? <PinOff size={14} /> : <Pin size={14} />}
          {windowState?.alwaysOnTop ? (zh ? '取消置顶' : 'Unpin window') : (zh ? '窗口置顶' : 'Keep on top')}
        </button>
      </div>
    </header>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {loading ? <div className="task-window-empty">{zh ? '正在打开原任务…' : 'Opening task…'}</div>
      : !available ? <div className="task-window-empty">{zh ? '任务已关闭或移除，请从主窗口历史记录中打开。' : 'This task is closed or removed. Open it from history in the main window.'}</div>
        : showSettings ? <Suspense fallback={<div className="task-window-empty">{zh ? '加载设置…' : 'Loading settings…'}</div>}><SettingsPage /></Suspense>
          : <ExperienceProjectionProvider mode="assistant">
          <main className="main task-window-main">
            {showNewSession ? <><button type="button" className="btn btn-ghost" onClick={() => useStore.setState({ showNewSession: false })}>{zh ? '返回原任务' : 'Back to task'}</button><WelcomeView /></> : <WorkbenchRoot />}
          </main>
        </ExperienceProjectionProvider>}
    {showCommandPalette && <CommandPalette />}
  </div>
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
