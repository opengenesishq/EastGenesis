import { desktopMenuCommand } from './desktop-keyboard'
import * as React from 'react'
import { Suspense, lazy, useCallback, useEffect } from 'react'
import { useStore } from './store'
import { useThemeEffect } from './theme'
import type { MenuCommand } from '../../shared/types'
import CommandPalette from './components/CommandPalette'
import TaskRecoveryModal from './components/TaskRecoveryModal'
import AppListView from './components/AppListView'
import { requestConversationFind } from './components/conversation-find'
import { APP_ICON_URL, APP_NAME } from './brand'
import type { ExperienceMode } from './store/experience-mode'
import { appendPersistentComposerDraft } from './store/composer-draft-persistence'
import splashDarkUrl from '../../../resources/eastgenesis/splash-dark.png?url'
import splashLightUrl from '../../../resources/eastgenesis/splash-light.png?url'

const SettingsPage = lazy(() => import('./components/SettingsModal'))

function startPrimaryCreation(onNewSession: () => void): void {
  onNewSession()
}

function sessionOrderForMode(
  order: string[],
  sessions: ReturnType<typeof useStore.getState>['sessions']
): string[] {
  return order.filter((id) => Boolean(sessions[id]))
}

export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const activeId = useStore((s) => s.activeId)
  const hydrated = useStore((s) => s.hydrated)
  const hasActive = useStore((s) => (activeId ? Boolean(s.sessions[activeId]) : false))
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const view = useStore((s) => s.view)
  const language = useStore((s) => s.settings.language)
  const showNewSession = useStore((s) => s.showNewSession)
  const showSettings = useStore((s) => s.showSettings)
  const showCommandPalette = useStore((s) => s.showCommandPalette)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowCommandPalette = useStore((s) => s.setShowCommandPalette)
  const selectSession = useStore((s) => s.selectSession)
  const setView = useStore((s) => s.setView)
  useThemeEffect()
  const focusSidebarSearch = useCallback((): void => {
    setView('list')
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.sidebar-search')
      if (!input) return
      input.focus()
      input.select()
    })
  }, [setView])
  const handleMenuCommand = useCallback(
    (command: MenuCommand): void => {
      if (command.type === 'new-session') {
        setShowSettings(false)
        startPrimaryCreation(() => setShowNewSession(true))
        return
      }
      if (command.type === 'settings') {
        setShowNewSession(false)
        setShowCommandPalette(false)
        setShowSettings(true)
        return
      }
      if (command.type === 'command-palette') {
        setShowCommandPalette(true)
        return
      }
      if (command.type === 'open-search') {
        if (requestConversationFind()) return
        setShowSettings(false)
        focusSidebarSearch()
        return
      }
      const id = sessionOrderForMode(order, sessions)[command.index]
      if (id) {
        setShowSettings(false)
        selectSession(id)
      }
    },
    [focusSidebarSearch, order, selectSession, sessions, setShowCommandPalette, setShowNewSession, setShowSettings]
  )
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    void init()
  }, [init])
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    return window.agentDesk.onMenuCommand(handleMenuCommand)
  }, [handleMenuCommand])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const command = desktopMenuCommand(e, useStore.getState().settings.desktopShortcuts)
      if (!command) return
      e.preventDefault()
      if (command === 'searchTasks') { setShowSettings(false); focusSidebarSearch() }
      else handleMenuCommand(command)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleMenuCommand])

  if (typeof window.agentDesk === 'undefined') {
    return (
      <div className="app-fallback">
        <img className="app-fallback-logo" src={APP_ICON_URL} alt="" />
        <h1>{APP_NAME}</h1>
        <p>请通过 Electron 启动本应用(npm run dev)。</p>
      </div>
    )
  }

  if (!hydrated) {
    return (
      <div className="eastgenesis-splash" role="status" aria-label={`${APP_NAME} 正在启动`}>
        <picture>
          <source media="(prefers-color-scheme: light)" srcSet={splashLightUrl} />
          <img src={splashDarkUrl} alt={`${APP_NAME} Desktop`} />
        </picture>
      </div>
    )
  }

  return (
    <div className="app">
      {showSettings ? (
        <Suspense fallback={<div className="office-loading">加载设置…</div>}>
          <SettingsPage />
        </Suspense>
      ) : (
        <AppListView
          activeId={activeId} experienceMode="assistant"
          hasActive={hasActive} language={language}
          showNewSession={showNewSession}
          onExperienceModeChange={() => undefined}
        />
      )}
      {showCommandPalette && <CommandPalette />}
      {!showSettings && <TaskRecoveryModal />}
    </div>
  )
}
