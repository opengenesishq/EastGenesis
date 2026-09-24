import { listRoutines, updateRoutine } from '../routineStore'
import { dirname } from 'node:path'
import { pauseSessionFollowUps } from '../task/session-follow-up-gate'

/** Explicit task pause/cancel also stops automatic prompts targeting that Session. */
export async function pauseSessionContinuations(routineRoot: string, sessionId: string): Promise<void> {
  pauseSessionFollowUps(dirname(routineRoot), sessionId)
  for (const routine of await listRoutines(routineRoot)) {
    if (routine.enabled && routine.executionTarget?.sessionId === sessionId) {
      await updateRoutine(routineRoot, routine.id, { enabled: false,
        ...(routine.goalContinuation ? { goalContinuationState: { ...(routine.goalContinuationState ?? { turns: 0, repeatedResults: 0 }), status: 'paused', reason: '用户已暂停当前任务。' } } : {}) })
    }
  }
}
