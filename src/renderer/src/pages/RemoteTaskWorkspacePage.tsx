import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteHostCommandKind, RemoteHostCommandReceipt, RemoteHostTask, RemoteHostTasks, RemoteHostView } from '../../../shared/remote-host-types'
import { useStore } from '../store'
import { useRemoteTaskNavigation, type RemoteTaskNavigationTarget } from '../store/remote-task-navigation'
import RemoteHostConnectionGate from '../components/experience/RemoteHostConnectionGate'
import { remoteCreateLabel } from '../components/experience/welcome-remote-task'
import { sameRemoteTarget } from '../components/experience/welcome-remote-target'
import RemoteWorkspacePanel from '../components/settings/RemoteWorkspacePanel'
import './remote-task-workspace.css'

export default function RemoteTaskWorkspacePage({ target }: { target: RemoteTaskNavigationTarget }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [host, setHost] = useState<RemoteHostView>(), [tasks, setTasks] = useState<RemoteHostTasks>(), [receipt, setReceipt] = useState<RemoteHostCommandReceipt>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [instruction, setInstruction] = useState(''), [filesOpen, setFilesOpen] = useState(false), [ready, setReady] = useState(false)
  const generation = useRef(0), mutating = useRef(false), mounted = useRef(true)
  const key = JSON.stringify(target)
  const refresh = useCallback(async () => {
    const seq = ++generation.current
    setBusy(true); setError('')
    try {
      const listed = await window.agentDesk.listRemoteHosts(), current = listed.hosts.find(item => sameRemoteTarget(target.connection, item))
      if (!current) throw new Error(zh ? '原连接不可用，请核对原主机。' : 'Original connection unavailable.')
      let source = await window.agentDesk.findRemoteHostCommandByRequestId(target.hostId, target.requestId)
      if (source && current.status === 'paired' && !current.renewal) source = await window.agentDesk.reconcileRemoteHostCommand(target.hostId, source.commandId)
      if (!source || source.commandId !== target.sourceCommandId || source.createdTask?.projectId !== target.projectId || source.createdTask.workItemId !== target.workItemId || source.createdTask.sessionId !== target.sessionId) throw new Error(zh ? '原创建回执与任务身份不匹配。' : 'Original receipt does not match this task.')
      if (mounted.current && seq === generation.current) { setHost(current); setReceipt(source) }
      const next = await window.agentDesk.readRemoteHostTasks(target.hostId)
      if (next.projectId !== target.projectId || !next.workItems.some(item => item.id === target.workItemId)) throw new Error(zh ? '远端当前未返回该原任务，不能替换成其他任务。' : 'Original task not present in the current host response.')
      if (mounted.current && seq === generation.current) setTasks(next)
    } catch (cause) {
      if (mounted.current && seq === generation.current) { setTasks(undefined); setFilesOpen(false); setError(cause instanceof Error ? cause.message : 'Cannot open remote task') }
    } finally { if (mounted.current && seq === generation.current) setBusy(false) }
  }, [key, zh])
  useEffect(() => { mounted.current = true; setHost(undefined); setTasks(undefined); setFilesOpen(false); void refresh(); return () => { mounted.current = false; generation.current++ } }, [refresh])
  const task = tasks?.workItems.find(item => item.id === target.workItemId)
  const commands = host?.commands.filter(item => item.workItemId === target.workItemId) ?? []
  const unresolved = commands.some(item => ['sending', 'unknown', 'not_received'].includes(item.state) || ['pending', 'offline'].includes(item.status ?? '') || item.execution?.status === 'running')
  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    if (mutating.current) return
    mutating.current = true; setBusy(true); setError('')
    try { await operation(); if (mounted.current) await refresh() }
    catch { if (mounted.current) { setError(zh ? '操作结果待核对，请刷新并核对原命令，不要重复发送。' : 'Outcome unconfirmed. Refresh and check the original command.'); const next = await window.agentDesk.listRemoteHosts().catch(() => null); if (mounted.current && next) setHost(next.hosts.find(item => sameRemoteTarget(target.connection, item))) } }
    finally { mutating.current = false; if (mounted.current) setBusy(false) }
  }
  const command = (kind: RemoteHostCommandKind, selected: RemoteHostTask, text?: string): void => {
    if (!ready || unresolved || selected.id !== target.workItemId || !tasks || !task) return
    const permitted = kind === 'resume_work_item' ? tasks.capabilities.includes('resume_work_item') && task.canResume
      : tasks.capabilities.includes('control_work_item') && (kind === 'append_task' ? task.canAppend : kind === 'pause_work_item' ? task.canPause : kind === 'cancel_work_item' && task.canCancel)
    if (!permitted) return
    const sentText = text
    void act(async () => {
      const result = await window.agentDesk.sendRemoteHostCommand({ hostId: target.hostId, kind, workItemId: target.workItemId, expectedRevision: selected.revision,
        requestId: crypto.randomUUID(), ...(kind === 'append_task' ? { text } : {}) })
      if (result.state !== 'received' || result.status === 'rejected' || result.status === 'expired') throw new Error('Command unconfirmed')
      if (mounted.current && sentText !== undefined) setInstruction(current => current === sentText ? '' : current)
    })
  }
  const controlledTask = task && { ...task, canResume: task.canResume && !!tasks?.capabilities.includes('resume_work_item'),
    canAppend: task.canAppend && !!tasks?.capabilities.includes('control_work_item'), canPause: task.canPause && !!tasks?.capabilities.includes('control_work_item'), canCancel: task.canCancel && !!tasks?.capabilities.includes('control_work_item') }
  const approvedCommands = new Set(commands.map(item => item.commandId))
  return <section className="remote-task-page" data-remote-task-workspace data-remote-host={target.hostId} data-remote-work-item={target.workItemId} data-remote-session={target.sessionId} aria-label={zh ? '远端原任务' : 'Original remote task'}>
    <header><div><small>{target.connection.hostLabel} · {target.connection.projectLabel}</small><h2>{task?.title ?? (zh ? '远端任务' : 'Remote task')}</h2></div><button className="btn btn-ghost" onClick={() => useRemoteTaskNavigation.getState().close()}>{zh ? '返回工作台' : 'Back to workspace'}</button></header>
    <RemoteHostConnectionGate target={target.connection} onReady={setReady} />
    <div className="remote-task-receipt"><strong>{remoteCreateLabel(receipt, zh)}</strong><small>{zh ? '创建回执只反映任务建立和输入接收；实际工作进度以下方状态为准。' : 'Creation receipts describe task creation and input receipt. Work progress appears below.'}</small><code>{target.sourceCommandId}</code></div>
    <div className="remote-task-actions"><button disabled={busy || !ready} onClick={() => void refresh()}>{zh ? '刷新原任务' : 'Refresh original task'}</button>
      {controlledTask?.canResume && <button disabled={busy || !ready || unresolved} onClick={() => command('resume_work_item', controlledTask)}>{zh ? '继续任务' : 'Resume task'}</button>}
      {controlledTask?.canPause && <button disabled={busy || !ready || unresolved} onClick={() => command('pause_work_item', controlledTask)}>{zh ? '暂停' : 'Pause'}</button>}
      {controlledTask?.canCancel && <button disabled={busy || !ready || unresolved} onClick={() => command('cancel_work_item', controlledTask)}>{zh ? '取消任务' : 'Cancel task'}</button>}
      {task && tasks?.capabilities.includes('workspace_read') && <button disabled={!ready} onClick={() => setFilesOpen(value => !value)}>{zh ? '文件与代码' : 'Files and code'}</button>}
    </div>
    {task && <p role="status">{zh ? '当前任务状态' : 'Task status'}：{task.status}{task.resumeReason ? ` · ${task.resumeReason}` : ''}</p>}
    {controlledTask?.canAppend && <form onSubmit={event => { event.preventDefault(); if (instruction.trim()) command('append_task', controlledTask, instruction) }}><textarea value={instruction} maxLength={200000} disabled={busy || unresolved || !ready} onChange={event => setInstruction(event.target.value)} placeholder={zh ? '补充要求，继续这个远端任务…' : 'Add instructions to this remote task…'} /><button disabled={busy || unresolved || !ready || !instruction.trim()}>{zh ? '继续原任务' : 'Continue original task'}</button></form>}
    {tasks?.capabilities.includes('approve_effect') && task && <section><h3>{zh ? '原任务审批' : 'Task approvals'}</h3>
      {tasks.approvalCandidates.filter(item => item.workItemId === target.workItemId && item.sessionId === target.sessionId).map(candidate => <article key={candidate.permissionRequestId}><p>{candidate.summary}</p><button disabled={busy || !ready || unresolved} onClick={() => void act(() => window.agentDesk.sendRemoteHostCommand({ hostId: target.hostId, kind: 'approve_effect', workItemId: target.workItemId, expectedRevision: candidate.revision, approvalCandidate: candidate, requestId: crypto.randomUUID() }))}>{zh ? '审阅这个操作' : 'Review this operation'}</button></article>)}
      {tasks.approvals.filter(item => approvedCommands.has(item.commandId)).map(item => <article key={item.id}><p>{item.summary || item.action}</p><code>{item.targetDigest}</code>{(['approve', 'reject'] as const).map(decision => <button key={decision} disabled={busy || !ready || item.expiresAt <= Date.now() || host?.decisions?.some(row => row.approvalId === item.id && (row.state !== 'received' || row.approval?.status === 'pending'))} onClick={() => void act(() => window.agentDesk.decideRemoteHostApproval({ hostId: target.hostId, approvalId: item.id, expectedRevision: item.recordRevision, approvalDigest: item.approvalDigest, decision, requestId: crypto.randomUUID() }))}>{decision === 'approve' ? zh ? '批准此版本' : 'Approve version' : zh ? '拒绝' : 'Reject'}</button>)}</article>)}
      {host?.decisions?.filter(item => commands.some(command => command.approval?.id === item.approvalId) || tasks.approvals.some(approval => approval.id === item.approvalId && approvedCommands.has(approval.commandId))).map(item => <article key={item.requestId}><span>{zh ? '审批决定' : 'Approval decision'} · {item.decision} · {item.approval?.status ?? item.state}</span>{item.error && <p>{item.error}</p>}<button disabled={busy || !ready} onClick={() => void act(() => window.agentDesk.reconcileRemoteHostApproval(target.hostId, item.requestId))}>{zh ? '核对原审批决定' : 'Check original approval decision'}</button></article>)}
    </section>}
    {!!commands.length && <details><summary>{zh ? '原任务命令记录' : 'Task command records'}</summary>{commands.slice().reverse().map(item => <article key={item.commandId}><span>{item.kind} · {item.state} · {item.execution?.status ?? item.status}</span><code>{item.commandId}</code>{item.error && <p>{item.error}</p>}<button disabled={busy || !ready} onClick={() => void act(() => window.agentDesk.reconcileRemoteHostCommand(target.hostId, item.commandId))}>{zh ? '核对原命令' : 'Check original command'}</button></article>)}</details>}
    {filesOpen && controlledTask && ready && <RemoteWorkspacePanel hostId={target.hostId} hostLabel={target.connection.hostLabel} task={controlledTask} zh={zh} busy={busy || unresolved} expectedProjectId={target.projectId} expectedSessionId={target.sessionId} onCommand={command} onClose={() => setFilesOpen(false)} />}
    {busy && <p role="status">{zh ? '读取原任务记录…' : 'Reading original task records…'}</p>}{error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
