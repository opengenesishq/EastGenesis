/** Main-process budget inputs; never accepted from tool arguments or renderer IPC. */
export interface RequestBudgetScope {
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
