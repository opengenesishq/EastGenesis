import { useCallback, useEffect, useRef, useState } from 'react'
import type { EffectRecord, EffectResolution, TaskEffectRecoveryView } from '../../../shared/types'
import { useStore } from '../store'

export interface TaskEffectRecoveryPanelProps {
  sessionId: string
  runId?: string
  taskId?: string
  onChanged?: () => void | Promise<void>
}

/** The same existing Run/Effect ledger is used by results, run detail and Palace. */
export default function TaskEffectRecoveryPanel(props: TaskEffectRecoveryPanelProps): React.JSX.Element {
  return <BoundEffectRecoveryPanel key={JSON.stringify([props.sessionId, props.runId, props.taskId])} {...props} />
}

function BoundEffectRecoveryPanel({ sessionId, runId, taskId, onChanged }: TaskEffectRecoveryPanelProps): React.JSX.Element {
  const english = useStore(state => state.settings.language) === 'en'
  const openRecovery = useStore(state => state.setShowTaskRecovery)
  const [view, setView] = useState<TaskEffectRecoveryView>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const live = useRef(true)
  const sequence = useRef(0)
  const pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false; sequence.current++ } }, [])
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    try {
      const result = await window.agentDesk.getTaskEffectRecovery(sessionId, runId, taskId)
      if (!live.current || request !== sequence.current) return
      if (result.sessionId !== sessionId || result.runId !== runId || result.taskId !== taskId ||
        result.snapshots.some(snapshot => (runId && snapshot.runId !== runId) || (taskId && snapshot.taskId !== taskId) ||
          snapshot.effects.some(effect => effect.sessionId !== sessionId || effect.runId !== snapshot.runId))) {
        throw new Error(english ? 'Recovery records do not match this task.' : '恢复记录与当前任务不一致。')
      }
      setView(result)
      setError('')
    } catch (failure) {
      if (live.current && request === sequence.current) { setView(undefined); setError(errorText(failure)) }
    }
  }, [sessionId, runId, taskId, english])
  useEffect(() => {
    void refresh()
    return window.agentDesk.onSessionEvent((id, event) => {
      if (id === sessionId && !pending.current && ['turn-result', 'status', 'checkpoint-restore'].includes(event.kind)) void refresh()
    })
  }, [refresh, sessionId])

  const act = async (snapshot: TaskEffectRecoveryView['snapshots'][number], effect: EffectRecord,
    action: EffectResolution | 'recheck'): Promise<void> => {
    if (pending.current || !snapshot.canResolve) return
    pending.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      const result = action === 'recheck'
        ? await window.agentDesk.recheckTaskEffect(snapshot.snapshotId, effect.id, effect.revision)
        : (await window.agentDesk.resolveTaskEffect(snapshot.snapshotId, effect.id, effect.revision, action, notes[effect.id]?.trim())).snapshot
      if (!live.current) return
      if (result.id !== snapshot.snapshotId || result.sessionId !== sessionId || result.run?.id !== snapshot.runId ||
        result.taskId !== snapshot.taskId || result.run.taskId !== snapshot.taskId) throw new Error(english ? 'The receipt belongs to another task.' : '处置回执不属于当前任务。')
      const updated = result.run.effects?.find(item => item.id === effect.id)
      if (!updated || updated.targetDigest !== effect.targetDigest) throw new Error(english ? 'The operation changed. Refresh its records.' : '原操作已变化，请刷新记录。')
      if (updated.revision !== effect.revision) setNotice(updated.status === 'confirmed'
        ? (english ? 'The original operation is confirmed. Its execution was not repeated.' : '原操作已确认，没有重复执行。')
        : action === 'abandoned_by_user' ? (english ? 'Abandonment recorded. Retry remains blocked.' : '已记录放弃，仍禁止重放。')
          : action === 'confirmed_not_applied' ? (english ? 'Non-execution and permission to retry are recorded. Recovery may execute the operation again.' : '已记录未执行与重试授权，后续恢复可能再次执行。')
            : (english ? 'The result is still unresolved. Check the original system before deciding.' : '结果仍待核对，请查看原系统后再处置。'))
      await refresh()
      if (live.current) await onChanged?.()
    } catch (failure) {
      if (live.current) {
        await refresh()
        if (live.current) setError(errorText(failure))
      }
    } finally {
      pending.current = false
      if (live.current) setBusy(false)
    }
  }

  const entries = view?.snapshots.flatMap(snapshot => snapshot.effects
    .filter(effect => effect.status === 'waiting_reconciliation' || effect.evidence.some(item => item.resolutionReceipt))
    .map(effect => ({ snapshot, effect }))) ?? []
  if (!entries.length && !error && !notice) return <></>
  return <section className="task-recovery-effects" data-task-effect-recovery aria-busy={busy}>
    <div className="task-recovery-effect-heading">{english ? 'Check external operations' : '外部操作核对'}</div>
    <p className="task-recovery-meta">{english
      ? 'Check the original operation before continuing. Unknown results are not failures and are not automatically retried.'
      : '继续工作前先核对原操作。结果未知不会被当成失败或自动重放。'}</p>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh()}>{english ? 'Refresh records' : '刷新记录'}</button>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {(entries.length > 0 || notice) && view && !view.snapshots.some(snapshot => snapshot.effects.some(effect =>
      ['prepared', 'executing', 'waiting_reconciliation'].includes(effect.status))) && <p>
      {english ? 'The recorded operations are resolved. Continue explicitly from recovery controls.' : '已完成这些操作的处置。请通过“核对后继续”或恢复中心明确继续任务。'}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => openRecovery(true)}>
        {english ? 'Open Recovery Center' : '打开恢复中心'}
      </button>
    </p>}
    {entries.map(({ snapshot, effect }) => {
      const receipt = [...effect.evidence].reverse().find(item => item.resolutionReceipt)
      return <div className="task-recovery-effect-row" key={`${snapshot.snapshotId}:${effect.id}`}>
        <div className="task-recovery-effect-copy">
          <strong>{effect.toolName} · {effect.status}</strong>
          <span>{targetLabel(effect)}</span>
          <small>{effect.error}</small>
          <details><summary>{english ? 'Original operation and version' : '原操作与版本'}</summary>
            <p>Run: {effect.runId} · Effect: {effect.id} · v{effect.revision}</p>
            <p>{english ? 'Target digest' : '目标摘要'}: <code>{effect.targetDigest}</code></p>
            {receipt?.resolutionReceipt && <p>{receipt.resolutionReceipt.resolution} · v{receipt.resolutionReceipt.expectedRevision} · {receipt.resolutionReceipt.note}</p>}
          </details>
          {effect.status === 'waiting_reconciliation' && <>
            <p>{effect.reconcilability === 'queryable'
              ? (english ? 'Recheck queries the recorded target without repeating the operation.' : '重新核对只查询原目标，不重复执行操作。')
              : (english ? 'No result query is available. Check the original system and record your conclusion.' : '没有结果查询服务，请在原系统核对，并记录结论。')}</p>
            <label>{english ? 'What you checked' : '核对说明'}
              <textarea value={notes[effect.id] ?? ''} maxLength={2000} rows={2} disabled={busy || !snapshot.canResolve}
                placeholder={english ? 'Result, reference, or reason for abandonment' : '核对结果、原记录位置或放弃原因'}
                onChange={event => setNotes(value => ({ ...value, [effect.id]: event.target.value }))} />
            </label>
            {!snapshot.canResolve && <p>{english ? 'Pause the active task before resolving this operation.' : '请先暂停正在执行的任务，再处置此操作。'}</p>}
            <div className="task-recovery-effect-actions">
              {effect.reconcilability === 'queryable' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !snapshot.canResolve}
                onClick={() => void act(snapshot, effect, 'recheck')}>{english ? 'Recheck original result' : '重新核对原结果'}</button>}
              {(['confirmed_applied', 'confirmed_not_applied', 'abandoned_by_user'] as const).map(action => <button type="button" className="btn btn-ghost btn-sm" key={action}
                disabled={busy || !snapshot.canResolve || !notes[effect.id]?.trim()} onClick={() => void act(snapshot, effect, action)}>
                {action === 'confirmed_applied' ? (english ? 'Confirm applied' : '确认已执行')
                  : action === 'confirmed_not_applied' ? (english ? 'Not applied; allow retry' : '确认未执行并允许重试')
                    : (english ? 'Abandon; keep retry blocked' : '放弃本次操作，禁止重放')}
              </button>)}
            </div>
          </>}
        </div>
      </div>
    })}
  </section>
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function targetLabel(effect: EffectRecord): string {
  const target = effect.target
  if (target.kind === 'file_content') return target.relativePath
  if (target.kind === 'git_push') return `${target.remote}/${target.branch}`
  if (target.kind === 'git_commit') return `${target.branch} @ ${target.preHead.slice(0, 12)}`
  if (target.kind === 'git_merge') return `${target.destinationRef} ← ${target.sourceRef}`
  if (target.kind === 'pull_request_create') return `${target.projectPath}: ${target.sourceBranch} → ${target.baseBranch}`
  return target.kind
}
