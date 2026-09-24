import type { SessionMeta } from './types'

export interface WorkspaceHandoffReceipt {
  schemaVersion: 1
  id: string
  sessionId: string
  direction: 'worktree' | 'local'
  fromCwd: string
  toCwd: string
  createdAt: number
  committedAt: number
  fileCount: number
  /** This receipt changes placement only; task, conversation and Run identities remain unchanged. */
  state: 'committed'
}
export interface WorkspaceHandoffView {
  sessionId: string
  current: 'worktree' | 'local'
  destination?: string
  pending: boolean
  lastReceipt?: WorkspaceHandoffReceipt
}
export interface WorkspaceHandoffApi {
  getWorkspaceHandoff(sessionId: string): Promise<WorkspaceHandoffView>
  handoffWorkspace(sessionId: string): Promise<SessionMeta>
}
