import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { ChatItem } from '../store'
import { useStore } from '../store'
import { isShortcutCapture, matchesDesktopShortcut } from '../desktop-keyboard'
import './conversation-find.css'

export const CONVERSATION_FIND_EVENT = 'caogen:find-current-conversation'

export function requestConversationFind(): boolean {
  return !window.dispatchEvent(new Event(CONVERSATION_FIND_EVENT, { cancelable: true }))
}

export interface ConversationMatch {
  itemId: string
  before: string
  match: string
  after: string
}

/** Search message bodies, excluding private reasoning and tool parameters. */
export function findConversationMessages(items: ChatItem[], query: string): ConversationMatch[] {
  const needle = query.trim()
  if (!needle) return []
  const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  const matches: ConversationMatch[] = []
  for (const item of items) {
    const text = item.kind === 'user' || item.kind === 'notice' ? item.text
      : item.kind === 'assistant' ? item.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n')
        : item.kind === 'turn-result' && item.isError ? item.resultText ?? '' : ''
    const found = expression.exec(text)
    if (!found) continue
    const at = found.index
    const length = found[0].length
    matches.push({ itemId: item.id,
      before: `${at > 48 ? '…' : ''}${text.slice(Math.max(0, at - 48), at)}`,
      match: text.slice(at, at + length),
      after: `${text.slice(at + length, at + length + 96)}${text.length > at + length + 96 ? '…' : ''}` })
  }
  return matches
}

export function useConversationFind(sessionId: string | null, items: ChatItem[], root: React.RefObject<HTMLDivElement>, beforeReveal: () => void) {
  const [openedFor, setOpenedFor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const open = Boolean(sessionId && openedFor === sessionId)
  const matches = useMemo(() => open ? findConversationMessages(items, query) : [], [items, open, query])
  const index = Math.max(0, matches.findIndex((match) => match.itemId === selectedId))
  const selected = matches[index]
  const inputRef = useRef<HTMLInputElement>(null)
  const show = useCallback(() => {
    if (!sessionId) return
    setOpenedFor(sessionId)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
  }, [sessionId])
  const close = (): void => {
    setOpenedFor(null)
    root.current?.querySelector<HTMLButtonElement>('.header-more > button')?.focus()
  }
  useEffect(() => { setOpenedFor(null); setQuery(''); setSelectedId(null) }, [sessionId])
  useEffect(() => {
    const available = (): boolean => Boolean(sessionId && root.current && root.current.getBoundingClientRect().width > 0)
    const onFind = (event: Event): void => {
      if (!available()) return
      event.preventDefault()
      show()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (isShortcutCapture(event.target) || !matchesDesktopShortcut(event, 'findConversation', useStore.getState().settings.desktopShortcuts) || !available()) return
      // Editors and terminal use their own find shortcuts when focused.
      if ((event.target as Element | null)?.closest?.('.monaco-editor, .xterm')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      show()
    }
    window.addEventListener(CONVERSATION_FIND_EVENT, onFind)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener(CONVERSATION_FIND_EVENT, onFind); window.removeEventListener('keydown', onKey, true) }
  }, [root, sessionId, show])
  const changeQuery = (next: string): void => {
    beforeReveal()
    setQuery(next)
    setSelectedId(null)
    setRevision((value) => value + 1)
  }
  const move = (delta: number): void => {
    if (!matches.length) return
    beforeReveal()
    setSelectedId(matches[(index + delta + matches.length) % matches.length].itemId)
    setRevision((value) => value + 1)
  }
  return { open, show, close, query, changeQuery, inputRef, index, selected, count: matches.length, move,
    reveal: selected ? { itemId: selected.itemId, revision } : undefined }
}

export function ConversationFindBar({ find, zh }: { find: ReturnType<typeof useConversationFind>; zh: boolean }): React.JSX.Element | null {
  if (!find.open) return null
  return <section className="conversation-find" role="search" aria-label={zh ? '在当前对话中查找' : 'Find in this conversation'}>
    <div className="conversation-find-controls">
      <Search size={15} aria-hidden="true" />
      <input ref={find.inputRef} type="search" value={find.query} placeholder={zh ? '查找消息正文' : 'Find in message text'}
        aria-label={zh ? '查找消息正文' : 'Find in message text'} onChange={(event) => find.changeQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); find.move(event.shiftKey ? -1 : 1) }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); find.close() }
        }} />
      <span className="conversation-find-count" role="status" aria-live="polite">{find.query.trim()
        ? `${find.count ? find.index + 1 : 0} / ${find.count}${zh ? ' 条消息' : ' messages'}`
        : (zh ? '当前对话' : 'This conversation')}</span>
      <button type="button" className="icon-btn" disabled={!find.count} aria-label={zh ? '上一条匹配消息' : 'Previous matching message'} title="Shift+Enter" onClick={() => find.move(-1)}><ChevronUp size={16} /></button>
      <button type="button" className="icon-btn" disabled={!find.count} aria-label={zh ? '下一条匹配消息' : 'Next matching message'} title="Enter" onClick={() => find.move(1)}><ChevronDown size={16} /></button>
      <button type="button" className="icon-btn" aria-label={zh ? '关闭对话查找' : 'Close conversation search'} onClick={find.close}><X size={15} /></button>
    </div>
    {find.selected && <div className="conversation-find-excerpt">{find.selected.before}<mark>{find.selected.match}</mark>{find.selected.after}</div>}
    {find.query.trim() && !find.count && <div className="conversation-find-excerpt">{zh ? '当前对话中没有匹配的消息。' : 'No matching messages in this conversation.'}</div>}
  </section>
}

export function revealConversationMessage(scroll: HTMLDivElement, node: HTMLElement): void {
  const viewport = scroll.getBoundingClientRect()
  const row = node.getBoundingClientRect()
  scroll.scrollTop += row.top - viewport.top - Math.max(24, (viewport.height - row.height) / 2)
}
