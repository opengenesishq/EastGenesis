import { Suspense, lazy, useEffect } from 'react'
import { deriveTaskProjection } from './experience/task-projection'
import type { ExperienceMode } from '../store/experience-mode'
import { useStore } from '../store'
import Sidebar from './Sidebar'
import WelcomeView from './WelcomeView'
import WorkbenchRoot from './workbench/WorkbenchRoot'
import { ExperienceProjectionProvider } from './experience/ExperienceProjection'
import { useFirstTaskOnboardingLifecycle } from './experience/first-task-onboarding'
import StudioProjectionTabs, {
  STUDIO_PROJECTION_PANEL_IDS,
  STUDIO_PROJECTION_TAB_IDS,
  type StudioProjectionSurface
} from './experience/StudioProjectionTabs'
import { loadStudioView } from './studio/loadStudioView'
import { loadVideoStudioView } from './studio/loadVideoStudioView'
import { resolveSelectedBusinessLine } from '../../../shared/business-line-types'
import BusinessLineWorkbench from './business-lines/BusinessLineWorkbench'
import { WORK_OS_NAVIGATION_EVENT, requestStudioSectionNavigation, type WorkOsNavigationTarget } from './work-os-navigation'
import { requestTaskPlanNavigation } from './experience/task-plan-navigation'

const StudioView = lazy(loadStudioView)
const VideoStudioView = lazy(loadVideoStudioView)
const StudioResultPanel = lazy(() => import('./workbench/StudioResultPanel'))

interface AppListViewProps {
  activeId: string | null
  experienceMode: ExperienceMode
  hasActive: boolean
  language: 'zh' | 'en'
  showNewSession: boolean
  studioVisited: boolean
  videoVisited: boolean
  onExperienceModeChange: (mode: ExperienceMode) => void
}

interface SessionSurfaceProps {
  activeId: string | null
  experienceMode: ExperienceMode
  hasActive: boolean
  hidden: boolean
  showNewSession: boolean
}

function SessionSurface({
  activeId,
  experienceMode,
  hasActive,
  hidden,
  showNewSession
}: SessionSurfaceProps): React.JSX.Element {
  return (
    <section
      id={STUDIO_PROJECTION_PANEL_IDS.session}
      className="experience-surface experience-session"
      data-experience-projection={experienceMode}
      role={experienceMode === 'studio' ? 'tabpanel' : undefined}
      aria-labelledby={experienceMode === 'studio' ? STUDIO_PROJECTION_TAB_IDS.session : undefined}
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      {showNewSession || !hasActive ? <WelcomeView /> : <WorkbenchRoot key={activeId} />}
    </section>
  )
}

function WorkspaceSurface({ hidden }: { hidden: boolean }): React.JSX.Element {
  return (
    <section
      id={STUDIO_PROJECTION_PANEL_IDS.workspace}
      className="experience-surface experience-workspace"
      role="tabpanel"
      aria-labelledby={STUDIO_PROJECTION_TAB_IDS.workspace}
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      <Suspense fallback={<div className="studio-loading">加载工作台...</div>}>
        <StudioView active={!hidden} />
      </Suspense>
    </section>
  )
}

interface ResultSurfaceProps {
  activeId: string | null
  hidden: boolean
  onOpenSession: () => void
}

function ResultSurface({ activeId, hidden, onOpenSession }: ResultSurfaceProps): React.JSX.Element {
  return (
    <section
      id={STUDIO_PROJECTION_PANEL_IDS.result}
      className="experience-surface experience-result"
      role="tabpanel"
      aria-labelledby={STUDIO_PROJECTION_TAB_IDS.result}
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      {!hidden && (
        <Suspense fallback={<div className="studio-loading">加载交付结果...</div>}>
          <StudioResultPanel sessionId={activeId} standalone onOpenSessionSurface={onOpenSession} />
        </Suspense>
      )}
    </section>
  )
}

function VideoSurface({ hidden }: { hidden: boolean }): React.JSX.Element {
  return (
    <section
      className="experience-surface experience-video"
      hidden={hidden}
      aria-hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
    >
      <Suspense fallback={<div className="studio-loading">加载视频工作室...</div>}>
        <VideoStudioView active={!hidden} />
      </Suspense>
    </section>
  )
}

function useStudioSurface(
  workspaceNonce: number,
  sessionNonce: number,
  hasResult: boolean,
  hasSession: boolean
): [StudioProjectionSurface, (surface: StudioProjectionSurface) => void] {
  const surface = useStore((state) => state.studioSurface)
  const setSurface = useStore((state) => state.setStudioSurface)
  useEffect(() => {
    if (workspaceNonce > 0) setSurface('workspace')
  }, [workspaceNonce])
  useEffect(() => {
    if (sessionNonce > 0) setSurface('session')
  }, [sessionNonce])
  useEffect(() => {
    if (!hasResult && surface === 'result') setSurface(hasSession ? 'session' : 'workspace')
    if (!hasSession && surface === 'session') setSurface('workspace')
  }, [hasResult, hasSession, surface])
  return [surface, setSurface]
}

