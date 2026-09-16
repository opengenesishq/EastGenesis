import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionMeta, WorkflowLedgerRendererSelection } from '../../../../shared/types'
import { createRunDetailRoute, resolveRunRecoverySnapshotId } from '../../../../shared/run-detail-projection'
import { useStore } from '../../store'
import RunDetailPanel from '../studio/RunDetailPanel'
import { mergeWorkflowLedgerPages } from '../studio/workInboxNavigation'
import SessionRawRecords from '../office/PalaceRawRecords'
import './task-execution-panel.css'

type Binding = Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>

export default function TaskExecutionPanel({ sessionId, active = true }: { sessionId: string | null; active?: boolean }): React.JSX.Element | null {
  const session = useStore(state => sessionId ? state.sessions[sessionId] : undefined)
  if (!session || !active) return null
  const binding = session.meta
  return <BoundExecutionPanel key={JSON.stringify([binding.id, binding.workspaceId, binding.goalId, binding.workItemId])} binding={binding} />
}

function BoundExecutionPanel({ binding }: { binding: Binding }): React.JSX.Element {
  const zh = useStore(state => state.settings.language) === 'zh'
  const session = useStore(state => state.sessions[binding.id])
  const [tab, setTab] = useState<'run' | 'records'>('run')
  const [ledger, setLedger] = useState<WorkflowLedgerRendererSelection>()
  const [runId, setRunId] = useState<string>()
  const [route, setRoute] = useState<string>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const pending = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const request = ++sequence.current
    setLoading(true)
    try {
      const next = await readTaskExecution(binding)
      if (request !== sequence.current) return
      setLedger(next.ledger); setRunId(next.runId); setError('')
      setRoute(previous => next.runId && (previous?.startsWith(`run/${encodeURIComponent(next.runId)}/`)
        ? previous : createRunDetailRoute(next.runId)))
    } catch (cause) {
      if (request === sequence.current) {
        setLedger(undefined); setRunId(undefined); setRoute(undefined)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally { pending.current = false; if (request === sequence.current) setLoading(false) }
  }, [binding.id, binding.workspaceId, binding.goalId, binding.workItemId])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 10_000)
    const unsubscribe = window.agentDesk.onSessionEvent((id, event) => {
      if (id === binding.id && ['turn-result', 'status', 'checkpoint-restore'].includes(event.kind)) void refresh()
    })
    return () => { sequence.current++; window.clearInterval(timer); unsubscribe() }
  }, [refresh, binding.id])
  const recover = async (requestedId: string): Promise<void> => {
    // Re-read ownership before issuing any mutation; displayed data may be old.
    const current = await readTaskExecution(binding)
    const run = current.ledger?.runs.items.find(item => item.id === requestedId)
    if (current.runId !== requestedId || !run) throw new Error(zh ? '当前执行已变化，请刷新记录。' : 'The current execution changed. Refresh the records.')
    const snapshots = await window.agentDesk.listTaskSnapshots()
    const snapshotId = resolveRunRecoverySnapshotId(run, snapshots)
    const latest = await readTaskExecution(binding)
    if (latest.runId !== requestedId || useStore.getState().activeId !== binding.id) throw new Error(zh ? '任务已切换，请重新打开恢复记录。' : 'The task changed. Reopen its recovery records.')
    await useStore.getState().recoverTaskSnapshot(snapshotId, { activate: false })
    await refresh()
  }
  return <section className="task-execution-panel" data-task-execution-session={binding.id}>
    <header><strong>{zh ? '执行记录' : 'Execution records'}</strong>
      <button className="btn btn-ghost btn-sm" type="button" disabled={loading} onClick={() => void refresh()}>{zh ? '刷新' : 'Refresh'}</button></header>
    <nav aria-label={zh ? '任务执行详情' : 'Task execution details'}>
      <button className="btn btn-ghost btn-sm" type="button" aria-pressed={tab === 'run'} onClick={() => setTab('run')}>{zh ? '进度、验收与恢复' : 'Progress, acceptance and recovery'}</button>
      <button className="btn btn-ghost btn-sm" type="button" aria-pressed={tab === 'records'} onClick={() => setTab('records')}>{zh ? '工具与原始记录' : 'Tools and source records'}</button>
    </nav>
    {tab === 'records' && session ? <SessionRawRecords session={session} zh={zh} /> : <>
      {loading && !ledger && <p role="status">{zh ? '正在读取执行记录…' : 'Reading execution records…'}</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !runId && <p>{zh ? '当前任务尚无执行记录。可以继续对话或查看计划与审批。' : 'This task has no execution record yet. Continue the conversation or review its plan and approvals.'}</p>}
      {error && <button className="btn btn-secondary btn-sm" type="button" onClick={() => useStore.getState().setShowTaskRecovery(true)}>{zh ? '打开恢复中心' : 'Open Recovery'}</button>}
      {ledger && route && runId && <RunDetailPanel route={route} onNavigate={setRoute} onRecover={recover} onRecoveryChanged={refresh}
        input={{ runs: ledger.runs.items, workItems: ledger.workItems.items, artifacts: ledger.artifacts.items,
          acceptances: ledger.acceptances.items, evidenceLinks: ledger.evidenceLinks.items, events: ledger.events.items }}
        onOpenDelivery={() => { if (useStore.getState().activeId === binding.id) useStore.getState().openPanel('result') }} />}
    </>}
  </section>
}

/** Scope reads to the current work item, then verify its explicit current Run.
 * An absent or different owner never falls back to an earlier execution. */
async function readTaskExecution(binding: Binding): Promise<{ ledger?: WorkflowLedgerRendererSelection; runId?: string }> {
  if (!binding.workItemId) return {}
  const pages: WorkflowLedgerRendererSelection[] = [], seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await window.agentDesk.listWorkflowLedger({ projectId: binding.workspaceId,
      goalId: binding.goalId, workItemId: binding.workItemId, limit: 500, cursor })
    pages.push(page)
    const more = Object.values(page).filter(value => value.hasMore)
    cursor = more[0]?.nextCursor
    if (more.length && (!cursor || seen.has(cursor))) throw new Error('执行记录分页不完整，请刷新重试。 / Incomplete execution records.')
    if (cursor) seen.add(cursor)
  } while (cursor)
  const ledger = mergeWorkflowLedgerPages(pages)
  if (!ledger) throw new Error('执行记录未读取，请刷新。 / Execution records unavailable.')
  const items = ledger.workItems.items.filter(item => item.id === binding.workItemId &&
    item.projectId === binding.workspaceId && item.goalId === binding.goalId)
  if (items.length !== 1) throw new Error('任务归属无法核对，请重新打开任务。 / Task ownership could not be verified.')
  const currentRunId = items[0].currentRunId ?? items[0].runIds.at(-1)
  if (!currentRunId) return { ledger }
  const runs = ledger.runs.items.filter(run => run.id === currentRunId)
  if (!items[0].runIds.includes(currentRunId) || runs.length !== 1 || runs[0].sessionId !== binding.id || runs[0].projectId !== binding.workspaceId ||
    runs[0].goalId !== binding.goalId || runs[0].workItemId !== binding.workItemId) {
    throw new Error('当前执行记录缺失或属于另一会话，请从收件箱重新打开当前任务。 / Reopen the current task from the inbox.')
  }
  return { ledger, runId: currentRunId }
}
