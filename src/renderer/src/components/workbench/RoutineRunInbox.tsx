import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RoutineInboxItem, RoutineInboxResult, RoutineInboxSnapshot, RoutineInboxStatus } from '../../../../shared/routine-inbox-types'
import { createRunDetailRoute } from '../../../../shared/run-detail-projection'
import { useStore } from '../../store'
import RunDetailPanel from '../studio/RunDetailPanel'
import './routine-run-inbox.css'

function label(item: RoutineInboxItem): string {
  const run = item.run
  if (run.heartbeat?.phase === 'needs_reconciliation') return '需要核对'
  if (run.heartbeat && run.status === 'queued') return '等待原任务空闲'
  if (run.inboxStatus === 'waiting_approval') return '等待批准'
  if (run.inboxStatus === 'needs_review') return '待验收'
  if (run.inboxStatus === 'accepted') return '已验收'
  if (run.inboxStatus === 'rejected') return '已退回'
  return { queued: '排队中', running: '运行中', failed: '失败', succeeded: '已完成' }[run.status]
}
function time(value?: number): string { return value ? new Date(value).toLocaleString() : '—' }
const errorText = (error: unknown) => error instanceof Error ? error.message : '暂时无法读取运行记录。'
const staleProjectError = (error?: string): boolean => Boolean(error && /Routine Project (?:does not exist|is not active)|项目不存在|项目已停用/i.test(error))
const displayRunError = (error?: string): string => staleProjectError(error) ? '关联项目已失效，需要重新绑定项目。' : (error ?? '')

interface CollapsedInboxItem {
  item: RoutineInboxItem
  repeatCount: number
}

