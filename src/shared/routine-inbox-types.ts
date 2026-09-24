import type { RoutineRunRecord } from './types'
import type { RunDetailCanonicalInput } from './run-detail-projection'

export type RoutineInboxStatus = 'all' | 'running' | 'waiting' | 'failed' | 'completed'
export interface RoutineInboxQuery {
  routineId?: string
  projectId?: string
  query?: string
  status?: RoutineInboxStatus
  unreadOnly?: boolean
  page?: number
}
export interface RoutineInboxItem {
  run: RoutineRunRecord
  sourceVersion: string
  unread: boolean
}
export interface RoutineInboxSnapshot {
  snapshotId: string
  items: RoutineInboxItem[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  /** Unread count before the unread-only filter, within the other current filters. */
  unreadCount: number
  projects: Array<{ id: string; label: string }>
}
export interface RoutineInboxResult {
  item: RoutineInboxItem
  detail?: RunDetailCanonicalInput
  workflowIssue?: string
  detailsTruncated?: boolean
}
export interface RoutineInboxTask {
  sessionId: string
  sessionCreatedAt: number
  cwd: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
}
export interface RoutineInboxMarkInput {
  snapshotId: string
  /** Only occurrences visible in this frozen page can be acknowledged. */
  runIds: string[]
  read: boolean
}
export interface RoutineInboxApi {
  listRoutineInbox(input?: RoutineInboxQuery): Promise<RoutineInboxSnapshot>
  readRoutineInboxResult(snapshotId: string, runId: string): Promise<RoutineInboxResult>
  markRoutineInboxRead(input: RoutineInboxMarkInput): Promise<void>
  resolveRoutineInboxTask(snapshotId: string, runId: string): Promise<RoutineInboxTask>
  onRoutineInboxChanged(callback: () => void): () => void
}
