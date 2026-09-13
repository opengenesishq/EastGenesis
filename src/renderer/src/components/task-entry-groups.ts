import { resolveBusinessLineId } from '../../../shared/business-line-types'
import type { SidebarEntry } from './sidebar-project-groups'

export interface TaskEntryGroup {
  key: string
  representative: SidebarEntry
  attention: SidebarEntry[]
  related: SidebarEntry[]
  entries: SidebarEntry[]
}

export function taskEntryRecord(entry: SidebarEntry) { return entry.kind === 'active' ? entry.meta : entry.history }

/** Storage identity stays unchanged. Only the task-facing list groups a WorkItem's execution Sessions. */
export function taskEntryKey(entry: SidebarEntry): string {
  const record = taskEntryRecord(entry)
  return record.workItemId ? `task:${resolveBusinessLineId(record)}:${record.workItemId}` : `session:${entry.id}`
}

export function taskEntryNeedsAttention(entry: SidebarEntry): boolean {
  return entry.kind === 'active' && entry.pendingCount > 0
}

function entryPriority(entry: SidebarEntry, selectedId?: string | null): number {
  if (taskEntryNeedsAttention(entry)) return 400
  if (entry.kind === 'active' && entry.meta.status === 'running') return 300
  if (entry.kind === 'active' && entry.meta.status === 'error') return 200
  if (entry.id === selectedId) return 150
  return entry.kind === 'active' ? 100 : 0
}

export function groupTaskEntries(entries: SidebarEntry[], selectedId?: string | null): TaskEntryGroup[] {
  const groups = new Map<string, SidebarEntry[]>()
  for (const entry of entries) {
    const key = taskEntryKey(entry)
    const list = groups.get(key) ?? []
    list.push(entry); groups.set(key, list)
  }
  return [...groups].map(([key, list]) => {
    const ordered = [...list].sort((a, b) => entryPriority(b, selectedId) - entryPriority(a, selectedId))
    const [representative, ...rest] = ordered
    return { key, representative, entries: list, attention: rest.filter(taskEntryNeedsAttention), related: rest.filter((entry) => !taskEntryNeedsAttention(entry)) }
  })
}

export function taskEntryCount(entries: SidebarEntry[]): number { return new Set(entries.map(taskEntryKey)).size }
