import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Hand, Monitor, Pause, X } from 'lucide-react'
import type { GuiPreviewSnapshot } from '../../../../shared/gui-preview-types'
import './gui-preview.css'

const phases = {
  idle: ['等待电脑操作', 'Waiting for computer use'], waiting: ['等待审批', 'Approval needed'],
  running: ['正在操作', 'Working'], completed: ['本次操作已完成', 'Action completed'], failed: ['需要查看结果', 'Check the result'],
  stopping: ['正在停止', 'Stopping'], paused: ['已暂停', 'Paused'], unavailable: ['暂不可用', 'Unavailable']
}
const actionEnglish: Record<string, string> = {
  gui_list_windows: 'Inspect windows', gui_activate_window: 'Switch window', gui_screenshot: 'Capture screen',
  gui_click: 'Click', gui_type: 'Type text', gui_scroll: 'Scroll', gui_hotkey: 'Use shortcut'
}

export default function GuiPreviewApp(): React.JSX.Element {
  const api = window.guiPreview!
  const [state, setState] = useState<GuiPreviewSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const inFlight = useRef(false)
  const alive = useRef(true)
  const receive = (value: GuiPreviewSnapshot): void => {
    if (alive.current) setState(previous => previous && previous.revision > value.revision ? previous : value)
  }
  useEffect(() => {
    alive.current = true
    document.documentElement.classList.add('is-gui-preview')
    const off = api.onState(receive)
    void api.getState().then(receive).catch(e => { if (alive.current) setError(String(e)) })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive.current = false; off(); clearInterval(timer); document.documentElement.classList.remove('is-gui-preview') }
  }, [api])
  const zh = state?.language !== 'en'
  const action = async (run: () => Promise<unknown>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await run() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const age = state?.frame ? Math.max(0, Math.floor((now - state.frame.capturedAt) / 1000)) : 0
  const ageLabel = age < 60 ? `${age}${zh ? ' 秒前' : 's ago'}` : `${Math.floor(age / 60)}${zh ? ' 分钟前' : 'm ago'}`
  return <main className="gui-preview" aria-label={zh ? '电脑操作画中画' : 'Computer use preview'}>
    <header className="gui-preview-header"><Monitor size={16}/><strong>{zh ? '电脑操作' : 'Computer use'}</strong>
      <button type="button" aria-label={zh ? '关闭画中画' : 'Close preview'} title={zh ? '关闭画中画，任务继续运行' : 'Close preview; task continues'} onClick={() => void action(() => api.close())}><X size={16}/></button>
    </header>
    {!state ? <section className="gui-preview-loading"><Monitor size={30}/><p>{error || (zh ? '加载原任务…' : 'Loading task…')}</p><button type="button" onClick={() => void action(async () => receive(await api.getState()))}>{zh ? '重试' : 'Retry'}</button></section> : <>
      <div className="gui-preview-task"><span title={state.title}>{state.title}</span><span className={`gui-preview-status is-${state.phase}`}>{phases[state.phase][zh ? 0 : 1]}</span></div>
      <figure className="gui-preview-frame">
        {state.frame ? <img src={state.frame.dataUrl} alt={`${zh ? '最近授权截图' : 'Last authorized capture'}: ${state.frame.sourceLabel}`}/> : <div className="gui-preview-empty"><Monitor size={30}/><strong>{zh ? '等待已授权画面' : 'Waiting for an authorized capture'}</strong><span>{zh ? '任务执行截图后，画面将在这里显示。' : 'The next approved task screenshot appears here.'}</span></div>}
      </figure>
      <div className="gui-preview-caption">{state.frame ? <><span title={state.frame.sourceLabel}>{state.frame.sourceLabel}</span><time dateTime={new Date(state.frame.capturedAt).toISOString()} title={new Date(state.frame.capturedAt).toLocaleString()}>{zh ? '截图于' : 'Captured'} {ageLabel}</time></> : <span>{zh ? '显示最近一次截图；不会自动截取桌面。' : 'Shows the last capture; no automatic screen recording.'}</span>}</div>
      <section className="gui-preview-operation" aria-live="polite">
        <strong>{state.action ? zh ? state.action.label : actionEnglish[state.action.toolName] || state.action.label : phases[state.phase][zh ? 0 : 1]}</strong>
        {state.action && <span title={state.action.target}>{state.action.target}</span>}
        {state.message && <p>{state.message}</p>}
      </section>
      <footer className="gui-preview-controls">
        <button type="button" disabled={busy || !state.canStop} onClick={() => void action(async () => receive(await api.pause(state.runId)))}><Pause size={14}/>{zh ? '暂停' : 'Pause'}</button>
        <button type="button" className="gui-preview-takeover" disabled={busy || !state.canStop} onClick={() => void action(async () => receive(await api.takeOver(state.runId)))}><Hand size={14}/>{zh ? '我来接管' : 'Take over'}</button>
        <button type="button" disabled={busy || !state.available} onClick={() => void action(() => api.openTask())}><ArrowUpRight size={15}/>{zh ? '原任务' : 'Task'}</button>
      </footer>
    </>}
    {state && error && <p className="gui-preview-error" role="alert">{error}</p>}
  </main>
}
