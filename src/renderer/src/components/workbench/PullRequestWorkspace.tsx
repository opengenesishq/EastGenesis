import { useEffect, useRef, useState } from 'react'
import type { PullRequestWorkspaceCapability, PullRequestWorkspaceFeedback, PullRequestWorkspaceList,
  PullRequestWorkspaceSection, PullRequestWorkspaceSnapshot } from '../../../../shared/pull-request-workspace-types'
import { appendPersistentComposerDraft } from '../../store/composer-draft-persistence'
import './PullRequestWorkspace.css'

const labels: Record<PullRequestWorkspaceSection | 'overview', string> = { overview: '概览', files: '文件', commits: '提交', comments: '评论', reviews: '审查', checks: '检查' }
const sectionNames: PullRequestWorkspaceSection[] = ['files', 'commits', 'comments', 'reviews', 'checks']
type Tab = PullRequestWorkspaceSection | 'overview'

export default function PullRequestWorkspace({ sessionId, onClose }: { sessionId: string; onClose(): void }): React.JSX.Element {
  const [capability, setCapability] = useState<PullRequestWorkspaceCapability>()
  const [list, setList] = useState<PullRequestWorkspaceList>()
  const [snapshot, setSnapshot] = useState<PullRequestWorkspaceSnapshot>()
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open')
  const [tab, setTab] = useState<Tab>('overview')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>()
  const generation = useRef(0), alive = useRef(true), selectionRequest = useRef<{ key: string; requestId: string }>()
  const repo = capability?.repository
  useEffect(() => {
    alive.current = true; const key = ++generation.current
    void window.agentDesk.inspectPullRequestWorkspace(sessionId).then(value => {
      if (alive.current && key === generation.current) setCapability(value)
    }).catch(cause => { if (alive.current && key === generation.current) setError(message(cause)) })
    return () => { alive.current = false; generation.current++ }
  }, [sessionId])
  async function inspect(): Promise<void> {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const next = await window.agentDesk.inspectPullRequestWorkspace(sessionId)
      if (!alive.current) return
      setCapability(next)
      if (next.repository?.digest !== repo?.digest) { setList(undefined); setSnapshot(undefined); setSelected([]) }
    } catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function loadList(page = 1, state = filter): Promise<void> {
    if (!repo || busy) return
    const key = ++generation.current; setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await window.agentDesk.listPullRequestWorkspaceItems(sessionId, { state, page, expectedRepositoryDigest: repo.digest })
      if (!alive.current || key !== generation.current) return
      if (result.ok) { setList(result.value); setFilter(state) } else setError(result.issue.message)
    } catch (cause) { if (alive.current && key === generation.current) setError(message(cause)) }
    finally { if (alive.current && key === generation.current) setBusy(false) }
  }
  async function read(number: number, pages: Partial<Record<PullRequestWorkspaceSection, number>> = {}, nextTab: Tab = 'overview', keepHead = false): Promise<void> {
    if (!repo || busy) return
    const key = ++generation.current; setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await window.agentDesk.readPullRequestWorkspaceItem(sessionId, { number, expectedRepositoryDigest: repo.digest, pages,
        ...(keepHead && snapshot ? { expectedHeadSha: snapshot.pullRequest.headSha } : {}) })
      if (!alive.current || key !== generation.current) return
      if (result.ok) {
        const next = result.value
        const previousFeedback = [...snapshot?.comments?.items ?? [], ...snapshot?.reviews?.items ?? []]
        const nextFeedback = [...next.comments?.items ?? [], ...next.reviews?.items ?? []]
        setSelected(current => keepHead ? current.filter(id => {
          const previous = previousFeedback.find(item => item.id === id), replacement = nextFeedback.find(item => item.id === id)
          return previous && replacement && JSON.stringify(previous) === JSON.stringify(replacement)
        }) : [])
        setSnapshot(next); setTab(nextTab)
      } else setError(result.issue.message)
    } catch (cause) { if (alive.current && key === generation.current) setError(message(cause)) }
    finally { if (alive.current && key === generation.current) setBusy(false) }
  }
  function pageMap(): Partial<Record<PullRequestWorkspaceSection, number>> {
    return Object.fromEntries(sectionNames.flatMap(section => snapshot?.[section] ? [[section, snapshot[section]!.page]] : []))
  }
  function openTab(next: Tab): void {
    if (busy || !snapshot) return
    if (next === 'overview' || snapshot[next]) { setTab(next); return }
    void read(snapshot.pullRequest.number, { ...pageMap(), [next]: 1 }, next, true)
  }
  async function adopt(): Promise<void> {
    if (!snapshot || !selected.length || busy) return
    setBusy(true); setError(undefined); setNotice(undefined)
    const key = `${snapshot.digest}:${[...selected].sort().join(',')}`
    if (selectionRequest.current?.key !== key) selectionRequest.current = { key, requestId: crypto.randomUUID() }
    try {
      const draft = await window.agentDesk.preparePullRequestReviewDraft(sessionId, { snapshotId: snapshot.id, snapshotDigest: snapshot.digest,
        selectedFeedbackIds: [...selected].sort(), requestId: selectionRequest.current.requestId })
      if (!alive.current) return
      const receipt = appendPersistentComposerDraft(window.localStorage, sessionId, draft.text, draft.id)
      setNotice(receipt.duplicate ? '这些意见已在当前任务草稿中。' : '已加入当前任务输入框，并保存原意见证据。核对后点击发送才会执行。')
    } catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  function toggleFeedback(id: string): void {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : current.length < 20 ? [...current, id] : current)
  }
  const collection = snapshot && tab !== 'overview' ? snapshot[tab] : undefined

  return <section className="pr-workspace" aria-label="PR/MR 工作区">
    <header className="pr-workspace-header"><div><h3>PR/MR 工作区</h3><p>浏览远端代码审查，将选定意见带入当前任务。</p></div>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>收起</button></header>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice notice-info" role="status">{notice}</div>}
    {repo && <p className="pr-workspace-hint">{repo.host}/{repo.projectPath} · {repo.branch ?? 'Detached HEAD'} · {repo.localHeadSha.slice(0, 10)}</p>}
    {!capability?.available && <p>{capability?.message ?? '正在检查本地仓库…'}</p>}
    <div className="pr-workspace-actions">
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void inspect()}>重新检查工具</button>
      <select aria-label="PR/MR 状态" value={filter} disabled={busy} onChange={event => { setFilter(event.target.value as typeof filter); setList(undefined) }}>
        <option value="open">开放中</option><option value="closed">已关闭</option><option value="all">全部</option>
      </select>
      <button className="btn btn-primary btn-sm" disabled={busy || !capability?.available} onClick={() => void loadList()}>{list ? '刷新列表' : '读取 PR/MR 列表'}</button>
    </div>
    {!list && capability?.available && <p className="pr-workspace-hint">读取时使用 {capability.tool} 的登录状态。文件、评论等详情只在打开对应标签后加载。</p>}
    {busy && <p role="status">正在读取或整理所选内容…</p>}
    {list && <div className="pr-workspace-list">
      {list.items.length ? list.items.map(item => <button type="button" key={item.number} className={`pr-workspace-row${snapshot?.pullRequest.number === item.number ? ' active' : ''}`}
        disabled={busy} onClick={() => void read(item.number)}><span>#{item.number} · {item.state}{item.draft ? ' · 草稿' : ''}</span><b>{item.title}</b><small>{item.author} · {item.sourceBranch} → {item.baseBranch}</small></button>) : <p>本页没有符合条件的 PR/MR。</p>}
      <Pagination page={list.page} hasMore={list.hasMore} disabled={busy} onPage={page => void loadList(page)} />
    </div>}
    {snapshot && <div className="pr-workspace-detail">
      <header className="pr-workspace-header"><div><h3>#{snapshot.pullRequest.number} {snapshot.pullRequest.title}</h3>
        <p>{snapshot.pullRequest.state} · {snapshot.pullRequest.sourceBranch} → {snapshot.pullRequest.baseBranch}</p></div>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void read(snapshot.pullRequest.number)}>刷新概览</button></header>
      <p className="pr-workspace-hint">读取于 {new Date(snapshot.observedAt).toLocaleString()} · HEAD <code>{snapshot.pullRequest.headSha.slice(0, 12)}</code> · <ExternalLink url={snapshot.pullRequest.url}>打开原 PR/MR</ExternalLink></p>
      {snapshot.repository.localHeadSha !== snapshot.pullRequest.headSha && <p className="pr-workspace-hint">本地 HEAD 与这份 PR/MR 不同。采纳意见前需核对当前代码。</p>}
      <nav className="pr-workspace-tabs" aria-label="PR/MR 内容">{(['overview', ...sectionNames] as Tab[]).map(name => <button key={name} type="button" aria-pressed={tab === name}
        disabled={busy} onClick={() => openTab(name)}>{labels[name]}{name !== 'overview' && snapshot[name] ? ` (${snapshot[name]!.items.length})` : ''}</button>)}</nav>
      {tab === 'overview' && <><pre className="pr-workspace-prose">{snapshot.pullRequest.body || '没有说明。'}</pre>{snapshot.pullRequest.bodyTruncated && <p className="pr-workspace-hint">说明过长，当前预览已截断；全文见原 PR/MR。</p>}</>}
      {collection && <>
        {collection.issue && <div className="notice notice-info">{collection.issue.message} 部分内容可能未读取。<button className="btn btn-ghost btn-sm" disabled={busy}
          onClick={() => void read(snapshot.pullRequest.number, pageMap(), tab, true)}>重试当前页</button></div>}
        {collection.truncated && <p className="pr-workspace-hint">本页有内容被截断或远端未提供完整内容，全文请在原 PR/MR 核对。</p>}
        {!collection.items.length && !collection.issue && <p>本页没有{labels[tab]}记录。</p>}
        {tab === 'files' && snapshot.files?.items.map(file => <details key={file.path} className="pr-workspace-file"><summary><code>{file.path}</code> · {file.status}
          {file.additions !== undefined ? ` · +${file.additions}/−${file.deletions ?? 0}` : ''}</summary>
          {file.previousPath && file.previousPath !== file.path && <p>原路径：{file.previousPath}</p>}
          <pre className="pr-workspace-patch">{file.patch || '远端未提供文本差异（可能是二进制或大文件）。'}</pre>{file.patchTruncated && <p className="pr-workspace-hint">差异未完整显示。</p>}</details>)}
        {tab === 'commits' && snapshot.commits?.items.map(commit => <div className="pr-workspace-commit" key={commit.sha}><code>{commit.sha.slice(0, 10)}</code><b>{commit.title}</b><span>{commit.author}</span><ExternalLink url={commit.url}>原提交</ExternalLink></div>)}
        {(tab === 'comments' || tab === 'reviews') && (snapshot[tab]?.items ?? []).map(feedback => <Feedback key={feedback.id} feedback={feedback} checked={selected.includes(feedback.id)} disabled={busy || selected.length >= 20 && !selected.includes(feedback.id)} onToggle={() => toggleFeedback(feedback.id)} />)}
        {tab === 'checks' && snapshot.checks?.items.map(check => <div className="pr-workspace-check" key={check.id}><b>{check.name}</b><span>{check.status}{check.conclusion ? ` · ${check.conclusion}` : ''}</span><ExternalLink url={check.url}>原检查</ExternalLink></div>)}
        <Pagination page={collection.page} hasMore={collection.hasMore} disabled={busy} onPage={page => void read(snapshot.pullRequest.number, { ...pageMap(), [tab]: page }, tab, true)} />
      </>}
      <div className="pr-workspace-actions"><button className="btn btn-primary" disabled={busy || selected.length === 0} onClick={() => void adopt()}>加入当前任务草稿{selected.length ? ` (${selected.length})` : ''}</button>
        <span className="pr-workspace-hint">评论按外部原文展示；选中和加入草稿都不会自动执行。</span></div>
    </div>}
  </section>
}
function Feedback({ feedback, checked, disabled, onToggle }: { feedback: PullRequestWorkspaceFeedback; checked: boolean; disabled: boolean; onToggle(): void }): React.JSX.Element {
  return <article className="pr-workspace-feedback"><header><label><input type="checkbox" checked={checked} disabled={disabled || !feedback.body.trim() || feedback.bodyTruncated} onChange={onToggle} aria-label={`选择 ${feedback.author} 的意见 ${feedback.id}`} />
    <b>{feedback.author || '未署名'}</b></label><span>{feedback.kind === 'inline_comment' ? '行内意见' : feedback.kind === 'review' ? '审查' : '评论'}{feedback.state ? ` · ${feedback.state}` : ''}{feedback.resolved ? ' · 已解决' : ''}</span><ExternalLink url={feedback.url}>原意见</ExternalLink></header>
    {feedback.path && <p className="pr-workspace-hint"><code>{feedback.path}</code>{feedback.line ? `:${feedback.line}` : ''}{feedback.side ? ` · ${feedback.side}` : ''}{feedback.commitSha ? ` · ${feedback.commitSha.slice(0, 10)}` : ''}</p>}
    <pre className="pr-workspace-prose">{feedback.body || '此审查记录没有文字意见。'}</pre>{feedback.bodyTruncated && <p className="pr-workspace-hint">文字已截断，请在原记录中核对全文。</p>}
    <small>{feedback.updatedAt ?? feedback.createdAt ?? ''} · {feedback.id}</small></article>
}
function Pagination({ page, hasMore, disabled, onPage }: { page: number; hasMore: boolean; disabled: boolean; onPage(page: number): void }): React.JSX.Element {
  return <div className="pr-workspace-pagination"><button className="btn btn-ghost btn-sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>上一页</button><span>第 {page} 页{hasMore ? ' · 可能还有更多' : ''}</span><button className="btn btn-ghost btn-sm" disabled={disabled || !hasMore} onClick={() => onPage(page + 1)}>下一页</button></div>
}
function ExternalLink({ url, children }: { url?: string; children: React.ReactNode }): React.JSX.Element | null {
  return url && /^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noreferrer">{children}</a> : null
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
