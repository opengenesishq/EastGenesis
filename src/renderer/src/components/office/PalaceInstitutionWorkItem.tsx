import { useState } from 'react'
import type { WorkItem, WorkflowRunSummary } from '../../../../shared/types'
import type { SessionState } from '../../store'
import OfficeSessionActions from './OfficeSessionActions'
import { palaceInstitutionExecution } from './palaceActions'

/** An institution's task remains the same task while the user inspects and
 * operates its existing execution from the palace. No dispatch is created. */
export default function PalaceInstitutionWorkItem({ item, runs, sessions, zh, onRun, onStudy, onDelivery, onWorkItem }: {
  item: WorkItem
  runs: readonly WorkflowRunSummary[]
  sessions: Record<string, SessionState>
  zh: boolean
  onRun(runId: string): void
  onStudy(sessionId: string): void
  onDelivery(): void
  onWorkItem(): void
}): React.JSX.Element {
  const [runId, setRunId] = useState<string>()
  const execution = palaceInstitutionExecution(item, runs, Object.values(sessions).map(session => session.meta))
  const selectedRun = execution.runs.find(run => run.id === runId) ?? execution.runs[0]
  const session = execution.sessionId ? sessions[execution.sessionId] : undefined
  const controlsCurrentRun = item.runRefs.length === 0 || selectedRun?.id === item.runRefs.at(-1)
  return <article className="palace-institution-work-item" data-palace-institution-work-item={item.id}>
    <div className="palace-work-row"><div><strong>{item.title}</strong><p>{stateLabel(item.status, zh)} · {item.owner?.displayName || item.owner?.id || (zh ? '未分派' : 'Unassigned')} · {item.runRefs.length} {zh ? '次执行' : 'executions'} · {item.artifactRefs.length} {zh ? '产物' : 'artifacts'}</p></div>
      <button type="button" className="btn btn-ghost btn-sm" data-palace-institution-study onClick={() => session ? onStudy(session.meta.id) : onWorkItem()}>{zh ? '打开任务' : 'Open task'}</button>
      <button type="button" className="btn btn-ghost btn-sm" data-palace-institution-delivery onClick={onDelivery}>{zh ? '查看交付与验收' : 'Delivery and acceptance'}</button>
    </div>
    {execution.unavailableRuns > 0 && <p role="status">{zh ? `${execution.unavailableRuns} 次运行尚未读到匹配的记录，请刷新后查看。` : `${execution.unavailableRuns} runs have no matching record loaded. Refresh to inspect them.`}</p>}
    {selectedRun && <div className="palace-institution-run-controls">
      <label className="palace-work-selector">{zh ? '执行记录' : 'Execution history'}<select value={selectedRun.id} data-palace-institution-run-selector title={selectedRun.id}
        onChange={event => setRunId(event.target.value)}>{execution.runs.map(run => <option key={run.id} value={run.id}>{zh ? `第 ${item.runRefs.indexOf(run.id) + 1} 次执行` : `Execution ${item.runRefs.indexOf(run.id) + 1}`} · {stateLabel(run.status, zh)} · {new Date(run.startedAt ?? run.createdAt).toLocaleString()}</option>)}</select></label>
      <button type="button" className="btn btn-ghost btn-sm" data-palace-institution-run={selectedRun.id} onClick={() => onRun(selectedRun.id)}>{zh ? '核对运行 / 恢复' : 'Review / recover execution'}</button>
    </div>}
    {session && controlsCurrentRun && <OfficeSessionActions key={session.meta.id} session={session} />}
  </article>
}

function stateLabel(status: string, zh: boolean): string {
  if (!zh) return status.replaceAll('_', ' ')
  return ({ draft: '草稿', backlog: '待安排', planned: '待执行', planning: '规划中', queued: '排队中', ready: '待执行', running: '执行中', executing: '执行中', starting: '启动中', completed: '已完成',
    done: '已完成', succeeded: '已完成', failed: '失败', blocked: '阻塞', cancelled: '已取消', stopped: '已停止',
    waiting_approval: '等待审批', waiting_reconciliation: '等待核对', verifying: '验收中', recovering: '恢复中' } as Record<string, string>)[status] ?? status
}
