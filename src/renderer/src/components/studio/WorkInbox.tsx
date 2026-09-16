import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkflowLedgerRendererSelection } from '../../../../shared/types'
import { useStore } from '../../store'
import { localized } from './projectWorkspaceStudioLocale'
import {
  adaptCrossProjectWorkInbox,
  CROSS_PROJECT_WORK_INBOX_LANE_ORDER,
  mergeWorkflowLedgerPages,
  type CrossProjectWorkInboxItem
} from './workInboxNavigation'
import { requestProjectWorkspaceNavigation } from './projectWorkspaceNavigation'
import RunDetailPanel from './RunDetailPanel'
import { createRunDetailRoute, parseRunDetailRoute, resolveRunRecoverySnapshotId } from '../../../../shared/run-detail-projection'
import { requestTaskPlanNavigation } from '../experience/task-plan-navigation'
import { resolveInboxTaskDestination } from './workInboxTaskNavigation'
import GoalTaskStarter from './GoalTaskStarter'
import { useProjectGoalTaskStart } from './useProjectWorkspaceStudio'

const REFRESH_INTERVAL_MS = 15_000
const PAGE_SIZE = 500

export default function WorkInbox({ active }: { active: boolean }): React.JSX.Element {
  const projects = useStore((state) => state.projectWorkspaces)
  const preferredProjectId = useStore((state) => state.preferredProjectWorkspaceId)
  const [intakeProjectId, setIntakeProjectId] = useState<string | null>(null)
  const recoverTaskSnapshot = useStore((state) => state.recoverTaskSnapshot)
  const selectSession = useStore((state) => state.selectSession)
  const syncSession = useStore((state) => state.syncSession)
  const setStudioSurface = useStore((state) => state.setStudioSurface)
  const setShowNewSession = useStore((state) => state.setShowNewSession)
  const refreshProjects = useStore((state) => state.refreshProjectWorkspaces)
  const openProjectWorkspace = useStore((state) => state.openProjectWorkspace)
  const openNewProjectWorkspace = useStore((state) => state.openNewProjectWorkspace)
  const [ledger, setLedger] = useState<WorkflowLedgerRendererSelection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedRunRoute, setSelectedRunRoute] = useState<string | null>(null)
  const [openingTaskId, setOpeningTaskId] = useState<string | null>(null)
  const [navigationError, setNavigationError] = useState('')
  const taskNavigation = useRef(0)
  useEffect(() => {
    setOpeningTaskId(null)
    if (!active) taskNavigation.current += 1
    return () => { taskNavigation.current += 1 }
  }, [active])
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      await refreshProjects()
      const pages: WorkflowLedgerRendererSelection[] = []
      let cursor: string | undefined
      do {
        const page = await window.agentDesk.listWorkflowLedger({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
        pages.push(page)
        cursor = [page.goals, page.workItems, page.runs, page.artifacts, page.acceptances, page.evidenceLinks, page.events]
          .find((candidate) => candidate.hasMore)?.nextCursor
      } while (cursor)
      setLedger(mergeWorkflowLedgerPages(pages))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause instanceof Error ? cause : new Error(String(cause))
    } finally {
      setLoading(false)
    }
  }, [refreshProjects])
  const openTask = useCallback(async (item: CrossProjectWorkInboxItem, focus: 'task' | 'plan'): Promise<void> => {
    const request = ++taskNavigation.current
    const state = useStore.getState()
    const navigationKey = () => {
      const current = useStore.getState()
      return JSON.stringify([current.activeId, current.view, current.experienceMode, current.studioSurface,
        current.studioSessionNavigationNonce, current.showSettings, current.showTaskRecovery, current.showNewSession])
    }
    const initialNavigation = navigationKey()
    const current = () => request === taskNavigation.current && navigationKey() === initialNavigation
    setOpeningTaskId(item.id)
    setNavigationError('')
    try {
      const target = await resolveInboxTaskDestination(item, {
        readLedger: scope => window.agentDesk.listWorkflowLedger(scope),
        listSessions: () => window.agentDesk.listSessions()
      })
      if (!current()) return
      if (!target.sessionId) {
        if (target.runId) {
          await refresh()
          if (!current()) return
          setSelectedRunRoute(createRunDetailRoute(target.runId))
        }
        setNavigationError(target.reason === 'identity_conflict'
          ? localized('任务归属发生冲突，请刷新并核对执行记录。', 'Task ownership conflicts. Refresh and review the execution record.')
          : localized('原任务会话尚未载入。可核对下方执行记录，或打开恢复中心继续。', 'The original task session is unavailable. Review its execution below or open Recovery.'))
        return
      }
      if (!await syncSession(target.sessionId)) {
        if (current()) setNavigationError(localized('原任务会话已关闭，请从恢复中心继续。', 'The original session has closed. Continue from Recovery.'))
        return
      }
      if (!current()) return
      const meta = useStore.getState().sessions[target.sessionId]?.meta
      if (!meta || meta.status === 'closed' || !target.binding || meta.workspaceId !== target.binding.workspaceId ||
        meta.goalId !== target.binding.goalId || meta.workItemId !== target.binding.workItemId) {
        setNavigationError(localized('任务会话已变化，请刷新后重新打开。', 'The task session changed. Refresh and open it again.'))
        return
      }
      const latest = await resolveInboxTaskDestination(item, {
        readLedger: scope => window.agentDesk.listWorkflowLedger(scope),
        listSessions: () => window.agentDesk.listSessions()
      })
      if (!current()) return
      if (latest.sessionId !== target.sessionId || latest.runId !== target.runId) {
        setNavigationError(localized('任务执行已变化，请重新打开当前任务。', 'The current execution changed. Open the task again.'))
        return
      }
      // Queue the plan before changing surfaces; the real session workbench
      // consumes it after mounting. No duplicate approval UI lives in Inbox.
      if (focus === 'plan') requestTaskPlanNavigation(target.sessionId)
      selectSession(target.sessionId)
      state.setView('list')
      setStudioSurface('session')
      setShowNewSession(false)
      state.setShowTaskRecovery(false)
      setSelectedRunRoute(null)
    } catch (cause) {
      if (current()) setNavigationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === taskNavigation.current) setOpeningTaskId(null)
    }
  }, [refresh, selectSession, setShowNewSession, setStudioSurface, syncSession])
  const goalStarter = useProjectGoalTaskStart(refresh)
  const selectedIntakeProject = intakeProjectId ?? preferredProjectId ?? ''
  const intakeProject = projects.find((project) => project.id === selectedIntakeProject && project.status === 'active')
  const recoverRun = useCallback(async (runId: string): Promise<void> => {
    const canonicalRun = ledger?.runs.items.find((run) => run.id === runId)
    if (!canonicalRun) throw new Error('Run 已不在 canonical Ledger 中，已阻止恢复。')
    const taskSnapshots = await window.agentDesk.listTaskSnapshots()
    const snapshotId = resolveRunRecoverySnapshotId(canonicalRun, taskSnapshots)
    await recoverTaskSnapshot(snapshotId, { activate: false })
    await refresh()
  }, [ledger, refresh, recoverTaskSnapshot])
  const openDelivery = useCallback((projectId: string, workItemId?: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId && candidate.status === 'active')
    if (!project) return
    requestProjectWorkspaceNavigation(project.id, 'delivery', workItemId)
    openProjectWorkspace(project.id)
    setSelectedRunRoute(null)
  }, [openProjectWorkspace, projects])
  useEffect(() => {
    if (!active) return
    void refresh().catch(() => undefined)
    const timer = window.setInterval(() => void refresh().catch(() => undefined), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active, refresh])
  const projection = useMemo(() => ledger ? adaptCrossProjectWorkInbox(ledger, projects) : null, [ledger, projects])
  const selectedRunProjectAvailable = useMemo(() => {
    const runId = selectedRunRoute ? parseRunDetailRoute(selectedRunRoute)?.runId : undefined
    const projectId = runId ? ledger?.runs.items.find((run) => run.id === runId)?.projectId : undefined
    return Boolean(projectId && projects.some((project) => project.id === projectId && project.status === 'active'))
  }, [ledger, projects, selectedRunRoute])
  const openGoalCreation = (): void => {
    const project = projects.find((item) => item.status === 'active')
    if (!project) {
      openNewProjectWorkspace()
      return
    }
    requestProjectWorkspaceNavigation(project.id, 'goal')
    openProjectWorkspace(project.id)
  }
  return (
    <section className="pws-inbox cross-project-work-inbox" aria-labelledby="cross-project-work-inbox-title" data-cross-project-work-inbox>
      <header className="pws-inbox-header">
        <div><h2 id="cross-project-work-inbox-title">{localized('工作收件箱', 'Work Inbox')}</h2><span>{projection?.total ?? 0} {localized('项', 'items')}</span></div>
        <div className="pws-inbox-header-actions">
          <button type="button" className="btn btn-primary btn-sm" data-work-inbox-action="create-goal" onClick={openGoalCreation}>{localized('创建目标', 'Create goal')}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void refresh().catch(() => undefined)}>{loading ? localized('刷新中…', 'Refreshing…') : localized('刷新', 'Refresh')}</button>
        </div>
      </header>
      <div className="pws-inbox-intake" data-work-inbox-intake>
        <label>{localized('当前项目', 'Current project')}
          <select className="input" value={intakeProject?.id ?? ''} disabled={goalStarter.busy}
            onChange={(event) => setIntakeProjectId(event.target.value)} data-goal-task-project>
            <option value="">{localized('独立任务', 'Standalone task')}</option>
            {projects.filter((project) => project.status === 'active').map((project) =>
              <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <GoalTaskStarter key={intakeProject?.id ?? 'personal'} projectId={intakeProject?.id} state={goalStarter} />
      </div>
      {error && <p className="pws-inbox-error" role="alert">{error}</p>}
      {navigationError && <div className="pws-inbox-error" role="alert">{navigationError}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => useStore.getState().setShowTaskRecovery(true)}>{localized('打开恢复中心', 'Open Recovery')}</button>
      </div>}
      {!loading && !error && projection?.total === 0 && <p className="pws-inbox-empty">{localized('暂无工作项', 'No work items')}</p>}
      {projection && projection.total > 0 && <div className="pws-inbox-lanes" data-cross-project-inbox-total={projection.total}>
        {CROSS_PROJECT_WORK_INBOX_LANE_ORDER.map((lane) => {
          const laneItems = projection.lanes[lane].items
          if (laneItems.length === 0) return null
          return <details key={lane} className="pws-inbox-lane" open>
            <summary>{laneLabel(lane)} <span>({laneItems.length})</span></summary>
            <div className="pws-inbox-list" role="list" data-cross-project-inbox-lane={lane}>
              {laneItems.slice(0, 50).map((item) => <CrossProjectInboxRow key={item.id} item={item} opening={openingTaskId === item.id}
                onOpenTask={item.workItemId || item.runId ? () => void openTask(item, 'task') : undefined}
                onOpenDelivery={item.lane === 'ready_for_delivery' && item.projectId ? () => openDelivery(item.projectId!, item.workItemId) : undefined}
                onOpenRun={item.runId ? () => setSelectedRunRoute(createRunDetailRoute(item.runId!)) : undefined}
                onOpenPlan={item.workItemId || item.runId ? () => void openTask(item, 'plan') : undefined} onOpen={() => {
                if (!item.projectId || !item.projectAvailable) return
                requestProjectWorkspaceNavigation(item.projectId, 'work-item', item.workItemId)
                openProjectWorkspace(item.projectId)
              }} />)}
            </div>
          </details>
        })}
      </div>}
      {projection && ledger && selectedRunRoute && <div className="cross-project-run-detail-wrap">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedRunRoute(null)}>关闭 Run 详情</button>
        <RunDetailPanel
          input={{ runs: ledger.runs.items, workItems: ledger.workItems.items, acceptances: ledger.acceptances.items, artifacts: ledger.artifacts.items, evidenceLinks: ledger.evidenceLinks.items }}
          route={selectedRunRoute}
          onNavigate={setSelectedRunRoute}
          onRecover={recoverRun}
          onRecoveryChanged={refresh}
          onOpenDelivery={selectedRunProjectAvailable ? openDelivery : undefined}
        />
      </div>}
    </section>
  )
}

