import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeSessionRecordsFromDocument } from '../active-session-registry-format'
import { historyEntriesFromDocument } from '../history-store-format'
import { sessionCreationJournalRecordsFromDocument } from '../session-creation-journal-format'

export interface MemorySessionIdentity {
  id: string
  taskMemorySessionId?: string
  workspaceId?: string
  projectId?: string
  workItemId?: string
  goalId?: string
  sourceCwd?: string
  cwd?: string
  createdAt?: number
}

/** All retained identities matter, including closed history and pending creation. */
export function readMemorySessionIdentities(root: string, extra: readonly unknown[] = []): MemorySessionIdentity[] {
  const records: unknown[] = [...extra]
  for (const [name, parse] of [
    ['sessions.json', historyEntriesFromDocument],
    ['active-sessions.json', activeSessionRecordsFromDocument],
    ['session-creation-journal.json', sessionCreationJournalRecordsFromDocument]
  ] as const) {
    const file = join(root, name)
    if (existsSync(file)) records.push(...parse(JSON.parse(readFileSync(file, 'utf8'))))
  }
  return records.map(value => {
    if (!isRecord(value)) throw new Error('Session memory ownership metadata is invalid')
    const meta = isRecord(value.meta) ? value.meta : isRecord(value.draft) && isRecord(value.draft.baseMeta) ? value.draft.baseMeta : value
    const id = meta.id ?? value.sessionId
    if (typeof id !== 'string' || !id.trim()) throw new Error('Session memory ownership identity is missing')
    for (const field of ['taskMemorySessionId', 'workspaceId', 'projectId', 'workItemId', 'goalId', 'sourceCwd', 'cwd']) {
      if (meta[field] !== undefined && (typeof meta[field] !== 'string' || !meta[field].trim())) {
        throw new Error('Session memory ownership field is invalid')
      }
    }
    return { ...meta, id } as MemorySessionIdentity
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
