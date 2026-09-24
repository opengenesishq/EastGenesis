import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SessionMeta, TranscriptEntry } from '../../../../shared/types'
import type { SessionState } from '../../store'
import { formatPermissionInput } from '../PermissionBar'

type RecordFilter = 'all' | 'tools' | 'permissions' | 'failures'
type Binding = Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>

export default function SessionRawRecords({ session, zh }: { session: SessionState; zh: boolean }): React.JSX.Element {
  const binding = session.meta
  return <BoundRecords key={JSON.stringify([binding.id, binding.workspaceId, binding.goalId, binding.workItemId])} binding={binding} zh={zh} />
}

function BoundRecords({ binding, zh }: { binding: Binding; zh: boolean }): React.JSX.Element {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadedAt, setLoadedAt] = useState<number>()
  const [filter, setFilter] = useState<RecordFilter>('all')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(100)
  const request = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++request.current
    setLoading(true); setError('')
    try {
      const matches = (meta: SessionMeta): boolean => meta.id === binding.id && meta.workspaceId === binding.workspaceId &&
        meta.goalId === binding.goalId && meta.workItemId === binding.workItemId && meta.status !== 'closed'
      const verifySession = async (): Promise<void> => {
        const sessions = (await window.agentDesk.listSessions()).filter(meta => meta.id === binding.id)
        if (sessions.length !== 1 || !matches(sessions[0])) throw new Error(zh ? '原会话已不可用或归属已变化，请重新打开任务。' : 'The original session is unavailable or its ownership changed. Reopen the task.')
      }
      await verifySession()
      const transcript = await window.agentDesk.getTranscript(binding.id)
      await verifySession()
      if (request.current !== generation) return
      setEntries(transcript); setLoadedAt(Date.now())
    } catch (cause) {
      if (request.current === generation) {
        setEntries([]); setLoadedAt(undefined)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally { if (request.current === generation) setLoading(false) }
  }, [binding.id, binding.workspaceId, binding.goalId, binding.workItemId, zh])
  useEffect(() => { void refresh(); return () => { request.current++ } }, [refresh])
  const records = useMemo(() => entries.map(entry => ({ entry, text: formatPermissionInput(entry) })), [entries])
  const matching = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return records.filter(({ entry, text }) => matchesFilter(entry, filter) && (!search || text.toLocaleLowerCase().includes(search)))
  }, [records, filter, query])
  const refreshLabel = zh ? '刷新原始记录' : 'Refresh source records'
  return <div className="session-raw-records" data-session-raw-records={binding.id}>
    <div className="session-raw-records-toolbar">
      <h3>{zh ? '原始会话记录' : 'Original session records'}</h3>
      <button type="button" className="btn btn-ghost btn-sm" title={refreshLabel} aria-label={refreshLabel} disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /></button>
      <select aria-label={zh ? '记录类型' : 'Record type'} value={filter} onChange={event => { setFilter(event.target.value as RecordFilter); setVisibleCount(100) }}>
        <option value="all">{zh ? '全部事件' : 'All events'}</option>
        <option value="tools">{zh ? '工具与测试输出' : 'Tools and test output'}</option>
        <option value="permissions">{zh ? '授权决定' : 'Permission decisions'}</option>
        <option value="failures">{zh ? '失败记录' : 'Failures'}</option>
      </select>
      <input type="search" aria-label={zh ? '搜索原始记录' : 'Search source records'} placeholder={zh ? '搜索记录' : 'Search records'} value={query}
        onChange={event => { setQuery(event.target.value); setVisibleCount(100) }} />
    </div>
    <p className="session-raw-records-identity">{binding.id}</p>
    <p role="status">{loading ? (zh ? '正在读取原始记录…' : 'Reading source records…') : loadedAt
      ? `${zh ? '读取时间' : 'Read at'} ${new Date(loadedAt).toLocaleTimeString()} · ${matching.length} / ${entries.length} ${zh ? '条事件' : 'events'}` : ''}
      {entries.length > 0 && ` · #${entries[0].seq} – #${entries.at(-1)!.seq}`}</p>
    {entries.length > 0 && entries[0].seq > 1 && <p role="status">{zh ? '当前为引擎返回的最近记录，序号范围之前的事件未载入。' : 'These are recent records returned by the engine. Earlier events are not loaded.'}</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && matching.length === 0 && <p>{zh ? '当前没有匹配的原始记录。' : 'No matching source records.'}</p>}
    {matching.slice(0, visibleCount).map(({ entry, text }) => <details key={`${entry.seq}:${entry.eventId ?? ''}`} data-raw-record-seq={entry.seq}>
      <summary>#{entry.seq} · {entry.event.kind}{entry.occurredAt ? ` · ${new Date(entry.occurredAt).toLocaleString()}` : ''}{entry.event.kind === 'tool-result' && entry.event.isError ? (zh ? ' · 失败' : ' · Failed') : ''}</summary>
      <pre>{text}</pre>
    </details>)}
    {matching.length > visibleCount && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVisibleCount(count => count + 100)}>{zh ? '加载更多记录' : 'Show more records'}</button>}
  </div>
}

function matchesFilter(entry: TranscriptEntry, filter: RecordFilter): boolean {
  const event = entry.event
  if (filter === 'all') return true
  if (filter === 'permissions') return event.kind === 'permission-request' || event.kind === 'permission-resolved'
  if (filter === 'tools') return event.kind === 'tool-start' || event.kind === 'tool-result' ||
    (event.kind === 'assistant-message' && event.blocks.some(block => block.type === 'tool_use')) || (event.kind === 'hook-event' && Boolean(event.shellCommand))
  return ((event.kind === 'tool-result' || event.kind === 'turn-result') && event.isError) ||
    event.kind === 'provider-recovery-exhausted' || (event.kind === 'hook-event' && event.shellOk === false)
}
