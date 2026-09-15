import { lazy, Suspense, memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { Goal, ProjectSquad, ProjectWorkspace, WorkItem, WorkItemComment } from '../../../../shared/types'
const DigitalWorkerStudio = lazy(() => import('./DigitalWorkerStudio'))
import ProjectWorkspaceStudio, { type ProjectWorkspaceStudioContext } from './ProjectWorkspaceStudio'
import { TEXT } from './projectWorkspaceStudioModel'
import { useStore } from '../../store'
import './studio-view.css'
import { PROJECT_WORKSPACE_NAVIGATION_EVENT, takeProjectWorkspaceNavigation, type ProjectWorkspaceFocus } from './projectWorkspaceNavigation'
import WorkInbox from './WorkInbox'
import PalaceSceneBuilder from './PalaceSceneBuilder'
import GoldenTasksPanel from './GoldenTasksPanel'
import WorkOsRunReviewPanel from './WorkOsRunReviewPanel'
import { STUDIO_SECTION_NAVIGATION_EVENT, takeStudioSectionNavigation, type StudioSectionTarget } from '../work-os-navigation'

type StudioSection = 'inbox' | 'work' | 'team' | 'builder' | 'golden-tasks' | 'runs' | 'review'

const EMPTY_CONTEXT: ProjectWorkspaceStudioContext = {
  project: null,
  goals: [],
  workItems: [],
  squads: [],
  comments: []
}

function StudioView({ active = true }: { active?: boolean }): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const initialProjectId = useStore((state) => state.preferredProjectWorkspaceId) ?? undefined
  const [workspaceNavigation, setWorkspaceNavigation] = useState<{ projectId: string; focus: ProjectWorkspaceFocus; workItemId?: string } | null>(null)
  const newProjectRequest = useStore((state) => state.studioNewProjectNonce)
  // 0913: the first Studio surface is the unified Work Inbox. Project and
  // team surfaces remain one click away and explicit project navigation still
  // switches to the requested work item.
  const [section, setSection] = useState<StudioSection>('inbox')
  const [context, setContext] = useState<ProjectWorkspaceStudioContext>(EMPTY_CONTEXT)
  const [workspaceActivated, setWorkspaceActivated] = useState(false)

  const updateContext = useCallback((next: ProjectWorkspaceStudioContext): void => {
    setContext((current) => sameContext(current, next) ? current : next)
  }, [])
  useEffect(() => {
    if (!active || section !== 'work' || workspaceActivated) return
    const frameIds: number[] = []
    const activateAfterPaint = (): void => {
      frameIds.push(window.requestAnimationFrame(() => setWorkspaceActivated(true)))
    }
    // Keep project hydration out of the shell's first interactive paint.
    activateAfterPaint()
    return () => frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId))
  }, [active, section, workspaceActivated])
  useEffect(() => {
    const onNavigation = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId: string; focus: ProjectWorkspaceFocus }>).detail
      if (!detail?.projectId) return
      const next = takeProjectWorkspaceNavigation(detail.projectId)
      if (next) {
        setWorkspaceNavigation(next)
        setSection('work')
      }
    }
    window.addEventListener(PROJECT_WORKSPACE_NAVIGATION_EVENT, onNavigation)
    return () => window.removeEventListener(PROJECT_WORKSPACE_NAVIGATION_EVENT, onNavigation)
  }, [])
  useEffect(() => {
    if (!initialProjectId) return
    const next = takeProjectWorkspaceNavigation(initialProjectId)
    if (next) {
      setWorkspaceNavigation(next)
      setSection('work')
    }
  }, [initialProjectId])
  useEffect(() => {
    const applySection = (target: StudioSectionTarget): void => {
      setSection(target === 'inbox' ? 'inbox' : target === 'work' ? 'work' : target === 'runs' ? 'runs' : target === 'review' ? 'review' : 'team')
    }
    const onNavigation = (event: Event): void => {
      const target = (event as CustomEvent<StudioSectionTarget>).detail
      if (target === 'inbox' || target === 'work' || target === 'team' || target === 'runs' || target === 'review') {
        // Consume the queued value as soon as a mounted Studio receives it;
        // otherwise a later lazy remount could replay an old route.
        takeStudioSectionNavigation()
        applySection(target)
      }
    }
    const pendingSection = takeStudioSectionNavigation()
    if (pendingSection) applySection(pendingSection)
    window.addEventListener(STUDIO_SECTION_NAVIGATION_EVENT, onNavigation)
    return () => window.removeEventListener(STUDIO_SECTION_NAVIGATION_EVENT, onNavigation)
  }, [])

  const project = context.project
  const projects = useMemo(() => project ? [{ id: project.id, name: project.name }] : [], [project])
  return (
    <div className="studio-view" data-studio-view data-language={language}>
      <nav
        className="studio-section-switcher"
        aria-label={language === 'zh' ? '工作区表面' : 'Studio surfaces'}
        role="tablist"
      >
        <button
          type="button"
          className={section === 'inbox' ? 'active' : ''}
          aria-selected={section === 'inbox'}
          aria-pressed={section === 'inbox'}
          data-studio-section-option="inbox"
          role="tab"
          onClick={() => setSection('inbox')}
        >
          {language === 'zh' ? '工作收件箱' : 'Work Inbox'}
        </button>
        <button
          type="button"
          className={section === 'work' ? 'active' : ''}
          aria-selected={section === 'work'}
          aria-pressed={section === 'work'}
          data-studio-section-option="work"
          role="tab"
          onClick={() => setSection('work')}
        >
          {TEXT.workSection}
        </button>
        <button
          type="button"
          className={section === 'team' ? 'active' : ''}
          aria-selected={section === 'team'}
          aria-pressed={section === 'team'}
          data-studio-section-option="team"
          role="tab"
          onClick={() => setSection('team')}
        >
          {TEXT.digitalTeamSection}
        </button>
        <button
          type="button"
          className={section === 'builder' ? 'active' : ''}
          aria-selected={section === 'builder'}
          aria-pressed={section === 'builder'}
          data-studio-section-option="builder"
          role="tab"
          onClick={() => setSection('builder')}
        >
          {language === 'zh' ? '宫苑场景' : 'PalaceScene'}
        </button>
        <button
          type="button"
          className={section === 'runs' ? 'active' : ''}
          aria-selected={section === 'runs'}
          aria-pressed={section === 'runs'}
          data-studio-section-option="runs"
          role="tab"
          onClick={() => setSection('runs')}
        >
          {language === 'zh' ? '运行' : 'Runs'}
        </button>
        <button
          type="button"
          className={section === 'review' ? 'active' : ''}
          aria-selected={section === 'review'}
          aria-pressed={section === 'review'}
          data-studio-section-option="review"
          role="tab"
          onClick={() => setSection('review')}
        >
          {language === 'zh' ? '审查' : 'Review'}
        </button>
        <button
          type="button"
          className={section === 'golden-tasks' ? 'active' : ''}
          aria-selected={section === 'golden-tasks'}
          aria-pressed={section === 'golden-tasks'}
          data-studio-section-option="golden-tasks"
          role="tab"
          onClick={() => setSection('golden-tasks')}
        >
          {language === 'zh' ? '黄金任务' : 'Golden Tasks'}
        </button>
      </nav>
      <p className="studio-section-description">
        {language === 'zh'
          ? '普通任务直接开始。需要并行处理独立工作时，再安排数字团队。'
          : 'Start ordinary tasks directly. Arrange a team when independent work benefits from parallel execution.'}
      </p>

      <div className="studio-section" hidden={section !== 'inbox'} aria-hidden={section !== 'inbox'}>
        {section === 'inbox' && <WorkInbox active={active} />}
      </div>
      <div className="studio-section" hidden={section !== 'work'} aria-hidden={section !== 'work'}>
        <ProjectWorkspaceStudio
          active={workspaceActivated}
          initialProjectId={initialProjectId}
          requestedFocus={workspaceNavigation?.focus}
          requestedWorkItemId={workspaceNavigation?.workItemId}
          newProjectRequest={newProjectRequest}
          onContextChange={updateContext}
        />
      </div>
      <div className="studio-section" hidden={section !== 'team'} aria-hidden={section !== 'team'}>
        {section === 'team' && <Suspense fallback={<div>加载协作配置…</div>}><DigitalWorkerStudio
          active={active && section === 'team'}
          projectId={project?.id}
          projects={projects}
          workItems={context.workItems}
          assignedBy="user"
        /></Suspense>}
      </div>
      <div className="studio-section" hidden={section !== 'builder'} aria-hidden={section !== 'builder'}>
        {section === 'builder' && <PalaceSceneBuilder active={active && section === 'builder'} />}
      </div>
      <div className="studio-section" hidden={section !== 'golden-tasks'} aria-hidden={section !== 'golden-tasks'}>
        {section === 'golden-tasks' && <GoldenTasksPanel active={active && section === 'golden-tasks'} />}
      </div>
      <div className="studio-section" hidden={section !== 'runs'} aria-hidden={section !== 'runs'}>
        {section === 'runs' && <WorkOsRunReviewPanel active={active && section === 'runs'} view="runs" />}
      </div>
      <div className="studio-section" hidden={section !== 'review'} aria-hidden={section !== 'review'}>
        {section === 'review' && <WorkOsRunReviewPanel active={active && section === 'review'} view="review" />}
      </div>
    </div>
  )
}

export default memo(StudioView)

function sameContext(left: ProjectWorkspaceStudioContext, right: ProjectWorkspaceStudioContext): boolean {
  return sameRecord(left.project, right.project) &&
    sameRecordList(left.goals, right.goals) &&
    sameRecordList(left.workItems, right.workItems) &&
    sameRecordList(left.squads, right.squads) &&
    sameRecordList(left.comments, right.comments)
}

function sameRecord(
  left: ProjectWorkspace | null,
  right: ProjectWorkspace | null
): boolean {
  return left?.id === right?.id && left?.revision === right?.revision
}

function sameRecordList(
  left: Array<Goal | WorkItem | ProjectSquad | WorkItemComment>,
  right: Array<Goal | WorkItem | ProjectSquad | WorkItemComment>
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index]
    return candidate?.id === item.id && candidate.revision === item.revision
  })
}
