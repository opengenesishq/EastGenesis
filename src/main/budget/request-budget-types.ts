/** Main-process budget inputs; never accepted from tool arguments or renderer IPC. */
export interface RequestBudgetScope {
  /** Stable canonical memberships, including groups that do not yet have a limit. */
  aggregateBudgetIds?: string[]
  aggregateBudgets?: Array<{ id: string; sessionIds: string[]; limitUsd?: number; textSpentUsd: number;
    textCostFloors?: Array<{ id: string; sessionIds: string[]; observedUsd: number; minimumUsd: number }> }>
  sessionId: string
  sdkSessionId?: string
  sessionTextCostUsd: number
  sessionLimitUsd?: number
  monthlyLimitUsd?: number
  monthlyTextSpentUsd: number
  observedSessions: Array<{ id: string; sdkSessionId?: string; costUsd: number }>
}

export interface RequestBudgetReservation {
  id: string
  kind: 'model' | 'media'
  sessionKey: string
  providerId: string
  model?: string
  estimatedUsd?: number
  actualUsd?: number
  status: 'reserved' | 'settled' | 'unknown' | 'released'
  createdAt: number
  updatedAt: number
}

export interface BudgetSession {
  key: string
  sessionIds: string[]
  sdkSessionId?: string
  /** Retained when history is removed or concurrent siblings are not projected yet. */
  aggregateBudgetIds?: string[]
  baselineTextUsd: number
  observedTextUsd: number
  createdAt: number
}

export interface RequestBudgetDocument {
  schemaVersion: 1
  sessions: BudgetSession[]
  reservations: RequestBudgetReservation[]
}

export interface RequestBudgetSnapshot {
  aggregateRemainingUsd?: number[]
  aggregateUsage?: RequestBudgetAggregateUsage[]
  /** Settled text only; excludes media and live reservations. Missing if any
   * completed text request lacks an actual priced usage result. */
  actualTextCostUsd?: number
  sessionSpentUsd: number
  monthlySpentUsd: number
  sessionRemainingUsd?: number
  monthlyRemainingUsd?: number
  sessionUnknown: boolean
  monthlyUnknown: boolean
}

/** A read projection of the same accounting used at request admission. */
export interface RequestBudgetAggregateUsage {
  id: string
  recordedSpentUsd: number
  accountedUsd: number
  reservedUsd: number
  reservedCount: number
  unpricedReservedCount: number
  uncertainHeldUsd: number
  uncertainCount: number
  remainingUsd?: number
  admissionBlocked: boolean
}

export interface ReserveRequestBudgetInput {
  rootDir: string
  id: string
  kind: RequestBudgetReservation['kind']
  providerId: string
  model?: string
  estimatedUsd?: number
  scope: RequestBudgetScope
  now?: number
}
