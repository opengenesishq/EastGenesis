import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { PALACE_ACTIONS, palaceInstitutionWorkItems, type PalaceAction, type PalaceActionContext } from './palaceActions'
import { usePalaceWorkData } from './usePalaceWorkData'
import { adaptCrossProjectWorkInbox, type CrossProjectWorkInboxItem } from '../studio/workInboxNavigation'
import { createRunDetailRoute, resolveRunRecoverySnapshotId } from '../../../../shared/run-detail-projection'
import type { WorkItem } from '../../../../shared/types'
import { projectInstitutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE, LEGACY_PROJECT_INSTITUTION_TEMPLATE } from '../../../../shared/project-institution-template'
import { requestProjectWorkspaceNavigation } from '../studio/projectWorkspaceNavigation'
import PermissionBar from '../PermissionBar'
import TaskPlanWorkbench from '../experience/TaskPlanWorkbench'
import CouncilPanel from '../experience/CouncilPanel'
import RunDetailPanel from '../studio/RunDetailPanel'
import { ProjectDeliveryWorkbench } from '../studio/ProjectDeliveryWorkbench'
import OfficeSessionActions from './OfficeSessionActions'
import PalaceInstitutionWorkItem from './PalaceInstitutionWorkItem'
import { preparePalaceTaskNavigation } from './palaceTaskNavigation'
import { capturePalaceSessionBinding, isPalaceSessionBindingCurrent, type PalaceSessionBinding } from './palace-task-binding'
import { palaceUrgentReports } from './palace-urgent-reports'
import PalaceUrgentReports from './PalaceUrgentReports'
import PalaceRawRecords from './PalaceRawRecords'
import PalaceAudienceTasks from './PalaceAudienceTasks'
import PalaceCourtOverview from './PalaceCourtOverview'
import { ExperienceProjectionProvider } from '../experience/ExperienceProjection'
import { sessionExperienceMode } from '../../store/session-experience'
import './palace-work-panel.css'

const ChatView = lazy(() => import('../ChatView'))
const FilePanel = lazy(() => import('../workbench/FilePanel'))
const DiffPanel = lazy(() => import('../workbench/DiffPanel'))
const StudioResultPanel = lazy(() => import('../workbench/StudioResultPanel'))
type Surface = 'chat' | 'logs' | 'files' | 'diff' | 'results'
type WorkSelection = { kind: 'session'; binding: PalaceSessionBinding }
  | { kind: 'delivery'; projectId: string; workItemId?: string }

