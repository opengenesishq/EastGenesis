import { deleteComposerDrafts } from './composer-draft-persistence'

/** Remove only local copies whose canonical ownership was confirmed by deletion. */
export function clearDeletedTaskLocalData(sessionIds: readonly string[], projectId?: string, storage = window.localStorage): void {
  const sessions = new Set(sessionIds)
  const draftKeys = [...sessions]
  if (projectId) draftKeys.push(`goal-intake:${projectId}`, `goal-intake:${projectId}:template`, `goal-intake:${projectId}:mode`)
  deleteComposerDrafts(storage, draftKeys)
  for (const id of sessions) storage.removeItem(`caogen.session-input-request.v1:${id}`)
  const key = 'caogen.project-goal-submissions.v1'
  const raw = storage.getItem(key)
  if (raw === null) return
  const pending: unknown = JSON.parse(raw)
  if (!Array.isArray(pending)) throw new Error('任务已删除，但本地提交缓存无法解析，请清理应用缓存。')
  const retained = pending.filter((item: unknown) => {
    if (!item || typeof item !== 'object') return true
    const record = item as { projectId?: string; sessionId?: string }
    return !(projectId && record.projectId === projectId) && !(record.sessionId && sessions.has(record.sessionId))
  })
  if (retained.length) storage.setItem(key, JSON.stringify(retained))
  else storage.removeItem(key)
}
