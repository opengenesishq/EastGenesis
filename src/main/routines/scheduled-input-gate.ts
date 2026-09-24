import { join } from 'node:path'
import { listRoutines } from '../routineStore'
import { listRoutineRuns } from './routine-runner'
import { currentGoalModeOccurrence } from './goal-mode-generation'

export async function assertScheduledInputCurrent(workspaceRoot: string, sessionId: string, requestId: string): Promise<void> {
  if (!requestId.startsWith('routine-heartbeat-')) return
  const root = join(workspaceRoot, 'routines')
  const record = (await listRoutineRuns(root)).find(run => run.sessionId === sessionId && run.heartbeat?.inputRequestId === requestId)
  if (!record || record.status === 'succeeded' || record.status === 'failed') throw new Error('自动继续已结束或退出，旧请求不可重新派发')
  const routine = (await listRoutines(root)).find(item => item.id === record.routineId)
  if (!routine?.enabled || !currentGoalModeOccurrence(routine, record)) throw new Error('持续目标已暂停或退出，旧请求不可派发')
}
export async function assertScheduledMessageCurrent(workspaceRoot: string, sessionId: string, messageId?: string): Promise<void> {
  const prefix = `session-input:${sessionId}:`
  if (messageId?.startsWith(prefix)) await assertScheduledInputCurrent(workspaceRoot, sessionId, messageId.slice(prefix.length))
}
