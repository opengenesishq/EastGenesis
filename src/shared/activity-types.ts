export type ActivityFilter = 'all' | 'unread' | 'running' | 'waiting'
export type TaskActivityStatus = 'running' | 'waiting' | 'failed' | 'completed' | 'idle' | 'recovery'

export interface TaskActivityItem {
  id: string
  sessionId: string
  sessionAliases: string[]
  title: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  historyId?: string
  recoverySnapshotId?: string
  active: boolean
  archived: boolean
  status: TaskActivityStatus
  pendingCount: number
  unread: boolean
  updatedAt: number
  /** Opaque source version; derived from the existing event identity, never renderer time. */
  sourceVersion: string
}
export interface TaskActivitySnapshot {
  snapshotId: string
  items: TaskActivityItem[]
  unreadCount: number
  createdAt: number
}
export interface TaskActivityMarkInput {
  snapshotId: string
  /** Omit to acknowledge every item in this exact snapshot. */
  itemIds?: string[]
  read: boolean
}
export interface TaskActivityDestination {
  kind: 'session' | 'history' | 'recovery'
  sessionId: string
  historyId?: string
  recoverySnapshotId?: string
}
export interface TaskActivityRecord {
  sessionId: string
  title: string
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
  truncated: boolean
}
export interface TaskActivityApi {
  listTaskActivity(): Promise<TaskActivitySnapshot>
  markTaskActivity(input: TaskActivityMarkInput): Promise<void>
  resolveTaskActivity(snapshotId: string, itemId: string): Promise<TaskActivityDestination>
  readTaskActivityRecord(snapshotId: string, itemId: string): Promise<TaskActivityRecord>
  onTaskActivityChanged(callback: () => void): () => void
}
