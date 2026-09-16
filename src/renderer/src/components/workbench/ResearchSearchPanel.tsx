import { useEffect, useRef, useState } from 'react'
import type { AssistantSearchAttempt } from '../../../../shared/assistant-search-types'
import { useStore } from '../../store'
import './research-search-panel.css'

const recentSearches = new Map<string, AssistantSearchAttempt>()

/** Search stays with this task; navigation neither starts a Run nor dispatches an Agent. */
export default function ResearchSearchPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const en = useStore(state => state.settings.language) === 'en'
  const status = useStore(state => state.sessions[sessionId]?.meta.status)
  const openBrowser = useStore(state => state.openBrowserPanel)
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState<AssistantSearchAttempt | undefined>(() => recentSearches.get(sessionId))
  const [pending, setPending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const active = useRef<{ requestId: string; cancelled: boolean }>()
  const available = status === 'idle' || status === 'error'
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const search = async (): Promise<void> => {
    if (!query.trim() || !available || active.current) return
    const operation = { requestId: crypto.randomUUID(), cancelled: false }
    active.current = operation
    setPending(true); setCancelling(false); setError(''); setAttempt(undefined)
    try {
      const request = await window.agentDesk.authorizeAssistantSearch({ sessionId, requestId: operation.requestId, query })
      if (operation.cancelled) {
        await window.agentDesk.cancelAssistantSearch(sessionId, operation.requestId)
        return
      }
      const result = await window.agentDesk.searchAssistant(request)
      recentSearches.set(sessionId, result)
      if (recentSearches.size > 100) recentSearches.delete(recentSearches.keys().next().value!)
      if (mounted.current) setAttempt(result)
    } catch (cause) {
      if (mounted.current && !operation.cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      active.current = undefined
      if (mounted.current) { setPending(false); setCancelling(false) }
    }
  }
  const cancel = async (): Promise<void> => {
    const operation = active.current
    if (!operation) return
    operation.cancelled = true
    setCancelling(true)
    try { await window.agentDesk.cancelAssistantSearch(sessionId, operation.requestId) }
    catch { if (mounted.current) setError(en ? 'Could not confirm cancellation. Check the result before retrying.' : '尚未确认取消结果，请先核对本次结果再重试。') }
  }
  const open = async (url: string): Promise<void> => {
    if (useStore.getState().activeId !== sessionId) return
    try { await openBrowser(url) }
    catch { if (mounted.current) setError(en ? 'Could not open the source.' : '暂时无法打开来源。') }
  }

  return <section className="research-search-panel" aria-label={en ? 'Research sources' : '搜索资料'} data-research-search-session={sessionId}>
    <h3>{en ? 'Research sources' : '搜索资料'}</h3>
    <form onSubmit={event => { event.preventDefault(); void search() }}>
      <label className="research-search-label" htmlFor={`research-query-${sessionId}`}>{en ? 'Search query' : '想查找什么'}</label>
      <input id={`research-query-${sessionId}`} className="input" maxLength={512} value={query} disabled={pending}
        placeholder={en ? 'A question, topic, or source' : '输入问题、主题或来源'} onChange={event => setQuery(event.target.value)} />
      <p className="research-search-help">{en ? 'Search sends this query to Bing. Results are saved as sources for this task.' : '搜索会将这段查询发送给 Bing，结果登记为当前任务的来源。'}</p>
      <div className="research-search-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!query.trim() || !available || pending}>
          {pending ? (en ? 'Searching…' : '搜索中…') : (en ? 'Search' : '搜索')}
        </button>
        {pending && <button type="button" className="btn btn-ghost btn-sm" disabled={cancelling} onClick={() => void cancel()}>
          {cancelling ? (en ? 'Cancelling…' : '取消中…') : (en ? 'Cancel search' : '取消搜索')}
        </button>}
      </div>
      {!available && <p className="research-search-help">{en ? 'Pause the task before using its browser to search.' : '先暂停当前任务，再使用它的浏览器搜索资料。'}</p>}
    </form>
    {error && <p role="alert">{error}</p>}
    {attempt?.status === 'failed' && <p role="status">{failureLabel(attempt, en)}</p>}
    {attempt?.status === 'succeeded' && <div aria-live="polite">
      <p>{en ? `${attempt.citations.length} sources recorded` : `已登记 ${attempt.citations.length} 条来源`}</p>
      <p className="research-search-help">{en ? 'Search summaries; original pages have not been read.' : '以下是搜索摘要，尚未读取原网页正文。'}</p>
      <ol className="research-search-results">{attempt.citations.map(citation => <li key={citation.evidenceId}>
        <p>{citation.summary}</p>
        <time className="research-search-help" dateTime={new Date(citation.fetchedAt).toISOString()}>{new Date(citation.fetchedAt).toLocaleString(en ? 'en-US' : 'zh-CN')}</time>
        <button type="button" className="btn btn-ghost btn-sm" title={citation.url} onClick={() => void open(citation.url)}>
          {en ? 'Open source' : '打开来源'} · {sourceHost(citation.url)}
        </button>
      </li>)}</ol>
    </div>}
  </section>
}

function sourceHost(url: string): string { try { return new URL(url).hostname } catch { return '' } }
function failureLabel(attempt: AssistantSearchAttempt, en: boolean): string {
  const labels: Record<string, [string, string]> = {
    cancelled: ['搜索已取消。', 'Search cancelled.'],
    no_results: ['未找到可登记的来源，可调整查询后重试。', 'No usable sources found. Try a different query.'],
    timeout: ['本次搜索超时，请核对浏览器中的实际状态后重试。', 'Search timed out. Check the browser before retrying.'],
    unknown: ['上次搜索结果未知，未自动重新发送。请先核对原记录。', 'The previous outcome is unknown. It was not sent again automatically. Check its records first.'],
    scope_denied: ['任务或运行已变化，请回到原任务核对后重新搜索。', 'The task or Run changed. Check the original task before searching again.'],
    egress_denied: ['本次搜索未获得外发查询授权。', 'Sending this query was not authorized.'],
    browser_unavailable: ['当前任务的浏览器不可用，请重新打开浏览器。', 'The task browser is unavailable. Open it again.']
  }
  return labels[attempt.failureCode ?? '']?.[en ? 1 : 0] ?? (en ? 'Search did not complete. Check the browser for a connection error or sign-in request.' : '搜索未完成，请检查浏览器中的连接错误或登录提示。')
}
