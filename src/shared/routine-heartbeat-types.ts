/** Captured by main when a user schedules a continuation of an existing task. */
export interface RoutineSessionTarget {
  kind: 'existing_session'
  sessionId: string
  sessionCreatedAt: number
  cwd: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  legacyProjectId?: string
}

export interface RoutineHeartbeatRun {
  target: RoutineSessionTarget
  /** Binds this occurrence to the current goal mode; legacy records use 0. */
  goalModeGeneration?: number
  scheduledAt: number
  inputRequestId: string
  messageId: string
  /** Immutable prompt for this occurrence, including after the plan is edited. */
  prompt: string
  phase: 'queued' | 'dispatching' | 'accepted' | 'needs_reconciliation'
}

/** Explicitly enabled, bounded continuation of the target's existing Goal. */
export interface RoutineGoalContinuation { maxTurns: number }
export interface RoutineGoalContinuationState {
  generation?: number
  exitedAt?: number
  turns: number
  reservedRunId?: string
  resultRunId?: string
  resultDigest?: string
  repeatedResults: number
  status: 'active' | 'waiting' | 'paused' | 'completed' | 'limited' | 'stalled' | 'exited'
  reason?: string
}

export function normalizeRoutineGoalContinuation(value: unknown): RoutineGoalContinuation | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isSafeInteger((value as RoutineGoalContinuation).maxTurns) ||
      (value as RoutineGoalContinuation).maxTurns < 1 || (value as RoutineGoalContinuation).maxTurns > 100) {
    throw new Error('持续推进必须设置 1–100 轮的上限。')
  }
  return { maxTurns: (value as RoutineGoalContinuation).maxTurns }
}
