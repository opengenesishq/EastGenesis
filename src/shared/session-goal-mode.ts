export interface SessionGoalModeClearResult {
  sessionId: string
  routineIds: string[]
  cancelledInputIds: string[]
  /** Submitted/unknown requests remain preserved for reconciliation. */
  pendingInputIds: string[]
  executionPaused: boolean
  reason?: string
}
export interface GoalModeApi {
  clearSessionGoalMode(sessionId: string): Promise<SessionGoalModeClearResult>
}
