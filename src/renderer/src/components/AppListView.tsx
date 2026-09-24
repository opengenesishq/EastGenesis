import { Suspense, lazy, useEffect } from 'react'
import type { ExperienceMode } from '../store/experience-mode'
import { useStore } from '../store'
import { useActivityStore } from '../store/activity-store'
import { useRemoteTaskNavigation } from '../store/remote-task-navigation'
import Sidebar from './Sidebar'
import WelcomeView from './WelcomeView'
import WorkbenchRoot from './workbench/WorkbenchRoot'
import { ExperienceProjectionProvider } from './experience/ExperienceProjection'
import { useFirstTaskOnboardingLifecycle } from './experience/first-task-onboarding'
import './codex-desktop-shell.css'

// The desktop shell has one user-facing workspace: a conversation and its result.
// Legacy project/video records remain readable in the store, but they no longer
// select a second product surface or add another navigation model.
const ActivityCenter = lazy(() => import('./studio/ActivityCenter'))
const RemoteTaskWorkspacePage = lazy(() => import('../pages/RemoteTaskWorkspacePage'))

interface AppListViewProps {
  activeId: string | null
  experienceMode: ExperienceMode
  hasActive: boolean
  language: 'zh' | 'en'
  showNewSession: boolean
  studioVisited?: boolean
  videoVisited?: boolean
  onExperienceModeChange: (mode: ExperienceMode) => void
}

function ConversationSurface({
  activeId,
  hasActive,
  hidden,
  showNewSession
}: {
  activeId: string | null
  hasActive: boolean
  hidden: boolean
  showNewSession: boolean
}): React.JSX.Element {
  return (
    <section
      className="experience-surface experience-session"
      data-experience-projection="assistant"
      data-simple-workspace
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      <WorkbenchRoot key={activeId} active={!hidden}>
        {showNewSession || !hasActive ? <WelcomeView /> : undefined}
      </WorkbenchRoot>
    </section>
  )
}

export default function AppListView({
  activeId,
  hasActive,
  language,
  showNewSession,
  onExperienceModeChange
}: AppListViewProps): React.JSX.Element {
  useFirstTaskOnboardingLifecycle()
  const activityVisible = useActivityStore(state => state.visible)
  const remoteTask = useRemoteTaskNavigation(state => state.target)

  useEffect(() => {
    // Keep the shell deterministic when a legacy task or external notification
    // re-enters the app. The next action always lands in the single composer.
    useRemoteTaskNavigation.getState().close()
  }, [activeId, showNewSession])

  return (
    <div className="caogen-desktop-shell" data-product-surface="conversation">
      <Sidebar
        experienceMode="assistant"
        language={language}
        onExperienceModeChange={onExperienceModeChange}
      />
      <ExperienceProjectionProvider mode="assistant">
        <main className="main">
          <DesktopViewNavigation language={language} />
          <div className="experience-pane" data-experience-mode="assistant">
            {remoteTask && (
              <section className="experience-surface experience-remote-task">
                <Suspense fallback={<div className="studio-loading">正在打开任务…</div>}>
                  <RemoteTaskWorkspacePage key={`${remoteTask.hostId}:${remoteTask.sourceCommandId}`} target={remoteTask} />
                </Suspense>
              </section>
            )}
            {activityVisible && (
              <section className="experience-surface experience-activity">
                <Suspense fallback={<div className="studio-loading">正在加载活动…</div>}>
                  <ActivityCenter active />
                </Suspense>
              </section>
            )}
            {!remoteTask && !activityVisible && (
              <ConversationSurface
                activeId={activeId}
                hasActive={hasActive}
                hidden={false}
                showNewSession={showNewSession}
              />
            )}
          </div>
        </main>
      </ExperienceProjectionProvider>
    </div>
  )
}

function DesktopViewNavigation({ language }: { language: 'zh' | 'en' }): React.JSX.Element {
  const setView = useStore(state => state.setView)
  return (
    <header className="desktop-view-header drag-region">
      <nav className="desktop-view-switcher no-drag" aria-label={language === 'zh' ? '工作台' : 'Workspace'}>
        <button type="button" aria-current="page" className="is-active" onClick={() => setView('list')}>
          {language === 'zh' ? '工作台' : 'Workspace'}
        </button>
      </nav>
      <div id="workbench-layout-controls-slot" className="desktop-layout-controls-slot no-drag" />
    </header>
  )
}
