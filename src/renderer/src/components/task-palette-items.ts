import type { CommandDescriptor } from '../commands'
import type { HistoryEntry } from '../../../shared/types'
import { resolveBusinessLineId } from '../../../shared/business-line-types'
import type { AppStore } from '../store'
import type { SidebarEntry } from './sidebar-project-groups'
import { groupTaskEntries, taskEntryRecord } from './task-entry-groups'

export type PaletteSection = 'command' | 'session' | 'history' | 'plugin'
export interface PaletteItem extends CommandDescriptor { section: PaletteSection; children?: PaletteItem[] }

export function taskPaletteItems(input: {
  lineId: string; order: string[]; sessions: AppStore['sessions']; history: HistoryEntry[]
  selectSession(id: string): void; resume(entry: HistoryEntry): Promise<void>
}): PaletteItem[] {
  const open = new Set(input.order)
  const sdk = new Set(input.order.map((id) => input.sessions[id]?.meta.sdkSessionId))
  const entries: SidebarEntry[] = input.order.flatMap((id) => {
    const session = input.sessions[id]
    return session && resolveBusinessLineId(session.meta) === input.lineId
      ? [{ kind: 'active' as const, id, meta: session.meta, pendingCount: session.pendingPermissions.length }] : []
  })
  for (const history of input.history) {
    if (!open.has(history.id) && !sdk.has(history.sdkSessionId) && resolveBusinessLineId(history) === input.lineId) entries.push({ kind: 'history', id: history.id, history })
  }
  return groupTaskEntries(entries).flatMap((group) => {
    const primary = entryItem(group.representative, input)
    const attention = group.attention.map((entry) => ({ ...entryItem(entry, input), hint: '同一任务的其它待审批执行' }))
    if (group.entries.length === 1) return [primary]
    const history: PaletteItem = { id: `${group.key}:executions`, title: `${primary.title} · 执行与历史（${group.entries.length}）`,
      hint: '查看每次执行，处理审批或恢复历史', section: primary.section,
      searchText: group.entries.map((entry) => taskEntryRecord(entry).title).join(' '),
      children: group.entries.map((entry) => entryItem(entry, input)) }
    return [primary, ...attention, history]
  })
}

function entryItem(entry: SidebarEntry, handlers: { selectSession(id: string): void; resume(entry: HistoryEntry): Promise<void> }): PaletteItem {
  const record = taskEntryRecord(entry)
  const attention = entry.kind === 'active' && entry.pendingCount > 0 ? `待审批 ${entry.pendingCount} · ` : ''
  return { id: `${entry.kind === 'active' ? 'session' : 'history'}:${entry.id}`, title: record.title,
    hint: `${attention}${record.sourceCwd ?? record.cwd}`, searchText: `${record.title} ${record.cwd} ${record.sourceCwd ?? ''}`,
    section: entry.kind === 'active' ? 'session' : 'history',
    run: () => { if (entry.kind === 'active') handlers.selectSession(entry.id); else void handlers.resume(entry.history) } }
}

export function runPaletteItem(item: PaletteItem | undefined, close: () => void, openGroup: (item: PaletteItem) => void): void {
  if (!item) return
  if (item.children) { openGroup(item); return }
  close(); item.run?.()
}
