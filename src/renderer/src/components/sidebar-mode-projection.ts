import { groupTaskEntries } from './task-entry-groups'
import type { HistoryEntry } from '../../../shared/types'
import type { ExperienceMode } from '../store/experience-mode'
import type { SidebarEntry } from './sidebar-project-groups'

export function splitAssistantEntries(entries: SidebarEntry[]): {
  archived: HistoryEntry[]
  pinned: SidebarEntry[]
  sessions: SidebarEntry[]
} {
  const result: { archived: HistoryEntry[]; pinned: SidebarEntry[]; sessions: SidebarEntry[] } = { archived: [], pinned: [], sessions: [] }
  for (const group of groupTaskEntries(entries)) {
    const live = group.entries.some((entry) => entry.kind === 'active' || !entry.history.archived)
    if (!live) { result.archived.push(...group.entries.flatMap((entry) => entry.kind === 'history' ? [entry.history] : [])); continue }
    const pinned = group.entries.some((entry) => Boolean(entry.history?.pinned))
    result[pinned ? 'pinned' : 'sessions'].push(...group.entries)
  }
  return result
}

export function sidebarSearchKey(mode: ExperienceMode): 'searchSessionsPlaceholder' | 'searchProjectsPlaceholder' | 'searchVideosPlaceholder' {
  if (mode === 'studio') return 'searchProjectsPlaceholder'
  if (mode === 'video') return 'searchVideosPlaceholder'
  return 'searchSessionsPlaceholder'
}

export function sidebarVisibleCount(
  mode: ExperienceMode,
  assistantCounts: number[],
  projectCounts: number[]
): number {
  return (mode === 'assistant' ? assistantCounts : projectCounts).reduce((total, count) => total + count, 0)
}
