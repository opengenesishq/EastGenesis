import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  AcceptanceSpec,
  Goal,
  GoalInput,
  MutationOptions,
  ProjectWorkspaceTemplateApplyInput,
  ProjectWorkspaceTemplateApplyResult,
  ProjectWorkspaceTemplateDefinition,
  ProjectWorkspace,
  ProjectWorkspaceInput,
  WorkItem,
  WorkItemInput
} from '../../shared/project-workspace-types'
import { projectWorkspaceTemplate } from '../../shared/project-workspace-templates'
import { openProjectWorkspaceCommandService } from './command-service'
import { openProjectWorkspaceStore } from './store'

export async function createProjectWorkspaceWithTemplate(
  rootDir: string,
  input: ProjectWorkspaceInput,
  options?: MutationOptions
): Promise<ProjectWorkspace> {
  const store = await openProjectWorkspaceStore(rootDir)
  const created = await store.createWorkspace(input, options)
  await applyProjectWorkspaceTemplate(rootDir, {
    requestId: `project-create-template:${created.id}`,
    projectId: created.id,
    templateId: created.kind
  })
  return created
}

export async function applyProjectWorkspaceTemplate(
  rootDir: string,
  input: ProjectWorkspaceTemplateApplyInput
): Promise<ProjectWorkspaceTemplateApplyResult> {
  const requestId = requiredText(input.requestId, 'requestId')
  const projectId = requiredText(input.projectId, 'projectId')
  const template = projectWorkspaceTemplate(input.templateId)
  const store = await openProjectWorkspaceStore(rootDir)
  const workspace = await store.getWorkspace(projectId)
  if (!workspace) throw new Error(`ProjectWorkspace not found: ${projectId}`)
  if (workspace.status !== 'active') throw new Error(`ProjectWorkspace is not active: ${projectId}`)
  if (workspace.kind !== template.id) {
    throw new Error(`Project template ${template.id} does not match Project kind ${workspace.kind}`)
  }

  const commands = await openProjectWorkspaceCommandService(rootDir)
  const goalInput = templateGoalInput(projectId, template)
  const goal = await ensureGoal(store, commands, goalInput, template)
  const workItems: WorkItem[] = []
  const ids = new Map(template.workItems.map((preset) => [preset.key, templateWorkItemId(projectId, template.id, preset.key)]))
  for (const preset of template.workItems) {
    const workItemInput = templateWorkItemInput(projectId, goal.id, template, preset, ids)
    workItems.push(await ensureWorkItem(store, commands, workItemInput))
  }
  return {
    requestId,
    projectId,
    templateId: template.id,
    templateDigest: digest(template),
    goal,
    workItems,
    resourceSuggestions: structuredClone(template.resourceSuggestions)
  }
}

function templateGoalInput(projectId: string, template: ProjectWorkspaceTemplateDefinition): GoalInput {
  return {
    id: templateGoalId(projectId, template.id),
    projectId,
    title: template.goal.title,
    objective: template.goal.objective,
    constraints: template.goal.constraints,
    successCriteria: template.goal.successCriteria,
    forbiddenActions: template.goal.forbiddenActions,
    riskLevel: template.goal.riskLevel,
    acceptance: acceptanceSpecs(`template-${template.id}-goal`, template.goal.acceptance),
    status: 'planned',
    createdBy: `project-template:${template.id}`
  }
}

function templateWorkItemInput(
  projectId: string,
  goalId: string,
  template: ProjectWorkspaceTemplateDefinition,
  preset: ProjectWorkspaceTemplateDefinition['workItems'][number],
  ids: ReadonlyMap<string, string>
): WorkItemInput {
  const dependencyIds = preset.dependencyKeys.map((key) => {
    const id = ids.get(key)
    if (!id) throw new Error(`Project template dependency is unknown: ${template.id}:${key}`)
    return id
  })
  return {
    id: ids.get(preset.key),
    projectId,
    goalId,
    type: preset.type,
    title: preset.title,
    description: [
      preset.description,
      `Expected Artifacts: ${preset.expectedArtifactKinds.join(', ')}`
    ].join('\n\n'),
    dependencyIds,
    status: 'backlog',
    acceptanceSpec: acceptanceSpecs(`template-${template.id}-${preset.key}`, preset.acceptance)
  }
}

async function ensureGoal(
  store: Awaited<ReturnType<typeof openProjectWorkspaceStore>>,
  commands: Awaited<ReturnType<typeof openProjectWorkspaceCommandService>>,
  input: GoalInput,
  template: ProjectWorkspaceTemplateDefinition
): Promise<Goal> {
  const existing = await store.getGoal(input.id!)
  const goal = existing ?? await commands.createGoal(input)
  const expectedAcceptance = input.acceptance ?? []
  if (goal.projectId !== input.projectId || goal.title !== input.title || goal.objective !== input.objective ||
      goal.createdBy !== input.createdBy || goal.riskLevel !== input.riskLevel ||
      !isDeepStrictEqual(goal.constraints, input.constraints) ||
      !isDeepStrictEqual(goal.successCriteria, input.successCriteria) ||
      !isDeepStrictEqual(goal.forbiddenActions, input.forbiddenActions) ||
      !isDeepStrictEqual(goal.acceptance, expectedAcceptance)) {
    throw new Error(`Project template Goal identity conflict: ${template.id}:${goal.id}`)
  }
  return goal
}

async function ensureWorkItem(
  store: Awaited<ReturnType<typeof openProjectWorkspaceStore>>,
  commands: Awaited<ReturnType<typeof openProjectWorkspaceCommandService>>,
  input: WorkItemInput
): Promise<WorkItem> {
  const existing = await store.getWorkItem(input.id!)
  const item = existing ?? await commands.createWorkItem(input)
  if (item.projectId !== input.projectId || item.goalId !== input.goalId || item.type !== input.type ||
      item.title !== input.title || item.description !== input.description ||
      !isDeepStrictEqual(item.dependencyIds, input.dependencyIds ?? []) ||
      !isDeepStrictEqual(item.acceptanceSpec, input.acceptanceSpec ?? [])) {
    throw new Error(`Project template WorkItem identity conflict: ${item.id}`)
  }
  return item
}

function acceptanceSpecs(prefix: string, criteria: readonly string[]): AcceptanceSpec[] {
  return criteria.map((criterion, index) => ({
    id: `${prefix}-acceptance-${index + 1}`,
    criterion,
    required: true
  }))
}

function templateGoalId(projectId: string, templateId: string): string {
  return `project-template-goal-${shortDigest(projectId, templateId)}`
}

function templateWorkItemId(projectId: string, templateId: string, key: string): string {
  return `project-template-work-${shortDigest(projectId, templateId, key)}`
}

function shortDigest(...parts: string[]): string {
  return createHash('sha256').update(['caogen.project-template.v1', ...parts].join('\0')).digest('hex').slice(0, 24)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 2048) throw new Error(`${field} is invalid`)
  return normalized
}
