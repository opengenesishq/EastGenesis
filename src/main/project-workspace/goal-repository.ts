import { randomUUID } from 'node:crypto'
import type {
  AcceptanceResult,
  Goal,
  GoalContract,
  GoalContractInput,
  GoalInput,
  GoalPatch,
  GoalStatus,
  MutationOptions,
  ProjectWorkspaceState
} from '../../shared/project-workspace-types'
import {
  isAcceptanceSatisfied,
  isGoalStatus,
  PROJECT_WORKSPACE_SCHEMA_VERSION
} from '../../shared/project-workspace-types'
import {
  clone,
  flattenContract,
  normalizeAcceptanceResult,
  normalizeContract,
  optionalId,
  requiredId,
  requiredText,
  timestamp
} from './codec'
import { ProjectWorkspaceError } from './errors'
import { appendEvent, ProjectWorkspacePersistence } from './persistence'
import type { ListOptions } from './repository-types'
import { activeWorkspaceFrom, assertProject, goalFrom, workspaceFrom } from './state-access'
import { assertProjectAuthorized, projectMutationActor } from './project-authorization'
import type { SessionRequirementRevisionInput } from '../../shared/session-requirement-revision'
import { reviseGoalRequirements } from './goal-requirement-revision'

const GOAL_TRANSITIONS: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  draft: new Set(['planned', 'cancelled']),
  planned: new Set(['running', 'cancelled']),
  running: new Set(['waiting_approval', 'blocked', 'verifying', 'cancelled']),
  waiting_approval: new Set(['running', 'blocked']),
  blocked: new Set(['running', 'failed', 'cancelled']),
  verifying: new Set(['completed', 'running', 'blocked', 'failed']),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
  archived: new Set([])
}

export class GoalRepository {
  constructor(private readonly persistence: ProjectWorkspacePersistence) {}

  reviseRequirements(id: string, input: SessionRequirementRevisionInput, options?: MutationOptions | number): Promise<Goal> {
    return reviseGoalRequirements(this.persistence, id, input, options)
  }

