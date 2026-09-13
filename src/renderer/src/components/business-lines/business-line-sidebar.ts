import { resolveBusinessLineId, type BusinessLineDefinition, type BusinessLineTaskIdentity } from '../../../../shared/business-line-types'
import type { SidebarEntry } from '../sidebar-project-groups'

export function belongsToBusinessLine(meta: BusinessLineTaskIdentity | undefined, lineId: string): boolean {
  return Boolean(meta && resolveBusinessLineId(meta) === lineId)
}

export function businessLineConversationEntries(line: BusinessLineDefinition, entries: SidebarEntry[]): SidebarEntry[] {
  return entries.filter((entry) => belongsToBusinessLine(entry.kind === 'active' ? entry.meta : entry.history, line.id))
}

export function builtinLineValue<T>(line: BusinessLineDefinition, value: T): T | undefined {
  return line.origin === 'builtin' ? value : undefined
}