function CrossProjectInboxRow({ item, opening, onOpen, onOpenTask, onOpenPlan, onOpenRun, onOpenDelivery }: { item: CrossProjectWorkInboxItem; opening: boolean; onOpen: () => void; onOpenTask?: () => void; onOpenPlan?: () => void; onOpenRun?: () => void; onOpenDelivery?: () => void }): React.JSX.Element {
  return <article className="pws-inbox-row" role="listitem" data-inbox-state={item.lane} data-project-id={item.projectId ?? ''} data-work-item-id={item.workItemId ?? ''}>
    <span className={`pws-inbox-state pws-inbox-state-${item.lane}`}>{laneLabel(item.lane)}</span>
    <span className="pws-inbox-copy"><strong>{item.title}</strong><span>{item.projectName}{item.detail ? ` · ${item.detail}` : ''}</span></span>
    <time dateTime={new Date(item.updatedAt).toISOString()}>{formatInboxTime(item.updatedAt)}</time>
    {onOpenTask && <button type="button" className="btn btn-primary btn-sm" disabled={opening} onClick={onOpenTask} data-inbox-action="open-task">{opening ? localized('打开中…', 'Opening…') : localized('打开任务', 'Open task')}</button>}
    <button type="button" className="btn btn-ghost btn-sm" disabled={!item.projectAvailable} onClick={onOpen}>{localized('打开项目', 'Open project')}</button>
    {onOpenDelivery && <button type="button" className="btn btn-ghost btn-sm" disabled={!item.projectAvailable} onClick={onOpenDelivery} data-inbox-action="open-delivery">{localized('打开交付验收', 'Open delivery')}</button>}
    {onOpenPlan && <button type="button" className="btn btn-ghost btn-sm" disabled={opening} data-inbox-action="open-plan" onClick={onOpenPlan}>{localized('打开计划', 'Open plan')}</button>}
    {onOpenRun && <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRun} data-inbox-action="open-run">{localized('打开 Run', 'Open Run')}</button>}
  </article>
}

function laneLabel(lane: CrossProjectWorkInboxItem['lane']): string {
  return ({
    needs_confirmation: localized('待我确认', 'Needs confirmation'), running: localized('运行中', 'Running'), blocked: localized('被阻塞', 'Blocked'), ready_for_delivery: localized('待交付', 'Ready for delivery'), completed: localized('已完成', 'Completed')
  })[lane]
}

function formatInboxTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
