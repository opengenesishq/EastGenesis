import { currentGoalModeOccurrence } from './goal-mode-generation'
import { createHash } from 'node:crypto'
import { listRoutines, updateRoutine } from '../routineStore'
import type { RoutineRunRecord } from './routine-runner'
import { sameRoutineSessionTarget } from './routine-heartbeat-target'

/** Count before dispatch; uncertainty never gives an already reserved turn back. */
export async function reserveGoalContinuationTurn(root: string, record: RoutineRunRecord): Promise<void> {
  const current = (await listRoutines(root)).find(item => item.id === record.routineId)
  if (!current?.enabled || !sameRoutineSessionTarget(current.executionTarget, record.heartbeat?.target)) throw new Error('持续推进已暂停或任务绑定已变化。')
  if (!current.goalContinuation) return
  if (!currentGoalModeOccurrence(current, record)) throw new Error('持续目标已退出，旧排队不可恢复')
  const state = current.goalContinuationState ?? { turns: 0, repeatedResults: 0, status: 'active' as const }
  if (state.reservedRunId === record.id) return
  if (!Number.isSafeInteger(state.turns) || state.turns < 0 || state.turns >= current.goalContinuation.maxTurns) throw new Error('持续推进已达到轮数上限。')
  await updateRoutine(root, current.id, { goalContinuationState: { ...state, turns: state.turns + 1, reservedRunId: record.id, status: 'active', reason: undefined } })
}

export async function settleGoalContinuationTurn(root: string, record: RoutineRunRecord): Promise<void> {
  const current = (await listRoutines(root)).find(item => item.id === record.routineId)
  if (!current?.goalContinuation || !sameRoutineSessionTarget(current.executionTarget, record.heartbeat?.target)) return
  const state = current.goalContinuationState
  if (!state || state.resultRunId === record.id || !currentGoalModeOccurrence(current, record)) return
  const resultDigest = createHash('sha256').update(record.resultText?.trim() ?? '').digest('hex')
  const repeatedResults = state.resultDigest === resultDigest ? state.repeatedResults + 1 : 1
  const failed = record.status === 'failed', stalled = repeatedResults >= 2, limited = state.turns >= current.goalContinuation.maxTurns
  const reason = failed ? record.error || '本轮执行失败，请处理后再继续。' : stalled ? '连续两轮返回相同结果，已停止自动推进。' : limited ? '已达到本次持续推进的轮数上限。' : undefined
  await updateRoutine(root, current.id, { ...(reason ? { enabled: false, lastError: reason } : {}),
    goalContinuationState: { ...state, resultRunId: record.id, resultDigest, repeatedResults,
      status: failed ? 'paused' : stalled ? 'stalled' : limited ? 'limited' : 'active', reason } })
}
