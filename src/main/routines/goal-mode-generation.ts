import type { Routine } from '../routineStore'
import type { RoutineRunRecord } from './routine-runner'
export function goalModeGeneration(routine: Routine): number {
  const value = routine.goalContinuationState?.generation ?? 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('持续目标代次无效')
  return value
}
export function currentGoalModeOccurrence(routine: Routine, record: RoutineRunRecord): boolean {
  const generation = record.heartbeat?.goalModeGeneration ?? 0
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('持续目标派发代次无效')
  return !routine.goalContinuation || (routine.goalContinuationState?.status !== 'exited' && generation === goalModeGeneration(routine))
}