  async create(input: GoalInput, options?: MutationOptions | number): Promise<Goal> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const projectId = requiredId(input.projectId, 'goal projectId')
      const project = activeWorkspaceFrom(state, projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      const id = optionalId(input.id, 'goal id') ?? randomUUID()
      if (state.goals.some((goal) => goal.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `goal ${id} already exists`)
      }
      const goal = buildGoal(input, id, projectId, now)
      state.goals.push(goal)
      appendEvent(state, projectId, 'goal', id, 'goal.created', 1, goal as unknown as Record<string, unknown>, now)
      return goal
    })
  }

  async get(id: string): Promise<Goal | undefined> {
    const state = await this.persistence.read()
    const goal = state.goals.find((item) => item.id === id)
    return goal ? clone(goal) : undefined
  }

  async list(projectId?: string, options: ListOptions = {}): Promise<Goal[]> {
    const state = await this.persistence.read()
    if (projectId !== undefined) requiredId(projectId, 'projectId')
    return state.goals
      .filter((goal) => projectId === undefined || goal.projectId === projectId)
      .filter((goal) => options.includeArchived || goal.status !== 'archived')
      .filter((goal) => options.includeDeleted || workspaceFrom(state, goal.projectId).status !== 'deleted')
      .map(clone)
  }

  async update(id: string, patch: GoalPatch, options?: MutationOptions | number, capability: 'edit' | 'approve' = 'edit'): Promise<Goal> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const goal = goalFrom(state, id)
      const project = assertProject(state, goal.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), capability)
      this.persistence.assertEntityRevision(goal.revision, options, 'goal')
      if (goal.status === 'archived') throw new ProjectWorkspaceError('archived', `goal ${id} is archived`)
      if (isTerminalGoal(goal.status)) {
        throw new ProjectWorkspaceError('terminal', `goal ${id} is terminal`)
      }
      applyGoalPatch(goal, patch, now)
      appendEvent(state, goal.projectId, 'goal', goal.id, 'goal.updated', goal.revision, patch as unknown as Record<string, unknown>, now)
      propagateGoalContract(state, goal, now)
      return goal
    })
  }

  async setAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<Goal> {
    return this.update(id, { acceptanceResult: result }, options, 'approve')
  }

  async transition(id: string, status: GoalStatus, options?: MutationOptions | number): Promise<Goal> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const goal = goalFrom(state, id)
      const project = assertProject(state, goal.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      this.persistence.assertEntityRevision(goal.revision, options, 'goal')
      validateGoalTransition(state, goal, status)
      if (goal.status === status) return goal
      goal.status = status
      goal.updatedAt = now
      if (status === 'completed') goal.completedAt = now
      goal.revision += 1
      appendEvent(state, goal.projectId, 'goal', goal.id, `goal.${status}`, goal.revision, { status }, now)
      return goal
    })
  }

  async archive(id: string, options?: MutationOptions | number): Promise<Goal> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const goal = goalFrom(state, id)
      const project = assertProject(state, goal.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      this.persistence.assertEntityRevision(goal.revision, options, 'goal')
      if (goal.status === 'archived') return goal
      if (!isTerminalGoal(goal.status)) {
        throw new ProjectWorkspaceError('invalid_transition', `goal ${id} must be terminal before archive`)
      }
      goal.archivedFromStatus = goal.status
      goal.status = 'archived'
      goal.archivedAt = now
      goal.updatedAt = now
      goal.revision += 1
      appendEvent(state, goal.projectId, 'goal', goal.id, 'goal.archived', goal.revision, { status: goal.status }, now)
      return goal
    })
  }

  async restore(id: string, options?: MutationOptions | number): Promise<Goal> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const goal = goalFrom(state, id)
      const project = assertProject(state, goal.projectId)
      assertProjectAuthorized(state, project, projectMutationActor(options), 'edit')
      this.persistence.assertEntityRevision(goal.revision, options, 'goal')
      if (goal.status !== 'archived') return goal
      goal.status = goal.archivedFromStatus ?? 'draft'
      goal.archivedAt = undefined
      goal.archivedFromStatus = undefined
      goal.updatedAt = now
      goal.revision += 1
      appendEvent(state, goal.projectId, 'goal', goal.id, 'goal.restored', goal.revision, { status: goal.status }, now)
      return goal
    })
  }
}

function buildGoal(input: GoalInput, id: string, projectId: string, now: number): Goal {
  const contract = normalizeContract(goalContractInput(input), goalContractFallback(input))
  const status = input.status ?? 'draft'
  if (!isGoalStatus(status) || status === 'archived') {
    throw new ProjectWorkspaceError('invalid_input', 'goal status is invalid at creation')
  }
  if (status === 'completed') {
    throw new ProjectWorkspaceError(
      'invalid_input',
      'goal cannot be created completed; transition through verifying after Acceptance'
    )
  }
  const createdAt = timestamp(input.createdAt, 'goal createdAt', now)
  return {
    schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    id,
    projectId,
    title: requiredText(input.title, 'goal title'),
    objective: contract.objective,
    background: contract.background,
    constraints: clone(contract.constraints),
    successCriteria: clone(contract.successCriteria),
    budget: clone(contract.budget),
    dueAt: contract.dueAt,
    riskLevel: contract.riskLevel,
    forbiddenActions: clone(contract.forbiddenActions),
    acceptance: clone(contract.acceptance),
    acceptanceResult: normalizeAcceptanceResult(input.acceptanceResult),
    contract,
    status,
    createdBy: optionalId(input.createdBy, 'goal createdBy'),
    createdAt,
    updatedAt: timestamp(input.updatedAt, 'goal updatedAt', createdAt),
    revision: 1
  }
}

