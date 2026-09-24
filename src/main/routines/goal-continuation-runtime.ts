import type { Routine } from '../routineStore'
import { readTaskBudget } from '../budget/task-budget-projection'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { listHistory } from '../history'
import { sessionManager } from '../sessionManager'
import { SupervisorStateStore } from '../task/supervisor-state'
import { listTaskRuns } from '../task/task-snapshot'
import type { RoutineRunRecord } from './routine-runner'
import { goalContinuationDecision, type GoalContinuationDecision } from './goal-continuation-policy'
import { assertRoutineSessionTarget } from './routine-heartbeat-target'

export async function checkGoalContinuation(workspaceRoot: string, routine: Routine, record: RoutineRunRecord): Promise<GoalContinuationDecision> {
  if (!routine.goalContinuation) return { action: 'continue', status: 'active' }
  const target = routine.executionTarget
  if (!target?.workspaceId || !target.goalId || !target.workItemId) throw new Error('持续推进缺少原目标绑定。')
  const meta = sessionManager.get(target.sessionId)?.meta
  assertRoutineSessionTarget(target, meta)
  const reads = createProjectWorkspaceReadService(workspaceRoot, 'canonical')
  const [state, supervisorRuns, taskRuns] = await Promise.all([
    reads.getWorkspaceExecutionState(target.workspaceId),
    new SupervisorStateStore(workspaceRoot).listRuns({ projectId: target.workspaceId }),
    listTaskRuns(target.sessionId, workspaceRoot)
  ])
  const currentRun = sessionManager.getTaskRun(target.sessionId)
  return goalContinuationDecision(routine, record.id, { meta, workspaceActive: state.workspace?.status === 'active',
    goal: state.goals.find(goal => goal.id === target.goalId), workItem: state.workItems.find(item => item.id === target.workItemId),
    budget: readTaskBudget(meta, [...listHistory(), ...sessionManager.list()], workspaceRoot),
    supervisorRuns: supervisorRuns.filter(run => run.workItemId === target.workItemId),
    taskRuns: currentRun ? [...taskRuns.filter(run => run.id !== currentRun.id), currentRun] : taskRuns })
}

