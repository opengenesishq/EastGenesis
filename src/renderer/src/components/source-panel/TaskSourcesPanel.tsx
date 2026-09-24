import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ExternalLink, FileText, FolderOpen, RefreshCw } from 'lucide-react'
import type { SessionMeta } from '../../../../shared/types'
import type { TaskSourceCollection, TaskSourceDetail, TaskSourceItem } from '../../../../shared/task-source-types'
import { useStore } from '../../store'
import PreviewRenderer from '../workbench/PreviewRenderer'
import ResearchSourceDetails from '../workbench/ResearchSourceDetails'
import './task-sources.css'

function identity(meta?: SessionMeta): string {
  return JSON.stringify(meta ? [meta.id, meta.createdAt, meta.cwd, meta.sourceCwd, meta.taskMemorySessionId, meta.sdkSessionId, meta.workspaceId, meta.projectId, meta.goalId, meta.workItemId] : [])
}
export default function TaskSourcesPanel({ sessionId, active }: { sessionId: string | null; active: boolean }): React.JSX.Element {
  const taskIdentity = useStore(state => identity(sessionId ? state.sessions[sessionId]?.meta : undefined))
  const zh = useStore(state => state.settings.language === 'zh')
  if (!active) return <></>
  if (!sessionId) return <div className="task-sources-empty">{zh ? '开始任务后可查看附件、成果和来源。' : 'Start a task to see attachments, outputs and sources.'}</div>
  return <Sources key={`${sessionId}:${taskIdentity}`} sessionId={sessionId} taskIdentity={taskIdentity} />
}

