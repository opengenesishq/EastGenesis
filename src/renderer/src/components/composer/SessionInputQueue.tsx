import type { SessionInputRecord } from '../../../../shared/session-input-types'

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
  const pending = records.filter((record) => record.phase !== 'applied' && record.phase !== 'cancelled')
  if (!pending.length && !error) return null
  return <section className="composer-pending-inputs" aria-label={zh ? '当前任务的补充要求' : 'Additions to the current task'}>
    {error && <div className="composer-error" role="alert">{error}</div>}
    {pending.length > 0 && <div>{zh ? '补充要求已保存到当前任务。' : 'Additions are saved to this task. '}{running
      ? zh ? '本轮结束或暂停后可继续应用。' : 'Apply them when this turn ends or after pausing.'
      : zh ? '继续应用会在同一任务中发起下一轮。' : 'Continue and apply starts the next turn in the same task.'}</div>}
    {pending.map((record) => <div className="composer-pending-input" key={record.id}>
      <p>{record.payload.text || (zh ? '补充资料' : 'Additional materials')}{(record.payload.images?.length || record.payload.documents?.length) ? ` · ${(record.payload.images?.length ?? 0) + (record.payload.documents?.length ?? 0)} ${zh ? '个附件' : 'attachments'}` : ''}</p>
      {record.error && <div className="composer-error" role="status">{record.error}</div>}
      {record.phase === 'queued' ? <div className="composer-pending-actions">
        <button className="btn" disabled={running || Boolean(busy)} onClick={() => void onApply(record)}>{zh ? '继续并应用' : 'Continue and apply'}</button>
        <button className="btn" disabled={Boolean(busy)} onClick={() => void onCancel(record)}>{zh ? '撤回补充' : 'Withdraw addition'}</button>
      </div> : <button className="btn" disabled={Boolean(busy)} onClick={() => void onRefresh().catch(() => undefined)}>{zh ? '核对接收结果' : 'Check receipt'}</button>}
    </div>)}
  </section>
}
