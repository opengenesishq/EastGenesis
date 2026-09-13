import { useState } from 'react'
import { Brain, Gauge, History, Unlink } from 'lucide-react'
import type { DigitalWorker, DigitalWorkerAssignment, RoleTemplate } from '../../../../shared/types'
import type { DigitalWorkerStudioWorkItem } from './digital-worker-studio-model'
import {
  WATERCOLOR_ROLE_LABELS,
  WORKER_STATUS_LABELS,
  acceptancePolicyLabels,
  assignmentsForWorker,
  budgetLabel,
  compactId,
  dataScopeLabels,
  escalationPolicyLabels,
  permissionsFor,
  performanceProfileLabels,
  roleForWorker,
  studioLocalized,
  watercolorRoleForWorker,
  workerInitials,
  workItemTitle
} from './digital-worker-studio-model'

interface WorkerRosterProps {
  workers: readonly DigitalWorker[]
  roles: readonly RoleTemplate[]
  assignments: readonly DigitalWorkerAssignment[]
  workItems: readonly DigitalWorkerStudioWorkItem[]
  showProject: boolean
  busyKey: string | null
  onActivate: (worker: DigitalWorker) => void
  onPause: (worker: DigitalWorker) => void
  onResume: (worker: DigitalWorker) => void
  onRetire: (worker: DigitalWorker) => void
  onRefreshPerformance: (worker: DigitalWorker) => void
  onMemory: (worker: DigitalWorker) => void
  onHistory: (worker: DigitalWorker) => void
  onAssign: (workerId: string) => void
  onReleaseAssignment: (assignment: DigitalWorkerAssignment) => void
  onHire: () => void
}

export function WorkerRoster(props: WorkerRosterProps): React.JSX.Element {
  const { workers, onHire } = props
  if (workers.length === 0) {
    return (
      <div className="dws-empty" role="status">
        <strong>{studioLocalized('当前筛选下没有数字员工', 'No digital workers match the current filters')}</strong>
        <button type="button" className="dws-button dws-button-primary" onClick={onHire}>{studioLocalized('招聘员工', 'Hire worker')}</button>
      </div>
    )
  }
  return (
    <div className="dws-worker-grid" role="list" aria-label={studioLocalized('数字员工列表', 'Digital worker list')}>
      {workers.map((worker) => <WorkerCard key={worker.id} worker={worker} {...props} />)}
    </div>
  )
}