function Sources({ sessionId, taskIdentity }: { sessionId: string; taskIdentity: string }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [collection, setCollection] = useState<TaskSourceCollection | null>(null)
  const [detail, setDetail] = useState<TaskSourceDetail | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0), mounted = useRef(false)
  const current = useCallback(() => {
    const state = useStore.getState()
    return mounted.current && state.activeId === sessionId && !state.showNewSession && state.workbench.activePanelId === 'sources' && identity(state.sessions[sessionId]?.meta) === taskIdentity
  }, [sessionId, taskIdentity])
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true); setReading(false); setError(''); setDetail(null); setSelected(null); setCollection(null)
    try {
      const result = await window.agentDesk.listTaskSources(sessionId)
      if (current() && request === sequence.current) setCollection(result)
    } catch (err) { if (current() && request === sequence.current) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (current() && request === sequence.current) setLoading(false) }
  }, [current, sessionId])
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false; sequence.current++ }
  }, [refresh])
  const read = async (item: TaskSourceItem) => {
    if (!collection || !current()) return
    const request = ++sequence.current
    setSelected(item.id); setDetail(null); setReading(true); setError('')
    try {
      const result = await window.agentDesk.readTaskSource(sessionId, collection.collectionId, item.id)
      if (current() && request === sequence.current) setDetail(result)
    } catch (err) { if (current() && request === sequence.current) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (current() && request === sequence.current) setReading(false) }
  }
  const openRecordedUrl = async () => {
    if (!collection || !detail || !current()) throw new Error('任务已变化')
    const request = sequence.current
    const url = await window.agentDesk.resolveTaskSourceUrl(sessionId, collection.collectionId, detail.item.id)
    if (!current() || request !== sequence.current) throw new Error('任务或选择已变化')
    await useStore.getState().openBrowserPanel(url)
  }
  const items = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return (collection?.items ?? []).filter(item => !term || `${item.title} ${item.mime ?? ''} ${item.artifactId ?? ''} ${item.evidenceId ?? ''}`.toLocaleLowerCase().includes(term))
  }, [collection, query])
  const groups: Array<{ kind: TaskSourceItem['kind']; label: string }> = [
    { kind: 'attachment', label: zh ? '任务附件' : 'Task attachments' },
    { kind: 'artifact', label: zh ? '成果与版本' : 'Outputs and versions' },
    { kind: 'research', label: zh ? '已登记来源' : 'Recorded sources' }
  ]
  return <section className="task-sources-panel" aria-label={zh ? '当前任务资料' : 'Current task sources'} data-task-sources={sessionId}>
    <header className="task-sources-heading"><div><h2>{zh ? '资料' : 'Sources'}</h2><p>{zh ? '当前任务的附件、成果和来源' : 'Attachments, outputs and sources for this task'}</p></div>
      <button className="icon-btn" type="button" disabled={loading} aria-label={zh ? '刷新资料' : 'Refresh sources'} title={zh ? '刷新资料' : 'Refresh sources'} onClick={() => void refresh()}><RefreshCw size={15} /></button>
    </header>
    <label className="task-sources-search"><span className="sr-only">{zh ? '搜索任务资料' : 'Search task sources'}</span><input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索资料…' : 'Search sources…'} /></label>
    {error && <div className="notice notice-error" role="alert">{error}<button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>{zh ? '重新加载' : 'Reload'}</button></div>}
    {collection?.warnings.map(warning => <p className="task-sources-note" key={warning}>{warning}</p>)}
    {loading && <p className="task-sources-empty" role="status">{zh ? '正在读取任务记录…' : 'Reading task records…'}</p>}
    {!loading && collection && groups.map(group => {
      const matching = items.filter(item => item.kind === group.kind)
      return <section key={group.kind} className="task-sources-group"><h3>{group.label}<span>{matching.length}</span></h3>
        {matching.length ? <ul>{matching.map(item => <li key={item.id}><button type="button" className={`task-source-row${selected === item.id ? ' is-selected' : ''}`} aria-pressed={selected === item.id} onClick={() => void read(item)}>
          {item.kind === 'research' ? <BookOpen size={16} /> : <FileText size={16} />}<span><strong>{item.title}</strong><small>{sourceLabel(item, zh)}{item.version !== undefined ? ` · v${item.version}` : ''}{item.historical ? (zh ? ' · 历史版本' : ' · Previous version') : ''}</small>
            {item.unavailableReason && <small className="task-source-unavailable">{item.unavailableReason}</small>}</span>
        </button></li>)}</ul> : <p className="task-sources-empty">{query ? (zh ? '没有匹配的资料' : 'No matching sources') : group.kind === 'research' ? (zh ? '尚无登记来源；对话中的普通链接不会自动记为来源。' : 'No recorded sources. Links in conversation are not automatically registered.') : (zh ? '暂无记录' : 'No records yet')}</p>}
      </section>
    })}
    {reading && <p className="task-sources-empty" role="status">{zh ? '正在核对资料版本…' : 'Checking source version…'}</p>}
    {detail && <section className="task-source-detail" aria-label={zh ? '资料详情' : 'Source details'}>
      <h3>{detail.item.title}</h3><p className="task-sources-note">{sourceLabel(detail.item, zh)}</p>
      {detail.item.provenance === 'imported_attachment' && <p className="task-sources-note">{zh ? '已导入当前任务，未找到发送记录。文件库未保存原始文件名。' : 'Imported into this task; no sent-message record was found. The vault did not retain the original filename.'}</p>}
      {detail.item.unavailableReason && <p role="status">{detail.item.unavailableReason}</p>}
      {detail.item.digest && <code className="task-source-digest">{detail.item.digest}</code>}
      {detail.preview && <PreviewRenderer preview={{ ...detail.preview }} />}
      {detail.evidence && <ResearchSourceDetails key={detail.evidence.id} evidence={detail.evidence} language={zh ? 'zh' : 'en'} onOpen={openRecordedUrl} />}
      {(detail.artifact || detail.evidence) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { if (current()) useStore.getState().openPanel('result') }}><ExternalLink size={14} />{zh ? '打开成果与证据记录' : 'Open outputs and evidence'}</button>}
    </section>}
    {collection && <section className="task-sources-group task-source-memory"><h3>{zh ? '记忆' : 'Memory'}</h3><p className="task-sources-note">{zh ? '记忆是工作上下文，不代表本次任务已引用的来源。' : 'Memory provides context; it is not evidence that a source was used in this task.'}</p>
      <button type="button" className="task-source-row" onClick={() => { if (current()) useStore.getState().openPanel('memory', { memoryScope: 'task' }) }}><BookOpen size={16} /><span><strong>{zh ? '任务记忆' : 'Task memory'}</strong><small>{zh ? '当前任务保存的事实与约定' : 'Facts and instructions saved for this task'}</small></span></button>
      {collection.memory.project && <button type="button" className="task-source-row" onClick={() => { if (current()) useStore.getState().openPanel('memory', { memoryScope: 'project' }) }}><FolderOpen size={16} /><span><strong>{zh ? '项目记忆' : 'Project memory'}</strong><small>{zh ? '同项目共享，草稿确认后生效' : 'Shared within this project after confirmation'}</small></span></button>}
    </section>}
  </section>
}
function sourceLabel(item: TaskSourceItem, zh: boolean): string {
  if (item.provenance === 'message_attachment') return zh ? '消息中的附件' : 'Message attachment'
  if (item.provenance === 'imported_attachment') return zh ? '已导入 · 未找到发送记录' : 'Imported · no sent record'
  if (item.kind === 'artifact') return zh ? '已登记成果' : 'Registered output'
  return item.sourceContentKind === 'search_snippet' ? (zh ? '搜索摘要 · 尚未读取原文' : 'Search summary · page not read') : (zh ? '已登记来源记录' : 'Recorded source')
}
