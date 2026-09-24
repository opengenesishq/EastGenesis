import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LayeredMemoryEntry,
  ProjectMemoryDraft,
  ProjectMemoryEntry,
  ReadProjectMemoryResult
} from '../../../shared/types'
import LearningApprovalPanel from './LearningApprovalPanel'
import LegacyMemoryImportPanel from './LegacyMemoryImportPanel'
import MemoryRetentionPanel from './MemoryRetentionPanel'
import TaskMemoryPreferences, { useTaskMemoryPreferences } from './TaskMemoryPreferences'

const EMPTY_FORM = { kind: 'note', title: '', body: '', reason: '' }
type LoopOutcome = 'success' | 'partial' | 'failure'
const EMPTY_REVIEW_FORM = {
  outcome: 'success' as LoopOutcome,
  title: '',
  summary: '',
  failure: '',
  rootCause: '',
  verification: '',
  preference: ''
}

interface Props {
  sessionId: string
  onClose?: () => void
  initialForm?: Partial<typeof EMPTY_FORM>
  initialScope?: 'task' | 'project'
}

/**
 * 当前任务与项目记忆管理面板。
 * - readProjectMemory 拉取 confirmed 条目(entries)与待确认草稿(drafts)
 * - drafts: 采纳(acceptMemoryDraft)/ 删除(deleteMemoryEntry)
 * - confirmed: 删除(deleteMemoryEntry)
 * - 顶部表单:任务记忆直接保存，项目记忆提交后落入 drafts 待用户采纳
 *
 * 直接调用 window.agentDesk.*(与 SettingsModal 的迁移/健康检查同风格),
 * 无需经 store。所有 IPC 在 acting 期间禁用按钮避免并发竞态。
 */
export default function MemoryPanel(props: Props): React.JSX.Element {
  return <ProjectMemoryPanel key={props.sessionId} {...props} />
}

