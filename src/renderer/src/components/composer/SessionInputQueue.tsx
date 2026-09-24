import type { SessionInputRecord } from '../../../../shared/session-input-types'
import { useState } from 'react'
import GoalObjectiveRevision from '../workbench/GoalObjectiveRevision'
import { useStore } from '../../store'
import TaskRequirementRevision from '../experience/TaskRequirementRevision'

export default function SessionInputQueue({ records, running, busy, error, onApply, onCancel, onRefresh, zh = true }: {
  records: SessionInputRecord[]
  running: boolean
  busy: string | null
  error: string
  zh?: boolean
  onApply(record: SessionInputRecord): Promise<void>
  onCancel(record: SessionInputRecord): Promise<void>
  onRefresh(): Promise<void>
}): React.JSX.Element | null {
  const sessions = useStore(state => state.sessions)
  const [review, setReview] = useState<SessionInputRecord>()
  const pending = records.filter((record) => record.phase !== 'applied' && record.phase !== 'requirements_applied' && record.phase !== 'goal_revised' && record.phase !== 'cancelled')
  if (!pending.length && !error && !review) return null
  return <section className="composer-pending-inputs" aria-label={zh ? '当前任务的补充要求' : 'Additions to the current task'}>
    {error && <div className="composer-error" role="alert">{error}</div>}
    {pending.length > 0 && <div>{zh ? '补充内容已保存到当前任务，按提交顺序处理。' : 'Additions are saved to this task and processed in order.'}</div>}
    {pending.map((record) => <div className="composer-pending-input" key={record.id}>
      <p>{record.payload.text || (zh ? '补充资料' : 'Additional materials')}{(record.payload.images?.length || record.payload.documents?.length) ? ` · ${(record.payload.images?.length ?? 0) + (record.payload.documents?.length ?? 0)} ${zh ? '个附件' : 'attachments'}` : ''}</p>
      {record.error && <div className="composer-error" role="status">{record.error}</div>}
      {record.phase === 'queued' && record.followUp && <div role="status">{record.followUp.state === 'paused'
        ? zh ? '自动继续已暂停，请手动继续。' : 'Automatic continuation paused. Continue manually.'
        : record.followUp.behavior === 'pause_and_apply'
          ? zh ? '正在等待安全暂停，随后在原任务应用。' : 'Waiting for a safe pause before applying in this task.'
          : zh ? '已排队，本轮结束后在原任务自动继续。' : 'Queued to continue automatically after the current turn.'}</div>}
      {record.phase === 'queued' ? <div className="composer-pending-actions">
        {record.payload.goalRevisionIntent ? <button className="btn" disabled={Boolean(busy)} onClick={() => setReview(record)}>{zh ? '复核目标修订' : 'Review goal revision'}</button>
          : record.payload.requirementRevisionIntent ? <button className="btn" disabled={Boolean(busy)} onClick={() => setReview(record)}>{zh ? '复核交付要求修订' : 'Review requirement revision'}</button>
          : <button className="btn" disabled={running || Boolean(busy) || record.followUp?.state === 'armed'} onClick={() => void onApply(record)}>{zh ? '继续并应用' : 'Continue and apply'}</button>}
        <button className="btn" disabled={Boolean(busy)} onClick={() => void onCancel(record)}>{zh ? '撤回补充' : 'Withdraw addition'}</button>
      </div> : <button className="btn" disabled={Boolean(busy)} onClick={() => void onRefresh().catch(() => undefined)}>{zh ? '核对接收结果' : 'Check receipt'}</button>}
    </div>)}
    {review?.payload.goalRevisionIntent && sessions[review.sessionId]?.meta && <GoalObjectiveRevision meta={sessions[review.sessionId].meta} initialRecord={review} onClose={() => { setReview(undefined); void onRefresh().catch(() => undefined) }} />}
    {review && !review.payload.goalRevisionIntent && <TaskRequirementRevision sessionId={review.sessionId} initialText={review.payload.text} initialRecord={review} onClose={() => { setReview(undefined); void onRefresh().catch(() => undefined) }} />}
  </section>
}