export default function RoutineRunInbox({ routineId, refreshKey, onOpenSession, onRepairRoutine, onDeleteRoutine }: {
  routineId?: string | null
  refreshKey?: unknown
  onOpenSession?: (id: string) => void
  onRepairRoutine?: () => void
  onDeleteRoutine?: () => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RoutineInboxSnapshot | null>(null)
  const [status, setStatus] = useState<RoutineInboxStatus>('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<{ snapshotId: string; result: RoutineInboxResult } | null>(null)
  const [route, setRoute] = useState('')
  const listEpoch = useRef(0), detailEpoch = useRef(0)
  const refresh = useCallback(async (quiet = false) => {
    const epoch = ++listEpoch.current
    if (!quiet) setLoading(true)
    try {
      const result = await window.agentDesk.listRoutineInbox({ routineId: routineId ?? undefined, status, unreadOnly, query, projectId: projectId || undefined, page })
      if (epoch !== listEpoch.current) return
      setSnapshot(result); setError('')
      if (result.page !== page) setPage(result.page)
    } catch (cause) { if (epoch === listEpoch.current) setError(errorText(cause)) }
    finally { if (epoch === listEpoch.current) setLoading(false) }
  }, [routineId, status, unreadOnly, query, projectId, page])
  useEffect(() => {
    detailEpoch.current++; setSelected(null); setRoute(''); setBusy(false)
    void refresh()
    return () => { listEpoch.current++; detailEpoch.current++ }
  }, [refresh])
  useEffect(() => { void refresh(true) }, [refreshKey])
  useEffect(() => {
    const unsubscribe = window.agentDesk.onRoutineInboxChanged(() => { void refresh(true) })
    const interval = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(true) }, 15_000)
    return () => { unsubscribe(); window.clearInterval(interval) }
  }, [refresh])
  const filters = () => { detailEpoch.current++; setPage(1); setSelected(null); setBusy(false) }
  const mark = async (runIds: string[], read: boolean) => {
    if (!snapshot) return
    setBusy(true)
    try { await window.agentDesk.markRoutineInboxRead({ snapshotId: snapshot.snapshotId, runIds, read }); await refresh(true) }
    catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }
  const openResult = async (item: RoutineInboxItem) => {
    if (!snapshot) return
    const epoch = ++detailEpoch.current, snapshotId = snapshot.snapshotId
    setBusy(true); setError(''); setSelected(null)
    try {
      const result = await window.agentDesk.readRoutineInboxResult(snapshotId, item.run.id)
      if (epoch !== detailEpoch.current) return
      setSelected({ snapshotId, result }); setRoute(item.run.workflowRunId ? createRunDetailRoute(item.run.workflowRunId) : '')
      await window.agentDesk.markRoutineInboxRead({ snapshotId, runIds: [item.run.id], read: true })
      await refresh(true)
    } catch (cause) { if (epoch === detailEpoch.current) setError(errorText(cause)) }
    finally { if (epoch === detailEpoch.current) setBusy(false) }
  }
  const openTask = async () => {
    if (!selected || !onOpenSession) return
    const epoch = detailEpoch.current
    setBusy(true); setError('')
    try {
      const target = await window.agentDesk.resolveRoutineInboxTask(selected.snapshotId, selected.result.item.run.id)
      if (epoch !== detailEpoch.current) return
      if (!await useStore.getState().syncSession(target.sessionId)) throw new Error('原任务当前不可用，运行记录已保留。')
      const meta = useStore.getState().sessions[target.sessionId]?.meta
      if (!meta || meta.createdAt !== target.sessionCreatedAt || meta.cwd !== target.cwd || meta.workspaceId !== target.workspaceId ||
        meta.goalId !== target.goalId || meta.workItemId !== target.workItemId) throw new Error('原任务身份已变化，请刷新运行记录。')
      await window.agentDesk.resolveRoutineInboxTask(selected.snapshotId, selected.result.item.run.id)
      if (epoch === detailEpoch.current) onOpenSession(target.sessionId)
    } catch (cause) { if (epoch === detailEpoch.current) setError(errorText(cause)) }
    finally { if (epoch === detailEpoch.current) setBusy(false) }
  }
  const record = selected?.result.item.run
  const latestItem = snapshot?.items.find(item => item.run.id === record?.id)
  const resultChanged = latestItem && latestItem.sourceVersion !== selected?.result.item.sourceVersion
  const visibleItems = useMemo<CollapsedInboxItem[]>(() => {
    const groups = new Map<string, CollapsedInboxItem>()
    for (const item of snapshot?.items ?? []) {
      const key = item.run.status === 'failed' && staleProjectError(item.run.error)
        ? `${item.run.routineId}\0${item.run.error}`
        : item.run.id
      const existing = groups.get(key)
      if (existing) existing.repeatCount += 1
      else groups.set(key, { item, repeatCount: 1 })
    }
    return [...groups.values()]
  }, [snapshot?.items])
  const collapsedStaleFailures = visibleItems.reduce((total, group) => total + (staleProjectError(group.item.run.error) ? group.repeatCount : 0), 0)
  return <section className="routine-run-inbox" aria-label="定时运行收件箱">
    <header className="routine-run-inbox-heading">
      <div><h3>运行收件箱</h3><span>{snapshot ? `${snapshot.total} 次执行 · ${snapshot.unreadCount} 条未读` : '按每次执行查看结果'}</span></div>
      <div className="routine-run-inbox-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading || busy} onClick={() => void refresh()}>刷新记录</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading || busy || !snapshot?.items.some(item => item.unread)} onClick={() => void mark(snapshot!.items.map(item => item.run.id), true)}>本页已读</button>
      </div>
    </header>
    <div className="routine-run-inbox-filters">
      <input aria-label="搜索运行记录" placeholder="搜索名称、结果或错误" value={query} onChange={event => { filters(); setQuery(event.target.value) }} />
      <select aria-label="运行状态" value={status} onChange={event => { filters(); setStatus(event.target.value as RoutineInboxStatus) }}>
        <option value="all">全部状态</option><option value="running">运行中</option><option value="waiting">等待处理</option><option value="failed">失败或退回</option><option value="completed">已完成</option>
      </select>
      <select aria-label="运行所属项目" value={projectId} onChange={event => { filters(); setProjectId(event.target.value) }}>
        <option value="">全部项目</option>{snapshot?.projects.map(project => <option key={project.id} value={project.id}>{project.label}</option>)}
      </select>
      <label><input type="checkbox" checked={unreadOnly} onChange={event => { filters(); setUnreadOnly(event.target.checked) }} />只看未读</label>
    </div>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {collapsedStaleFailures > 0 && <div className="notice notice-info routine-run-inbox-repair" role="status">
      <span>{collapsedStaleFailures > 1 ? `已合并 ${collapsedStaleFailures} 条相同的失效项目失败记录。` : '该计划绑定的项目已经失效。'}</span>
      {onRepairRoutine && <button type="button" className="btn btn-primary btn-sm" onClick={onRepairRoutine}>重新绑定项目</button>}
      {onDeleteRoutine && <button type="button" className="btn btn-ghost btn-sm" onClick={onDeleteRoutine}>删除计划</button>}
    </div>}
    <div className="routine-run-inbox-list" aria-busy={loading}>
      {visibleItems.map(({ item, repeatCount }) => <article key={item.run.id} className={`routine-run-inbox-row${item.unread ? ' is-unread' : ''}`} data-routine-run-id={item.run.id}>
        <button type="button" className="routine-run-inbox-open" disabled={busy} onClick={() => void openResult(item)}>
          <span className="routine-run-inbox-status">{item.unread && <i aria-label="未读" />}{label(item)}</span>
          <strong>{item.run.routineName}{repeatCount > 1 && <em className="routine-run-inbox-repeat">×{repeatCount}</em>}</strong><time>{time(item.run.startedAt)}</time>
          <small>{displayRunError(item.run.error) || item.run.resultText || (item.run.status === 'queued' ? '等待调度' : '暂无结果')}</small>
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void mark([item.run.id], item.unread)}>{item.unread ? '标为已读' : '标为未读'}</button>
      </article>)}
      {!loading && snapshot?.items.length === 0 && <p className="routine-run-inbox-empty">当前筛选下没有运行记录。</p>}
      {loading && !snapshot && <p>正在读取运行记录…</p>}
    </div>
    {snapshot && <nav className="routine-run-inbox-pages" aria-label="运行记录分页">
      <button type="button" className="btn btn-ghost btn-sm" disabled={loading || busy || snapshot.page <= 1} onClick={() => setPage(snapshot.page - 1)}>上一页</button>
      <span>第 {snapshot.page} / {Math.max(1, Math.ceil(snapshot.total / snapshot.pageSize))} 页</span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={loading || busy || !snapshot.hasMore} onClick={() => setPage(snapshot.page + 1)}>下一页</button>
    </nav>}
    {selected && record && <section className="routine-run-inbox-detail" aria-label="定时执行结果" data-routine-result-id={record.id}>
      <header><div><h3>{record.routineName}</h3><span>{label(selected.result.item)} · {time(record.startedAt)}</span></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => { detailEpoch.current++; setSelected(null); setBusy(false) }}>关闭详情</button></header>
      {resultChanged && latestItem && <p className="notice notice-info">这次运行有新结果。<button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void openResult(latestItem)}>读取最新结果</button></p>}
      <dl><dt>本次执行</dt><dd>{record.id}</dd><dt>调度阶段</dt><dd>{{ preparing: '准备中', session_created: '任务已创建', prompt_accepted: '任务已接收' }[record.dispatchState]}</dd>
        <dt>完成时间</dt><dd>{time(record.finishedAt)}</dd><dt>工作目录</dt><dd>{record.projectCwd}</dd>
        {record.workflowRunId && <><dt>Run</dt><dd>{record.workflowRunId}</dd></>}{record.artifactId && <><dt>成果</dt><dd>{record.artifactId}</dd></>}{record.evidenceId && <><dt>证据</dt><dd>{record.evidenceId}</dd></>}
      </dl>
      {record.error && <div className="routine-run-inbox-original"><h4>失败记录</h4><pre>{displayRunError(record.error)}</pre></div>}
      {record.resultText && <div className="routine-run-inbox-original"><h4>执行结果</h4><pre>{record.resultText}</pre></div>}
      {record.reviewNote && <div className="routine-run-inbox-original"><h4>验收记录</h4><pre>{record.reviewNote}</pre></div>}
      {record.heartbeat?.phase === 'needs_reconciliation' && <p className="notice notice-error">投递结果未知，需要先核对原任务的输入记录。</p>}
      {selected.result.workflowIssue && <p className="notice notice-info">{selected.result.workflowIssue}</p>}
      {record.sessionId && onOpenSession && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void openTask()}>{record.heartbeat ? '返回原任务' : '打开原任务'}</button>}
      {selected.result.detailsTruncated && <p className="notice notice-info">关联账本记录超过单页上限；当前显示本次 Run 的前 200 条关联记录。</p>}
      {selected.result.detail && route && <RunDetailPanel input={selected.result.detail} route={route} onNavigate={setRoute} onRecoveryChanged={() => openResult(selected.result.item)} />}
    </section>}
  </section>
}
