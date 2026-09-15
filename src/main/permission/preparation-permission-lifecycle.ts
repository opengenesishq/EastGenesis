import type { SessionMeta } from '../../shared/types'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { ProjectDeletionJournal } from '../data-lifecycle/project-deletion-journal'
import { SessionDeletionJournal } from '../data-lifecycle/session-deletion-journal'
import { hasVerifiedPreparationRestoreAfter } from '../data-lifecycle/preparation-restore-evidence'

/** Call while holding the lifecycle lock; both pending and completed purges are final for queued work. */
export function assertPreparationSessionNotDeleted(root: string, meta: SessionMeta): void {
  if (meta.status === 'closed') throw new Error('已关闭会话不能变更或使用准备区授权。')
  const session = new SessionDeletionJournal(root).sessionDeletionState(meta.id)
  const project = new ProjectDeletionJournal(root).sessionDeletionState(meta.id, meta.workspaceId)
  if (session.pending || project.pending) {
    throw new Error('任务或所属项目正在删除或已永久删除，准备区操作已停止。')
  }
  const completed = [session.completedAt, project.completedAt].filter((at): at is number => at !== undefined)
  if (completed.length && !hasVerifiedPreparationRestoreAfter(root, meta, Math.max(...completed))) {
    throw new Error('任务或所属项目已永久删除，缺少删除后完成的已验证导入，准备区操作已停止。')
  }
}

/** Resolve the live Session only after acquiring the same lock used by purge and import. */
export function withActivePreparationSession<T>(
  root: string,
  sessionId: string,
  readMeta: (id: string) => SessionMeta,
  assertOwnership: (meta: SessionMeta) => Promise<unknown>,
  operation: (meta: SessionMeta) => T
): Promise<T> {
  return withDataLifecycleMutation(root, async () => {
    const before = { ...readMeta(sessionId) }
    if (before.id !== sessionId) throw new Error('当前会话身份不一致。')
    assertPreparationSessionNotDeleted(root, before)
    await assertOwnership(before)
    // Ownership reads may yield. Never reuse their stale Session when the task
    // was closed or rebound meanwhile; completed journal receipts can compact.
    const current = readMeta(sessionId)
    if (binding(current) !== binding(before)) throw new Error('任务归属已变化，请重新打开当前任务。')
    assertPreparationSessionNotDeleted(root, current)
    return operation(current)
  })
}

function binding(meta: SessionMeta): string {
  return JSON.stringify([meta.id, meta.createdAt, meta.cwd, meta.workspaceId, meta.goalId,
    meta.workItemId, meta.businessLineId, meta.personalWorkspaceId, meta.parentSessionId])
}
