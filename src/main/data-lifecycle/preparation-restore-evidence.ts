import { readFileSync } from 'node:fs'
import type { SessionMeta } from '../../shared/types'
import { ProjectImportJournal } from './project-import-journal'
import { ProjectImportSourceStore } from './project-import-source-store'
import { assertPreparationPath, preparationPaths } from './preparation-data-files'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'

/** A completed local import may supersede an old deletion; the source bundle never grants permission. */
export function hasVerifiedPreparationRestoreAfter(root: string, meta: SessionMeta, completedAfter: number): boolean {
  if (!meta.workspaceId || !Number.isFinite(completedAfter)) return false
  const sources = new ProjectImportSourceStore(root)
  for (const entry of new ProjectImportJournal(root).listCompleted(meta.workspaceId)) {
    if (!Number.isFinite(entry.completedAt) || entry.createdAt < completedAfter ||
        entry.completedAt! < entry.createdAt || entry.importedSemanticDigest !== entry.sourceSemanticDigest ||
        !entry.importedAggregateDigest || !entry.aggregateRevision) continue
    try {
      const source = sources.read(entry.sourcePath, entry.operationId, meta.workspaceId)
      if (source.sourceDigest !== entry.sourceDigest || source.bundle.exportDigest !== entry.exportDigest ||
          source.bundle.aggregate.aggregateDigest !== entry.sourceAggregateDigest) continue
      const runtime = source.bundle.runtime
      if (!runtime?.sessionIds.includes(meta.id)) continue
      const candidates = [...runtime.sessionHistory, ...runtime.activeSessions, ...runtime.sessionCreationJournal,
        ...runtime.taskSnapshots].flatMap(value => {
        if (!isRecord(value)) return []
        const current = isRecord(value.meta) ? value.meta : isRecord(value.draft) && isRecord(value.draft.baseMeta) ? value.draft.baseMeta : value
        return current.id === meta.id || value.sessionId === meta.id ? [current] : []
      })
      const fields = ['createdAt', 'workspaceId', 'goalId', 'workItemId', 'businessLineId', 'personalWorkspaceId', 'parentSessionId'] as const
      if (!candidates.length || candidates.some(current => fields.some(field => current[field] !== meta[field]))) continue
      const preparation = runtime.preparation?.sessions.find(session => session.sessionId === meta.id)
      if (preparation) {
        const path = preparationPaths(root, meta.id).audit
        if (!assertPreparationPath(root, path, false)) continue
        const { files: _, ...original } = preparation
        if (readFileSync(path, 'utf8') !== projectAggregateCanonicalJson({ schemaVersion: 1, ...original })) continue
      }
      return true
    } catch {
      // An unreadable or corrupted retained source is not proof of a successful restore.
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
