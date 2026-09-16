import { ProjectDeletionJournal } from '../data-lifecycle/project-deletion-journal'
import { ProjectImportJournal } from '../data-lifecycle/project-import-journal'
import { ProjectImportSourceStore } from '../data-lifecycle/project-import-source-store'

/** Called under the shared lifecycle lock so a queued task cannot recreate purged Project memory. */
export function assertMemoryProjectWritable(root: string, projectId: string): void {
  const state = new ProjectDeletionJournal(root).sessionDeletionState(`project-memory:${projectId}`, projectId)
  if (state.pending) throw new Error('项目正在永久删除，不能保存任务记忆')
  if (state.completedAt === undefined) return
  for (const entry of new ProjectImportJournal(root).listCompleted(projectId)) {
    if (entry.createdAt < state.completedAt || !entry.completedAt || entry.completedAt < entry.createdAt ||
        entry.importedSemanticDigest !== entry.sourceSemanticDigest || !entry.importedAggregateDigest || !entry.aggregateRevision) continue
    try {
      const source = new ProjectImportSourceStore(root).read(entry.sourcePath, entry.operationId, projectId)
      if (source.sourceDigest === entry.sourceDigest && source.bundle.exportDigest === entry.exportDigest &&
          source.bundle.aggregate.aggregateDigest === entry.sourceAggregateDigest) return
    } catch { /* An unreadable source is not proof of a completed restore. */ }
  }
  throw new Error('项目已永久删除，需完成已验证的项目恢复后才能保存任务记忆')
}
