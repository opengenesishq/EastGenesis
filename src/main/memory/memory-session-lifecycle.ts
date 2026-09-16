import type { SessionMeta } from '../../shared/types'
import { SessionDeletionJournal } from '../data-lifecycle/session-deletion-journal'
import { hasVerifiedPreparationRestoreAfter } from '../data-lifecycle/preparation-restore-evidence'
import { readMemorySessionIdentities } from './memory-session-inventory'
import type { MemoryScope } from './memory-manager'

/** The writing Session is distinct from the memory anchor shared by explicit resumes. */
export function assertMemorySessionWritable(root: string, scope: MemoryScope): void {
  const sessionId = scope.writerSessionId ?? scope.sessionId
  if (!sessionId) return
  const state = new SessionDeletionJournal(root).sessionDeletionState(sessionId)
  if (state.pending) throw new Error('会话正在永久删除，不能修改任务记忆')
  if (state.completedAt === undefined) return
  const candidates = readMemorySessionIdentities(root).filter(meta => meta.id === sessionId)
  if (candidates.length && candidates.every(meta =>
    meta.workspaceId === scope.projectId && meta.workItemId === scope.workItemId &&
    (meta.taskMemorySessionId ?? meta.id) === scope.sessionId &&
    hasVerifiedPreparationRestoreAfter(root, meta as SessionMeta, state.completedAt!))) return
  throw new Error('会话已永久删除，需完成原会话的已验证恢复后才能修改任务记忆')
}
