import type { Goal, WorkItem } from '../../shared/project-workspace-types'
import type { RoutineGoalContinuationState } from '../../shared/routine-heartbeat-types'
import type { TaskBudgetView } from '../../shared/task-budget-types'
import type { SessionMeta, SupervisorRunRecord, TaskRunRecord } from '../../shared/types'
import type { Routine } from '../routineStore'

export interface GoalContinuationDecision {
  action: 'continue' | 'wait' | 'stop'
  status: RoutineGoalContinuationState['status']
  reason?: string
}
export interface GoalContinuationContext {
  workspaceActive: boolean
  meta: SessionMeta
  goal?: Goal
  workItem?: WorkItem
  budget: TaskBudgetView
  supervisorRuns: SupervisorRunRecord[]
  taskRuns: TaskRunRecord[]
}

export function goalContinuationDecision(routine: Routine, recordId: string, context: GoalContinuationContext): GoalContinuationDecision {
  const { meta, goal, workItem, budget } = context
  const stop = (reason: string, status: GoalContinuationDecision['status'] = 'paused'): GoalContinuationDecision => ({ action: 'stop', status, reason })
  const wait = (reason: string): GoalContinuationDecision => ({ action: 'wait', status: 'waiting', reason })
  if (!routine.goalContinuation) return { action: 'continue', status: 'active' }
  if (routine.goalContinuationState?.status === 'exited') return stop('持续目标模式已退出。', 'exited')
  if (!context.workspaceActive || !goal || !workItem || meta.workspaceId !== goal.projectId || workItem.projectId !== goal.projectId ||
      meta.goalId !== goal.id || meta.workItemId !== workItem.id || workItem.goalId !== goal.id) return stop('目标或任务归属已变化，请核对原任务。')
  if (goal.status === 'completed') return stop('目标已有完成记录，持续推进已停止。', 'completed')
  if (workItem.status === 'done') return stop('当前分工已有完成记录，持续推进已停止。', 'completed')
  if (['failed', 'cancelled', 'archived', 'blocked'].includes(goal.status) || ['failed', 'cancelled', 'blocked'].includes(workItem.status)) return stop('目标或任务已停止，需要先处理阻塞。')
  if (meta.taskStrategy === 'plan') return stop('当前任务仍处于计划阶段，请先确认计划并切换到执行。')
  if (goal.status === 'waiting_approval' || workItem.status === 'waiting_approval' || context.supervisorRuns.some(run => run.status === 'waiting_approval') || context.taskRuns.some(run => run.status === 'waiting_approval')) return wait('等待原任务审批，尚未派发下一轮。')
  if (context.supervisorRuns.some(run => ['waiting_reconciliation', 'paused', 'blocked'].includes(run.status)) ||
      context.taskRuns.some(run => ['waiting_reconciliation', 'recovering'].includes(run.status))) return stop('原执行已暂停或存在待核对结果，请先在执行记录中处理。')
  const state = routine.goalContinuationState
  if (state && (!Number.isSafeInteger(state.turns) || state.turns < 0 || !Number.isSafeInteger(state.repeatedResults) || state.repeatedResults < 0)) return stop('持续推进的轮次记录无法核对。')
  if ((state?.repeatedResults ?? 0) >= 2) return stop('连续两轮返回相同结果，已停止自动推进，请调整要求后再继续。', 'stalled')
  if ((state?.turns ?? 0) >= routine.goalContinuation.maxTurns && state?.reservedRunId !== recordId) return stop('已达到本次持续推进的轮数上限。', 'limited')
  if (budget.state !== 'ready' || budget.remainingState === 'unknown') return stop('目标费用尚未核对，持续推进已暂停。')
  if (budget.remainingState === 'exhausted') return stop('已达到目标预算上限，持续推进已暂停。', 'limited')
  if (meta.status === 'running' || meta.status === 'starting' || context.taskRuns.some(run => !['completed', 'failed', 'cancelled'].includes(run.status))) return wait('等待当前执行结束。')
  return { action: 'continue', status: 'active' }
}
