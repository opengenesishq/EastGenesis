import type { WorkItem } from '../../../../shared/types'

/** Institution seats select existing work. Meeting a person is navigation and
 * cannot create another council, task, session, or permission grant. */
export default function PalaceAudienceTasks({ items, zh, loading, openingTaskId, onMeet, onWorkItem }: {
  items: WorkItem[]
  zh: boolean
  loading: boolean
  openingTaskId?: string
  onMeet(item: WorkItem): void
  onWorkItem(item: WorkItem): void
}): React.JSX.Element {
  return <div data-palace-audience-tasks>
    <p>{zh ? '选择该机构已分派的任务，召见其当前执行 Agent。' : 'Choose assigned work to meet the Agent handling its current execution.'}</p>
    {!loading && items.length === 0 && <p role="status">{zh ? '当前没有可确认归属的任务，该机构暂无可召见的执行 Agent。' : 'This institution has no confirmed assignment or executing Agent to meet.'}</p>}
    {items.map(item => <article key={`${item.projectId}:${item.id}`} className="palace-work-row" data-palace-audience-work-item={item.id}>
      <div><strong>{item.title}</strong><p>{item.owner?.displayName || item.owner?.id || (zh ? '未分派负责人' : 'No assigned owner')} · {stateLabel(item.status, zh)}</p></div>
      <button type="button" className="btn btn-primary btn-sm" data-palace-audience-meet={item.id} disabled={Boolean(openingTaskId)}
        onClick={() => onMeet(item)}>{openingTaskId === `work-item:${item.id}` ? (zh ? '正在定位…' : 'Locating…') : (zh ? '召见当前 Agent' : 'Meet current Agent')}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onWorkItem(item)}>{zh ? '查看工作项' : 'View work item'}</button>
    </article>)}
  </div>
}

function stateLabel(status: WorkItem['status'], zh: boolean): string {
  if (!zh) return status.replaceAll('_', ' ')
  return ({ backlog: '待安排', ready: '待执行', waiting_approval: '等待审批', running: '执行中', verifying: '验收中', blocked: '阻塞', failed: '失败', done: '完成', cancelled: '已取消' } satisfies Record<WorkItem['status'], string>)[status]
}
