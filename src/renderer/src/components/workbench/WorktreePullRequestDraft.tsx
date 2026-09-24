import { useEffect, useId, useRef, useState } from 'react'
import type { WorktreePullRequestResult } from '../../../../shared/types'
import type { WorktreePullRequestDraft as Draft, WorktreePullRequestDraftPreparation } from '../../../../shared/worktree-pr-draft-types'
import { useStore } from '../../store'
import './WorktreePullRequestDraft.css'

const submissionLabels = { prepared: '已准备，尚未推送', pushing: '正在核对推送', pushed: '推送已确认，待创建 PR/MR',
  creating: '正在核对 PR/MR', completed: '提交已完成', needs_reconciliation: '原提交结果待核对', failed: '原提交已停止' }

export default function WorktreePullRequestDraft({ sessionId, onClose, onResult }: {
  sessionId: string; onClose(): void; onResult(result: WorktreePullRequestResult): void
}): React.JSX.Element {
  const branchList = useId()
  const [preparation, setPreparation] = useState<WorktreePullRequestDraftPreparation>()
  const [draft, setDraft] = useState<Draft>()
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [baseBranch, setBaseBranch] = useState('')
  const [busy, setBusy] = useState<'load' | 'save' | 'submit'>('load')
  const [idle, setIdle] = useState(false)
  const [error, setError] = useState<string>(), [notice, setNotice] = useState<string>()
  const [result, setResult] = useState<WorktreePullRequestResult>()
  const [verified, setVerified] = useState(false)
  const edited = useRef(false), mounted = useRef(true)
  const saveRequest = useRef<{ payload: string; id: string }>()
  const snapshot = preparation?.snapshot
  const status = draft?.submission?.status
  const locked = Boolean(status && ['pushing', 'creating', 'needs_reconciliation'].includes(status))
  const baseChanged = Boolean(snapshot && baseBranch.trim() !== snapshot.baseBranch)
  const draftMatches = Boolean(draft && snapshot && draft.snapshot.digest === snapshot.digest &&
    draft.title === title.trim() && draft.body === body && draft.snapshot.baseBranch === baseBranch.trim())
  const canStart = Boolean(preparation?.capability.available && snapshot?.remote && !snapshot.baseUnavailable &&
    snapshot.commitCount > 0 && !snapshot.dirty.conflicted)
  const readExisting = Boolean(status && (locked || status === 'completed'))

  async function load(initial = false): Promise<void> {
    setIdle(false); setBusy('load'); setError(undefined); setVerified(false)
    try {
      const next = await window.agentDesk.prepareWorktreePullRequestDraft(sessionId, initial ? undefined : { baseBranch: baseBranch.trim() })
      if (!mounted.current) return
      setPreparation(next); setDraft(next.draft); setBaseBranch(next.snapshot.baseBranch); setVerified(true)
      if (initial || !edited.current) { setTitle(next.defaults.title); setBody(next.defaults.body) }
    } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { if (mounted.current) setIdle(true) }
  }
  useEffect(() => { mounted.current = true; void load(true); return () => { mounted.current = false } }, [sessionId])

  async function save(): Promise<void> {
    if (!snapshot || !idle) return
    setIdle(false); setBusy('save'); setError(undefined); setNotice(undefined)
    const payload = { draftId: draft?.id, expectedRevision: draft?.revision ?? 0,
      snapshotDigest: snapshot.digest, title, body, baseBranch: baseBranch.trim() }
    const serialized = JSON.stringify(payload)
    if (saveRequest.current?.payload !== serialized) saveRequest.current = { payload: serialized, id: crypto.randomUUID() }
    try {
      const saved = await window.agentDesk.saveWorktreePullRequestDraft(sessionId, { ...payload, requestId: saveRequest.current.id })
      if (!mounted.current) return
      setDraft(saved); setTitle(saved.title); setBody(saved.body); edited.current = false
      setNotice(`草稿 v${saved.revision} 已保存到本机`); setResult(undefined)
    } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { if (mounted.current) setIdle(true) }
  }
  async function submit(): Promise<void> {
    if (!draft || !idle) return
    setIdle(false); setBusy('submit'); setError(undefined); setNotice(undefined)
    try {
      const outcome = await window.agentDesk.createWorktreePullRequest(sessionId, {
        draftId: draft.id, expectedRevision: draft.revision, snapshotDigest: draft.snapshot.digest
      })
      if (!mounted.current) return
      setResult(outcome); onResult(outcome)
      if (!outcome.ok) setError(outcome.error)
      const next = await window.agentDesk.prepareWorktreePullRequestDraft(sessionId, { baseBranch: draft.snapshot.baseBranch })
      if (mounted.current) { setPreparation(next); setDraft(next.draft); setVerified(true) }
    } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { if (mounted.current) setIdle(true) }
  }
  function openRecovery(): void {
    useStore.getState().setShowTaskRecovery(true)
    void useStore.getState().hydrateTaskRecoveryCandidates().catch(() => undefined)
  }

  return <section className="worktree-pr-draft" aria-label="PR/MR 准备">
    <header className="worktree-pr-draft-header">
      <div><h3>准备 PR/MR</h3><p>核对提交与差异，编辑标题和说明，然后推送并创建。</p></div>
      <div className="worktree-pr-draft-actions">
        <button className="btn btn-ghost btn-sm" disabled={!idle} onClick={() => void load()}>刷新差异</button>
        <button className="btn btn-ghost btn-sm" disabled={!idle} onClick={onClose}>收起</button>
      </div>
    </header>
    {!idle && <p role="status">{busy === 'load' ? '正在读取本地提交…' : busy === 'save' ? '正在保存草稿…' : '正在处理原提交记录…'}</p>}
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice notice-info" role="status">{notice}</div>}
    {snapshot && <>
      <dl className="worktree-pr-draft-context">
        <div><dt>仓库</dt><dd>{snapshot.remote?.host ? `${snapshot.remote.host}/${snapshot.remote.projectPath}` : snapshot.binding.repoRoot}</dd></div>
        <div><dt>来源分支</dt><dd><code>{snapshot.binding.branch}</code> · <code>{snapshot.headSha.slice(0, 12)}</code></dd></div>
      </dl>
      <label className="worktree-pr-draft-field">目标分支
        <input data-pr-draft-base value={baseBranch} list={branchList} disabled={!idle || locked} spellCheck={false}
          onChange={event => { setBaseBranch(event.target.value); edited.current = true }} />
        <datalist id={branchList}>{[...new Set(snapshot.branches.map(branch => branch.name))].map(branch => <option key={branch} value={branch} />)}</datalist>
      </label>
      <p className="worktree-pr-draft-hint">比较依据：{snapshot.baseRef ?? '尚无本地目标引用'}{snapshot.baseSha ? ` · ${snapshot.baseSha.slice(0, 12)}` : ''}。本页读取本地引用，远端可能已有新提交。</p>
      {baseChanged && <div className="notice notice-info">目标分支已改动，请先刷新差异再保存。</div>}
      {snapshot.baseUnavailable && <div className="notice notice-info">{snapshot.baseUnavailable}</div>}
      <label className="worktree-pr-draft-field">标题
        <input data-pr-draft-title value={title} maxLength={256} disabled={!idle || locked} onChange={event => { setTitle(event.target.value); edited.current = true }} />
      </label>
      <label className="worktree-pr-draft-field">说明
        <textarea data-pr-draft-body value={body} maxLength={200000} rows={8} disabled={!idle || locked}
          onChange={event => { setBody(event.target.value); edited.current = true }} />
      </label>
      <details className="worktree-pr-draft-detail" open><summary>本次 PR 的已提交内容 · {snapshot.commitCount} 个提交</summary>
        {snapshot.commits.length ? <ul>{snapshot.commits.map(commit => <li key={commit.sha}><code>{commit.sha.slice(0, 8)}</code> {commit.subject}</li>)}</ul> : <p>尚无可比较的提交。</p>}
        {snapshot.commitsTruncated && <p>仅显示最近 100 个提交。</p>}
      </details>
      <details className="worktree-pr-draft-detail"><summary>文件与差异 · {snapshot.files.length}{snapshot.filesTruncated ? '+' : ''} 个文件</summary>
        <ul>{snapshot.files.map(file => <li key={file.path}><code>{file.path}</code> <span>{file.added === null ? '二进制' : `+${file.added} / −${file.removed}`}</span></li>)}</ul>
        {snapshot.diff ? <pre className="worktree-pr-draft-diff">{snapshot.diff}</pre> : <p>没有已提交文件差异。</p>}
        {(snapshot.diffTruncated || snapshot.filesTruncated) && <p>预览已截断；保存的差异摘要覆盖完整读取结果。</p>}
      </details>
      <p className="worktree-pr-draft-hint">未提交文件：暂存 {snapshot.dirty.staged} · 工作区 {snapshot.dirty.unstaged} · 未跟踪 {snapshot.dirty.untracked} · 冲突 {snapshot.dirty.conflicted}。这些文件不会自动提交或进入本次 PR。</p>
      {!preparation.capability.available && <p className="worktree-pr-draft-hint">{preparation.capability.message ?? 'PR 工具尚不可用'}；仍可保存本地草稿。</p>}
      {preparation.capability.available && <p className="worktree-pr-draft-hint">使用 {preparation.capability.tool}；登录与远端状态在提交时核对。</p>}
      {draft && <p className="worktree-pr-draft-hint">草稿 v{draft.revision} · {new Date(draft.updatedAt).toLocaleString()}{!draftMatches ? ' · 当前内容或仓库状态尚未保存' : ''}</p>}
      {status && <div className="worktree-pr-draft-receipt">
        <b>{submissionLabels[status]}</b>
        {draft?.submission?.error && <p>{draft.submission.error}</p>}
        <code>{draft?.submission?.phase === 'pr' ? draft.submission.prOperationId : draft?.submission?.pushOperationId}</code>
        {locked && <button className="btn btn-ghost btn-sm" onClick={openRecovery}>打开恢复记录</button>}
      </div>}
      {result?.ok && result.created && /^https?:\/\//i.test(result.url) && <p><a href={result.url} target="_blank" rel="noreferrer">打开已创建的 PR/MR</a></p>}
      {result?.ok && !result.created && <p>{result.message}</p>}
      <div className="worktree-pr-draft-actions">
        <button className="btn btn-ghost" disabled={!idle || locked || !verified || baseChanged || !title.trim()}
          onClick={() => void save()}>保存草稿{status === 'prepared' || status === 'pushed' ? '并停止原提交' : ''}</button>
        <button className="btn btn-primary" disabled={!idle || !draft || (!readExisting && (!verified || !draftMatches || baseChanged || !canStart || status === 'failed'))}
          onClick={() => void submit()}>{readExisting ? '核对原提交' : status === 'pushed' ? '继续创建 PR/MR' : '推送并创建 PR/MR'}</button>
      </div>
    </>}
  </section>
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
