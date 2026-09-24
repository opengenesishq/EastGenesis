import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteCommandRecord } from '../../shared/remote-types'
import type { ProjectGoalTaskStarted } from '../../shared/project-workspace-types'
import type { RemoteCreatedTask, RemoteCreatedTaskProjection } from '../../shared/remote-created-task-types'
import type { SessionInputRecord } from '../../shared/session-input-types'
import { ProjectGoalSubmissionStore } from '../project-workspace/goal-submission-store'
import { goalTaskIds } from '../project-workspace/goal-task-service'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { TaskPlanContractStore } from '../task/task-plan-contract-store'

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const same = (a: RemoteCreatedTask, b: RemoteCreatedTask): boolean => ['projectId', 'goalId', 'workItemId', 'sessionId'].every(key => a[key as keyof RemoteCreatedTask] === b[key as keyof RemoteCreatedTask])
export function remoteCreatedTaskResult(started: ProjectGoalTaskStarted): RemoteCreatedTaskProjection {
  const createdTask = { projectId: started.workItem.projectId, goalId: started.goal.id, workItemId: started.workItem.id, sessionId: started.sessionId }
  if (started.goal.projectId !== createdTask.projectId || started.workItem.goalId !== createdTask.goalId) throw new Error('远端创建结果归属不一致。')
  return { createdTask, createPhase: started.kind === 'plan' ? 'plan_ready' : started.input.phase === 'applied' ? 'input_received' : started.input.phase === 'queued' ? 'input_queued' : 'needs_reconciliation' }
}

/** Reads existing task evidence only. Never creates/restores a Session or applies an input. */
export async function inspectRemoteCreatedTask(root: string, command: RemoteCommandRecord): Promise<RemoteCreatedTaskProjection | undefined> {
  if (command.envelope.kind !== 'create_task') return undefined
  const payload = command.envelope.payload
  if (!payload || payload.kind !== 'create_task') return { createPhase: 'needs_reconciliation' }
  try {
    const projectId = command.envelope.scope.projectId, requestId = `remote-${command.envelope.commandId}`
    const input = { projectId, requestId, objective: payload.objective, businessLineId: payload.businessLineId, template: 'auto' as const }
    const record = new ProjectGoalSubmissionStore(root).read(input)
    if (!record) return { createPhase: command.execution ? 'needs_reconciliation' : 'preparing' }
    const ids = goalTaskIds(projectId, requestId), reads = createProjectWorkspaceReadService(root, 'canonical')
    const [goal, workItem] = await Promise.all([reads.getGoal(ids.goalId), reads.getWorkItem(ids.workItemId)])
    if (!goal || !workItem || goal.projectId !== projectId || workItem.projectId !== projectId || workItem.goalId !== goal.id ||
      payload.businessLineId !== undefined && workItem.businessLineId !== payload.businessLineId) throw new Error('task binding')
    const binding: RemoteCreatedTask = { projectId, goalId: goal.id, workItemId: workItem.id, sessionId: record.sessionId }
    if (command.execution?.createdTask && !same(binding, command.execution.createdTask)) throw new Error('original binding')
    const plan = new TaskPlanContractStore(() => root).get(binding.sessionId)
    if (record.startDecision?.kind === 'plan') {
      const current = plan.currentVersion?.binding
      if (!current || current.sessionId !== binding.sessionId || current.workspaceId !== projectId || current.goalId !== goal.id || current.workItemId !== workItem.id) throw new Error('plan binding')
      return { createdTask: binding, createPhase: 'plan_ready' }
    }
    if (plan.currentVersion) throw new Error('unexpected plan')
    const inputId = `goal-start-${sha(JSON.stringify([projectId, requestId]))}`
    const path = join(root, 'private', 'session-inputs', sha(binding.sessionId), `${sha(inputId)}.json`)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('input file')
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as SessionInputRecord
    if (receipt.schemaVersion !== 1 || receipt.id !== inputId || receipt.sessionId !== binding.sessionId || receipt.workspaceId !== projectId || receipt.goalId !== goal.id || receipt.workItemId !== workItem.id ||
      receipt.messageId !== `session-input:${binding.sessionId}:${inputId}` || receipt.payload?.text !== payload.objective || receipt.payload.images?.length || receipt.payload.documents?.length ||
      receipt.payload.goalRevisionIntent || receipt.payload.requirementRevisionIntent || receipt.payload.officeRevisionIntent || !['queued', 'dispatching', 'applied', 'needs_reconciliation', 'cancelled'].includes(receipt.phase) ||
      !Number.isFinite(receipt.createdAt) || !Number.isFinite(receipt.updatedAt)) throw new Error('input binding')
    return { createdTask: binding, createPhase: receipt.phase === 'applied' ? 'input_received' : receipt.phase === 'queued' ? 'input_queued' : 'needs_reconciliation' }
  } catch { return { createPhase: 'needs_reconciliation' } }
}
