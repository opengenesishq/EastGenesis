/** Exact result of one remote create command; never the caller's local Session. */
export interface RemoteCreatedTask {
  projectId: string
  goalId: string
  workItemId: string
  sessionId: string
}
export type RemoteCreatePhase = 'preparing' | 'plan_ready' | 'input_queued' | 'input_received' | 'needs_reconciliation'
export interface RemoteCreatedTaskProjection {
  createdTask?: RemoteCreatedTask
  createPhase: RemoteCreatePhase
}
