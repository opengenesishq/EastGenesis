import { TaskExecutionAuthorityStore } from '../permission/task-execution-authority-store'

/** Retained creation journals may predate the grant; only their export copies gain a restriction. */
export function portableCreationAuthorityMarkers<T>(
  rootDir: string,
  creationRecords: readonly T[],
  publicRecords: readonly unknown[]
): T[] {
  const authority = new TaskExecutionAuthorityStore(rootDir)
  const restrictedIds = new Set(publicRecords.map(portableMeta)
    .filter(meta => meta?.taskExecutionAuthorityRequired === true).map(meta => meta!.id))
  return creationRecords.map(record => {
    const portable = structuredClone(record)
    const meta = portableMeta(portable)
    if (meta && typeof meta.id === 'string' &&
        (restrictedIds.has(meta.id) || authority.hasPersistedRestriction(meta.id))) meta.taskExecutionAuthorityRequired = true
    return portable
  })
}

/** Never export a private restriction as an unrestricted portable Session. */
export function assertTaskExecutionAuthorityMarkersPortable(
  rootDir: string,
  sessionIds: Iterable<string>,
  records: readonly unknown[]
): void {
  const authority = new TaskExecutionAuthorityStore(rootDir)
  const metas = records.map(portableMeta).filter((value): value is Record<string, unknown> => value !== undefined)
  for (const sessionId of new Set(sessionIds)) {
    const sources = metas.filter(meta => meta.id === sessionId)
    const requiresMarker = authority.hasPersistedRestriction(sessionId) ||
      sources.some(meta => meta.taskExecutionAuthorityRequired === true)
    if (!requiresMarker) continue
    if (sources.length === 0 || sources.some(meta => meta.taskExecutionAuthorityRequired !== true)) {
      throw new Error(`TASK_AUTHORITY_EXPORT_RECONCILIATION: 任务 ${sessionId} 的授权限制尚未同步到所有恢复记录，请打开原任务完成恢复后再导出。`)
    }
  }
}

function portableMeta(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.meta)) return value.meta
  if (isRecord(value.draft) && isRecord(value.draft.baseMeta)) return value.draft.baseMeta
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
