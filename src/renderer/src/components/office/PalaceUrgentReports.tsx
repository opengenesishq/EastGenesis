import type { CrossProjectWorkInboxItem } from '../studio/workInboxNavigation'
import type { PalaceUrgentReport } from './palace-urgent-reports'

export default function PalaceUrgentReports({ reports, zh, loading, openingTaskId, onOpen, onTask, onApprovals, onPermission, onDelivery }: {
  reports: PalaceUrgentReport[]
  zh: boolean
  loading: boolean
  openingTaskId?: string
  onOpen(item: CrossProjectWorkInboxItem): void
  onTask(item: CrossProjectWorkInboxItem): void
  onApprovals(item: CrossProjectWorkInboxItem): void
  onPermission(sessionId: string): void
  onDelivery(projectId: string, workItemId?: string): void
}): React.JSX.Element {
  const permissionCount = reports.reduce((total, report) => total + report.permissions.reduce((count, request) => count + request.count, 0), 0)
  return <div data-palace-urgent-reports>
    <div className="palace-work-summary">
      <span>{zh ? '急奏任务' : 'Urgent tasks'} <strong>{reports.length}</strong></span>
      <span>{zh ? '授权待办' : 'Pending permissions'} <strong>{permissionCount}</strong></span>
      <span>{zh ? '阻塞 / 失败' : 'Blocked / failed'} <strong>{reports.filter(report => report.item?.lane === 'blocked').length}</strong></span>
      <span>{zh ? '待交付' : 'Ready for delivery'} <strong>{reports.filter(report => report.item?.lane === 'ready_for_delivery').length}</strong></span>
    </div>
    {!loading && reports.length === 0 && <p>{zh ? '当前没有需要处理的急奏。' : 'No urgent reports need attention.'}</p>}
    {reports.map(report => {
      const item = report.item
      const taskAvailable = Boolean(item?.workItemId || item?.runId)
      return <article key={report.id} className="palace-work-row" data-palace-urgent-report={report.id}>
        <div><strong>{item?.title ?? report.permissions[0]?.title}</strong>
          {item && <p>{item.projectName} · {urgentState(item, zh)}{item.detail ? ` · ${item.detail}` : ''}</p>}
          {report.permissions.map(request => <p key={request.sessionId}>{request.title} · {request.count} {zh ? '项授权待办' : 'pending permissions'}</p>)}
        </div>
        {report.permissions.map(request => <button key={request.sessionId} type="button" className="btn btn-primary btn-sm" data-palace-urgent-permission={request.sessionId}
          onClick={() => onPermission(request.sessionId)}>{zh ? '处理授权' : 'Review permissions'} · {request.title}</button>)}
        {item && <>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!item.runId && !item.projectAvailable} onClick={() => onOpen(item)}>
            {item.sourceKind === 'goal' ? (zh ? '打开项目目标' : 'Open project goals') : item.lane === 'blocked' ? (zh ? '核对记录 / 恢复' : 'Review / recover') : (zh ? '查看记录' : 'View records')}
          </button>
          {taskAvailable && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(openingTaskId)} onClick={() => onTask(item)}>
            {openingTaskId === item.id ? (zh ? '正在打开…' : 'Opening…') : (zh ? '继续当前任务' : 'Continue task')}
          </button>}
          {taskAvailable && item.lane === 'needs_confirmation' && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(openingTaskId)} onClick={() => onApprovals(item)}>{zh ? '批奏折' : 'Review approval'}</button>}
          {item.projectId && item.lane === 'ready_for_delivery' && <button type="button" className="btn btn-primary btn-sm" disabled={!item.projectAvailable}
            data-palace-urgent-delivery={item.workItemId ?? item.id} onClick={() => onDelivery(item.projectId!, item.workItemId)}>{zh ? '处理交付与验收' : 'Review delivery and acceptance'}</button>}
        </>}
      </article>
    })}
  </div>
}

function urgentState(item: CrossProjectWorkInboxItem, zh: boolean): string {
  if (item.lane === 'blocked') return zh ? '阻塞 / 失败' : 'Blocked / failed'
  if (item.lane === 'ready_for_delivery') return zh ? '待交付' : 'Ready for delivery'
  if (item.lane === 'needs_confirmation') return zh ? '待确认' : 'Needs confirmation'
  return zh ? '等待授权处理' : 'Awaiting permission review'
}
