import { useMemo, useState } from 'react'
import type { ProjectWorkspace, WorkflowLedgerRendererSelection } from '../../../../shared/types'
import type { SessionState } from '../../store'
import type { CrossProjectWorkInboxItem } from '../studio/workInboxNavigation'
import { palaceCourtHasRisk, palaceCourtNeedsDecision, palaceCourtProjection, type PalaceCourtRow } from './palace-court-projection'

type CourtFilter = 'all' | 'decisions' | 'risks' | 'running'
export default function PalaceCourtOverview({ ledger, projects, sessions, updatedAt, zh, openingTaskId, onOpen, onTask, onApprovals, onPermission, onDelivery }: {
  ledger: WorkflowLedgerRendererSelection
  projects: ProjectWorkspace[]
  sessions: Record<string, SessionState>
  updatedAt?: number
  zh: boolean
  openingTaskId?: string
  onOpen(item: CrossProjectWorkInboxItem): void
  onTask(item: CrossProjectWorkInboxItem): void
  onApprovals(item: CrossProjectWorkInboxItem): void
  onPermission(sessionId: string): void
  onDelivery(projectId: string, workItemId?: string): void
}): React.JSX.Element {
  const [filter, setFilter] = useState<CourtFilter>('all')
  const court = useMemo(() => palaceCourtProjection(ledger, projects, Object.values(sessions), updatedAt ?? Date.now()), [ledger, projects, sessions, updatedAt])
  const matches = (row: PalaceCourtRow): boolean => filter === 'all' || (filter === 'decisions' && palaceCourtNeedsDecision(row)) ||
    (filter === 'risks' && palaceCourtHasRisk(row)) || (filter === 'running' && row.item.lane === 'running')
  const decisions = court.rows.filter(palaceCourtNeedsDecision).length + court.unboundPermissions.length
  const risks = court.rows.filter(palaceCourtHasRisk).length
  const completed = court.rows.filter(row => row.item.lane === 'completed').length
  const resources = court.resources
  return <div data-palace-court-overview>
    <div className="palace-work-summary">
      <span>{zh ? '已完成事项' : 'Completed items'} <strong>{completed} / {court.rows.length}</strong></span>
      <span>{zh ? '待裁决事项' : 'Needs a decision'} <strong>{decisions}</strong></span>
      <span>{zh ? '风险事项' : 'Items at risk'} <strong>{risks}</strong></span>
    </div>
    <p>{zh ? '按目标汇总当前任务；待交付成果仍需验收，历史运行不重复计入当前进度。' : 'Current work is grouped by goal. Ready results still need acceptance; historical runs do not count again.'}</p>
    <details data-palace-court-resources open><summary>{zh ? '执行资源与已记录费用' : 'Execution resources and recorded cost'}</summary>
      <div className="palace-work-summary">
        <span>{zh ? '执行中' : 'Executing'} <strong>{resources.activeRuns}</strong></span>
        <span>{zh ? '排队' : 'Queued'} <strong>{resources.queuedRuns}</strong></span>
        <span>{zh ? '等待审批' : 'Awaiting approval'} <strong>{resources.waitingApproval}</strong></span>
        <span>{zh ? '等待对账' : 'Awaiting reconciliation'} <strong>{resources.reconciliation}</strong></span>
        <span>{zh ? '关联会话已知累计费用' : 'Known cumulative cost of linked sessions'} <strong>${resources.knownSessionCostUsd.toFixed(4)}</strong></span>
      </div>
      <p>{zh ? `费用来自当前执行关联的 ${resources.costSessions} 个已载入会话，同一会话只计一次；另有 ${resources.unknownCostSessions} 个会话费用未知。` : `Cost covers ${resources.costSessions} loaded sessions linked to current executions, counted once each; ${resources.unknownCostSessions} session costs are unknown.`}</p>
    </details>
    <nav className="palace-work-summary" aria-label={zh ? '上朝事项筛选' : 'Court item filters'}>{(['all', 'decisions', 'risks', 'running'] as const).map(value =>
      <button key={value} type="button" className="btn btn-ghost btn-sm" data-palace-court-filter={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
        {({ all: ['全部', 'All'], decisions: ['待裁决', 'Decisions'], risks: ['风险', 'Risks'], running: ['运行中', 'Running'] })[value][zh ? 0 : 1]}
      </button>)}</nav>
    {!court.rows.some(matches) && (!(filter === 'all' || filter === 'decisions') || court.unboundPermissions.length === 0) && <p>{zh ? '当前没有匹配事项。' : 'No matching items.'}</p>}
    {court.groups.map(group => {
      const rows = group.rows.filter(matches)
      if (!rows.length) return null
      return <section key={group.id} data-palace-court-goal={group.id}>
        <h3>{group.title ?? (zh ? '未关联目标的工作' : 'Work without a linked goal')}</h3>
        <p>{group.projectName} · {zh ? '已完成' : 'Completed'} {group.rows.filter(row => row.item.lane === 'completed').length} / {group.rows.length}</p>
        {rows.map(row => <article key={row.item.id} className="palace-work-row" data-palace-court-item={row.item.id}>
          <div><strong>{row.item.title}</strong><p>{rowState(row, zh)}{row.item.detail ? ` · ${row.item.detail}` : ''}</p></div>
          {row.permissions.map(request => <button key={request.sessionId} type="button" className="btn btn-primary btn-sm" data-palace-court-permission={request.sessionId}
            onClick={() => onPermission(request.sessionId)}>{zh ? '处理授权' : 'Review permissions'} · {request.title} ({request.count})</button>)}
          <button type="button" className="btn btn-ghost btn-sm" disabled={!row.item.runId && !row.item.projectAvailable} onClick={() => onOpen(row.item)}>
            {row.item.sourceKind === 'goal' ? (zh ? '查看目标' : 'View goal') : palaceCourtHasRisk(row) ? (zh ? '核对记录 / 恢复' : 'Review / recover') : (zh ? '查看记录' : 'View records')}
          </button>
          {(row.item.workItemId || row.item.runId) && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(openingTaskId)} onClick={() => onTask(row.item)}>
            {openingTaskId === row.item.id ? (zh ? '正在打开…' : 'Opening…') : (zh ? '继续当前任务' : 'Continue task')}
          </button>}
          {row.item.lane === 'needs_confirmation' && (row.item.workItemId || row.item.runId) && <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(openingTaskId)} onClick={() => onApprovals(row.item)}>{zh ? '批奏折' : 'Review approval'}</button>}
          {row.item.projectId && row.item.lane === 'ready_for_delivery' && <button type="button" className="btn btn-primary btn-sm" disabled={!row.item.projectAvailable}
            data-palace-court-delivery={row.item.workItemId ?? row.item.id} onClick={() => onDelivery(row.item.projectId!, row.item.workItemId)}>{zh ? '处理交付与验收' : 'Review delivery and acceptance'}</button>}
        </article>)}
      </section>
    })}
    {(filter === 'all' || filter === 'decisions') && court.unboundPermissions.map(report => <article className="palace-work-row" key={report.id} data-palace-court-item={report.id}>
      <div><strong>{report.permissions[0].title}</strong><p>{zh ? '会话授权待办，尚无对应账本事项。' : 'Session permission request without a matching ledger item.'}</p></div>
      {report.permissions.map(request => <button key={request.sessionId} type="button" className="btn btn-primary btn-sm" data-palace-court-permission={request.sessionId}
        onClick={() => onPermission(request.sessionId)}>{zh ? '处理授权' : 'Review permissions'} ({request.count})</button>)}
    </article>)}
  </div>
}

function rowState(row: PalaceCourtRow, zh: boolean): string {
  const state = ({ needs_confirmation: ['待确认', 'Needs confirmation'], running: ['运行中', 'Running'], blocked: ['阻塞 / 失败', 'Blocked / failed'],
    ready_for_delivery: ['待交付', 'Ready for delivery'], completed: ['已完成', 'Completed'] })[row.item.lane][zh ? 0 : 1]
  return [state, row.run?.status === 'queued' ? (zh ? '排队中' : 'Queued') : '', row.run?.status === 'waiting_reconciliation' ? (zh ? '外部操作结果待核对' : 'External effect awaits reconciliation') : '',
    row.overdue ? (zh ? '已超过截止时间' : 'Past due') : '', row.missingRun ? (zh ? '当前执行记录缺失' : 'Current execution record missing') : ''].filter(Boolean).join(' · ')
}
