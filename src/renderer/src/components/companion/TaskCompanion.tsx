import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Bell, ChevronRight, Coins, MessageSquare, Pause, Plus, X } from 'lucide-react'
import { useStore, type SessionState } from '../../store'
import { APP_ICON_URL, APP_NAME } from '../../brand'
import { useCompanionEnabled, setCompanionEnabled } from './companion-preference'
import './task-companion.css'

const CompanionFigure = lazy(() => import('./CompanionFigure'))

function taskStatus(session: SessionState, zh: boolean): string {
  if (session.pendingPermissions.length) return zh ? '等待你的审批' : 'Approval needed'
  if (session.meta.status === 'error') return zh ? '遇到问题，查看记录' : 'Needs attention'
  if (session.meta.status === 'starting') return zh ? '正在准备' : 'Starting'
  if (session.meta.status === 'running') {
    const count = Object.keys(session.runningTools).length
    return count ? (zh ? `${count} 项工具正在执行` : `${count} tools running`) : (zh ? '正在处理' : 'Working')
  }
  return zh ? '等待下一条指令' : 'Ready to continue'
}

export default function TaskCompanion(): React.JSX.Element | null {
  const enabled = useCompanionEnabled()
  const hydrated = useStore(state => state.hydrated)
  const zh = useStore(state => state.settings.language === 'zh')
  const sessions = useStore(state => state.sessions)
  const order = useStore(state => state.order)
  const activeId = useStore(state => state.activeId)
  const obscured = useStore(state => state.showSettings || state.showCommandPalette || state.showTaskRecovery)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const available = order.flatMap(id => sessions[id] && sessions[id].meta.status !== 'closed' ? [sessions[id]] : [])
  const active = activeId ? available.find(session => session.meta.id === activeId) : undefined
  const attention = available.filter(session => session.pendingPermissions.length || session.meta.status === 'error')
  const running = available.filter(session => session.meta.status === 'running' || session.meta.status === 'starting').length
  const entries = [...attention, ...available.filter(session => !attention.includes(session))].slice(0, 4)
  const close = (): void => { setOpen(false); launcher.current?.focus() }

  useEffect(() => { setError('') }, [activeId])
  useEffect(() => { if (obscured || !enabled) setOpen(false) }, [obscured, enabled])
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[data-companion-close]')?.focus()
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); setOpen(false); launcher.current?.focus()
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [open])

  const continueTask = (id: string): void => {
    const state = useStore.getState()
    if (!state.sessions[id] || state.sessions[id].meta.status === 'closed') return
    state.selectSession(id)
    state.setView('list')
    setOpen(false)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.experience-session:not([hidden]) .composer-input')?.focus())
  }
  const pause = async (): Promise<void> => {
    const id = active?.meta.id
    if (!id || inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await useStore.getState().interrupt(id) }
    catch (cause) { if (useStore.getState().activeId === id) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { inFlight.current = false; setBusy(false) }
  }

  if (!enabled || !hydrated || obscured) return null
  return <div className="task-companion" ref={root} data-task-companion>
    {open && <section className="companion-panel" id="task-companion-panel" role="dialog" aria-label={zh ? '随侍' : 'Companion'}>
      <header className="companion-head">
        <div className="companion-figure" aria-hidden="true"><Suspense fallback={<img className="companion-brand-image" src={APP_ICON_URL} alt={APP_NAME} draggable={false} />}><CompanionFigure /></Suspense></div>
        <div><strong>{zh ? '随侍' : 'Companion'}</strong><p>{zh ? '指令、进度与待办，随时在这里。' : 'Your tasks, activity and next steps.'}</p></div>
        <button type="button" data-companion-close onClick={close} aria-label={zh ? '收起随侍' : 'Close companion'}><X size={16} /></button>
      </header>
      <p className="companion-summary" role="status">{zh ? `${running} 项进行中 · ${attention.length} 项待处理` : `${running} running · ${attention.length} need attention`}</p>
      {active && <div className="companion-current" data-companion-active={active.meta.id}>
        <span>{zh ? '当前任务' : 'Current task'}</span><strong>{active.meta.title}</strong><p>{taskStatus(active, zh)}</p>
        <div className="companion-actions">
          <button type="button" data-companion-continue onClick={() => continueTask(active.meta.id)}><MessageSquare size={15} />{zh ? '继续任务' : 'Continue task'}</button>
          {(active.meta.status === 'running' || active.meta.status === 'starting') && <button type="button" disabled={busy} onClick={() => void pause()} data-companion-pause><Pause size={15} />{busy ? (zh ? '暂停中…' : 'Pausing…') : (zh ? '暂停' : 'Pause')}</button>}
        </div>
      </div>}
      {entries.length > 0 && <div className="companion-tasks" aria-label={zh ? '任务与待办' : 'Tasks and attention'}>
        {entries.map(session => <button type="button" key={session.meta.id} data-companion-task={session.meta.id} onClick={() => continueTask(session.meta.id)}>
          <span className={`companion-dot is-${session.pendingPermissions.length ? 'approval' : session.meta.status}`} />
          <span><strong>{session.meta.title}</strong><small>{taskStatus(session, zh)}</small></span><ChevronRight size={14} />
        </button>)}
      </div>}
      {!available.length && <p className="companion-empty">{zh ? '交代一件事，从一句话开始。' : 'Start with a task in your own words.'}</p>}
      {error && <p className="companion-error" role="alert">{error}</p>}
      <div className="companion-actions companion-navigation">
        <button type="button" data-companion-new onClick={() => { useStore.getState().setShowNewSession(true); setOpen(false) }}><Plus size={15} />{zh ? '新任务' : 'New task'}</button>
        <button type="button" data-companion-costs onClick={() => { setOpen(false); useStore.getState().setShowSettings(true, 'usage') }}><Coins size={15} />{zh ? '查看费用' : 'View costs'}</button>
      </div>
      <button type="button" className="companion-hide" onClick={() => setCompanionEnabled(false)}>{zh ? '隐藏随侍 · 可在设置 → 外观中恢复' : 'Hide · restore in Settings → Appearance'}</button>
    </section>}
    <button type="button" ref={launcher} className="companion-launcher" data-companion-toggle aria-expanded={open} aria-controls={open ? 'task-companion-panel' : undefined}
      aria-label={zh ? `随侍，${attention.length} 项待处理` : `Companion, ${attention.length} need attention`} onClick={() => setOpen(value => !value)}>
      <Bell size={17} /><span>{zh ? '随侍' : 'Companion'}</span>{attention.length > 0 && <span className="companion-badge">{attention.length}</span>}
    </button>
  </div>
}
