import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, CircleStop, MessageCircle, Plus, Send, X } from 'lucide-react'
import type { SideChatSendInput, SideChatView } from '../../../../shared/side-chat-types'
import { useStore } from '../../store'
import { matchesDesktopShortcut } from '../../desktop-keyboard'
import { appendPersistentComposerDraft } from '../../store/composer-draft-persistence'
import './side-chat-panel.css'

export default function SideChatPanel({ sourceSessionId, active }: { sourceSessionId: string | null; active: boolean }): React.JSX.Element {
  return <BoundSideChatPanel key={sourceSessionId ?? 'no-task'} sourceSessionId={sourceSessionId} active={active} />
}

function BoundSideChatPanel({ sourceSessionId, active }: { sourceSessionId: string | null; active: boolean }): React.JSX.Element {
  const zh = useStore(s => s.settings.language === 'zh')
  const [items, setItems] = useState<SideChatView[]>([])
  const [current, setCurrent] = useState<SideChatView | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const createRequest = useRef<string | null>(null)
  const selection = useRef(0)
  const pendingSend = useRef<SideChatSendInput | null>(null)
  const running = current?.status === 'running' || current?.status === 'starting'
  useEffect(() => {
    if (!active || !sourceSessionId) return
    let live = true
    const revision = selection.current
    void window.agentDesk.listSideChats(sourceSessionId).then(list => {
      if (!live || revision !== selection.current) return
      setItems(list)
      setCurrent(previous => previous ? list.find(item => item.id === previous.id) ?? null : list[0] ?? null)
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [active, sourceSessionId])
  useEffect(() => {
    if (!current || !active || busy) return
    let live = true, loading = false
    const id = current.id, revision = selection.current
    const timer = window.setInterval(async () => {
      if (loading) return
      loading = true
      try {
        const next = await window.agentDesk.getSideChat(id)
        if (live && revision === selection.current) setCurrent(next.closed ? null : next)
      } catch (e) {
        if (live && revision === selection.current) setError(e instanceof Error ? e.message : String(e))
      } finally { loading = false }
    }, 1200)
    return () => { live = false; window.clearInterval(timer) }
  }, [active, current?.id, busy])
  const send = async (): Promise<void> => {
    if (!current || !text.trim() || busy || running) return
    const revision = selection.current
    const value = text; setText(''); setBusy(true); setError('')
    const input = pendingSend.current?.sideChatId === current.id && pendingSend.current.text === value ? pendingSend.current
      : { sideChatId: current.id, requestId: `side-${crypto.randomUUID()}`, text: value }
    pendingSend.current = input
    try {
      const result = await window.agentDesk.sendSideChatMessage(input)
      if (revision !== selection.current) return
      setCurrent(result.view)
      if (result.input.phase === 'applied') pendingSend.current = null
      else {
        setText(value)
        setError(result.input.error || (zh ? '提交仍待确认；重试会核对同一份回执。' : 'Submission is unconfirmed. Retry checks the same receipt.'))
      }
    } catch (e) { if (revision === selection.current) { setText(value); setError(e instanceof Error ? e.message : String(e)) } }
    finally { setBusy(false) }
  }
  const create = async (): Promise<void> => {
    if (!sourceSessionId || busy) return
    ++selection.current; setBusy(true); setError('')
    const requestId = createRequest.current ?? `side-create-${crypto.randomUUID()}`
    createRequest.current = requestId
    try {
      const result = await window.agentDesk.createSideChat({ sourceSessionId, requestId })
      createRequest.current = null
      setCurrent(result); setText(''); setItems(previous => [result, ...previous.filter(item => item.id !== result.id)])
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const select = async (id: string): Promise<void> => {
    const revision = ++selection.current
    setCurrent(null); setText(''); setError(''); setBusy(true)
    try { if (id) { const next = await window.agentDesk.getSideChat(id); if (revision === selection.current) setCurrent(next) } }
    catch (e) { if (revision === selection.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (revision === selection.current) setBusy(false) }
  }
  const adopt = async (messageId: string): Promise<void> => {
    if (!current || !sourceSessionId) return
    try {
      const result = await window.agentDesk.adoptSideChatAnswer({ sideChatId: current.id, messageId })
      if (result.sourceSessionId !== sourceSessionId) throw new Error(zh ? '侧聊不属于当前任务，请重新打开。' : 'This side chat belongs to another task. Reopen it from its source.')
      appendPersistentComposerDraft(window.localStorage, result.sourceSessionId, result.text, result.adoptionId)
      setError(zh ? '已加入原任务草稿。' : 'Added to the source draft.')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const close = async (): Promise<void> => { if (!current || busy) return; setBusy(true); ++selection.current; try { await window.agentDesk.closeSideChat(current.id); setCurrent(null); setText(''); setItems(previous => previous.filter(item => item.id !== current.id)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const interrupt = async (): Promise<void> => { if (!current || busy) return; setBusy(true); try { await window.agentDesk.interruptSideChat(current.id) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const messages = useMemo(() => current?.messages ?? [], [current])
  return <section className="side-chat-panel" data-side-chat>
    <header><div><strong><MessageCircle size={16} />{zh ? '侧聊' : 'Side chat'}</strong><small>{current ? `${zh ? '快照' : 'Snapshot'} ${new Date(current.capturedAt).toLocaleString()}` : (zh ? '独立讨论，不打断原任务' : 'Independent discussion')}</small></div><div className="side-chat-head-actions"><button onClick={() => void create()} disabled={!sourceSessionId || busy} title={zh ? '新建侧聊' : 'New side chat'}><Plus size={15} /></button><button onClick={() => void close()} disabled={!current || busy} title={zh ? '结束侧聊' : 'Close'}><X size={15} /></button></div></header>
    {items.length > 1 && <select aria-label={zh ? '选择侧聊' : 'Select side chat'} value={current?.id ?? ''} disabled={busy} onChange={event => void select(event.target.value)}><option value="">{zh ? '选择侧聊' : 'Select side chat'}</option>{items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
    {!current ? <div className="side-chat-empty"><p>{sourceSessionId ? (zh ? '从当前任务创建一个独立讨论。' : 'Start an independent discussion from this task.') : (zh ? '先打开一个任务。' : 'Open a task first.')}</p><button onClick={() => void create()} disabled={!sourceSessionId || busy}><Plus size={14} />{zh ? '新建侧聊' : 'New side chat'}</button></div> : <><div className="side-chat-context">{zh ? '只读取创建时快照，之后原任务变化不会自动进入。' : 'Read-only snapshot captured at creation.'}</div><div className="side-chat-messages">{messages.map(message => <article key={message.id} className={`side-chat-message is-${message.role}`}><p>{message.text}</p>{message.role === 'assistant' && message.complete && <button onClick={() => void adopt(message.id)}><Check size={13} />{zh ? '采纳到原任务草稿' : 'Adopt to source draft'}</button>}</article>)}</div><div className="side-chat-compose"><textarea value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (matchesDesktopShortcut(event.nativeEvent, 'submitMultiline', useStore.getState().settings.desktopShortcuts)) { event.preventDefault(); void send() } }} placeholder={zh ? '继续讨论…' : 'Continue the discussion…'} disabled={busy} /><button onClick={() => void send()} disabled={busy || running || !text.trim()}>{busy ? <CircleStop size={15} /> : <Send size={15} />}</button></div></>}
    {running && <button type="button" className="side-chat-interrupt" onClick={() => void interrupt()} disabled={busy}><CircleStop size={14} />{zh ? '停止侧聊回答' : 'Stop side chat response'}</button>}
    {error && <p className="side-chat-error" role="status">{error}</p>}
  </section>
}
