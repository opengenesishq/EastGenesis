import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorktreePullRequestDraft } from '../../shared/worktree-pr-draft-types'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { writeDurableFileSync } from '../durable-file'
import { stableValueDigest } from '../task/tool-idempotency'

interface DraftFile { schemaVersion: 1; sessionId: string; drafts: WorktreePullRequestDraft[] }
export class WorktreePullRequestDraftStore {
  constructor(private readonly root: string) {}
  read(sessionId: string): WorktreePullRequestDraft[] {
    const path = this.path(sessionId)
    try {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('PR 草稿存储不是普通文件')
      const file = JSON.parse(readFileSync(path, 'utf8')) as DraftFile
      if (file.schemaVersion !== 1 || file.sessionId !== sessionId || !Array.isArray(file.drafts) || file.drafts.length > 200) throw new Error('PR 草稿存储无效')
      for (const draft of file.drafts) {
        if (draft.schemaVersion !== 1 || !draft.id || !Number.isSafeInteger(draft.revision) || draft.revision < 1 ||
            !Number.isSafeInteger(draft.stateRevision) || draft.stateRevision < 1 || draft.snapshot?.binding?.sessionId !== sessionId ||
            !/^[a-f0-9]{64}$/.test(draft.snapshot.digest) || typeof draft.title !== 'string' || typeof draft.body !== 'string' ||
            draft.titleDigest !== stableValueDigest(draft.title) || draft.bodyDigest !== stableValueDigest(draft.body)) throw new Error('PR 草稿正文或归属摘要不一致')
        if (draft.submission && (draft.submission.draftRevision !== draft.revision || !draft.submission.pushOperationId || !draft.submission.prOperationId ||
            !['prepared', 'pushing', 'pushed', 'creating', 'completed', 'needs_reconciliation', 'failed'].includes(draft.submission.status))) throw new Error('PR 提交回执无效')
      }
      return file.drafts
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  mutate<T>(sessionId: string, operation: (drafts: WorktreePullRequestDraft[]) => T | Promise<T>): Promise<T> {
    return withDataLifecycleMutation(this.root, async () => {
      const drafts = this.read(sessionId)
      const result = await operation(drafts)
      if (drafts.length > 200) throw new Error('此任务已有 200 个 PR 草稿版本，请先保留并整理历史')
      writeDurableFileSync(this.path(sessionId), JSON.stringify({ schemaVersion: 1, sessionId, drafts }))
      return structuredClone(result)
    })
  }
  private path(sessionId: string): string {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error('任务标识无效')
    return join(this.root, 'private', 'worktree-pr-drafts', `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  }
}
