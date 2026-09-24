import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CheckCheck, Circle, ExternalLink, MailOpen, RefreshCw } from 'lucide-react'
import type { ActivityFilter, TaskActivityItem, TaskActivityRecord } from '../../../../shared/activity-types'
import { useStore } from '../../store'
import { useActivityStore, useActivitySubscription } from '../../store/activity-store'
import './activity-center.css'

export default function ActivityCenter({ active }: { active: boolean }): React.JSX.Element {
  useActivitySubscription()
  const snapshot = useActivityStore(state => state.snapshot), loading = useActivityStore(state => state.loading)
  const error = useActivityStore(state => state.error), refresh = useActivityStore(state => state.refresh), mark = useActivityStore(state => state.mark)
  const zh = useStore(state => state.settings.language === 'zh')
  const [filter, setFilter] = useState<ActivityFilter>('all'), [includeArchived, setIncludeArchived] = useState(false)
  const [busy, setBusy] = useState(''), [actionError, setActionError] = useState(''), [record, setRecord] = useState<TaskActivityRecord | null>(null)
  const navigation = useRef(0)
  useEffect(() => { if (!active) navigation.current++; return () => { navigation.current++ } }, [active])
  const visible = (snapshot?.items ?? []).filter(item => (includeArchived || !item.archived) &&
    (filter === 'all' || filter === 'unread' && item.unread || filter === 'running' && item.status === 'running' || filter === 'waiting' && item.status === 'waiting'))
  const markItems = async (items: TaskActivityItem[], read: boolean) => {
    if (!snapshot) return
    setBusy('mark'); setActionError('')
    try { await mark(snapshot.snapshotId, items, read) }
    catch (error) { setActionError(message(error)) }
    finally { setBusy('') }
  }
  const open = async (item: TaskActivityItem) => {
    if (!snapshot) return
    const ticket = ++navigation.current, snapshotId = snapshot.snapshotId
    const key = () => { const s = useStore.getState(); return JSON.stringify([s.activeId, s.view, s.studioSurface, s.showSettings, s.showTaskRecovery, s.showNewSession, s.studioSessionNavigationNonce]) }
    const initialKey = key(), current = () => ticket === navigation.current && key() === initialKey
    setBusy(item.id); setActionError('')
    try {
      const target = await window.agentDesk.resolveTaskActivity(snapshotId, item.id)
      if (!current()) return
      if (target.kind === 'session') {
        if (!await useStore.getState().syncSession(target.sessionId)) throw new Error(zh ? '原任务已关闭，请刷新活动。' : 'The task has closed. Refresh Activity.')
        if (!current()) return
        const latest = await window.agentDesk.resolveTaskActivity(snapshotId, item.id)
        if (!current()) return
        if (latest.kind !== 'session' || latest.sessionId !== target.sessionId) throw new Error(zh ? '任务状态已变化，请刷新。' : 'Task state changed. Refresh Activity.')
        const meta = useStore.getState().sessions[target.sessionId]?.meta
        if (!meta || meta.status === 'closed' || (meta.workspaceId ?? meta.projectId) !== item.projectId || meta.goalId !== item.goalId || meta.workItemId !== item.workItemId) throw new Error(zh ? '任务身份已变化，请刷新。' : 'Task identity changed. Refresh Activity.')
        await mark(snapshotId, [item], true)
        if (!current()) return
        const state = useStore.getState()
        useActivityStore.getState().setVisible(false)
        state.setShowSettings(false); state.setShowTaskRecovery(false); state.selectSession(target.sessionId)
        state.setView('list'); state.setStudioSurface('session'); state.setShowNewSession(false)
      } else {
        const original = await window.agentDesk.readTaskActivityRecord(snapshotId, item.id)
        if (!current()) return
        setRecord(original)
        await mark(snapshotId, [item], true)
      }
    } catch (error) { if (current()) setActionError(message(error)) }
    finally { if (ticket === navigation.current) setBusy('') }
  }
  return <section className="activity-center" aria-labelledby="activity-title" data-activity-center>
    <header className="activity-header">
      <div><h2 id="activity-title">{zh ? '活动' : 'Activity'}</h2><span>{snapshot?.unreadCount ?? 0} {zh ? '项未读' : 'unread'}</span></div>
      <div className="activity-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading || Boolean(busy)} onClick={() => void refresh()} aria-label={zh ? '刷新活动' : 'Refresh Activity'}><RefreshCw size={14} /></button>
        <button type="button" className="btn btn-ghost btn-sm" data-activity-mark-all disabled={Boolean(busy) || !visible.some(item => item.unread)} onClick={() => void markItems(visible, true)}><CheckCheck size={14} />{zh ? '全部标为已读' : 'Mark all read'}</button>
      </div>
    </header>
    <nav className="activity-filters" aria-label={zh ? '活动筛选' : 'Activity filters'}>
      {(['all', 'unread', 'running', 'waiting'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} data-activity-filter={value} onClick={() => { setFilter(value); setRecord(null) }}>{({ all: zh ? '全部' : 'All', unread: zh ? '未读' : 'Unread', running: zh ? '运行中' : 'Running', waiting: zh ? '等待回复' : 'Waiting for you' })[value]}</button>)}
      <label><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />{zh ? '包含已归档' : 'Include archived'}</label>
    </nav>
    {filter === 'waiting' && <p className="activity-note">{zh ? '显示等待你审批或确认的任务。' : 'Tasks waiting for your approval or confirmation.'}</p>}
    {(error || actionError) && <div className="activity-error" role="alert">{actionError || error}<button type="button" className="btn btn-ghost btn-sm" onClick={() => { setActionError(''); void refresh() }}>{zh ? '重试' : 'Retry'}</button></div>}
    {record ? <article className="activity-record" data-activity-record={record.sessionId}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRecord(null)}><ArrowLeft size={14} />{zh ? '返回活动' : 'Back to Activity'}</button>
      <h3>{record.title}</h3><p className="activity-note">{zh ? '原任务记录' : 'Original task record'} · {record.sessionId}</p>
      {record.messages.length ? record.messages.map((entry, index) => <div className={`activity-record-message ${entry.role}`} key={index}><strong>{entry.role === 'user' ? (zh ? '你' : 'You') : 'EastGenesis'}</strong><p>{entry.text}</p></div>) : <p className="activity-empty">{zh ? '这项任务没有可显示的对话记录。' : 'No conversation is available for this task.'}</p>}
      {record.truncated && <p className="activity-note">{zh ? '此处显示最近的对话内容。完整历史仍保留在原任务中。' : 'Showing recent conversation content. The original history is retained.'}</p>}
    </article> : <>
      {loading && !snapshot && <p className="activity-empty" role="status">{zh ? '正在加载活动…' : 'Loading Activity…'}</p>}
      {!loading && !error && visible.length === 0 && <p className="activity-empty" role="status">{({ all: zh ? '暂无活动。开始一个任务后，进展会显示在这里。' : 'No activity yet. Task updates will appear here.', unread: zh ? '没有未读活动。' : 'No unread activity.', running: zh ? '当前没有运行中的任务。' : 'No tasks are running.', waiting: zh ? '当前没有等待你回复的任务。' : 'No tasks are waiting for you.' })[filter]}</p>}
      <div className="activity-list" role="list">{visible.map(item => <article className={`activity-row ${item.unread ? 'unread' : ''}`} role="listitem" key={item.id} data-activity-session={item.sessionId} data-activity-unread={item.unread}>
        <span className="activity-unread-dot" aria-label={item.unread ? (zh ? '未读' : 'Unread') : undefined}>{item.unread && <Circle size={7} fill="currentColor" />}</span>
        <button type="button" className="activity-row-open" disabled={Boolean(busy)} onClick={() => void open(item)}><strong>{item.title}</strong><span>{statusLabel(item, zh)} · {new Date(item.updatedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></button>
        <button type="button" className="btn btn-ghost btn-icon-sm" title={item.unread ? (zh ? '标记已读' : 'Mark read') : (zh ? '标记未读' : 'Mark unread')} aria-label={item.unread ? (zh ? '标记已读' : 'Mark read') : (zh ? '标记未读' : 'Mark unread')} disabled={Boolean(busy)} onClick={() => void markItems([item], item.unread)}><MailOpen size={15} /></button>
        <button type="button" className="btn btn-ghost btn-icon-sm" title={zh ? '打开原任务' : 'Open original task'} aria-label={zh ? '打开原任务' : 'Open original task'} disabled={Boolean(busy)} onClick={() => void open(item)}><ExternalLink size={15} /></button>
      </article>)}</div>
    </>}
  </section>
}
function statusLabel(item: TaskActivityItem, zh: boolean): string {
  return ({ running: zh ? '运行中' : 'Running', waiting: zh ? '等待审批或确认' : 'Waiting for approval', failed: zh ? '需要处理' : 'Needs attention', completed: zh ? '本轮已完成' : 'Turn completed', idle: zh ? '可继续' : 'Ready', recovery: zh ? '等待恢复' : 'Recovery needed' })[item.status]
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