function ProjectMemoryPanel({ sessionId, onClose, initialForm, initialScope }: Props): React.JSX.Element {
  const memoryControl = useTaskMemoryPreferences(sessionId)
  const contributionAllowed = memoryControl.snapshot?.effective.contributeSharedMemory === true && !memoryControl.saving
  const loadSequence = useRef(0)
  const mounted = useRef(false)
  const [data, setData] = useState<ReadProjectMemoryResult | null>(null)
  const [learningRefreshToken, setLearningRefreshToken] = useState(0)
  const [layered, setLayered] = useState<LayeredMemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [acting, setActing] = useState(false)
  const [editingLayeredId, setEditingLayeredId] = useState<string | null>(null)
  const [layeredDraft, setLayeredDraft] = useState({ title: '', body: '', expectedUpdatedAt: '' })

  const [showForm, setShowForm] = useState(false)
  const [formScope, setFormScope] = useState<'task' | 'project'>('task')
  const [viewScope, setViewScope] = useState<'all' | 'task' | 'project'>(initialScope ?? 'all')
  const [revising, setRevising] = useState<ProjectMemoryEntry | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [reviewForm, setReviewForm] = useState({ ...EMPTY_REVIEW_FORM })
  const [reviewNotice, setReviewNotice] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!mounted.current) return
    const sequence = ++loadSequence.current
    setLoading(true)
    setData(null)
    setLayered([])
    setError('')
    try {
      const [result, layeredEntries] = await Promise.all([
        window.agentDesk.readProjectMemory(sessionId),
        window.agentDesk.listLayeredMemories(sessionId)
      ])
      if (!mounted.current || sequence !== loadSequence.current) return
      setData(result)
      setLayered(layeredEntries)
      setLearningRefreshToken((value) => value + 1)
    } catch (err) {
      if (!mounted.current || sequence !== loadSequence.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current && sequence === loadSequence.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      loadSequence.current++
    }
  }, [load])

  useEffect(() => {
    setViewScope(initialScope ?? 'all')
    setFormScope(initialScope ?? 'task')
  }, [initialScope])

  useEffect(() => {
    if (!initialForm) return
    setViewScope('project')
    setFormScope('project')
    setForm({ ...EMPTY_FORM, ...initialForm })
    setShowForm(true)
  }, [initialForm])

  const propose = async (): Promise<void> => {
    if (!form.title.trim() || !form.body.trim()) {
      setError('标题与内容不能为空')
      return
    }
    setActing(true)
    setError('')
    try {
      if (formScope === 'task') {
        await window.agentDesk.addTaskMemory(sessionId, { title: form.title.trim(), body: form.body.trim() })
      } else {
        await window.agentDesk.proposeMemoryDraft(sessionId, {
          kind: form.kind.trim() || 'note',
          title: form.title.trim(),
          body: form.body.trim(),
          source: 'user',
          reason: form.reason.trim(),
          supersedes: revising?.id
        })
      }
      setForm({ ...EMPTY_FORM })
      setRevising(null)
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const accept = async (draftId: string): Promise<void> => {
    setActing(true)
    setError('')
    try {
      await window.agentDesk.acceptMemoryDraft(sessionId, draftId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const remove = async (entryId: string): Promise<void> => {
    setActing(true)
    setError('')
    try {
      await window.agentDesk.deleteMemoryEntry(sessionId, entryId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const startLayeredEdit = (entry: LayeredMemoryEntry): void => {
    setEditingLayeredId(entry.id)
    setLayeredDraft({ title: entry.title, body: entry.body, expectedUpdatedAt: entry.updatedAt })
  }

  const saveLayered = async (entry: LayeredMemoryEntry): Promise<void> => {
    setActing(true)
    setError('')
    try {
      const updated = await window.agentDesk.updateLayeredMemory(entry.id, {
        title: layeredDraft.title.trim(),
        body: layeredDraft.body.trim(),
        expectedUpdatedAt: layeredDraft.expectedUpdatedAt
      }, sessionId)
      if (!updated) throw new Error('记忆已被删除，请刷新后继续')
      setEditingLayeredId(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const removeLayered = async (entryId: string): Promise<void> => {
    setActing(true)
    setError('')
    try {
      await window.agentDesk.deleteLayeredMemory(entryId, sessionId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const submitReview = async (): Promise<void> => {
    const title = reviewForm.title.trim()
    const summary = reviewForm.summary.trim()
    const failure = reviewForm.failure.trim()
    const rootCause = reviewForm.rootCause.trim()
    const verification = splitReviewLines(reviewForm.verification)
    const preference = reviewForm.preference.trim()

    if (!title) {
      setError('复盘标题不能为空')
      return
    }
    if (!summary && !failure && !preference) {
      setError('复盘内容不能为空')
      return
    }
    if (reviewForm.outcome !== 'success' && !failure) {
      setError('部分完成或失败时必须填写失败信号')
      return
    }

    setActing(true)
    setError('')
    setReviewNotice('')
    try {
      let drafts = 0

      if (summary) {
        const body = renderTaskReviewBody({
          outcome: reviewForm.outcome,
          summary,
          failure,
          rootCause,
          verification
        })
        await window.agentDesk.proposeMemoryDraft(sessionId, {
          kind: 'task-retrospective',
          title: `任务复盘: ${title}`,
          body,
          source: 'memory-loop',
          reason: reviewForm.outcome === 'success' ? '任务完成后沉淀可复用上下文' : '任务结束后沉淀当前真实状态'
        })
        drafts++
      }

      if (reviewForm.outcome !== 'success' || failure) {
        const body = renderFailureReviewBody({ failure, rootCause, verification })
        await window.agentDesk.proposeMemoryDraft(sessionId, {
          kind: 'failure-retrospective',
          title: `失败复盘: ${title}`,
          body,
          source: 'memory-loop',
          reason: '失败或未完成任务需要形成下次开工前可检索的复盘建议'
        })
        drafts++
      }

      if (preference) {
        const titleText = preferenceTitle(preference)
        await window.agentDesk.proposeMemoryDraft(sessionId, {
          kind: 'preference',
          title: titleText,
          body: preference,
          source: 'memory-loop',
          reason: '用户偏好或长期约定,需要确认后进入项目记忆'
        })
        drafts++
      }

      setReviewForm({ ...EMPTY_REVIEW_FORM })
      setReviewNotice(`已生成 ${drafts} 条待确认草稿`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const drafts: ProjectMemoryDraft[] = data?.drafts ?? []
  const entries: ProjectMemoryEntry[] = data?.entries ?? []
  const visibleLayered = layered.filter(entry => viewScope === 'all' || (viewScope === 'task'
    ? Boolean(entry.sessionId || entry.workItemId)
    : !entry.sessionId && !entry.workItemId && entry.layer !== 'user'))

  return (
    <div className="memory-panel" data-memory-panel="true">
      <div className="settings-section-head">
        <h3 className="settings-h3">{viewScope === 'task' ? '任务记忆' : viewScope === 'project' ? '项目记忆' : '任务与项目记忆'}</h3>
        <div className="memory-panel-actions">
          <button
            className="btn btn-ghost btn-sm"
            disabled={acting}
            onClick={() => {
              setRevising(null)
              setFormScope(viewScope === 'project' ? 'project' : 'task')
              setForm({ ...EMPTY_FORM })
              setShowForm((v) => !v)
            }}
          >
            {showForm ? '取消' : '添加记忆'}
          </button>
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
      <p className="settings-hint">
        任务记忆只供当前任务使用，保存后生效；项目记忆供同项目任务共享，草稿确认后生效。记忆不授予工具权限。
      </p>
      <TaskMemoryPreferences control={memoryControl} />
      {memoryControl.snapshot && !contributionAllowed && <p className="field-hint">共享记忆贡献已关闭；可浏览或删除旧记录，并继续保存当前任务记忆。</p>}
      <label className="field-label">查看范围
        <select className="input input-block" aria-label="记忆查看范围" value={viewScope}
          onChange={event => setViewScope(event.target.value as 'all' | 'task' | 'project')}>
          <option value="all">全部可用记忆</option>
          <option value="task">仅当前任务</option>
          <option value="project">当前项目共享</option>
        </select>
      </label>

      {viewScope === 'all' && <><LegacyMemoryImportPanel key={sessionId} sessionId={sessionId} onImported={load} contributionAllowed={contributionAllowed} />
      <MemoryRetentionPanel key={`retention-${sessionId}`} sessionId={sessionId} onChanged={load} />

      <div className="memory-group">
        <h4 className="settings-h3">任务复盘</h4>
        <div className="memory-form" data-memory-loop-form="true">
          <label className="field-label">结果</label>
          <select
            className="input input-block"
            data-memory-loop-field="outcome"
            value={reviewForm.outcome}
            onChange={(e) =>
              setReviewForm((draft) => ({ ...draft, outcome: e.target.value as LoopOutcome }))
            }
          >
            <option value="success">成功</option>
            <option value="partial">部分完成</option>
            <option value="failure">失败</option>
          </select>
          <label className="field-label">标题</label>
          <input
            className="input input-block"
            data-memory-loop-field="title"
            value={reviewForm.title}
            placeholder="任务或问题名称"
            onChange={(e) => setReviewForm((draft) => ({ ...draft, title: e.target.value }))}
          />
          <label className="field-label">摘要</label>
          <textarea
            className="input input-block textarea"
            data-memory-loop-field="summary"
            rows={3}
            value={reviewForm.summary}
            placeholder="实际完成或当前状态"
            onChange={(e) => setReviewForm((draft) => ({ ...draft, summary: e.target.value }))}
          />
          <label className="field-label">失败信号</label>
          <textarea
            className="input input-block textarea"
            data-memory-loop-field="failure"
            rows={2}
            value={reviewForm.failure}
            placeholder="报错、阻塞、超时或未完成点"
            onChange={(e) => setReviewForm((draft) => ({ ...draft, failure: e.target.value }))}
          />
          <label className="field-label">根因</label>
          <input
            className="input input-block"
            data-memory-loop-field="rootCause"
            value={reviewForm.rootCause}
            placeholder="已确认则填写"
            onChange={(e) => setReviewForm((draft) => ({ ...draft, rootCause: e.target.value }))}
          />
          <label className="field-label">验证</label>
          <textarea
            className="input input-block textarea"
            data-memory-loop-field="verification"
            rows={2}
            value={reviewForm.verification}
            placeholder="每行一个命令或证据"
            onChange={(e) => setReviewForm((draft) => ({ ...draft, verification: e.target.value }))}
          />
          <label className="field-label">偏好</label>
          <textarea
            className="input input-block textarea"
            data-memory-loop-field="preference"
            rows={2}
            value={reviewForm.preference}
            placeholder="用户偏好、长期约定或踩坑规则"
            onChange={(e) => setReviewForm((draft) => ({ ...draft, preference: e.target.value }))}
          />
          <div className="modal-actions">
            <button
              className="btn btn-primary btn-sm"
              data-memory-loop-action="submit"
              disabled={acting || !contributionAllowed}
              onClick={() => void submitReview()}
            >
              {acting ? '生成中…' : '生成复盘'}
            </button>
          </div>
          {reviewNotice && <div className="notice notice-info">{reviewNotice}</div>}
        </div>
      </div>

      </>}

      {showForm && (
        <div className="memory-form" data-memory-form="true">
          <label className="field-label">使用范围</label>
          <select className="input input-block" data-memory-form-field="scope" value={formScope}
            disabled={acting || Boolean(revising)} onChange={(event) => setFormScope(event.target.value as 'task' | 'project')}>
            <option value="task">仅当前任务</option>
            <option value="project" disabled={!contributionAllowed}>当前项目共享</option>
          </select>
          {revising && <div className="field-hint">修订 v{revising.version} · {revising.source}。确认新版本前，当前版本继续生效。</div>}
          {formScope === 'project' && (
            <>
              <label className="field-label">类型</label>
              <input
                className="input input-block"
                data-memory-form-field="kind"
                value={form.kind}
                placeholder="note / convention / gotcha …"
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              />
            </>
          )}
          <label className="field-label">标题</label>
          <input
            className="input input-block"
            data-memory-form-field="title"
            value={form.title}
            placeholder="一句话概括"
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
          <label className="field-label">内容</label>
          <textarea
            className="input input-block textarea"
            data-memory-form-field="body"
            rows={3}
            value={form.body}
            placeholder="记忆正文"
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
          />
          {formScope === 'project' && (
            <>
              <label className="field-label">理由 <span className="field-hint">可选</span></label>
              <input
                className="input input-block"
                data-memory-form-field="reason"
                value={form.reason}
                placeholder="为什么值得记住"
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              />
            </>
          )}
          <div className="modal-actions">
            <button
              className="btn btn-primary btn-sm"
              data-memory-form-action="propose"
              disabled={acting || (formScope === 'project' && !contributionAllowed)}
              onClick={() => void propose()}
            >
              {acting ? '保存中…' : formScope === 'task' ? '保存到当前任务' : revising ? '提交修订草稿' : '提交草稿'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="notice notice-error">{error}</div>}
      {loading && <div className="provider-empty">加载中…</div>}

      {!loading && (
        <>
          {viewScope !== 'task' && <>
          <div className="memory-group">
            <h4 className="settings-h3">待确认草稿 · {drafts.length}</h4>
            {drafts.length === 0 ? (
              <div className="provider-empty">暂无草稿</div>
            ) : (
              <div className="provider-list">
                {drafts.map((d) => (
                  <div key={d.id} className="provider-row memory-row">
                    <div className="provider-row-body">
                      <div className="provider-row-name">
                        {d.title}
                        <span className="migrate-kind">{d.kind}</span>
                      </div>
                      <div className="provider-row-sub memory-body">{d.body}</div>
                      <div className="field-hint">来源: {d.source}{d.version ? ` · v${d.version}` : ''} · {d.updatedAt}</div>
                      {d.reason && <div className="field-hint">理由:{d.reason}</div>}
                    </div>
                    <div className="provider-row-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={acting || !contributionAllowed}
                        onClick={() => void accept(d.id)}
                      >
                        采纳
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={acting}
                        onClick={() => void remove(d.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="memory-group">
            <h4 className="settings-h3">已确认记忆 · {entries.length}</h4>
            {entries.length === 0 ? (
              <div className="provider-empty">暂无记忆</div>
            ) : (
              <div className="provider-list">
                {entries.map((m) => (
                  <div key={m.id} className="provider-row memory-row">
                    <div className="provider-row-body">
                      <div className="provider-row-name">
                        {m.title}
                        <span className="migrate-kind">{m.kind}</span>
                      </div>
                      <div className="provider-row-sub memory-body">{m.body}</div>
                      <div className="field-hint">来源: {m.source}{m.version ? ` · v${m.version}` : ''} · {m.updatedAt}</div>
                    </div>
                    <div className="provider-row-actions">
                      {m.version && <button
                        className="btn btn-ghost btn-sm"
                        disabled={acting || !contributionAllowed}
                        onClick={() => {
                          setRevising(m)
                          setFormScope('project')
                          setForm({ kind: m.kind, title: m.title, body: m.body, reason: m.reason })
                          setShowForm(true)
                        }}
                      >修订</button>}
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={acting}
                        onClick={() => void remove(m.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <LearningApprovalPanel sessionId={sessionId} refreshToken={learningRefreshToken} onChanged={load} contributionAllowed={contributionAllowed} />
          </>}

          <div className="memory-group">
            <h4 className="settings-h3">可用记忆 · {visibleLayered.length}</h4>
            {visibleLayered.length === 0 ? (
              <div className="provider-empty">暂无可用记忆</div>
            ) : (
              <div className="provider-list">
                {visibleLayered.map((entry) => {
                  const editing = editingLayeredId === entry.id
                  return (
                    <div key={entry.id} className="provider-row memory-row" data-layered-memory-id={entry.id}>
                      <div className="provider-row-body">
                        <div className="provider-row-name">
                          {entry.title}
                          <span className="migrate-kind">{entry.workItemId || entry.sessionId ? '仅当前任务' : entry.layer === 'user' ? '所有任务共享' : entry.layer === 'working' ? '历史工作记忆 · 项目共享' : '项目共享'}</span>
                        </div>
                        {editing ? (
                          <div className="memory-form">
                            <input
                              aria-label="记忆标题"
                              className="input input-block"
                              value={layeredDraft.title}
                              onChange={(e) => setLayeredDraft((draft) => ({ ...draft, title: e.target.value }))}
                            />
                            <textarea
                              aria-label="记忆内容"
                              className="input input-block textarea"
                              rows={3}
                              value={layeredDraft.body}
                              onChange={(e) => setLayeredDraft((draft) => ({ ...draft, body: e.target.value }))}
                            />
                          </div>
                        ) : (
                          <div className="provider-row-sub memory-body">{entry.body}</div>
                        )}
                        <div className="field-hint">来源: {entry.source} · {entry.updatedAt}{entry.archivedAt ? ' · 已归档，不参与检索' : ''}</div>
                      </div>
                      <div className="provider-row-actions">
                        {editing ? (
                          <>
                            <button className="btn btn-ghost btn-sm" disabled={acting || (!entry.sessionId && !entry.workItemId && !contributionAllowed)} onClick={() => void saveLayered(entry)}>
                              保存
                            </button>
                            <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => setEditingLayeredId(null)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-ghost btn-sm" disabled={acting || (!entry.sessionId && !entry.workItemId && !contributionAllowed)} onClick={() => startLayeredEdit(entry)}>
                              编辑
                            </button>
                            <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => void removeLayered(entry.id)}>
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function outcomeLabel(outcome: LoopOutcome): string {
  if (outcome === 'success') return '成功'
  if (outcome === 'failure') return '失败'
  return '部分完成'
}

function splitReviewLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function renderTaskReviewBody(input: {
  outcome: LoopOutcome
  summary: string
  failure: string
  rootCause: string
  verification: string[]
}): string {
  return [
    `结果: ${outcomeLabel(input.outcome)}`,
    `摘要: ${input.summary}`,
    renderReviewList('验证', input.verification),
    input.failure ? `失败信号: ${input.failure}` : '',
    input.rootCause ? `根因: ${input.rootCause}` : ''
  ].filter(Boolean).join('\n')
}

function renderFailureReviewBody(input: {
  failure: string
  rootCause: string
  verification: string[]
}): string {
  return [
    `现象: ${input.failure || '未提供具体失败文本'}`,
    input.rootCause ? `根因: ${input.rootCause}` : '根因: 未确认',
    '下次建议: 先复现第一个可观察失败,再做最小修复。',
    renderReviewList('验证', input.verification)
  ].join('\n')
}

function renderReviewList(label: string, values: string[]): string {
  if (values.length === 0) return `${label}: 未提供`
  if (values.length === 1) return `${label}: ${values[0]}`
  return `${label}:\n${values.map((value) => `- ${value}`).join('\n')}`
}

function preferenceTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`
}