function WorkerCard(props: WorkerRosterProps & { worker: DigitalWorker }): React.JSX.Element {
  const {
    worker,
    roles,
    assignments,
    workItems,
    showProject,
    busyKey
  } = props
  const role = roleForWorker(worker, roles)
  const watercolorRole = watercolorRoleForWorker(worker, role)
  const permissions = permissionsFor(worker)
  const activeAssignments = assignmentsForWorker(worker.id, assignments)
  const busy = busyKey !== null

  return (
    <article
      className="dws-worker-card"
      role="listitem"
      aria-labelledby={`dws-worker-${worker.id}`}
      data-digital-worker-id={worker.id}
      data-digital-worker-status={worker.status}
      data-watercolor-role={watercolorRole.role}
      data-watercolor-role-source={watercolorRole.source}
    >
      <header className="dws-worker-head">
        <div className="dws-avatar" aria-hidden="true">{workerInitials(worker.displayName)}</div>
        <div className="dws-worker-identity">
          <h3 id={`dws-worker-${worker.id}`}>{worker.displayName}</h3>
          <span>{role?.name || studioLocalized('岗位模板不可用', 'Role template unavailable')} · v{worker.roleTemplateVersion} · {WATERCOLOR_ROLE_LABELS[watercolorRole.role]}</span>
        </div>
        <span className={`dws-status dws-status-${worker.status}`}>
          <span className="dws-status-dot" aria-hidden="true" />
          {WORKER_STATUS_LABELS[worker.status]}
        </span>
      </header>

      {showProject && <div className="dws-project-line"><span>{studioLocalized('项目', 'Project')}</span><code>{compactId(worker.projectId)}</code></div>}

      <div className="dws-worker-metrics" aria-label={studioLocalized('员工运行配置', 'Worker runtime configuration')}>
        <div><span>{studioLocalized('预算', 'Budget')}</span><strong>{budgetLabel(worker.budgetPolicy)}</strong></div>
        <div><span>{studioLocalized('并发', 'Concurrency')}</span><strong>{worker.concurrencyLimit}</strong></div>
        <div><span>{studioLocalized('任务', 'Tasks')}</span><strong>{activeAssignments.length}</strong></div>
      </div>

      <section className="dws-worker-section" aria-label={studioLocalized('职责', 'Responsibilities')}>
        <h4>{studioLocalized('职责', 'Responsibilities')}</h4>
        {worker.responsibilityScope.length > 0 ? (
          <ul>{worker.responsibilityScope.map((item) => <li key={item}>{item}</li>)}</ul>
        ) : <span className="dws-muted">{studioLocalized('沿用岗位职责', 'Uses role responsibilities')}</span>}
      </section>

      <section className="dws-worker-section" aria-label={studioLocalized('工具权限', 'Tool permissions')}>
        <h4>{studioLocalized('工具权限', 'Tool permissions')}</h4>
        <div className="dws-chip-row">
          {(permissions.length > 0 ? permissions : [studioLocalized('未授予工具权限', 'No tool permissions granted')]).map((permission) => (
            <span key={permission} className="dws-chip">{permission}</span>
          ))}
        </div>
      </section>

      <section className="dws-worker-section" aria-label={studioLocalized('数据范围', 'Data scope')}>
        <h4>{studioLocalized('数据范围', 'Data scope')}</h4>
        <div className="dws-chip-row">
          {dataScopeLabels(worker).map((label) => <span key={label} className="dws-chip">{label}</span>)}
        </div>
      </section>

      <section className="dws-worker-section" aria-label={studioLocalized('验收与升级策略', 'Acceptance and escalation policy')}>
        <h4>{studioLocalized('验收与升级', 'Acceptance and escalation')}</h4>
        <div className="dws-chip-row">
          {acceptancePolicyLabels(worker).map((label) => <span key={`acceptance:${label}`} className="dws-chip">{label}</span>)}
          {escalationPolicyLabels(worker).map((label) => <span key={`escalation:${label}`} className="dws-chip">{label}</span>)}
        </div>
      </section>

      <section className="dws-worker-section" aria-label={studioLocalized('绩效', 'Performance')}>
        <h4>{studioLocalized('绩效', 'Performance')}</h4>
        <div className="dws-chip-row">
          {performanceProfileLabels(worker).map((label) => <span key={label} className="dws-chip">{label}</span>)}
        </div>
      </section>

      <section className="dws-worker-section" aria-label={studioLocalized('已分配 WorkItem', 'Assigned work items')}>
        <h4>WorkItem</h4>
        {activeAssignments.length > 0 ? (
          <ul className="dws-assignment-list">
            {activeAssignments.map((assignment) => (
              <li key={assignment.id} className="dws-assignment-row">
                <span>{workItemTitle(assignment.workItemId, workItems)}</span>
                <button
                  type="button"
                  className="dws-button dws-button-quiet dws-icon-button"
                  disabled={busy}
                  onClick={() => props.onReleaseAssignment(assignment)}
                  aria-label={studioLocalized(`解除 ${workItemTitle(assignment.workItemId, workItems)} 分配`, `Release assignment for ${workItemTitle(assignment.workItemId, workItems)}`)}
                  title={studioLocalized('解除分配', 'Release assignment')}
                  data-dws-action="release-assignment"
                  data-assignment-id={assignment.id}
                >
                  <Unlink aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : <span className="dws-muted">{studioLocalized('暂无分配', 'No assignments')}</span>}
      </section>

      <WorkerCardActions {...props} worker={worker} busy={busy} />
    </article>
  )
}

type WorkerCardActionsProps = Pick<
  WorkerRosterProps,
  | 'onActivate' | 'onPause' | 'onResume' | 'onRetire' | 'onRefreshPerformance'
  | 'onMemory' | 'onHistory' | 'onAssign'
> & { worker: DigitalWorker; busy: boolean }

function WorkerCardActions(props: WorkerCardActionsProps): React.JSX.Element {
  const {
    worker, busy, onActivate, onPause, onResume, onRetire,
    onRefreshPerformance, onMemory, onHistory, onAssign
  } = props
  const [confirmRetire, setConfirmRetire] = useState(false)
  if (confirmRetire && worker.status !== 'retired') {
    return (
      <div className="dws-retire-confirm" role="alert">
        <span>{studioLocalized('退休后不可重新启用；请先解除所有在办任务。', 'Retired workers cannot be reactivated. Release all active assignments first.')}</span>
        <div>
          <button type="button" className="dws-button dws-button-danger" disabled={busy} onClick={() => onRetire(worker)} data-dws-action="confirm-retire">{studioLocalized('确认退休', 'Confirm retirement')}</button>
          <button type="button" className="dws-button dws-button-quiet" disabled={busy} onClick={() => setConfirmRetire(false)}>{studioLocalized('取消', 'Cancel')}</button>
        </div>
      </div>
    )
  }
  return (
    <footer className="dws-worker-actions">
      <button type="button" className="dws-button" disabled={busy} onClick={() => onMemory(worker)} aria-label={studioLocalized(`查看 ${worker.displayName} 的记忆`, `View memory for ${worker.displayName}`)} data-dws-action="worker-memory">
        <Brain aria-hidden="true" />{studioLocalized('记忆', 'Memory')}
      </button>
      <button type="button" className="dws-button" disabled={busy} onClick={() => onHistory(worker)} aria-label={studioLocalized(`查看 ${worker.displayName} 的交付历史`, `View delivery history for ${worker.displayName}`)} data-dws-action="worker-history">
        <History aria-hidden="true" />{studioLocalized('历史', 'History')}
      </button>
      {worker.status !== 'retired' && (
        <button type="button" className="dws-button" disabled={busy} onClick={() => onRefreshPerformance(worker)} aria-label={studioLocalized(`刷新 ${worker.displayName} 的绩效`, `Refresh performance for ${worker.displayName}`)} data-dws-action="refresh-performance">
          <Gauge aria-hidden="true" />{studioLocalized('刷新绩效', 'Refresh performance')}
        </button>
      )}
      {worker.status === 'proposed' && (
        <button type="button" className="dws-button dws-button-primary" disabled={busy} onClick={() => onActivate(worker)} aria-label={studioLocalized(`启用 ${worker.displayName}`, `Activate ${worker.displayName}`)} data-dws-action="activate">{studioLocalized('启用', 'Activate')}</button>
      )}
      {worker.status === 'active' && (
        <>
          <button type="button" className="dws-button dws-button-primary" disabled={busy} onClick={() => onAssign(worker.id)} aria-label={studioLocalized(`给 ${worker.displayName} 分配 WorkItem`, `Assign a work item to ${worker.displayName}`)} data-dws-action="assign">{studioLocalized('分配任务', 'Assign task')}</button>
          <button type="button" className="dws-button" disabled={busy} onClick={() => onPause(worker)} aria-label={studioLocalized(`暂停 ${worker.displayName}`, `Pause ${worker.displayName}`)} data-dws-action="pause">{studioLocalized('暂停', 'Pause')}</button>
        </>
      )}
      {worker.status === 'paused' && (
        <button type="button" className="dws-button dws-button-primary" disabled={busy} onClick={() => onResume(worker)} aria-label={studioLocalized(`恢复 ${worker.displayName}`, `Resume ${worker.displayName}`)} data-dws-action="resume">{studioLocalized('恢复', 'Resume')}</button>
      )}
      {worker.status !== 'retired' && (
        <button type="button" className="dws-button dws-button-quiet" disabled={busy} onClick={() => setConfirmRetire(true)} aria-label={studioLocalized(`退休 ${worker.displayName}`, `Retire ${worker.displayName}`)} data-dws-action="retire">{studioLocalized('退休', 'Retire')}</button>
      )}
    </footer>
  )
}

interface RoleLibraryProps {
  roles: readonly RoleTemplate[]
  canHire: boolean
  onCreate: () => void
  onHire: (roleId: string) => void
}

export function RoleLibrary({ roles, canHire, onCreate, onHire }: RoleLibraryProps): React.JSX.Element {
  if (roles.length === 0) {
    return (
      <div className="dws-empty" role="status">
        <strong>{studioLocalized('岗位库为空', 'The role library is empty')}</strong>
        <button type="button" className="dws-button dws-button-primary" onClick={onCreate}>{studioLocalized('新建岗位', 'New role')}</button>
      </div>
    )
  }
  return (
    <div className="dws-role-grid" role="list" aria-label={studioLocalized('岗位模板列表', 'Role template list')}>
      {roles.map((role) => (
        <article key={role.id} className="dws-role-card" role="listitem" data-role-template-id={role.id}>
          <header>
            <div>
              <h3>{role.name}</h3>
              <span>{studioLocalized('版本', 'Version')} {role.version}</span>
            </div>
            <span className="dws-role-source">{role.source === 'builtin' ? studioLocalized('内置', 'Built in') : studioLocalized('自定义', 'Custom')}</span>
          </header>
          <p>{role.purpose}</p>
          {(role.capabilityRefs.length > 0 || role.skillRefs.length > 0) && (
            <div className="dws-chip-row" aria-label={studioLocalized('岗位能力与技能', 'Role capabilities and skills')}>
              {[...new Set([...role.capabilityRefs, ...role.skillRefs])].map((item) => <span key={item} className="dws-chip">{item}</span>)}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="dws-button dws-button-primary"
              onClick={() => onHire(role.id)}
              disabled={!canHire}
              title={canHire ? undefined : studioLocalized('请先选择项目', 'Select a project first')}
              data-dws-action="hire-from-role"
            >
              {studioLocalized('按此岗位招聘', 'Hire for this role')}
            </button>
          </footer>
        </article>
      ))}
    </div>
  )
}