export default function PalaceWorkPanel({ action, initialContext, onClose, onAction, onOpenWorkspace }: {
  action: Exclude<PalaceAction, 'edict'>
  initialContext?: PalaceActionContext
  onClose(): void
  onAction(action: PalaceAction, context?: PalaceActionContext): void
  onOpenWorkspace(sessionId: string): void
}): React.JSX.Element {
  const zh = useStore((state) => state.settings.language) === 'zh'
  const sessions = useStore((state) => state.sessions)
  const activeId = useStore((state) => state.activeId)
  const selectSession = useStore((state) => state.selectSession)
  const preferredProjectId = useStore((state) => state.preferredProjectWorkspaceId)
  const panel = useRef<HTMLElement>(null)
  const [surface, setSurface] = useState<Surface>(action === 'inspect' ? 'logs' : 'chat')
  const [roleId, setRoleId] = useState(initialContext?.roleId ?? 'all')
  const [workSelection, setWorkSelection] = useState<WorkSelection>(() => {
    const sessionId = initialContext ? initialContext.sessionId : activeId
    const meta = sessionId ? sessions[sessionId]?.meta : undefined
    if (meta && meta.status !== 'closed') return { kind: 'session', binding: capturePalaceSessionBinding(meta) }
    return { kind: 'delivery', projectId: initialContext?.projectId ?? (initialContext ? '' : preferredProjectId ?? ''),
      workItemId: initialContext?.projectId ? initialContext.workItemId : undefined }
  })
  const [deliveryOpen, setDeliveryOpen] = useState(action === 'approve' || action === 'desk')
  const [runRoute, setRunRoute] = useState<string>()
  const [openingTaskId, setOpeningTaskId] = useState<string>()
  const [navigationError, setNavigationError] = useState('')
  const taskNavigation = useRef(0)
  const sessionIds = Object.keys(sessions)
  const data = usePalaceWorkData(sessionIds)
  const institutionItems = useMemo(() => palaceInstitutionWorkItems(roleId, data.items, data.plans), [roleId, data.items, data.plans])
  // Embedded ChatView/FilePanel use activeId. Mount them only when it matches
  // this panel's explicit selection, so a global selection change cannot send
  // an approval, edit or instruction to another task under the old heading.
  const selectedSession = workSelection.kind === 'session' && workSelection.binding.id === activeId &&
    isPalaceSessionBindingCurrent(workSelection.binding, sessions[workSelection.binding.id]?.meta) ? sessions[workSelection.binding.id] : undefined
  const selected = action !== 'audience' || roleId === 'all' || institutionItems.some(item => item.id === selectedSession?.meta.workItemId &&
    item.projectId === selectedSession.meta.workspaceId && item.goalId === selectedSession.meta.goalId) ? selectedSession : undefined
  // A task's delivery and approvals share its live ownership. Project browsing
  // is a separate selection, so it cannot carry another task's permissions.
  const projectId = workSelection.kind === 'session' ? selected?.meta.workspaceId ?? '' : workSelection.projectId
  const deliveryWorkItemId = workSelection.kind === 'session' ? selected?.meta.workItemId : workSelection.workItemId
  const definition = PALACE_ACTIONS.find((item) => item.id === action)!
  const inbox = useMemo(() => data.ledger ? adaptCrossProjectWorkInbox(data.ledger, data.projects) : undefined, [data.ledger, data.projects])
  const urgentReports = useMemo(() => palaceUrgentReports(inbox?.items ?? [], Object.values(sessions), data.ledger?.runs.items ?? []), [inbox, sessions, data.ledger])
  const institutionRoles = useMemo(() => {
    const byId = new Map([...projectInstitutionTemplate(LEGACY_PROJECT_INSTITUTION_TEMPLATE).roles,
      ...projectInstitutionTemplate(DEFAULT_PROJECT_INSTITUTION_TEMPLATE).roles].map((role) => [role.id, role]))
    for (const item of data.items) {
      if (item.role && !byId.has(item.role)) byId.set(item.role, { id: item.role, name: item.role, nameEn: item.role,
        duty: '原任务记录的职责', dutyEn: 'Recorded task role', participation: 'legacy' })
    }
    return [...byId.values()]
  }, [data.items])
  const patrolItems = institutionItems
  useEffect(() => { panel.current?.focus(); return () => { taskNavigation.current++ } }, [])
  const openWorkItem = (item: Pick<WorkItem, 'id' | 'projectId'>): void => {
    useStore.getState().openProjectWorkspace(item.projectId)
    requestProjectWorkspaceNavigation(item.projectId, 'work-item', item.id)
    useStore.getState().setView('list')
  }
  const selectWork = (selection: WorkSelection): void => {
    taskNavigation.current++
    setOpeningTaskId(undefined)
    setNavigationError('')
    setWorkSelection(selection)
    setRunRoute(undefined)
  }
  const openDelivery = (nextProjectId: string, workItemId?: string): void => {
    selectWork({ kind: 'delivery', projectId: nextProjectId, workItemId })
    setDeliveryOpen(true)
  }
  const recoverRun = async (runId: string): Promise<void> => {
    const canonicalRun = data.ledger?.runs.items.find((run) => run.id === runId)
    if (!canonicalRun) throw new Error(zh ? '运行记录已不可用，请刷新。' : 'Run is unavailable. Refresh the records.')
    const snapshots = await window.agentDesk.listTaskSnapshots()
    const snapshotId = resolveRunRecoverySnapshotId(canonicalRun, snapshots)
    await useStore.getState().recoverTaskSnapshot(snapshotId, { activate: false })
    await data.refresh()
  }
  const openInboxItem = (item: CrossProjectWorkInboxItem): void => {
    taskNavigation.current++
    setOpeningTaskId(undefined)
    if (item.runId) setRunRoute(createRunDetailRoute(item.runId))
    else if (item.workItemId && item.projectId) openWorkItem({ id: item.workItemId, projectId: item.projectId })
    else if (item.sourceKind === 'goal' && item.projectId && item.projectAvailable) {
      useStore.getState().openProjectWorkspace(item.projectId)
      requestProjectWorkspaceNavigation(item.projectId, 'goal')
      useStore.getState().setView('list')
    }
  }
  const openInboxTask = async (item: CrossProjectWorkInboxItem, nextAction: 'study' | 'approve' | 'audience'): Promise<void> => {
    const request = ++taskNavigation.current
    const navigationKey = (): string => {
      const state = useStore.getState()
      return JSON.stringify([state.activeId, state.view, state.experienceMode, state.studioSurface,
        state.studioSessionNavigationNonce, state.showSettings, state.showTaskRecovery, state.showNewSession])
    }
    const initialNavigation = navigationKey()
    const current = (): boolean => request === taskNavigation.current && navigationKey() === initialNavigation
    setOpeningTaskId(item.id); setNavigationError('')
    try {
      const target = await preparePalaceTaskNavigation(item, {
        readLedger: scope => window.agentDesk.listWorkflowLedger(scope),
        listSessions: () => window.agentDesk.listSessions(),
        syncSession: id => useStore.getState().syncSession(id),
        session: id => useStore.getState().sessions[id]?.meta,
        current
      })
      if (!target || !current()) return
      if (!target.sessionId) {
        if (target.runId) { setRunRoute(createRunDetailRoute(target.runId)); void data.refresh() }
        setNavigationError(target.reason === 'identity_conflict'
          ? (zh ? '任务执行或归属已变化，请刷新后重新打开当前任务。' : 'The task execution or ownership changed. Refresh and open the current task again.')
          : (zh ? '原任务会话已不可用，请核对执行记录或从恢复中心继续。' : 'The original task session is unavailable. Review its execution or continue from Recovery.'))
        return
      }
      onAction(nextAction, { sessionId: target.sessionId, projectId: target.binding?.workspaceId, workItemId: target.binding?.workItemId,
        ...(nextAction === 'audience' ? { roleId } : {}) })
    } catch (cause) {
      if (current()) setNavigationError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (request === taskNavigation.current) setOpeningTaskId(undefined) }
  }
  const contextModes = ['audience', 'study', 'inspect', 'council', 'approve'].includes(action)
  const activeProject = data.projects.find((project) => project.id === projectId && project.status === 'active')
  const currentContext: PalaceActionContext = { sessionId: selected?.meta.id, projectId, workItemId: deliveryWorkItemId, roleId }
  const openPermission = (id: string): void => {
    const current = useStore.getState().sessions[id]
    if (current?.pendingPermissions.length) onAction('approve', { sessionId: id, projectId: current.meta.workspaceId, workItemId: current.meta.workItemId })
  }
  return <section ref={panel} tabIndex={-1} className="palace-work-panel no-drag" data-palace-work-panel={action}
    role="dialog" aria-label={zh ? definition.label : definition.labelEn} onKeyDown={(event) => {
      if (event.key === 'Escape' && event.target === event.currentTarget) onClose()
    }}>
    <header><h2>{zh ? definition.label : definition.labelEn}</h2><div>
      {selected && <button type="button" className="btn btn-primary btn-sm" data-palace-open-workspace={selected.meta.id}
        onClick={() => onOpenWorkspace(selected.meta.id)}>{zh ? '在工作台继续此任务' : 'Continue this task in workspace'}</button>}
      <button type="button" className="btn btn-ghost btn-sm" disabled={data.loading} onClick={() => void data.refresh()}>{zh ? '刷新记录' : 'Refresh'}</button>
      <button type="button" className="btn btn-ghost btn-sm" data-palace-work-close onClick={onClose}>{zh ? '回到故宫' : 'Back to palace'}</button>
    </div></header>
    <nav aria-label={zh ? '宫廷工作入口' : 'Palace work actions'}>{PALACE_ACTIONS.map((item) => <button key={item.id} type="button"
      className="btn btn-ghost btn-sm" aria-pressed={action === item.id} data-palace-panel-action={item.id}
      onClick={() => onAction(item.id, currentContext)}>{zh ? item.label : item.labelEn}</button>)}</nav>
    <p className="palace-work-freshness" role="status">{data.loading ? (zh ? '正在读取…' : 'Loading…') : data.updatedAt
      ? `${zh ? '记录更新时间' : 'Records updated'} ${new Date(data.updatedAt).toLocaleTimeString()}` : (zh ? '尚无读取结果' : 'No records loaded')}
      {data.error && <span role="alert"> · {zh ? '刷新失败，旧记录仅供参考：' : 'Refresh failed; showing previous records: '}{data.error}</span>}</p>
    {data.unavailablePlans > 0 && <p role="status">{zh ? `${data.unavailablePlans} 个任务方案暂未读取，机构汇总可能不完整。` : `${data.unavailablePlans} task plans could not be loaded; institution totals may be incomplete.`}</p>}
    {navigationError && <p role="alert" data-palace-navigation-error>{navigationError} <button type="button" className="btn btn-ghost btn-sm"
      onClick={() => { taskNavigation.current++; useStore.getState().setShowTaskRecovery(true) }}>{zh ? '打开恢复中心' : 'Open Recovery'}</button></p>}

    {action === 'desk' && <div className="palace-work-shortcuts">
      <button type="button" className="btn btn-primary" onClick={() => onAction('edict', currentContext)}>{zh ? '下旨 / 继续当前任务' : 'Give an instruction / continue work'}</button>
      <button type="button" className="btn" onClick={() => onAction('approve', currentContext)}>{zh ? '处理奏折' : 'Review approvals'}</button>
      <button type="button" className="btn" onClick={() => onAction('study', currentContext)}>{zh ? '继续御书房工作' : 'Continue in the study'}</button>
    </div>}
    {action === 'court' && data.ledger && <PalaceCourtOverview ledger={data.ledger} projects={data.projects} sessions={sessions} updatedAt={data.updatedAt}
      zh={zh} openingTaskId={openingTaskId} onOpen={openInboxItem} onTask={item => void openInboxTask(item, 'study')}
      onApprovals={item => void openInboxTask(item, 'approve')} onDelivery={openDelivery} onPermission={openPermission} />}
    {action === 'desk' && inbox && <>
      <div className="palace-work-summary">{Object.entries(inbox.lanes).map(([lane, value]) => <span key={lane}>{laneLabel(lane, zh)} <strong>{value.items.length}</strong></span>)}</div>
      <p>{zh ? '与现代工作台显示相同任务和状态。' : 'Shows the same tasks and states as the modern workspace.'}</p>
      <InboxRows items={inbox.items}
        zh={zh} openingTaskId={openingTaskId} onOpen={openInboxItem} onTask={item => void openInboxTask(item, 'study')}
        onApprovals={item => void openInboxTask(item, 'approve')} />
    </>}
    {action === 'urgent' && <PalaceUrgentReports reports={urgentReports} zh={zh} loading={data.loading} openingTaskId={openingTaskId}
      onOpen={openInboxItem} onTask={item => void openInboxTask(item, 'study')} onApprovals={item => void openInboxTask(item, 'approve')}
      onDelivery={openDelivery} onPermission={openPermission} />}
    {(action === 'approve' || action === 'desk') && <label className="palace-work-selector">{zh ? '项目交付与验收' : 'Project delivery and acceptance'}
      <select value={activeProject?.id ?? ''} onChange={(event) => selectWork({ kind: 'delivery', projectId: event.target.value })}>
        <option value="">{zh ? '选择项目' : 'Select a project'}</option>{data.projects.filter((project) => project.status === 'active').map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>}
    {activeProject && deliveryOpen && <ProjectDeliveryWorkbench key={`${activeProject.id}:${deliveryWorkItemId ?? ''}`} active projectId={activeProject.id} requestedWorkItemId={deliveryWorkItemId} />}

    {action === 'audience' && <>
      <label className="palace-work-selector">{zh ? '召见机构' : 'Institution to meet'}<select data-palace-audience-institution value={roleId} onChange={event => {
        setRoleId(event.target.value)
        selectWork({ kind: 'delivery', projectId: '' })
      }}>
        <option value="all">{zh ? '直接选择已有 Agent' : 'Choose an existing Agent'}</option>{institutionRoles.map(role => <option key={role.id} value={role.id}>{zh ? role.name : role.nameEn}</option>)}
      </select></label>
      {roleId !== 'all' && <PalaceAudienceTasks items={institutionItems} zh={zh} loading={data.loading} openingTaskId={openingTaskId}
        onWorkItem={openWorkItem} onMeet={item => {
          const target = inbox?.items.find(row => row.workItemId === item.id && row.projectId === item.projectId && row.goalId === item.goalId)
          if (target) void openInboxTask(target, 'audience')
          else setNavigationError(zh ? '该任务的执行记录尚未载入，请刷新或查看工作项。' : 'The task execution is not loaded. Refresh or open its work item.')
        }} />}
    </>}
    {contextModes && <>
      {(action !== 'audience' || roleId === 'all') &&
      <label className="palace-work-selector">{zh ? '现有任务 / Agent' : 'Existing task / Agent'}
        <select value={selected?.meta.id ?? ''} onChange={(event) => {
          const next = sessions[event.target.value]
          if (!next) { selectWork({ kind: 'delivery', projectId }); return }
          selectSession(next.meta.id)
          selectWork({ kind: 'session', binding: capturePalaceSessionBinding(next.meta) })
        }}>
          <option value="">{zh ? '选择已有任务' : 'Choose an existing task'}</option>{sessionIds.filter(id => sessions[id].meta.status !== 'closed').map((id) => <option key={id} value={id}>{sessions[id].meta.title} · {sessions[id].meta.status}{sessions[id].pendingPermissions.length ? ` · ${sessions[id].pendingPermissions.length} ${zh ? '项授权' : 'permissions'}` : ''}</option>)}
        </select></label>}
      {selected ? <p className="palace-work-identity">{selected.meta.title} · {selected.meta.id}<br />{zh ? '沿用同一会话、文件和授权。' : 'Continues the same session, files and permissions.'}</p> : <p>{zh ? '选择已有任务后继续；当前没有绑定任务。' : 'Choose an existing task to continue.'}</p>}
    </>}
    {action === 'council' && selected && <CouncilPanel sessionId={selected.meta.id} expanded />}
    {selected && (action === 'approve' || action === 'council') && <>
      <PermissionBar sessionId={selected.meta.id} requests={selected.pendingPermissions} />
      <TaskPlanWorkbench sessionId={selected.meta.id} strategy={selected.meta.taskStrategy ?? 'view'} running={['running', 'starting'].includes(selected.meta.status)} showCouncil={action !== 'council'} />
    </>}
    {selected && ['audience', 'study', 'inspect', 'council'].includes(action) && <>
      <OfficeSessionActions key={selected.meta.id} session={selected} showPermissions={action !== 'council' && surface !== 'chat'} onOpenResults={() => setSurface('results')} />
      <nav aria-label={zh ? '任务工作区' : 'Task workspace'}>{(['chat', 'logs', 'files', 'diff', 'results'] as const).map((tab) => <button key={tab} className="btn btn-ghost btn-sm" aria-pressed={surface === tab} data-palace-workspace-tab={tab} onClick={() => setSurface(tab)}>{surfaceLabel(tab, zh)}</button>)}</nav>
      <div className="palace-work-surface" data-palace-session-surface={surface} data-palace-session-id={selected.meta.id}>
        <Suspense fallback={<p>{zh ? '正在打开工作区…' : 'Opening workspace…'}</p>}>
          {surface === 'chat' ? <ExperienceProjectionProvider mode={sessionExperienceMode(selected.meta)}><ChatView /></ExperienceProjectionProvider> : surface === 'files' ? <FilePanel /> : surface === 'diff' ? <DiffPanel />
            : surface === 'results' ? <StudioResultPanel sessionId={selected.meta.id} standalone onOpenSessionSurface={() => {
              // Tools use the modern workbench. Carry the same task there so
              // preview/browser/terminal controls never open behind this panel.
              onOpenWorkspace(selected.meta.id)
            }} /> : <PalaceRawRecords session={selected} zh={zh} />}
        </Suspense>
      </div>
    </>}
    {action === 'patrol' && <>
      <label className="palace-work-selector">{zh ? '机构' : 'Institution'}<select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
        <option value="all">{zh ? '全部工作' : 'All work'}</option>{institutionRoles.map((role) => <option key={role.id} value={role.id}>{zh ? role.name : role.nameEn}</option>)}
      </select></label>
      <p>{zh ? '机构按已批准计划中冻结的职责或任务原有角色过滤。负责人来自真实任务分派；未载入的历史计划不会猜测归属。' : 'Filters use approved plan responsibilities or existing task roles. Owners come from task assignments.'}</p>
      <div className="palace-work-summary"><span>{zh ? '任务' : 'Tasks'} {patrolItems.length}</span><span>{zh ? '运行' : 'Running'} {patrolItems.filter((item) => item.status === 'running').length}</span><span>{zh ? '阻塞 / 失败' : 'Blocked / failed'} {patrolItems.filter((item) => ['blocked', 'failed'].includes(item.status)).length}</span><span>{zh ? '完成' : 'Completed'} {patrolItems.filter((item) => item.status === 'done').length}</span></div>
      {patrolItems.length === 0 && <p>{zh ? '当前没有可确认归属的任务。' : 'No task with a confirmed institution is available.'}</p>}
      {patrolItems.map((item) => <PalaceInstitutionWorkItem key={`${item.projectId}:${item.id}`} item={item} runs={data.ledger?.runs.items ?? []} sessions={sessions} zh={zh}
        onRun={runId => setRunRoute(createRunDetailRoute(runId))}
        onStudy={id => onAction('study', { sessionId: id, projectId: item.projectId, workItemId: item.id })}
        onDelivery={() => openDelivery(item.projectId, item.id)} onWorkItem={() => openWorkItem(item)} />)}
    </>}
    {runRoute && data.ledger && <RunDetailPanel route={runRoute} onNavigate={setRunRoute} onOpenDelivery={openDelivery}
      onRecover={recoverRun} onRecoveryChanged={data.refresh}
      input={{ runs: data.ledger.runs.items, workItems: data.ledger.workItems.items, artifacts: data.ledger.artifacts.items, acceptances: data.ledger.acceptances.items, evidenceLinks: data.ledger.evidenceLinks.items, events: data.ledger.events.items }} />}
  </section>
}

function InboxRows({ items, zh, openingTaskId, onOpen, onTask, onApprovals }: { items: CrossProjectWorkInboxItem[]; zh: boolean; openingTaskId?: string; onOpen(item: CrossProjectWorkInboxItem): void; onTask(item: CrossProjectWorkInboxItem): void; onApprovals(item: CrossProjectWorkInboxItem): void }): React.JSX.Element {
  return <div>{items.length === 0 && <p>{zh ? '当前没有相关待办。' : 'No matching work items.'}</p>}{items.map((item) => <article key={item.id} className="palace-work-row" data-palace-inbox-item={item.id}>
    <div><strong>{item.title}</strong><p>{item.projectName} · {laneLabel(item.lane, zh)} · {item.detail}</p></div>
    <button className="btn btn-ghost btn-sm" onClick={() => onOpen(item)}>{zh ? '查看记录' : 'View records'}</button>
    {(item.workItemId || item.runId) && <button type="button" className="btn btn-ghost btn-sm" data-palace-inbox-task={item.id} disabled={Boolean(openingTaskId)} onClick={() => onTask(item)}>{openingTaskId === item.id ? (zh ? '正在打开…' : 'Opening…') : (zh ? '继续当前任务' : 'Continue task')}</button>}
    {item.lane === 'needs_confirmation' && <button type="button" className="btn btn-primary btn-sm" data-palace-inbox-approval={item.id} disabled={Boolean(openingTaskId)} onClick={() => onApprovals(item)}>{zh ? '批奏折' : 'Review approval'}</button>}
  </article>)}</div>
}

function surfaceLabel(surface: Surface, zh: boolean): string { return ({ chat: ['对话', 'Conversation'], logs: ['原始日志', 'Original logs'], files: ['文件', 'Files'], diff: ['代码差异', 'Code changes'], results: ['成果与验收', 'Results and acceptance'] })[surface][zh ? 0 : 1] }
function laneLabel(lane: string, zh: boolean): string { return ({ needs_confirmation: ['待确认', 'Needs confirmation'], running: ['运行中', 'Running'], blocked: ['阻塞', 'Blocked'], ready_for_delivery: ['待交付', 'Ready for delivery'], completed: ['已完成', 'Completed'] } as Record<string, string[]>)[lane]?.[zh ? 0 : 1] ?? lane }
