import { useId, useRef } from 'react'
import { Check, Download, PackagePlus, Sparkles, Trash2, UserPlus, X } from 'lucide-react'
import type { DigitalWorker, DigitalWorkerAssignment, DigitalWorkerRoleRecommendation, DigitalWorkerStatus, LearningRecord } from '../../../../shared/types'
import { RoleLibrary, WorkerRoster } from './DigitalWorkerCards'
import { AssignmentForm, HireWorkerForm, RoleTemplateForm, WorkerMemoryForm } from './DigitalWorkerForms'
import type {
  DigitalWorkerStudioProject,
  DigitalWorkerStudioWorkItem,
  StudioTab
} from './digital-worker-studio-model'
import { WORKER_STATUS_LABELS } from './digital-worker-studio-model'
import { recommendationBudgetLabel, recommendationDataLabels, studioLocale, studioLocalized, toolPolicyLabels } from './digital-worker-studio-model'
import type { DigitalWorkerStudioState } from './useDigitalWorkerStudio'
import { TEAM_TEMPLATE_MARKET } from './team-template-market'
import { useStore } from '../../store'

function statusFilters(): Array<{ value: '' | DigitalWorkerStatus; label: string }> {
  return [
    { value: '', label: studioLocalized('全部状态', 'All statuses') },
    ...Object.entries(WORKER_STATUS_LABELS).map(([value, label]) => ({ value: value as DigitalWorkerStatus, label }))
  ]
}

export interface DigitalWorkerStudioViewProps {
  studio: DigitalWorkerStudioState
  className: string
  assignedBy: string
  selectedProjectId: string
  statusFilter: '' | DigitalWorkerStatus
  activeTab: StudioTab
  hireOpen: boolean
  hireRoleId?: string
  hireRecommendation?: DigitalWorkerRoleRecommendation
  roleEditorOpen: boolean
  assignmentOpen: boolean
  assignmentWorkerId?: string
  projects: readonly DigitalWorkerStudioProject[]
  filteredWorkers: readonly DigitalWorker[]
  projectWorkers: readonly DigitalWorker[]
  assignments: readonly DigitalWorkerAssignment[]
  workItems: readonly DigitalWorkerStudioWorkItem[]
  onSelectProject: (projectId: string) => void
  onStatusFilter: (status: '' | DigitalWorkerStatus) => void
  onTab: (tab: StudioTab) => void
  onOpenHire: (roleId?: string) => void
  onAdoptRecommendation: (recommendation: DigitalWorkerRoleRecommendation) => void
  onCloseHire: () => void
  onRoleEditor: (open: boolean) => void
  onOpenAssignment: (workerId: string) => void
  onCloseAssignment: () => void
}

export function DigitalWorkerStudioView(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  useStore((state) => state.settings.language)
  return (
    <section
      className={`digital-worker-studio ${props.className}`.trim()}
      aria-labelledby="digital-worker-studio-title"
      data-studio-surface="digital-workers"
      data-project-id={props.selectedProjectId || undefined}
    >
      <StudioHeader {...props} />
      <StudioSummary {...props} />
      <StudioAlerts studio={props.studio} />
      <StudioEditors {...props} />
      <StudioTabbedContent {...props} />
    </section>
  )
}

