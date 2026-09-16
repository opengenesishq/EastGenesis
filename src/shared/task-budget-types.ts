export interface TaskBudgetView {
  schemaVersion: 1
  sessionId: string
  observedAt: number
  state: 'ready' | 'unbound' | 'unavailable'
  source: 'request_budget_ledger'
  goal?: { id: string; projectId: string; title: string }
  /** USD accounting cap; zero in old Goal records means no cap. */
  limitUsd?: number
  goalLimitUsd?: number
  frozenRunLimitUsd?: number
  recordedSpentUsd?: number
  reservedUsd?: number
  reservedCount?: number
  unpricedReservedCount?: number
  uncertainHeldUsd?: number
  uncertainCount?: number
  missingUsageRunCount?: number
  remainingUsd?: number
  remainingState: 'available' | 'exhausted' | 'unlimited' | 'unknown'
  /** This view covers the Goal purse; other authorization/budget gates still apply. */
  errorCode?: 'BUDGET_UNAVAILABLE'
}

export interface TaskBudgetApi {
  getTaskBudget(sessionId: string): Promise<TaskBudgetView>
}
