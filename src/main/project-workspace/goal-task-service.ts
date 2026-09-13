import { createHash } from 'node:crypto'
import { assertSameBusinessLine, newBusinessLineId, storedBusinessLineId } from '../business-line-ownership'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import type {
  Goal,
  ProjectGoalTaskInput,
  ProjectGoalTaskResult,
  ProjectWorkspace,
  GoalStatus,
  WorkItem,
  WorkItemOwner,
  WorkItemStatus
} from '../../shared/project-workspace-types'
import { createProjectWorkspaceReadService } from './canonical-read-service'
import { openProjectWorkspaceCommandService } from './command-service'
import { openProjectWorkspaceStore } from './store'

const TERMINAL_GOAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'archived'])
const TERMINAL_WORK_ITEM_STATUSES = new Set(['done', 'failed', 'cancelled'])

export interface ProjectGoalTaskCreationOptions {
  workItemOwner?: WorkItemOwner
  goalStatus?: GoalStatus
  workItemStatus?: WorkItemStatus
}

export async function createProjectGoalTask(
  rawInput: ProjectGoalTaskInput,
  rootDir?: string,
  options: ProjectGoalTaskCreationOptions = {}
): Promise<ProjectGoalTaskResult> {
  const input = normalizeInput(rawInput)
  const ids = goalTaskIds(input.projectId, input.requestId)
  const reads = createProjectWorkspaceReadService(rootDir, 'canonical')
  const workspace = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(input.projectId)
  assertActiveWorkspace(workspace, input.projectId)

  let goal = await reads.getGoal(ids.goalId)
  let workItem = await reads.getWorkItem(ids.workItemId)
  const recovered = Boolean(goal || workItem)
  if (goal) assertMatchingGoal(goal, input)
  if (workItem) assertMatchingWorkItem(workItem, input, ids.goalId, options.workItemOwner)
  if (!workItem) {
    input.businessLineId = newBusinessLineId(input.businessLineId)
    assertActiveBusinessLine(input.businessLineId, rootDir)
  }

  const commands = await openProjectWorkspaceCommandService(rootDir)
  if (!goal) {
    goal = await createOrRecover(
      () => commands.createGoal({
        id: ids.goalId,
        projectId: input.projectId,
        title: taskTitle(input.objective),
        objective: input.objective,
        status: options.goalStatus ?? 'running',
        successCriteria: ['目标完成并有可核验的结果'],
        acceptance: [{ id: `${ids.goalId}-result`, criterion: '目标完成并有可核验的结果', required: true }]
      }),
      () => reads.getGoal(ids.goalId),
      (candidate) => assertMatchingGoal(candidate, input)
    )
  }
  if (!workItem) {
    workItem = await createOrRecover(
      () => commands.createWorkItem({
        id: ids.workItemId,
        projectId: input.projectId,
        goalId: goal!.id,
        businessLineId: input.businessLineId,
        title: taskTitle(input.objective),
        description: input.objective,
        type: 'custom',
        status: options.workItemStatus ?? 'ready',
        owner: options.workItemOwner,
        acceptanceSpec: [{
          id: `${ids.workItemId}-result`,
          criterion: '交付目标要求的结果并附带验证证据',
          required: true
        }]
      }),
      () => reads.getWorkItem(ids.workItemId),
      (candidate) => assertMatchingWorkItem(candidate, input, goal!.id, options.workItemOwner)
    )
  }
  return { requestId: input.requestId, goal, workItem, recovered }
}

export function goalTaskIds(projectId: string, requestId: string): { goalId: string; workItemId: string } {
  const digest = createHash('sha256')
    .update(`caogen.project-goal-task.v1\0${projectId}\0${requestId}`)
    .digest('hex')
    .slice(0, 24)
  return { goalId: `goal-${digest}`, workItemId: `work-item-${digest}` }
}

function normalizeInput(input: ProjectGoalTaskInput): ProjectGoalTaskInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('goal task input must be an object')
  const requestId = requiredText(input.requestId, 'requestId', 200)
  const projectId = requiredText(input.projectId, 'projectId', 200)
  const objective = requiredText(input.objective, 'objective', 20_000)
  return { requestId, projectId, objective, businessLineId: storedBusinessLineId(input.businessLineId) }
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const clean = value.trim()
  if (!clean || clean.length > maxLength || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean)) {
    throw new Error(`${label} is invalid`)
  }
  return clean
}

function taskTitle(objective: string): string {
  const clean = objective.replace(/\s+/g, ' ').trim()
  return clean.length <= 72 ? clean : `${clean.slice(0, 71)}…`
}

function assertActiveWorkspace(workspace: ProjectWorkspace | undefined, projectId: string): asserts workspace is ProjectWorkspace {
  if (!workspace) throw new Error(`canonical Workspace does not exist:${projectId}`)
  if (workspace.status !== 'active') throw new Error(`canonical Workspace is not active:${projectId}:${workspace.status}`)
}

function assertMatchingGoal(goal: Goal, input: ProjectGoalTaskInput): void {
  if (goal.projectId !== input.projectId || goal.objective !== input.objective || goal.title !== taskTitle(input.objective)) {
    throw new Error(`goal task request conflicts with existing Goal:${goal.id}`)
  }
  if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
    throw new Error(`goal task request cannot resume terminal Goal:${goal.id}:${goal.status}`)
  }
}

function assertMatchingWorkItem(
  workItem: WorkItem,
  input: ProjectGoalTaskInput,
  goalId: string,
  expectedOwner?: WorkItemOwner
): void {
  assertSameBusinessLine(input.businessLineId, workItem.businessLineId)
  if (workItem.projectId !== input.projectId || workItem.goalId !== goalId ||
      workItem.description !== input.objective || workItem.title !== taskTitle(input.objective)) {
    throw new Error(`goal task request conflicts with existing WorkItem:${workItem.id}`)
  }
  if (expectedOwner && (workItem.owner?.type !== expectedOwner.type || workItem.owner.id !== expectedOwner.id)) {
    throw new Error(`goal task request conflicts with existing WorkItem owner:${workItem.id}`)
  }
  if (TERMINAL_WORK_ITEM_STATUSES.has(workItem.status)) {
    throw new Error(`goal task request cannot resume terminal WorkItem:${workItem.id}:${workItem.status}`)
  }
}

async function createOrRecover<T>(
  create: () => Promise<T>,
  read: () => Promise<T | undefined>,
  validate: (value: T) => void
): Promise<T> {
  try {
    return await create()
  } catch (error) {
    const existing = await read()
    if (!existing) throw error
    validate(existing)
    return existing
  }
}
