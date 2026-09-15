import type { SessionMeta } from '../../shared/types'
import { ProjectDeletionJournal } from '../data-lifecycle/project-deletion-journal'
import { SessionDeletionJournal } from '../data-lifecycle/session-deletion-journal'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { assertPreparationSessionNotDeleted } from './preparation-permission-lifecycle'

/** Reuses the preparation/purge/import lock and live canonical ownership checks. */
export function withActiveTaskExecutionAuthoritySession<T>(
  root: string, sessionId: string, readMeta: (id: string) => SessionMeta,
  assertOwnership: (meta: SessionMeta) => Promise<unknown>, operation: (meta: SessionMeta) => T | Promise<T>
): Promise<T> {
  return withDataLifecycleMutation(root, async () => {
    const before = { ...readMeta(sessionId) }
    if (before.id !== sessionId) throw new Error('当前会话身份不一致。')
    assertTaskExecutionAuthoritySessionActive(root, before)
    await assertOwnership(before)
    const current = readMeta(sessionId)
    if (binding(current) !== binding(before)) throw new Error('任务归属已变化，请重新打开当前任务。')
    assertTaskExecutionAuthoritySessionActive(root, current)
    return operation(current)
  })
}

function binding(meta: SessionMeta): string {
  return JSON.stringify([meta.id, meta.createdAt, meta.cwd, meta.projectId, meta.workspaceId, meta.goalId,
    meta.workItemId, meta.businessLineId, meta.personalWorkspaceId, meta.parentSessionId])
}

export function assertTaskExecutionAuthoritySessionActive(root: string, meta: SessionMeta, grantedAt?: number): void {
  assertPreparationSessionNotDeleted(root, meta)
  if (grantedAt === undefined) return
  const session = new SessionDeletionJournal(root).sessionDeletionState(meta.id)
  const project = new ProjectDeletionJournal(root).sessionDeletionState(meta.id, meta.workspaceId)
  if ([session.completedAt, project.completedAt].some(at => at !== undefined && grantedAt <= at)) {
    throw new Error('删除前的任务执行授权不能在恢复后自动生效，请重新授权。')
  }
}