export default function AppListView({
  activeId,
  experienceMode,
  hasActive,
  language,
  onExperienceModeChange,
  showNewSession,
  studioVisited,
  videoVisited
}: AppListViewProps): React.JSX.Element {
  useFirstTaskOnboardingLifecycle()
  const studioNavigationNonce = useStore((state) => state.studioNavigationNonce)
  const studioSessionNavigationNonce = useStore((state) => state.studioSessionNavigationNonce)
  const newSessionProjectId = useStore((state) => state.newSessionProjectId)
  const welcomeProjectChoice = useStore((state) => state.welcomeDraft.projectChoice)
  const activeSession = useStore((state) => activeId ? state.sessions[activeId]?.meta : undefined)
  const settings = useStore((state) => state.settings)
  const selectedLine = resolveSelectedBusinessLine(settings)
  const projection = deriveTaskProjection({
    activeSession, hasActive, newSessionProjectId, showNewSession, welcomeProjectChoice
  })
  const [studioSurface, setStudioSurface] = useStudioSurface(
    studioNavigationNonce,
    studioSessionNavigationNonce,
    projection.hasProjectTask,
    projection.hasProjectSession
  )
  useEffect(() => {
    const onWorkOsNavigation = (event: Event): void => {
      const target = (event as CustomEvent<WorkOsNavigationTarget>).detail
      if (!target || target === 'settings') return
      setStudioSurface(target === 'runs' || target === 'review' || target === 'inbox' || target === 'projects' || target === 'library' ? 'workspace' : studioSurface)
      if (target === 'runs' || target === 'review') requestStudioSectionNavigation(target)
    }
    window.addEventListener(WORK_OS_NAVIGATION_EVENT, onWorkOsNavigation)
    return () => window.removeEventListener(WORK_OS_NAVIGATION_EVENT, onWorkOsNavigation)
  }, [setStudioSurface, studioSurface])
  const sessionProjection = experienceMode === 'studio' && studioSurface === 'session' ? 'studio' : 'assistant'
  const sessionHidden = experienceMode === 'video' || (experienceMode === 'studio' && studioSurface !== 'session')
  const workspaceHidden = experienceMode !== 'studio' || studioSurface !== 'workspace'
  const resultHidden = experienceMode !== 'studio' || studioSurface !== 'result'
  const videoHidden = experienceMode !== 'video'
  if (selectedLine.origin === 'custom') return <>
    <Sidebar experienceMode="assistant" language={language} onExperienceModeChange={onExperienceModeChange} />
    <main className="main"><BusinessLineWorkbench key={selectedLine.id} line={selectedLine} /></main>
  </>
  return (
    <>
      <Sidebar
        experienceMode={experienceMode}
        language={language}
        onExperienceModeChange={onExperienceModeChange}
      />
      <ExperienceProjectionProvider mode={sessionProjection}>
        <main className="main">
          {studioVisited && (
            <StudioProjectionTabs
              hasResult={projection.hasProjectTask}
              hasSession={projection.hasProjectSession}
              hidden={experienceMode !== 'studio'}
              language={language}
              surface={studioSurface}
              onChange={setStudioSurface}
            />
          )}
          <TaskWorkspaceNavigation mode={experienceMode} surface={studioSurface} language={language} onChange={setStudioSurface} />
          <div
            className="experience-pane"
            data-experience-mode={experienceMode}
            data-studio-surface={experienceMode === 'studio' ? studioSurface : undefined}
          >
            <SessionSurface
              activeId={activeId}
              experienceMode={experienceMode}
              hasActive={experienceMode === 'studio' ? projection.hasProjectTask : projection.hasAssistantSession}
              hidden={sessionHidden}
              showNewSession={showNewSession}
            />
            {studioVisited && <WorkspaceSurface hidden={workspaceHidden} />}
            {studioVisited && (
              <ResultSurface
                activeId={activeId}
                hidden={resultHidden}
                onOpenSession={() => setStudioSurface('session')}
              />
            )}
            {videoVisited && <VideoSurface hidden={videoHidden} />}
          </div>
        </main>
      </ExperienceProjectionProvider>
    </>
  )
}

function TaskWorkspaceNavigation({ mode, surface, language, onChange }: {
  mode: ExperienceMode; surface: StudioProjectionSurface; language: 'zh' | 'en'; onChange(surface: StudioProjectionSurface): void
}): React.JSX.Element | null {
  const activeId = useStore((state) => state.activeId)
  const session = useStore((state) => activeId ? state.sessions[activeId] : undefined)
  const openPanel = useStore((state) => state.openPanel)
  const setView = useStore((state) => state.setView)
  if (mode !== 'studio' || surface === 'workspace') return null
  const zh = language === 'zh'
  return <nav className="task-workspace-navigation" aria-label={zh ? '当前任务工作区' : 'Current task workspace'} data-task-workspace-session={activeId ?? ''}>
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange('workspace')}>{language === 'zh' ? '返回项目' : 'Back to projects'}</button>
    {session && <>
      <span className="task-workspace-current-title" title={session.meta.title}>{session.meta.title}</span>
      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={surface === 'session'} onClick={() => onChange('session')}>{zh ? '对话' : 'Conversation'}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onChange('session'); openPanel('files') }}>{zh ? '文件' : 'Files'}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onChange('session'); openPanel('diff') }}>{zh ? '代码与变更' : 'Code and changes'}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
        onChange('session')
        requestTaskPlanNavigation(session.meta.id)
      }}>{zh ? '计划与审批' : 'Plan and approvals'}{session.pendingPermissions.length ? ` (${session.pendingPermissions.length})` : ''}</button>
      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={surface === 'result'} onClick={() => onChange('result')}>{zh ? '进度与成果' : 'Progress and results'}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setView('office')}>{zh ? '去故宫' : 'Palace'}</button>
    </>}
  </nav>
}
