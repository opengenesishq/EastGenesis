import type { HistoryEntry, SessionMeta } from '../shared/types'
import { listHistory, upsertHistory } from './history'
import { sessionHistoryEntry } from './session-history-entry'

/**
 * Runtime-owned history boundary.
 *
 * SessionManager may need a read model for recovery/budget decisions and may
 * persist the current session projection, but it should not know which file
 * store, migration or cache implements that projection.  Other legacy IPC
 * callers can keep using history.ts until their own boundary is migrated.
 */
export class SessionHistoryRepository {
  list(): HistoryEntry[] {
    return listHistory()
  }

  findById(id: string): HistoryEntry | undefined {
    return this.list().find((entry) => entry.id === id)
  }

  sdkSessionIds(): string[] {
    return this.list()
      .map((entry) => entry.sdkSessionId)
      .filter((id): id is string => Boolean(id))
  }

  upsertSession(meta: SessionMeta & { sdkSessionId: string }): void {
    upsertHistory(sessionHistoryEntry(meta))
  }
}
