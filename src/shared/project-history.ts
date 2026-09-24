import type { HistoryEntry } from './types'

export interface ProjectHistoryScope { kind: 'canonical' | 'legacy'; id: string }
export interface ProjectHistoryArchiveInput {
  scope: ProjectHistoryScope
  historyIds: string[]
  archived: boolean
}
export interface ProjectHistoryArchiveResult { changedIds: string[]; skippedIds: string[] }
export interface ProjectHistoryApi {
  archiveProjectHistory(input: ProjectHistoryArchiveInput): Promise<ProjectHistoryArchiveResult>
}

/** Same identity precedence as the sidebar; a directory never overrides a canonical owner. */
export function historyBelongsToProject(entry: HistoryEntry, scope: ProjectHistoryScope, legacyPath?: string): boolean {
  if (entry.unassigned) return false
  if (scope.kind === 'canonical') return entry.workspaceId === scope.id
  if (entry.workspaceId) return false
  if (entry.projectId) return entry.projectId === scope.id
  return Boolean(legacyPath && (entry.sourceCwd ?? entry.cwd) === legacyPath)
}
