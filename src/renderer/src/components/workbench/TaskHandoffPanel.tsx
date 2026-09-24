import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteHostView } from '../../../../shared/remote-host-types'
import type { TaskHandoffRemoteCapabilities, TaskHandoffView } from '../../../../shared/task-handoff-api'
import { useStore } from '../../store'
import './task-handoff.css'

const terminal = (row: TaskHandoffView): boolean => ['committed', 'cancelled'].includes(row.state)
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
export const handoffBytes = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`

export default function TaskHandoffPanel({ sessionId, sessionCreatedAt }: { sessionId: string; sessionCreatedAt: number }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [hosts, setHosts] = useState<RemoteHostView[]>([]), [rows, setRows] = useState<TaskHandoffView[]>([])
  const [hostId, setHostId] = useState(''), [destinationId, setDestinationId] = useState('')
  const [targets, setTargets] = useState<TaskHandoffRemoteCapabilities>()
  const [busy, setBusy] = useState(''), [loadingTargets, setLoadingTargets] = useState(false), [loaded, setLoaded] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false), [confirmedDigest, setConfirmedDigest] = useState('')
  const [error, setError] = useState('')
  const alive = useRef(true), readSequence = useRef(0), targetSequence = useRef(0), operation = useRef(false)
  const current = useCallback(() => {
    const state = useStore.getState()
    return alive.current && state.activeId === sessionId && state.sessions[sessionId]?.meta.createdAt === sessionCreatedAt
  }, [sessionId, sessionCreatedAt])
  const acceptRows = useCallback((value: TaskHandoffView[]) => value.filter(row => row.identity.sessionId === sessionId && row.identity.sessionCreatedAt === sessionCreatedAt)
    .sort((a, b) => b.createdAt - a.createdAt), [sessionId, sessionCreatedAt])
  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++readSequence.current
    const [hostState, history] = await Promise.all([window.agentDesk.listRemoteHosts(), window.agentDesk.listTaskHandoffs(sessionId)])
    if (!current() || readSequence.current !== sequence) return
    setHosts(hostState.hosts); setRows(acceptRows(history)); setLoaded(true)
  }, [sessionId, current, acceptRows])
  useEffect(() => {
    alive.current = true
    void refresh().catch(cause => { if (current()) setError(message(cause)) })
    return () => { alive.current = false; readSequence.current++; targetSequence.current++ }
  }, [refresh, current])
  const pending = rows.some(row => !terminal(row))
  useEffect(() => {
    if (!pending && !busy) return
    // Read journal progress only; a timer never retries a mutation or creates a handoff.
    const timer = window.setInterval(() => void refresh().catch(() => {}), 2000)
    return () => window.clearInterval(timer)
  }, [pending, busy, refresh])
  const chooseHost = async (id: string): Promise<void> => {
    const sequence = ++targetSequence.current
    setHostId(id); setDestinationId(''); setTargets(undefined); setAcknowledged(false); setError('')
    if (!id) { setLoadingTargets(false); return }
    setLoadingTargets(true)
    try {
      const result = await window.agentDesk.getTaskHandoffTargets(id, sessionId)
      if (current() && sequence === targetSequence.current) setTargets(result)
    } catch (cause) { if (current() && sequence === targetSequence.current) setError(message(cause)) }
    finally { if (current() && sequence === targetSequence.current) setLoadingTargets(false) }
  }
  const run = async (label: string, action: () => Promise<TaskHandoffView>): Promise<void> => {
    if (operation.current || !current()) return
    operation.current = true; setBusy(label); setError(''); setConfirmedDigest('')
    try {
      const result = await action()
      if (current()) {
        readSequence.current++
        if (result.identity.sessionId !== sessionId || result.identity.sessionCreatedAt !== sessionCreatedAt) throw new Error(zh ? '移交结果不属于当前任务。' : 'Handoff result belongs to another task.')
        setRows(previous => acceptRows([result, ...previous.filter(row => row.id !== result.id)]))
      }
    } catch (cause) { if (current()) setError(message(cause)) }
    finally {
      if (current()) {
        // Prepare can fail after creating its durable record. Reload that record
        // so the next action reconciles the original ID instead of preparing again.
        try { await refresh() } catch (cause) { if (current()) { setLoaded(false); setError(message(cause)) } }
        if (current()) setBusy('')
      }
      operation.current = false
    }
  }
  const candidates = hosts.filter(host => host.status === 'paired' && host.capabilities.includes('task_handoff') && (host.expiresAt ?? 0) > Date.now())
  const selectedHost = candidates.find(host => host.id === hostId)
  const destinations = targets?.destinations.filter(item => item.enabled && item.expiresAt > Date.now()) ?? []
  const target = destinations.find(item => item.id === destinationId)
  const latest = rows[0]
  const sourceTransferred = latest?.direction === 'outgoing' && latest.state === 'committed'
  const blocked = !loaded || rows.some(row => row.direction === 'outgoing' && !terminal(row)) || sourceTransferred
  return <section className="task-handoff-panel" aria-label={zh ? '任务移交到其他主机' : 'Hand task to another host'} data-task-handoff-panel={sessionId}>
    <header><div><h4>{zh ? '移交到其他主机' : 'Hand off to another host'}</h4><p>{zh ? '将原任务及其完整记录、项目依赖和工作文件交给另一台 EastGenesis 继续。' : 'Move the original task, full records, project dependencies and working files to another EastGenesis computer.'}</p></div>
      <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void refresh().catch(cause => { if (current()) setError(message(cause)) })}>{zh ? '刷新' : 'Refresh'}</button></header>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {busy && <p role="status" data-task-handoff-busy>{busy}</p>}
    {!blocked && <fieldset disabled={Boolean(busy)}>
      <label>{zh ? '目标主机' : 'Destination host'}<select value={hostId} onChange={event => void chooseHost(event.target.value)} data-task-handoff-host>
        <option value="">{zh ? '选择已授权任务移交的主机' : 'Select a host with handoff permission'}</option>
        {candidates.map(host => <option key={host.id} value={host.id}>{host.label} · {host.identity.origin}</option>)}
      </select></label>
      {!candidates.length && <p>{zh ? '暂无可用主机。在设置 → 控制其他主机中添加连接，并在接收端明确开启任务移交权限。' : 'No eligible host. Add a connection in Settings → Control other hosts and enable handoff on the receiving computer.'}</p>}
      {loadingTargets && <p role="status">{zh ? '正在读取预授权接收目录…' : 'Reading authorized destinations…'}</p>}
      {targets && <label>{zh ? '接收目录' : 'Receiving directory'}<select value={destinationId} data-task-handoff-destination onChange={event => { setDestinationId(event.target.value); setAcknowledged(false) }}>
        <option value="">{zh ? '选择接收端已授权目录' : 'Select an authorized destination'}</option>
        {destinations.map(item => <option key={item.id} value={item.id}>{item.label} · {item.path}</option>)}
      </select></label>}
      {targets && !destinations.length && <p>{zh ? '接收端尚无有效接收目录。请在那台电脑的设置 → 控制其他主机 → 本机接收目录中添加。' : 'The receiver has no authorized directory. Add one in its Settings → Control other hosts → Local receiving directories.'}</p>}
      {target && <><code>{target.path}</code><label className="task-handoff-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
        {zh ? '准备移交会暂停当前任务并复制任务记录与文件；我将在预览后确认是否交给目标电脑执行。' : 'Preparation pauses this task and copies its records and files. I will review the preview before transferring execution.'}</label></>}
      <button type="button" className="btn btn-primary btn-sm" data-task-handoff-prepare disabled={!selectedHost || !target || !acknowledged || loadingTargets}
        onClick={() => { if (selectedHost && target) void run(zh ? '正在暂停并准备移交…' : 'Pausing and preparing…', () => window.agentDesk.prepareTaskHandoff({ sessionId, hostId: selectedHost.id, destinationId: target.id })) }}>
        {zh ? '暂停并准备移交' : 'Pause and prepare handoff'}</button>
    </fieldset>}
    {sourceTransferred && <p className="notice notice-info" data-task-handoff-source-released>{zh ? '此任务已交给目标电脑执行。当前电脑保留原任务历史，不能继续执行；请在目标电脑打开同一任务。' : 'Execution belongs to the receiving computer. This computer retains the original history and cannot continue execution. Open the same task on the receiver.'}</p>}
    {rows.map(row => <article key={row.id} className="task-handoff-record" data-task-handoff-id={row.id} data-task-handoff-state={row.state}>
      <header><strong>{row.title}</strong><span>{handoffState(row.state, zh)} · {row.direction === 'incoming' ? zh ? '接收' : 'Incoming' : zh ? '发出' : 'Outgoing'}</span></header>
      <p>{zh ? '目标目录' : 'Destination'}：<code>{row.targetPath ?? (zh ? '准备中' : 'Preparing')}</code></p>
      <p>{row.files} {zh ? '个文件' : 'files'} · {handoffBytes(row.bytes)} · {new Date(row.updatedAt).toLocaleString()}</p>
      {row.message && <p role="status">{row.message}</p>}
      {row.excluded.length > 0 && <details><summary>{zh ? '不复制的文件' : 'Excluded files'} · {row.excluded.length}</summary><ul>{row.excluded.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul></details>}
      <details open={row.missingResources.length > 0}><summary>{zh ? '目标缺少的资源' : 'Missing resources'} · {row.missingResources.length}</summary>
        {row.missingResources.length ? <ul>{row.missingResources.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul> : <p>{zh ? '未报告缺失资源。' : 'No missing resources reported.'}</p>}</details>
      {row.direction === 'outgoing' && row.state === 'ready' && row.previewDigest && <div className="task-handoff-confirm">
        <label className="task-handoff-check"><input type="checkbox" disabled={Boolean(busy)} checked={confirmedDigest === `${row.id}:${row.previewDigest}`}
          onChange={event => setConfirmedDigest(event.target.checked ? `${row.id}:${row.previewDigest}` : '')} />
          {zh ? '已核对目标路径、文件和缺失资源；确认后由目标电脑继续，源任务保留历史并停止执行。' : 'I reviewed the path, files and missing resources. The receiver will continue; the source retains history and stops executing.'}</label>
        <button type="button" className="btn btn-primary btn-sm" data-task-handoff-commit disabled={Boolean(busy) || confirmedDigest !== `${row.id}:${row.previewDigest}`}
          onClick={() => void run(zh ? '正在确认移交…' : 'Committing handoff…', () => window.agentDesk.commitTaskHandoff({ id: row.id, previewDigest: row.previewDigest! }))}>{zh ? '确认移交执行权' : 'Confirm execution handoff'}</button>
      </div>}
      {row.direction === 'outgoing' && row.state !== 'cancelled' && <div className="task-handoff-actions">
        <button type="button" className="btn btn-ghost btn-sm" data-task-handoff-reconcile disabled={Boolean(busy)} onClick={() => void run(zh ? '正在核对原移交…' : 'Reconciling original handoff…', () => window.agentDesk.reconcileTaskHandoff(row.id))}>{row.state === 'committed' ? (zh ? '核对移交回执' : 'Reconcile handoff receipt') : (zh ? '核对原移交状态' : 'Reconcile original handoff')}</button>
        {row.direction === 'outgoing' && row.canCancelBeforeRelease === true && <button type="button" className="btn btn-ghost btn-sm" data-task-handoff-cancel disabled={Boolean(busy)}
          onClick={() => void run(zh ? '正在取消原移交…' : 'Cancelling original handoff…', () => window.agentDesk.cancelTaskHandoff(row.id))}>{zh ? '取消移交，保留源任务' : 'Cancel handoff; retain source task'}</button>}
      </div>}
      <details><summary>{zh ? '移交记录' : 'Handoff record'}</summary><code>{row.id}</code><code>{row.sourceHostId} → {row.targetHostId}</code><code>{row.identity.sessionId}</code></details>
    </article>)}
  </section>
}

function handoffState(state: TaskHandoffView['state'], zh: boolean): string {
  const labels: Record<TaskHandoffView['state'], [string, string]> = { preparing: ['准备中', 'Preparing'], uploading: ['传输中', 'Transferring'], ready: ['等待确认', 'Ready for confirmation'], released: ['源端已释放，等待接收', 'Source released; awaiting receiver'], importing: ['目标正在导入', 'Importing on receiver'], committed: ['已移交', 'Committed'], cancelled: ['已取消', 'Cancelled'], needs_reconciliation: ['结果待核对', 'Needs reconciliation'] }
  return labels[state][zh ? 0 : 1]
}