function goalContractInput(input: GoalInput): GoalContractInput {
  if (input.contract) return { ...input.contract, objective: input.contract.objective ?? input.objective ?? '' }
  return goalContractFallback(input) as GoalContractInput
}

function goalContractFallback(input: GoalInput): Partial<GoalContract> {
  return {
    objective: input.objective,
    background: input.background,
    constraints: input.constraints,
    successCriteria: input.successCriteria,
    budget: input.budget,
    dueAt: input.dueAt,
    riskLevel: input.riskLevel,
    forbiddenActions: input.forbiddenActions,
    acceptance: input.acceptance
  }
}

function goalPatchContract(goal: Goal, patch: GoalPatch): GoalContractInput {
  if (patch.contract) return { ...patch.contract, objective: patch.contract.objective ?? patch.objective ?? goal.objective }
  return {
    objective: patch.objective ?? goal.objective,
    background: patch.background ?? goal.background,
    constraints: patch.constraints ?? goal.constraints,
    successCriteria: patch.successCriteria ?? goal.successCriteria,
    budget: patch.budget ?? goal.budget,
    dueAt: patch.dueAt ?? goal.dueAt,
    riskLevel: patch.riskLevel ?? goal.riskLevel,
    forbiddenActions: patch.forbiddenActions ?? goal.forbiddenActions,
    acceptance: patch.acceptance ?? goal.acceptance
  }
}

function applyGoalPatch(goal: Goal, patch: GoalPatch, now: number): void {
  if (patch.title !== undefined) goal.title = requiredText(patch.title, 'goal title')
  goal.contract = normalizeContract(goalPatchContract(goal, patch), goal.contract)
  flattenContract(goal, goal.contract)
  if (patch.acceptanceResult !== undefined) goal.acceptanceResult = normalizeAcceptanceResult(patch.acceptanceResult)
  if (patch.createdBy !== undefined) goal.createdBy = optionalId(patch.createdBy, 'goal createdBy')
  goal.updatedAt = now
  goal.revision += 1
}

function propagateGoalContract(state: ProjectWorkspaceState, goal: Goal, now: number): void {
  for (const item of state.workItems) {
    if (item.goalId !== goal.id) continue
    item.inheritedGoalContract = clone(goal.contract)
    if (item.acceptanceSpec.length === 0) item.acceptanceSpec = clone(goal.contract.acceptance)
    if (goal.contract.dueAt !== undefined && item.dueAt === undefined) item.dueAt = goal.contract.dueAt
    item.updatedAt = now
    item.revision += 1
    appendEvent(state, goal.projectId, 'work_item', item.id, 'work_item.contract_inherited', item.revision, {
      goalId: goal.id,
      contractRevision: goal.revision
    }, now)
  }
}

function validateGoalTransition(state: ProjectWorkspaceState, goal: Goal, status: GoalStatus): void {
  if (!isGoalStatus(status)) throw new ProjectWorkspaceError('invalid_input', `goal status ${String(status)} is invalid`)
  if (goal.status === status) return
  if (!GOAL_TRANSITIONS[goal.status].has(status)) {
    throw new ProjectWorkspaceError('invalid_transition', `goal ${goal.id} cannot transition ${goal.status} -> ${status}`)
  }
  if (status === 'completed' && !isAcceptanceSatisfied(goal.acceptanceResult)) {
    throw new ProjectWorkspaceError('acceptance_required', `goal ${goal.id} needs passed or waived Acceptance before completion`)
  }
  if (status === 'completed') {
    const incomplete = state.workItems
      .filter((item) => item.goalId === goal.id && item.status !== 'done')
      .map((item) => ({ id: item.id, status: item.status }))
    if (incomplete.length > 0) {
      throw new ProjectWorkspaceError(
        'work_items_incomplete',
        `goal ${goal.id} cannot complete while child WorkItems are unsettled`,
        { goalId: goal.id, workItems: incomplete }
      )
    }
  }
}

function isTerminalGoal(status: GoalStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
