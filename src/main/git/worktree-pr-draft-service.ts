import { randomUUID } from 'node:crypto'
import type { EffectRecord, SessionMeta, WorktreePullRequestResult } from '../../shared/types'
import type { WorktreePullRequestDraft, WorktreePullRequestDraftPrepareInput, WorktreePullRequestDraftPreparation,
  WorktreePullRequestDraftSaveInput, WorktreePullRequestDraftSubmitInput, WorktreePullRequestSnapshot } from '../../shared/worktree-pr-draft-types'
import type { ManagedWorktreeRecord } from '../managed-worktree-lifecycle'
import { stableValueDigest } from '../task/tool-idempotency'
import { inspectWorktreePullRequestSnapshot } from './worktree-pr-preview'
import { WorktreePullRequestDraftStore } from './worktree-pr-draft-store'

export interface WorktreePullRequestDraftRuntime {
  meta(sessionId: string): SessionMeta | undefined
  record(sessionId: string): ManagedWorktreeRecord | null
  defaults(meta: SessionMeta, snapshot: WorktreePullRequestSnapshot): { title: string; body: string }
  capability(cwd: string): Omit<WorktreePullRequestDraftPreparation['capability'], 'authentication'>
  /** Reads the existing local Effect ledger only; preparation never probes the remote. */
  effect(sessionId: string, operationId: string): Promise<EffectRecord | undefined>
}
export class WorktreePullRequestDraftService {
  private readonly store: WorktreePullRequestDraftStore
  constructor(root: string, private readonly runtime: WorktreePullRequestDraftRuntime) { this.store = new WorktreePullRequestDraftStore(root) }
  prepare(sessionId: string, input: WorktreePullRequestDraftPrepareInput = {}): WorktreePullRequestDraftPreparation {
    const { meta, record } = this.context(sessionId)
    if (!input || typeof input !== 'object' || (input.baseBranch !== undefined && typeof input.baseBranch !== 'string')) throw new Error('PR 准备参数无效')
    const latest = this.store.read(sessionId).at(-1)
    const sameWorktree = latest && latest.snapshot.binding.registryDigest === stableValueDigest(record)
    const snapshot = inspectWorktreePullRequestSnapshot(meta, record, input.baseBranch ?? (sameWorktree ? latest.snapshot.baseBranch : undefined))
    const draft = this.store.read(sessionId).filter(item => sameBinding(item.snapshot, snapshot)).at(-1)
    return { snapshot, draft, defaults: draft ? { title: draft.title, body: draft.body } : this.runtime.defaults(meta, snapshot),
      capability: { ...this.runtime.capability(record.worktreePath), authentication: 'not_checked' },
      draftStale: Boolean(draft && draft.snapshot.digest !== snapshot.digest) }
  }
  async save(sessionId: string, input: WorktreePullRequestDraftSaveInput): Promise<WorktreePullRequestDraft> {
    validateSave(input)
    const requestDigest = stableValueDigest(input)
    return this.store.mutate(sessionId, drafts => {
      const repeated = drafts.find(draft => draft.saveRequestId === input.requestId)
      if (repeated) { if (repeated.saveRequestDigest !== requestDigest) throw new Error('相同保存标识不能用于不同 PR 草稿'); this.assertOwner(repeated); return repeated }
      if (drafts.some(draft => isPending(draft) && !['prepared', 'pushed'].includes(draft.submission!.status))) throw new Error('原 PR 提交仍在进行或待核对，请先处理原操作回执')
      const { meta, record } = this.context(sessionId)
      const snapshot = inspectWorktreePullRequestSnapshot(meta, record, input.baseBranch)
      if (snapshot.digest !== input.snapshotDigest) throw new Error('仓库或目标分支已变化，请刷新并核对差异后保存')
      const previous = drafts.filter(draft => sameBinding(draft.snapshot, snapshot)).at(-1)
      if ((previous?.revision ?? 0) !== input.expectedRevision || (input.draftId && input.draftId !== previous?.id)) throw new Error('PR 草稿版本已变化，请刷新原草稿')
      const now = Date.now(), title = input.title.trim()
      const draft: WorktreePullRequestDraft = { schemaVersion: 1, id: previous?.id ?? `pr-draft-${randomUUID()}`,
        revision: input.expectedRevision + 1, stateRevision: 1, snapshot, title, body: input.body,
        titleDigest: stableValueDigest(title), bodyDigest: stableValueDigest(input.body), saveRequestId: input.requestId,
        saveRequestDigest: requestDigest, createdAt: now, updatedAt: now }
      // Only stages with no mutation in flight may be superseded. Keep their push/PR receipts.
      for (const prior of drafts.filter(isPending)) {
        prior.submission!.status = 'failed'
        prior.submission!.error = '已保存新草稿，原提交在下一外部操作开始前停止；既有操作记录保留'
        touch(prior)
      }
      drafts.push(draft)
      return draft
    })
  }
  async freezeSubmission(sessionId: string, input: WorktreePullRequestDraftSubmitInput): Promise<WorktreePullRequestDraft> {
    validateSubmit(input)
    await this.reconcileLocal(sessionId, input)
    return this.store.mutate(sessionId, drafts => {
      const draft = requiredDraft(drafts, input)
      this.assertOwner(draft)
      if (draft.submission?.status === 'completed') return draft
      if (isPending(draft) && !['prepared', 'pushed'].includes(draft.submission!.status)) return draft
      if (draft.submission?.status === 'failed') throw new Error('原提交已停止，请核对结果后保存新的草稿版本再提交')
      if (drafts.some(other => other !== draft && isPending(other))) throw new Error('同一任务已有未完成的 PR 提交')
      const { meta, record } = this.context(sessionId)
      if (['running', 'starting', 'closed'].includes(meta.status)) throw new Error('当前任务尚未停止，不能提交 PR')
      const current = inspectWorktreePullRequestSnapshot(meta, record, draft.snapshot.baseBranch)
      if (current.digest !== draft.snapshot.digest) throw new Error('草稿对应的 HEAD、目标分支或仓库状态已变化，请刷新差异并重新保存')
      if (current.baseUnavailable || !current.baseSha || !current.mergeBaseSha) throw new Error(current.baseUnavailable ?? '目标分支基线不可核对')
      if (!current.commitCount) throw new Error('当前分支没有相对目标分支的新提交；未提交文件不会被自动提交')
      if (current.dirty.conflicted) throw new Error('Worktree 有未解决冲突，请先处理')
      const capability = this.runtime.capability(record.worktreePath)
      if (!capability.available) throw new Error(capability.message ?? 'PR 提交工具尚不可用；草稿已保留')
      if (!draft.submission) {
        draft.submission = { draftRevision: draft.revision, status: 'prepared',
          pushOperationId: `pr-draft-push-${randomUUID()}`, prOperationId: `pr-draft-create-${randomUUID()}`, updatedAt: Date.now() }
        touch(draft)
      }
      return draft
    })
  }
  assertCurrentDraft(sessionId: string, input: WorktreePullRequestDraftSubmitInput, phase: 'push' | 'pr'): void {
    const draft = requiredDraft(this.store.read(sessionId), input)
    this.assertOwner(draft)
    if (draft.submission?.status !== (phase === 'push' ? 'pushing' : 'creating')) throw new Error('草稿提交阶段已变化')
    const { meta, record } = this.context(sessionId)
    if (['running', 'starting', 'closed'].includes(meta.status) ||
        inspectWorktreePullRequestSnapshot(meta, record, draft.snapshot.baseBranch).digest !== draft.snapshot.digest) throw new Error('实际执行前任务、HEAD 或仓库状态发生变化，请核对原操作')
  }
  async markPhase(sessionId: string, input: WorktreePullRequestDraftSubmitInput, phase: 'push' | 'pr'): Promise<WorktreePullRequestDraft> {
    return this.store.mutate(sessionId, drafts => {
      const draft = requiredDraft(drafts, input); this.assertOwner(draft)
      const submission = draft.submission
      if (!submission || submission.status !== (phase === 'push' ? 'prepared' : 'pushed')) throw new Error('PR 提交阶段已变化，请核对原操作')
      const { meta, record } = this.context(sessionId)
      if (['running', 'starting', 'closed'].includes(meta.status) || inspectWorktreePullRequestSnapshot(meta, record, draft.snapshot.baseBranch).digest !== draft.snapshot.digest) throw new Error('提交前任务或仓库状态发生变化')
      submission.status = phase === 'push' ? 'pushing' : 'creating'; submission.phase = phase; submission.error = undefined
      touch(draft); return draft
    })
  }
  async recordOutcome(sessionId: string, input: WorktreePullRequestDraftSubmitInput, phase: 'push' | 'pr', outcome: {
    status: 'completed' | 'failed' | 'waiting_reconciliation'; effectId?: string; error?: string; result?: WorktreePullRequestResult
  }): Promise<WorktreePullRequestDraft> {
    return this.store.mutate(sessionId, drafts => {
      const draft = requiredDraft(drafts, input), submission = draft.submission
      if (!submission || submission.phase !== phase) throw new Error('PR 操作回执与提交阶段不一致')
      submission.status = outcome.status === 'completed' ? (phase === 'push' ? 'pushed' : 'completed') : outcome.status === 'failed' ? 'failed' : 'needs_reconciliation'
      submission.effectId = outcome.effectId; submission.error = outcome.error; submission.result = outcome.result
      touch(draft); return draft
    })
  }
  async reconcileLocal(sessionId: string, input: WorktreePullRequestDraftSubmitInput): Promise<WorktreePullRequestDraft> {
    const draft = requiredDraft(this.store.read(sessionId), input); this.assertOwner(draft)
    const submission = draft.submission
    if (!submission || !['pushing', 'creating', 'needs_reconciliation'].includes(submission.status) || !submission.phase) return draft
    const effect = await this.runtime.effect(sessionId, submission.phase === 'push' ? submission.pushOperationId : submission.prOperationId)
    if (effect && effectMatchesDraft(effect, draft, submission.phase) && (effect.status === 'confirmed' || effect.status === 'failed' || effect.status === 'abandoned')) {
      return this.recordOutcome(sessionId, input, submission.phase, { status: effect.status === 'confirmed' ? 'completed' : 'failed', effectId: effect.id, error: effect.error })
    }
    return draft
  }
  async confirmedPrEffect(sessionId: string, input: WorktreePullRequestDraftSubmitInput): Promise<EffectRecord | undefined> {
    const draft = requiredDraft(this.store.read(sessionId), input); this.assertOwner(draft)
    const effect = draft.submission && await this.runtime.effect(sessionId, draft.submission.prOperationId)
    return effect?.status === 'confirmed' && effectMatchesDraft(effect, draft, 'pr') ? effect : undefined
  }
  private assertOwner(draft: WorktreePullRequestDraft): void {
    const { meta } = this.context(draft.snapshot.binding.sessionId), binding = draft.snapshot.binding
    if (meta.createdAt !== binding.sessionCreatedAt || meta.workspaceId !== binding.workspaceId || meta.goalId !== binding.goalId ||
        meta.workItemId !== binding.workItemId || meta.projectId !== binding.projectId) throw new Error('PR 草稿与原任务身份不一致')
  }
  private context(sessionId: string) {
    const meta = this.runtime.meta(sessionId), record = this.runtime.record(sessionId)
    if (!meta || !record) throw new Error('请先打开具有受管 Worktree 的原任务')
    if (meta.id !== sessionId || record.sessionId !== sessionId) throw new Error('PR 草稿任务归属不一致')
    return { meta, record }
  }
}
export function effectMatchesDraft(effect: EffectRecord, draft: WorktreePullRequestDraft, phase: 'push' | 'pr'): boolean {
  const target = effect.target, snapshot = draft.snapshot, remote = snapshot.remote
  if (!remote) return false
  if (phase === 'push') return target.kind === 'git_push' && target.repoRoot === snapshot.binding.worktreePath &&
    target.branch === snapshot.binding.branch && target.intendedSha === snapshot.headSha && target.remote === remote.name && target.pushUrlDigest === remote.pushUrlDigest
  return target.kind === 'pull_request_create' && target.repoRoot === snapshot.binding.worktreePath &&
    stableValueDigest(target.repoRootIdentity) === stableValueDigest(snapshot.binding.worktreeIdentity) &&
    target.sourceBranch === snapshot.binding.branch && target.sourceSha === snapshot.headSha && target.baseBranch === snapshot.baseBranch &&
    target.remote === remote.name && target.remoteUrlDigest === remote.urlDigest && target.titleDigest === draft.titleDigest && target.bodyDigest === draft.bodyDigest
}
function sameBinding(a: WorktreePullRequestSnapshot, b: WorktreePullRequestSnapshot) { return stableValueDigest(a.binding) === stableValueDigest(b.binding) }
function requiredDraft(drafts: WorktreePullRequestDraft[], input: WorktreePullRequestDraftSubmitInput): WorktreePullRequestDraft {
  validateSubmit(input)
  const draft = drafts.find(item => item.id === input.draftId && item.revision === input.expectedRevision)
  if (!draft || draft.snapshot.digest !== input.snapshotDigest) throw new Error('PR 草稿版本或差异摘要不匹配')
  const latest = drafts.filter(item => item.id === draft.id).at(-1)
  if (latest !== draft && !draft.submission) throw new Error('此草稿已有新版本，请使用最新版本')
  return draft
}
function isPending(draft: WorktreePullRequestDraft) { return Boolean(draft.submission && !['completed', 'failed'].includes(draft.submission.status)) }
function touch(draft: WorktreePullRequestDraft) { draft.stateRevision++; draft.updatedAt = Date.now(); if (draft.submission) draft.submission.updatedAt = draft.updatedAt }
function validateSubmit(input: WorktreePullRequestDraftSubmitInput) {
  if (!input || typeof input.draftId !== 'string' || !input.draftId.startsWith('pr-draft-') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !/^[a-f0-9]{64}$/.test(input.snapshotDigest)) throw new Error('请选择已保存的 PR 草稿再提交')
}
function validateSave(input: WorktreePullRequestDraftSaveInput) {
  if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.requestId) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.snapshotDigest) ||
      typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256 || /[\0\r\n]/.test(input.title) ||
      typeof input.body !== 'string' || input.body.length > 200_000 || input.body.includes('\0') || typeof input.baseBranch !== 'string') throw new Error('PR 草稿标题、正文或版本无效')
}
