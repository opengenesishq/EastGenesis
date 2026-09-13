import { useStore } from '../../store'
import './personal-task-recovery.css'
import { useEffect, useState } from 'react'
import { createPersonalTaskSubmissionClient, type PersonalTaskSubmissionRecovery } from '../../lib/personal-task-submission'
import { clearRecoveredWelcomeInput, openPersonalTaskReceipt, personalTaskReceiptMessage, WELCOME_PERSONAL_SUBMISSION_KEY } from './welcome-personal-task'

/** Recovery is read-only until the user chooses an exact pending submission to retry. */
export default function PersonalTaskRecoveryPanel({ refreshKey, storageKey = WELCOME_PERSONAL_SUBMISSION_KEY }: { refreshKey?: boolean; storageKey?: string }): React.JSX.Element | null {
  const providersLoaded = useStore((state) => state.providersLoaded)
  const [records, setRecords] = useState<PersonalTaskSubmissionRecovery[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async (): Promise<void> => {
    try {
      const recovered = await createPersonalTaskSubmissionClient({ storageKey }).recover()
      setRecords(recovered); setError('')
      if (storageKey === WELCOME_PERSONAL_SUBMISSION_KEY) for (const item of recovered) {
        if (item.receipt?.status === 'submitted') clearRecoveredWelcomeInput(item.draft.input)
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { if (!refreshKey && providersLoaded) void refresh() }, [refreshKey, storageKey, providersLoaded])
  const act = async (record: PersonalTaskSubmissionRecovery): Promise<void> => {
    setBusy(true); setError('')
    try {
      const receipt = record.receipt?.status === 'submitted' ? record.receipt :
        (await createPersonalTaskSubmissionClient({ storageKey }).retry(record.draft.clientRequestId)).receipt
      setRecords((current) => current.map((item) => item.draft.clientRequestId === record.draft.clientRequestId ? { ...item, receipt } : item))
      if (receipt.status === 'submitted') await openPersonalTaskReceipt(receipt)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  if (!records.length && !error) return null
  return <section className="personal-task-recovery" data-personal-task-recovery aria-label="待确认的任务提交">
    <strong>任务提交回执</strong>
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void refresh()}>查询回执</button>
    {records.map((record) => <div key={record.draft.clientRequestId} data-personal-task-request={record.draft.clientRequestId}>
      <p>{record.draft.input.text.slice(0, 120)}</p>
      <small>{record.receipt ? personalTaskReceiptMessage(record.receipt) : record.error ?? '尚未找到回执；可以重试原提交。'}</small>
      {record.receipt?.status !== 'needs_reconciliation' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act(record)}>{record.receipt?.status === 'submitted' ? '打开任务' : '重试原提交'}</button>}
      {record.pendingCleanupError && <p role="status">{record.pendingCleanupError}</p>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>
}
