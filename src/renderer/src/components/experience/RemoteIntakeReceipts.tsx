import { useEffect, useState } from 'react'
import type { RemoteHostCommandReceipt } from '../../../../shared/remote-host-types'
import { useStore } from '../../store'
import { useRemoteHostSettingsNavigation, useRemoteTaskNavigation } from '../../store/remote-task-navigation'
import { useActivityStore } from '../../store/activity-store'
import { useLocalSitesNavigation } from '../../store/local-sites-navigation'
import { taskWindowSessionId } from '../../task-window-context'
import { recoverRemoteIntake, remoteCreateLabel, releaseUnrecordedRemoteIntake } from './welcome-remote-task'
import type { RemoteIntakeReference } from './welcome-remote-target'

export function openRemoteReceipt(reference: RemoteIntakeReference, receipt: RemoteHostCommandReceipt): void {
  const task = receipt.createdTask
  if (!task || task.projectId !== reference.target.projectId || receipt.kind !== 'create_task' || receipt.requestId !== reference.requestId) throw new Error('远端任务身份尚未确认。')
  useActivityStore.getState().setVisible(false); useLocalSitesNavigation.getState().setVisible(false)
  useStore.getState().setView('list')
  useRemoteTaskNavigation.getState().open({ connection: reference.target, hostId: reference.target.hostId,
    projectId: task.projectId, workItemId: task.workItemId, sessionId: task.sessionId, sourceCommandId: receipt.commandId, requestId: reference.requestId })
}
export default function RemoteIntakeReceipts({ refreshKey }: { refreshKey: boolean }): React.JSX.Element | null {
  const references = useStore(state => state.welcomeDraft.remoteIntakes ?? []), zh = useStore(state => state.settings.language === 'zh')
  const [receipts, setReceipts] = useState<Record<string, RemoteHostCommandReceipt | null>>({}), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [visibleCount, setVisibleCount] = useState(12)
  const visible = references.slice(-visibleCount)
  const detached = Boolean(taskWindowSessionId()), key = references.map(item => `${item.requestId}:${item.commandId ?? ''}`).join('|')
  useEffect(() => {
    let alive = true
    setError('')
    if (!detached) for (const item of visible) void recoverRemoteIntake(item, false).then(receipt => { if (alive) setReceipts(current => ({ ...current, [item.requestId]: receipt })) }).catch(() => { if (alive) setError(zh ? '部分原连接不可用。保留原请求，不能据此判断未提交。' : 'Some original connections are unavailable. This does not mean their requests were unsent.') })
    return () => { alive = false }
  }, [key, refreshKey, detached, zh, visibleCount])
  if (!references.length || detached) return null
  return <section className="welcome-remote-receipts" data-remote-intake-receipts aria-label={zh ? '远端提交回执' : 'Remote submission receipts'}>
    <h4>{zh ? '远端任务' : 'Remote tasks'}</h4>
    {visible.slice().reverse().map(reference => { const receipt = receipts[reference.requestId]; return <article key={reference.requestId}>
      <strong>{reference.target.hostLabel} · {reference.target.projectLabel}</strong><span>{remoteCreateLabel(receipt, zh)}</span>
      <small>{new Date(reference.createdAt).toLocaleString()} · {reference.requestId}</small>
      {receipt?.error && <p>{receipt.error}</p>}
      <div><button type="button" disabled={!!busy} onClick={() => { setBusy(reference.requestId); setError(''); void recoverRemoteIntake(reference, true).then(next => setReceipts(current => ({ ...current, [reference.requestId]: next }))).catch(() => setError(zh ? '核对未完成，请恢复原连接后继续核对；不会重发目标。' : 'Check incomplete. Restore the original connection and check again.')).finally(() => setBusy('')) }}>{zh ? '核对原提交' : 'Check original request'}</button>
        {receipt?.createdTask && <button type="button" data-remote-task-open onClick={() => { try { openRemoteReceipt(reference, receipt) } catch { setError(zh ? '任务身份不匹配，已停止打开。' : 'Task identity mismatch.') } }}>{zh ? '打开原任务' : 'Open original task'}</button>}
        {receipt && !receipt.createdTask && <button type="button" onClick={() => { useRemoteHostSettingsNavigation.getState().open(reference.target); useStore.getState().setShowSettings(true, 'remote-hosts') }}>{zh ? '查看配对项目' : 'View paired project'}</button>}
        {receipt === null && <button type="button" disabled={!!busy} data-remote-intake-release onClick={() => {
          setBusy(reference.requestId); setError('')
          void releaseUnrecordedRemoteIntake(reference).catch(() => setError(zh ? '无法确认本机没有原命令，引用继续保留。' : 'Could not confirm the absence of a local command; reference retained.')).finally(() => setBusy(''))
        }}>{zh ? '再次确认本机未记账并解除此引用' : 'Confirm no local command and release this reference'}</button>}
      </div>
    </article> })}
    {references.length > visibleCount && <button type="button" onClick={() => setVisibleCount(count => count + 12)}>{zh ? '显示更早的提交记录' : 'Show earlier submissions'}</button>}
    {error && <p role="alert">{error}</p>}
  </section>
}