function StudioHeader(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const { studio, projects, selectedProjectId, statusFilter } = props
  const hireDisabled = !selectedProjectId || studio.roles.length === 0 || studio.loading
  const hireTitle = !selectedProjectId
    ? studioLocalized('请先选择项目', 'Select a project first')
    : studio.roles.length === 0 ? studioLocalized('请先创建岗位模板', 'Create a role template first') : undefined
  return (
    <header className="dws-header">
      <div>
        <span className="dws-eyebrow">STUDIO</span>
        <h2 id="digital-worker-studio-title">{studioLocalized('数字员工与团队', 'Digital workers and teams')}</h2>
      </div>
      <div className="dws-toolbar">
        <label className="dws-filter">
          <span>{studioLocalized('项目', 'Project')}</span>
          <select value={selectedProjectId} onChange={(event) => props.onSelectProject(event.target.value)} aria-label={studioLocalized('按项目筛选数字员工', 'Filter digital workers by project')}>
            <option value="">{studioLocalized('全部项目', 'All projects')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="dws-filter">
          <span>{studioLocalized('状态', 'Status')}</span>
          <select value={statusFilter} onChange={(event) => props.onStatusFilter(event.target.value as '' | DigitalWorkerStatus)} aria-label={studioLocalized('按状态筛选数字员工', 'Filter digital workers by status')}>
            {statusFilters().map((status) => <option key={status.value || 'all'} value={status.value}>{status.label}</option>)}
          </select>
        </label>
        <button type="button" className="dws-button" onClick={() => void studio.refresh()} disabled={studio.loading || studio.busyKey !== null} data-dws-action="refresh">
          {studio.loading ? studioLocalized('刷新中...', 'Refreshing...') : studioLocalized('刷新', 'Refresh')}
        </button>
        <button
          type="button"
          className="dws-button"
          onClick={() => void studio.recommendTeam(selectedProjectId)}
          disabled={!selectedProjectId || studio.busyKey !== null}
          title={selectedProjectId ? studioLocalized('根据当前 Goal 生成必要岗位', 'Generate required roles from the current Goal') : studioLocalized('请先选择项目', 'Select a project first')}
          data-dws-action="recommend-team"
        >
          <Sparkles aria-hidden="true" />
          {studio.busyKey === 'team:recommend' ? studioLocalized('生成中...', 'Generating...') : studioLocalized('推荐团队', 'Recommend team')}
        </button>
        <button type="button" className="dws-button dws-button-primary" onClick={() => props.onOpenHire()} disabled={hireDisabled} title={hireTitle} data-dws-action="hire">
          {studioLocalized('招聘员工', 'Hire worker')}
        </button>
      </div>
    </header>
  )
}

function StudioSummary(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const { projectWorkers, assignments, studio } = props
  const active = projectWorkers.filter((worker) => worker.status === 'active').length
  const paused = projectWorkers.filter((worker) => worker.status === 'paused').length
  const assigned = assignments.filter((item) => item.assigneeKind === 'digital_worker').length
  return (
    <div className="dws-summary" aria-live="polite" aria-busy={studio.loading}>
      <div><span>{studioLocalized('团队规模', 'Team size')}</span><strong>{projectWorkers.length}</strong></div>
      <div><span>{studioLocalized('工作中', 'Active')}</span><strong>{active}</strong></div>
      <div><span>{studioLocalized('已暂停', 'Paused')}</span><strong>{paused}</strong></div>
      <div><span>{studioLocalized('任务分配', 'Assignments')}</span><strong>{assigned}</strong></div>
    </div>
  )
}

function StudioAlerts({ studio }: { studio: DigitalWorkerStudioState }): React.JSX.Element {
  return (
    <>
      {studio.error && (
        <div className="dws-notice dws-notice-error" role="alert">
          <span>{studio.error}</span>
          <button type="button" className="dws-button dws-button-quiet" onClick={studio.clearError}>{studioLocalized('关闭', 'Close')}</button>
        </div>
      )}
      <div className="dws-sr-only" role="status" aria-live="polite">{studio.notice}</div>
    </>
  )
}

function StudioEditors(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const { studio, selectedProjectId } = props
  return (
    <>
      {studio.recommendation?.projectId === selectedProjectId && (
        <TeamRecommendationPanel {...props} />
      )}
      {studio.workerMemory && (
        <WorkerMemoryPanel {...props} />
      )}
      {studio.workerHistory && (
        <WorkerHistoryPanel {...props} />
      )}
      {props.hireOpen && selectedProjectId && (
        <HireWorkerForm
          key={`${selectedProjectId}:${props.hireRoleId || ''}`}
          projectId={selectedProjectId}
          roles={studio.roles}
          initialRoleId={props.hireRoleId}
          recommendation={props.hireRecommendation}
          busy={studio.busyKey === 'worker:create'}
          onCancel={props.onCloseHire}
          onSubmit={(input, activate) => studio.createWorker({ input, activate })}
        />
      )}
      {props.assignmentOpen && selectedProjectId && (
        <AssignmentForm
          key={`${selectedProjectId}:${props.assignmentWorkerId || ''}`}
          projectId={selectedProjectId}
          workItems={props.workItems}
          workers={props.projectWorkers}
          assignments={props.assignments}
          initialWorkerId={props.assignmentWorkerId}
          busy={studio.busyKey?.startsWith('assignment:') === true}
          onCancel={props.onCloseAssignment}
          onSubmit={(workItemId, workerId, scope, reason) => studio.assignWorker({
            projectId: selectedProjectId,
            workItemId,
            workerId,
            assignedBy: props.assignedBy.trim() || 'user',
            scope,
            reason
          })}
        />
      )}
    </>
  )
}

function WorkerMemoryPanel(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const snapshot = props.studio.workerMemory
  if (!snapshot) return <></>
  const worker = props.studio.workers.find((candidate) => candidate.id === snapshot.workerId)
  const active = snapshot.workerStatus === 'active'
  return (
    <section className="dws-memory" aria-labelledby="dws-memory-title" data-dws-worker-memory={snapshot.workerId}>
      <header className="dws-recommendation-heading">
        <div>
          <span className="dws-eyebrow">WORKER MEMORY</span>
          <h3 id="dws-memory-title">{worker?.displayName ?? snapshot.workerId}</h3>
          <p className="dws-code">{snapshot.memoryNamespace}</p>
        </div>
        <button type="button" className="dws-button dws-button-quiet dws-icon-button" onClick={props.studio.closeWorkerMemory} aria-label={studioLocalized('关闭员工记忆', 'Close worker memory')} title={studioLocalized('关闭员工记忆', 'Close worker memory')}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="dws-memory-columns">
        <MemoryRecordSection title={studioLocalized('项目记忆', 'Project memory')} records={snapshot.projectMemories} empty={studioLocalized('无可读项目记忆', 'No readable project memory')} />
        <MemoryRecordSection
          title={studioLocalized('员工记忆', 'Worker memory')}
          records={snapshot.workerMemories}
          empty={studioLocalized('无已确认员工记忆', 'No approved worker memory')}
          actionLabel={studioLocalized('撤销', 'Revoke')}
          onAction={(record) => void props.studio.decideWorkerMemory(snapshot.workerId, record.id, 'revoke')}
          busyKey={props.studio.busyKey}
        />
        <MemoryRecordSection
          title={studioLocalized('待审核', 'Pending review')}
          records={snapshot.drafts}
          empty={studioLocalized('无待审核草稿', 'No drafts pending review')}
          onApprove={(record) => void props.studio.decideWorkerMemory(snapshot.workerId, record.id, 'approve')}
          onAction={(record) => void props.studio.decideWorkerMemory(snapshot.workerId, record.id, 'reject')}
          actionLabel={studioLocalized('拒绝', 'Reject')}
          busyKey={props.studio.busyKey}
        />
      </div>
      {active && (
        <WorkerMemoryForm
          busy={props.studio.busyKey === `memory:${snapshot.workerId}:propose`}
          onSubmit={(input) => props.studio.proposeWorkerMemory(snapshot.workerId, input)}
        />
      )}
      {snapshot.history.length > 0 && (
        <div className="dws-memory-history">
          <span>{studioLocalized('历史', 'History')} {snapshot.history.length}</span>
          {snapshot.history.map((record) => (
            <button
              key={record.id}
              type="button"
              className="dws-button dws-button-quiet"
              disabled={props.studio.busyKey !== null}
              onClick={() => void props.studio.decideWorkerMemory(snapshot.workerId, record.id, 'delete')}
              title={studioLocalized(`删除 ${record.payload.type === 'memory' ? record.payload.title : record.id}`, `Delete ${record.payload.type === 'memory' ? record.payload.title : record.id}`)}
            >
              <Trash2 aria-hidden="true" />
              {record.status}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function WorkerHistoryPanel(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const snapshot = props.studio.workerHistory
  if (!snapshot) return <></>
  const summary = [
    ['Assignment', snapshot.summary.assignments],
    ['Run', snapshot.summary.runs],
    ['Artifact', snapshot.summary.artifacts],
    ['Evidence', snapshot.summary.evidence],
    ['Acceptance', snapshot.summary.acceptances],
    ['Audit', snapshot.summary.audit]
  ] as const
  return (
    <section className="dws-memory dws-history" aria-labelledby="dws-history-title" data-dws-worker-history={snapshot.worker.id}>
      <header className="dws-recommendation-heading">
        <div>
          <span className="dws-eyebrow">IMMUTABLE DELIVERY HISTORY</span>
          <h3 id="dws-history-title">{snapshot.worker.displayName}</h3>
          <p className="dws-code">{snapshot.integrity.historyDigest}</p>
        </div>
        <div className="dws-history-actions">
          <button
            type="button"
            className="dws-button"
            disabled={props.studio.busyKey !== null}
            onClick={() => void props.studio.exportWorkerHistory(snapshot.worker.id)}
            data-dws-action="export-worker-history"
          >
            <Download aria-hidden="true" />
            {studioLocalized('导出历史', 'Export history')}
          </button>
          <button type="button" className="dws-button dws-button-quiet dws-icon-button" onClick={props.studio.closeWorkerHistory} aria-label={studioLocalized('关闭员工历史', 'Close worker history')} title={studioLocalized('关闭员工历史', 'Close worker history')}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="dws-history-summary" aria-label={studioLocalized('员工历史统计', 'Worker history statistics')}>
        {summary.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <div className="dws-history-runs">
        <h4>Run</h4>
        {snapshot.runs.length === 0 ? <span className="dws-muted">{studioLocalized('暂无执行记录', 'No execution records')}</span> : (
          <div role="list">
            {snapshot.runs.slice(-20).reverse().map((run) => (
              <div key={run.id} role="listitem" className="dws-history-run">
                <span className="dws-status">{run.status}</span>
                <strong>{workItemHistoryLabel(run.workItemId, props.workItems)}</strong>
                <code>{run.id}</code>
                <time dateTime={new Date(run.updatedAt).toISOString()}>{formatHistoryTime(run.updatedAt)}</time>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function workItemHistoryLabel(workItemId: string, workItems: readonly DigitalWorkerStudioWorkItem[]): string {
  return workItems.find((item) => item.id === workItemId)?.title ?? workItemId
}

function formatHistoryTime(value: number): string {
  return new Intl.DateTimeFormat(studioLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

interface MemoryRecordSectionProps {
  title: string
  records: readonly LearningRecord[]
  empty: string
  actionLabel?: string
  busyKey?: string | null
  onApprove?: (record: LearningRecord) => void
  onAction?: (record: LearningRecord) => void
}

function MemoryRecordSection(props: MemoryRecordSectionProps): React.JSX.Element {
  return (
    <section className="dws-memory-section">
      <h4>{props.title}</h4>
      {props.records.length === 0 ? <span className="dws-muted">{props.empty}</span> : (
        <div className="dws-memory-list">
          {props.records.map((record) => {
            const title = record.payload.type === 'memory' ? record.payload.title : record.id
            const body = record.payload.type === 'memory' ? record.payload.body : ''
            const busy = props.busyKey?.includes(record.id) === true
            return (
              <div key={record.id} className="dws-memory-row">
                <div><strong>{title}</strong><span>{body}</span></div>
                {(props.onApprove || props.onAction) && (
                  <div>
                    {props.onApprove && <button type="button" className="dws-button dws-icon-button" disabled={Boolean(props.busyKey)} onClick={() => props.onApprove?.(record)} aria-label={studioLocalized(`批准 ${title}`, `Approve ${title}`)} title={studioLocalized('批准', 'Approve')}><Check aria-hidden="true" /></button>}
                    {props.onAction && <button type="button" className="dws-button dws-button-quiet" disabled={Boolean(props.busyKey)} onClick={() => props.onAction?.(record)}>{busy ? studioLocalized('处理中...', 'Processing...') : props.actionLabel}</button>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function TeamRecommendationPanel(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const recommendation = props.studio.recommendation
  if (!recommendation) return <></>
  return (
    <section className="dws-recommendation" aria-labelledby="dws-recommendation-title" data-dws-team-recommendation={recommendation.digest}>
      <header className="dws-recommendation-heading">
        <div>
          <span className="dws-eyebrow">GOAL TEAM</span>
          <h3 id="dws-recommendation-title">{recommendation.source.goalTitle}</h3>
          <p>{recommendation.source.objective}</p>
        </div>
        <button
          type="button"
          className="dws-button dws-button-quiet dws-icon-button"
          onClick={props.studio.clearRecommendation}
          aria-label={studioLocalized('关闭团队建议', 'Close team recommendation')}
          title={studioLocalized('关闭团队建议', 'Close team recommendation')}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="dws-recommendation-grid">
        {recommendation.roles.map((role) => {
          const existing = props.studio.roles.find((candidate) => candidate.name.trim() === role.name.trim())
          const busy = props.studio.busyKey === `recommendation:${role.id}`
          return (
            <article key={role.id} className="dws-recommendation-card" data-recommended-role={role.watercolorRole}>
              <header>
                <div>
                  <h4>{role.name}</h4>
                  <span>{role.rationale}</span>
                </div>
                {role.id === recommendation.coordinatorRoleId && <span className="dws-role-source">{studioLocalized('负责人', 'Coordinator')}</span>}
              </header>
              <p>{role.purpose}</p>
              <RecommendationList title={studioLocalized('方法', 'Methods')} items={role.methods} />
              <RecommendationList title={studioLocalized('产出', 'Outputs')} items={role.outputs} />
              <RecommendationList title="Acceptance" items={role.acceptance} />
              <div className="dws-chip-row">
                {toolPolicyLabels(role.toolPolicy).map((label) => <span key={label} className="dws-chip">{label}</span>)}
                {recommendationDataLabels(role).map((label) => <span key={label} className="dws-chip">{label}</span>)}
                <span className="dws-chip">{recommendationBudgetLabel(role)}</span>
              </div>
              <footer>
                <button
                  type="button"
                  className="dws-button"
                  onClick={() => props.onAdoptRecommendation(role)}
                  disabled={props.studio.busyKey !== null}
                  data-dws-action="adopt-recommended-role"
                >
                  <UserPlus aria-hidden="true" />
                  {busy ? studioLocalized('采纳中...', 'Adopting...') : existing ? studioLocalized('配置员工', 'Configure worker') : studioLocalized('采纳岗位', 'Adopt role')}
                </button>
              </footer>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function RecommendationList({ title, items }: { title: string; items: readonly string[] }): React.JSX.Element {
  return (
    <div className="dws-recommendation-list">
      <h5>{title}</h5>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  )
}

function StudioTabbedContent(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const baseId = useId()
  const teamRef = useRef<HTMLButtonElement>(null)
  const rolesRef = useRef<HTMLButtonElement>(null)
  const choose = (tab: StudioTab): void => {
    props.onTab(tab)
    if (tab === 'team') teamRef.current?.focus()
    else rolesRef.current?.focus()
  }
  const handleKey = (event: React.KeyboardEvent, current: StudioTab): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') choose(current === 'team' ? 'roles' : 'team')
    else if (event.key === 'Home') choose('team')
    else if (event.key === 'End') choose('roles')
    else return
    event.preventDefault()
  }
  const teamTabId = `${baseId}-team-tab`
  const rolesTabId = `${baseId}-roles-tab`
  return (
    <>
      <div className="dws-tabs" role="tablist" aria-label={studioLocalized('数字员工 Studio 视图', 'Digital worker studio views')}>
        <button ref={teamRef} type="button" role="tab" id={teamTabId} aria-selected={props.activeTab === 'team'} aria-controls={`${baseId}-team-panel`} tabIndex={props.activeTab === 'team' ? 0 : -1} onClick={() => props.onTab('team')} onKeyDown={(event) => handleKey(event, 'team')}>
          {studioLocalized('团队', 'Team')} <span>{props.projectWorkers.length}</span>
        </button>
        <button ref={rolesRef} type="button" role="tab" id={rolesTabId} aria-selected={props.activeTab === 'roles'} aria-controls={`${baseId}-roles-panel`} tabIndex={props.activeTab === 'roles' ? 0 : -1} onClick={() => props.onTab('roles')} onKeyDown={(event) => handleKey(event, 'roles')}>
          {studioLocalized('岗位库', 'Role library')} <span>{props.studio.roles.length}</span>
        </button>
      </div>
      <StudioPanel {...props} baseId={baseId} teamTabId={teamTabId} rolesTabId={rolesTabId} />
    </>
  )
}

function StudioPanel(props: DigitalWorkerStudioViewProps & { baseId: string; teamTabId: string; rolesTabId: string }): React.JSX.Element {
  const { studio } = props
  if (studio.loading && studio.workers.length === 0 && studio.roles.length === 0) {
    return <div className="dws-loading" role="status"><span />{studioLocalized('正在加载团队...', 'Loading team...')}</div>
  }
  if (props.activeTab === 'team') {
    return (
      <div id={`${props.baseId}-team-panel`} role="tabpanel" aria-labelledby={props.teamTabId} tabIndex={0}>
        <WorkerRoster
          workers={props.filteredWorkers}
          roles={studio.roles}
          assignments={props.assignments}
          workItems={props.workItems}
          showProject={!props.selectedProjectId}
          busyKey={studio.busyKey}
          onActivate={(worker) => void studio.activateWorker(worker)}
          onPause={(worker) => void studio.pauseWorker(worker)}
          onResume={(worker) => void studio.resumeWorker(worker)}
          onRetire={(worker) => void studio.retireWorker(worker)}
          onRefreshPerformance={(worker) => void studio.refreshWorkerPerformance(worker)}
          onMemory={(worker) => void studio.openWorkerMemory(worker.id)}
          onHistory={(worker) => void studio.openWorkerHistory(worker.id)}
          onAssign={props.onOpenAssignment}
          onReleaseAssignment={(assignment) => void studio.releaseAssignment(assignment)}
          onHire={() => props.onOpenHire()}
        />
      </div>
    )
  }
  return (
    <div id={`${props.baseId}-roles-panel`} role="tabpanel" aria-labelledby={props.rolesTabId} tabIndex={0}>
      <div className="dws-panel-heading">
        <div><h3>{studioLocalized('岗位模板', 'Role templates')}</h3><span>{studioLocalized('版本化的职责与能力基线', 'Versioned responsibility and capability baselines')}</span></div>
        <button type="button" className="dws-button" onClick={() => props.onRoleEditor(true)} disabled={props.roleEditorOpen} data-dws-action="create-role">{studioLocalized('新建岗位', 'New role')}</button>
      </div>
      {props.roleEditorOpen && (
        <RoleTemplateForm busy={studio.busyKey === 'role:create'} onCancel={() => props.onRoleEditor(false)} onSubmit={studio.createRole} />
      )}
      <section className="dws-template-market" aria-label={studioLocalized('团队模板市场', 'Team template market')}>
        <div className="dws-panel-heading">
          <div><h3>{studioLocalized('团队模板市场', 'Team template market')}</h3><span>{studioLocalized('本地版本化模板，安装后可继续编辑岗位策略', 'Local versioned templates whose role policies remain editable after installation')}</span></div>
        </div>
        <div className="dws-template-market-grid">
          {TEAM_TEMPLATE_MARKET.map((pack) => {
            const installed = pack.roles.every((role) => role.id && studio.roles.some((item) => item.id === role.id))
            const busy = studio.busyKey === `team-template:${pack.id}`
            return (
              <article key={pack.id} className="dws-role-card" data-team-template-pack={pack.id}>
                <header><div><h3>{templateText(pack.name)}</h3><span>{studioLocalized(`${pack.roles.length} 个岗位`, `${pack.roles.length} roles`)}</span></div><span className="dws-role-source">{studioLocalized('组织策略', 'Organization policy')}</span></header>
                <p>{templateText(pack.summary)}</p>
                <div className="dws-muted">{templateText(pack.policy)}</div>
                <footer>
                  <button type="button" className="dws-button dws-button-primary" disabled={busy || studio.busyKey !== null || installed} onClick={() => void studio.installTeamTemplatePack(pack)}>
                    <PackagePlus aria-hidden="true" />{busy ? studioLocalized('安装中...', 'Installing...') : installed ? studioLocalized('已安装', 'Installed') : studioLocalized('安装模板', 'Install template')}
                  </button>
                </footer>
              </article>
            )
          })}
        </div>
      </section>
      <RoleLibrary
        roles={studio.roles}
        canHire={Boolean(props.selectedProjectId)}
        onCreate={() => props.onRoleEditor(true)}
        onHire={props.onOpenHire}
      />
    </div>
  )
}

function templateText(value: string): string {
  if (useStore.getState().settings.language !== 'en') return value
  const translations: Record<string, string> = {
    '软件交付团队': 'Software delivery team',
    '规划、开发、测试和独立审查四岗，适合代码与发布任务。': 'Four roles for planning, development, testing, and independent review, suited to code and release work.',
    '最小权限、独立审查、失败两次升级给 Project Owner': 'Least privilege, independent review, and escalation to the Project Owner after two failures',
    '研究与办公团队': 'Research and office team',
    '研究、写作、数据和演示四岗，适合报告与 Office 成品。': 'Four roles for research, writing, data, and presentations, suited to reports and Office deliverables.',
    '来源可追溯、数据写入需审批、成品必须有独立验收': 'Traceable sources, approval for data writes, and independent acceptance for final deliverables',
    '内容制作团队': 'Content production team',
    '策划、视觉、音频和成片审查四岗，适合视频 Studio。': 'Four roles for planning, visual production, audio, and final-cut review, suited to Video Studio.',
    '素材版本锁定、外部生成受预算约束、采用决定可追溯': 'Locked asset versions, budget-governed external generation, and traceable adoption decisions'
  }
  return translations[value] ?? value
}
