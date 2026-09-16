import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'
import type { OfficeOperationStatus } from './officeOperationRefresh'
import { SYSTEM_ROLES, type SystemRoleId, type SystemRoleSpec } from './kit/palace/systemRoleCatalog'
import type { TaskPlanStateView } from '../../../../shared/types'
import { palaceInstitutionWorkItems } from './palaceActions'
import './office-role-work-items.css'

/** Read-only projection. A scene role never becomes a task owner or an Agent. */
export function officeRoleWorkItems(roleId: SystemRoleId, workItems: readonly WorkItem[], plans: readonly TaskPlanStateView[] = []): WorkItem[] {
  return palaceInstitutionWorkItems(roleId, workItems, plans)
}

const STATUS_ZH: Record<WorkItem['status'], string> = {
  backlog: '待规划', ready: '待执行', running: '执行中', waiting_approval: '待审批',
  blocked: '已阻塞', verifying: '验收中', done: '已完成', failed: '失败', cancelled: '已取消'
}

export default function OfficeRoleWorkItems({ roleId, workItems, projects, status, zh, onOpen, onSelectRole, roles = SYSTEM_ROLES, plans = [] }: {
  roleId: SystemRoleId
  workItems: readonly WorkItem[]
  projects: readonly ProjectWorkspace[]
  status: OfficeOperationStatus
  zh: boolean
  onOpen: (item: WorkItem) => void
  onSelectRole: (roleId: SystemRoleId) => void
  roles?: readonly SystemRoleSpec[]
  plans?: readonly TaskPlanStateView[]
}): React.JSX.Element {
  const items = officeRoleWorkItems(roleId, workItems, plans)
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  return <section className="office-role-work-items" data-office-role-work-items={roleId}
    aria-label={zh ? '任务与负责人' : 'Tasks and owners'} aria-busy={status.state === 'loading'}>
    <label className="office-role-selector">{zh ? '查看职责' : 'View role'}
      <select value={roleId} data-office-role-selector onChange={(event) => onSelectRole(event.target.value as SystemRoleId)}>
        <option value="all">{zh ? '全部任务' : 'All tasks'}</option>
        {roles.map((role) => <option key={role.id} value={role.id}>{zh ? role.label : role.labelEn}</option>)}
      </select>
    </label>
    <p>{roleId === 'all'
      ? zh ? '协调事项：查看各项目的现有任务，进入工作台处理。' : 'Coordination: inspect existing project tasks and continue in the workbench.'
      : zh ? '按已批准方案中的机构职责或原任务角色显示；负责人以实际分派为准。' : 'Uses approved plan responsibilities or recorded task roles. Owners come from assignments.'}</p>
    {status.state === 'loading' && <p role="status">{zh ? '正在读取任务…' : 'Loading tasks…'}</p>}
    {status.state === 'stale' && <p role="alert" data-office-role-work-items-error>{zh ? '任务刷新失败，以下为最近读取的记录。' : 'Task refresh failed. Showing the last available records.'}</p>}
    {status.state !== 'loading' && items.length === 0 && <p data-office-role-work-items-empty>{status.state === 'stale'
      ? zh ? '当前没有可显示的记录。' : 'No records are available.'
      : roleId === 'all' ? zh ? '暂无任务。' : 'No tasks yet.'
        : zh ? '尚无明确分派给此角色的任务。场景人物不表示已有执行者。' : 'No task has this role. A scene figure does not indicate a configured executor.'}</p>}
    {items.length > 0 && <>
      <p data-office-role-work-items-count={items.length}>{zh ? `显示 ${Math.min(items.length, 20)} / ${items.length} 项` : `Showing ${Math.min(items.length, 20)} of ${items.length}`}</p>
      <ul>{items.slice(0, 20).map((item) => <li key={`${item.projectId}:${item.id}`} data-office-role-work-item={item.id}>
        <strong>{item.title}</strong>
        <span>{projectNames.get(item.projectId) ?? item.projectId}</span>
        <span data-office-role-work-item-status={item.status}>{zh ? STATUS_ZH[item.status] : item.status}</span>
        <span data-office-role-work-item-owner={item.owner?.id ?? ''}>{zh ? '负责人：' : 'Owner: '}{item.owner
          ? `${item.owner.displayName || item.owner.id} · ${item.owner.type === 'human' ? zh ? '人类' : 'Human' : zh ? '数字员工' : 'Digital worker'}`
          : zh ? '未分派' : 'Unassigned'}</span>
        <span>{zh ? `依赖 ${item.dependencyIds.length} · 执行记录 ${item.runRefs.length} · 产物 ${item.artifactRefs.length}`
          : `${item.dependencyIds.length} dependencies · ${item.runRefs.length} runs · ${item.artifactRefs.length} artifacts`}</span>
        <button type="button" className="btn btn-primary btn-sm" data-office-open-role-work-item={item.id}
          onClick={() => onOpen(item)}>{zh ? '在工作台处理' : 'Open in workbench'}</button>
      </li>)}</ul>
    </>}
  </section>
}
