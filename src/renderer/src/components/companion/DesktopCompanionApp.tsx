import { useEffect, useMemo, useRef, useState } from 'react'
import { Landmark, MessageSquare, MoreHorizontal, ExternalLink, X } from 'lucide-react'
import CompanionFigure from './CompanionFigure'
import VoiceDraftInput from '../VoiceDraftInput'
import type { DesktopCompanionSnapshot, DesktopCompanionDraftReceipt } from '../../../../shared/desktop-companion-types'
import './desktop-companion.css'

export default function DesktopCompanionApp(): React.JSX.Element {
  const api = window.desktopCompanion!
  const [state, setState] = useState<DesktopCompanionSnapshot | null>(null)
  const [error, setError] = useState('')
  const [figure, setFigure] = useState<{ dataUrl: string; name: string }>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [taskFilter, setTaskFilter] = useState<'all' | 'running' | 'attention' | 'ready'>('all')
  const [receipt, setReceipt] = useState<DesktopCompanionDraftReceipt>()
  const request = useRef<{ requestId: string; sessionId: string; text: string }>()
  const inFlight = useRef(false)
  useEffect(() => {
    document.documentElement.classList.add('is-desktop-companion')
    let alive = true
    const off = api.onState(value => { if (alive) setState(value) })
    void api.getState().then(value => { if (alive) setState(value) }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false; off(); document.documentElement.classList.remove('is-desktop-companion') }
  }, [api])
  const zh = state?.language !== 'en'
  useEffect(() => {
    let current = true
    setFigure(undefined)
    if (state?.settings.imageId) void api.getFigure().then(value => { if (current) setFigure(value ?? undefined) }).catch(cause => { if (current) setError(String(cause)) })
    return () => { current = false }
  }, [api, state?.settings.imageId])
  const selected = useMemo(() => state?.tasks.find(task => task.sessionId === state.selectedSessionId) ?? state?.tasks[0], [state])
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  if (!state) return <main className="desktop-companion-loading"><CompanionFigure /><span>{error || '加载随侍…'}</span><button onClick={() => void run(async () => setState(await api.getState()))}>重试</button></main>
  const currentReceipt = state.deliveries.find(item => item.requestId === receipt?.requestId) ?? receipt
  const text = selected ? drafts[selected.sessionId] ?? '' : ''
  const mini = state.settings.mode === 'mini'
  const filteredTasks = state.tasks.filter(task => taskFilter === 'all' || taskFilter === 'running' && ['running', 'starting'].includes(task.status) || taskFilter === 'attention' && (task.pendingApprovalCount > 0 || task.status === 'error') || taskFilter === 'ready' && task.status === 'idle' && task.pendingApprovalCount === 0)
  const taskStatus = (task: typeof state.tasks[number]): string => task.pendingApprovalCount > 0 ? (zh ? '等待回复' : 'Needs input') : task.status === 'error' ? (zh ? '受阻' : 'Blocked') : ['running','starting'].includes(task.status) ? (zh ? '进行中' : 'Running') : (zh ? '可继续' : 'Ready')
  const submit = (): void => {
    if (!selected || !text.trim()) return
    if (!request.current || request.current.sessionId !== selected.sessionId || request.current.text !== text) request.current = { requestId: crypto.randomUUID(), sessionId: selected.sessionId, text }
    const input = request.current
    void run(async () => {
      const result = await api.submitDraft(input)
      setReceipt(result)
      if (result.status !== 'rejected') setDrafts(current => ({ ...current, [input.sessionId]: '' }))
      request.current = undefined
    })
  }
  return <main className={`desktop-companion ${state.expanded ? 'is-expanded' : ''} ${mini ? 'is-mini' : ''}`} data-companion-mode={mini ? 'mini' : 'figure'}>
    <div className="desktop-companion-drag" title={zh ? '拖动随侍' : 'Drag companion'}>{zh ? '内廷随侍' : 'Companion'}</div>
    <button className="desktop-companion-dismiss" disabled={busy} aria-label={zh ? '隐藏随侍' : 'Hide'} onClick={() => void run(() => api.hide())}><X size={14} /></button>
    {!mini && <div className="desktop-companion-figure"><CompanionFigure image={figure} /></div>}
    {!state.expanded ? mini ? <button className="desktop-companion-mini-summary" disabled={busy} onClick={() => void run(() => api.setExpanded(true))} aria-label={zh ? '展开随侍' : 'Expand companion'}><span><b>{selected?.title || (zh ? '打开工作台开始任务' : 'Start a task in the workspace')}</b><small>{state.runningCount} {zh ? '项进行中' : 'running'} · {state.attentionCount} {zh ? '项待处理' : 'attention'}</small></span><MoreHorizontal size={19} /></button> : <button className="desktop-companion-open" disabled={busy} onClick={() => void run(() => api.setExpanded(true))} aria-label={zh ? '展开随侍' : 'Expand companion'}><MoreHorizontal size={19} /></button> : <section className="desktop-companion-card">
      <header><div><strong>{zh ? '内廷随侍' : 'Companion'}</strong><small>{state.runningCount} {zh ? '项进行中' : 'running'} · {state.attentionCount} {zh ? '项待处理' : 'attention'}</small></div><button disabled={busy} onClick={() => void run(() => api.setExpanded(false))} aria-label={zh ? '收起' : 'Collapse'}><MoreHorizontal size={17} /></button></header>
      <div className="desktop-companion-filters" role="group" aria-label={zh ? '活动筛选' : 'Activity filters'}>{(['all','running','attention','ready'] as const).map(filter => <button key={filter} type="button" aria-pressed={filter === taskFilter} onClick={() => setTaskFilter(filter)}>{({all:zh?'全部':'All',running:zh?'进行中':'Running',attention:zh?'待处理':'Attention',ready:zh?'可继续':'Ready'})[filter]}</button>)}</div>
      <div className="desktop-companion-tasks">{filteredTasks.map(task => <button key={task.sessionId} disabled={busy} className={task.sessionId === state.selectedSessionId ? 'is-selected' : ''} onClick={() => void run(() => api.selectTask(task.sessionId))}>
        <span className={`desktop-companion-dot is-${task.status}`} /><span><b>{task.title}</b><small>{taskStatus(task)}</small></span>
      </button>)}{!filteredTasks.length && <p>{zh ? '当前没有此类任务。' : 'No matching tasks.'}</p>}</div>
      {selected ? <>
        <button className="desktop-companion-primary" disabled={busy} onClick={() => void run(() => api.openTask(selected.sessionId))}><MessageSquare size={14} />{zh ? '继续当前任务' : 'Continue task'}</button>
        <button className="desktop-companion-secondary" disabled={busy} onClick={() => void run(() => api.openTask(selected.sessionId, 'detached'))}><ExternalLink size={14} />{zh ? '独立窗口' : 'Open task window'}</button>
        <form className="desktop-companion-draft" onSubmit={event => { event.preventDefault(); submit() }}>
          <label htmlFor="companion-draft">{zh ? `给「${selected.title}」补充要求` : `Add instructions for “${selected.title}”`}</label>
          <textarea id="companion-draft" maxLength={20_000} rows={3} value={text} disabled={busy} onChange={event => setDrafts(current => ({ ...current, [selected.sessionId]: event.target.value }))} />
          {state.settings.enabled && <VoiceDraftInput key={selected.sessionId} contextId={selected.sessionId} api={api} language={state.language} disabled={busy}
            onInsert={addition => setDrafts(current => ({ ...current, [selected.sessionId]: `${current[selected.sessionId] ?? ''}${current[selected.sessionId]?.trim() ? '\n' : ''}${addition}`.slice(0, 20_000) }))} />}
          <button className="desktop-companion-primary" disabled={busy || !text.trim()}>{zh ? '加入任务草稿' : 'Add to task draft'}</button>
          <small>{zh ? '在工作台确认后发送。' : 'Review and send from the workspace.'}</small>
        </form>
      </> : <p>{zh ? '从工作台新建任务，随侍会显示进展。' : 'Start a task in the workspace to see its progress here.'}</p>}
      <button className="desktop-companion-secondary" disabled={busy} onClick={() => void run(() => api.openMain('palace'))}><Landmark size={14} />{zh ? '去皇城' : 'Open palace'}</button>
      <button className="desktop-companion-secondary" disabled={busy} onClick={() => void run(() => api.openMain('main'))}>{zh ? '打开工作台' : 'Open workspace'}</button>
      <button className="desktop-companion-secondary" disabled={busy} onClick={() => void run(() => api.setMode(mini ? 'figure' : 'mini'))}>{mini ? (zh ? '切换人物随侍' : 'Switch to figure') : (zh ? '切换 Mini 浮窗' : 'Switch to Mini')}</button>
      {currentReceipt && <p role="status">{currentReceipt.status === 'delivered' ? (zh ? '已加入原任务草稿' : 'Added to task draft') : currentReceipt.status === 'pending' ? (zh ? '等待工作台接收…' : 'Waiting for workspace…') : currentReceipt.error || (zh ? '草稿未送达' : 'Draft not delivered')}</p>}
    </section>}
    {(error || state.error) && <p className="desktop-companion-error" role="alert">{error || state.error}</p>}
  </main>
}
