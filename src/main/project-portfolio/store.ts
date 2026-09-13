import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Goal,
  MutationOptions,
  ProjectWorkspaceState,
  WorkItem,
  WorkItemStatus
} from '../../shared/project-workspace-types'
import type {
  ProjectDependency,
  ProjectPortfolioDependencyHealth,
  ProjectDependencyInput,
  ProjectMilestone,
  ProjectMilestoneInput,
  ProjectMilestonePatch,
  ProjectPortfolioProjectSummary,
  ProjectPortfolioResourceLoad,
  ProjectPortfolioSnapshot,
  ProjectPortfolioState,
  ProjectPortfolioTimelineEntry,
  ProjectPortfolioStatusCounts
} from '../../shared/project-portfolio-types'
import { PROJECT_PORTFOLIO_SCHEMA_VERSION } from '../../shared/project-portfolio-types'
import { writeDurableFile } from '../durable-file'
import { canonicalJson, clone, digest, requiredId, requiredText } from '../project-workspace/codec'
import { openProjectWorkspaceStore } from '../project-workspace/store'

const FILE_NAME = 'project-portfolio.json'
const MAX_LABEL_LENGTH = 500

function emptyState(): ProjectPortfolioState {
  return { schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION, revision: 0, dependencies: [], milestones: [] }
}

function normalizeState(value: unknown): ProjectPortfolioState {
  if (!value || typeof value !== 'object') throw new Error('Project Portfolio store is invalid')
  const candidate = value as Partial<ProjectPortfolioState>
  if (candidate.schemaVersion !== PROJECT_PORTFOLIO_SCHEMA_VERSION || typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
    throw new Error('Project Portfolio store schema is unsupported')
  }
  if (!Array.isArray(candidate.dependencies) || !Array.isArray(candidate.milestones)) {
    throw new Error('Project Portfolio store collections are invalid')
  }
  return {
    schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION,
    revision: candidate.revision,
    dependencies: candidate.dependencies.map(normalizeDependency),
    milestones: candidate.milestones.map(normalizeMilestone)
  }
}

function normalizeDependency(value: unknown): ProjectDependency {
  if (!value || typeof value !== 'object') throw new Error('Project dependency is invalid')
  const item = value as Partial<ProjectDependency>
  if (item.schemaVersion !== PROJECT_PORTFOLIO_SCHEMA_VERSION || typeof item.id !== 'string' ||
      typeof item.fromProjectId !== 'string' || typeof item.toProjectId !== 'string' ||
      (item.status !== 'active' && item.status !== 'removed') ||
      typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1) {
    throw new Error('Project dependency fields are invalid')
  }
  return clone(item as ProjectDependency)
}

function normalizeMilestone(value: unknown): ProjectMilestone {
  if (!value || typeof value !== 'object') throw new Error('Project milestone is invalid')
  const item = value as Partial<ProjectMilestone>
  if (item.schemaVersion !== PROJECT_PORTFOLIO_SCHEMA_VERSION || typeof item.id !== 'string' ||
      typeof item.projectId !== 'string' || typeof item.title !== 'string' ||
      !Number.isFinite(item.dueAt) || typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
      !['planned', 'reached', 'missed', 'cancelled'].includes(item.status ?? '')) {
    throw new Error('Project milestone fields are invalid')
  }
  return clone(item as ProjectMilestone)
}

function now(): number { return Date.now() }

function assertExpected(actual: number, options: MutationOptions | undefined): void {
  if (options?.expectedStoreRevision !== undefined && options.expectedStoreRevision !== actual) {
    throw new Error(`Project Portfolio revision conflict: expected ${options.expectedStoreRevision}, got ${actual}`)
  }
}

function validDate(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a timestamp`)
  return value
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const result = value.trim()
  if (result.length > MAX_LABEL_LENGTH) throw new Error(`${label} is too long`)
  return result || undefined
}

function assertEntityRevision(actual: number, expected: number | undefined, label: string): void {
  if (expected !== undefined && expected !== actual) throw new Error(`${label} revision conflict: expected ${expected}, got ${actual}`)
}

function projectWorkItem(state: ProjectWorkspaceState, id: string | undefined, projectId: string, label: string): WorkItem | undefined {
  if (id === undefined) return undefined
  const item = state.workItems.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`${label} WorkItem ${id} was not found`)
  if (item.projectId !== projectId) throw new Error(`${label} crosses Project boundary`)
  return item
}

function projectGoal(state: ProjectWorkspaceState, id: string | undefined, projectId: string, label: string): Goal | undefined {
  if (id === undefined) return undefined
  const goal = state.goals.find((candidate) => candidate.id === id)
  if (!goal) throw new Error(`${label} Goal ${id} was not found`)
  if (goal.projectId !== projectId) throw new Error(`${label} crosses Project boundary`)
  return goal
}

function assertProject(state: ProjectWorkspaceState, projectId: string, label: string): void {
  const project = state.workspaces.find((candidate) => candidate.id === projectId)
  if (!project || project.status === 'deleted') throw new Error(`${label} Project ${projectId} is unavailable`)
}

function assertDependencyAcyclic(dependencies: readonly ProjectDependency[]): void {
  const graph = new Map<string, string[]>()
  for (const dependency of dependencies) {
    if (dependency.status !== 'active') continue
    const edges = graph.get(dependency.fromProjectId) ?? []
    edges.push(dependency.toProjectId)
    graph.set(dependency.fromProjectId, edges)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Project dependency cycle detected')
    if (visited.has(id)) return
    visiting.add(id)
    for (const next of graph.get(id) ?? []) visit(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of graph.keys()) visit(id)
}

function counts<T extends { status: string; dueAt?: number }>(items: readonly T[], at: number, completedStatuses: readonly string[]): ProjectPortfolioStatusCounts {
  let active = 0
  let blocked = 0
  let completed = 0
  let overdue = 0
  for (const item of items) {
    if (completedStatuses.includes(item.status)) completed += 1
    else active += 1
    if (item.status === 'blocked') blocked += 1
    if (item.dueAt !== undefined && item.dueAt < at && !completedStatuses.includes(item.status) && !['cancelled', 'failed'].includes(item.status)) overdue += 1
  }
  return { total: items.length, active, blocked, completed, overdue }
}

function itemProgress(status: string, completed: readonly string[]): number {
  if (completed.includes(status)) return 1
  if (status === 'verifying') return 0.85
  if (status === 'running') return 0.55
  if (status === 'ready' || status === 'planned') return 0.2
  return 0
}

function evaluateDependencyHealth(
  dependency: ProjectDependency,
  workspace: ProjectWorkspaceState
): ProjectPortfolioDependencyHealth {
  if (dependency.fromWorkItemId) {
    const upstream = workspace.workItems.find((item) => item.id === dependency.fromWorkItemId)
    if (!upstream || upstream.projectId !== dependency.fromProjectId) {
      return { dependencyId: dependency.id, state: 'blocked', sourceStatus: 'missing' }
    }
    if (upstream.status === 'done') {
      return { dependencyId: dependency.id, state: 'satisfied', sourceStatus: upstream.status }
    }
    if (upstream.status === 'failed' || upstream.status === 'cancelled') {
      return { dependencyId: dependency.id, state: 'blocked', sourceStatus: upstream.status }
    }
    return { dependencyId: dependency.id, state: 'waiting', sourceStatus: upstream.status }
  }

  const upstreamProject = workspace.workspaces.find((project) => project.id === dependency.fromProjectId)
  if (!upstreamProject || upstreamProject.status === 'deleted') {
    return { dependencyId: dependency.id, state: 'blocked', sourceStatus: 'missing' }
  }
  if (upstreamProject.status === 'archived') {
    return { dependencyId: dependency.id, state: 'satisfied', sourceStatus: 'archived' }
  }
  const upstreamWorkItems = workspace.workItems.filter((item) => item.projectId === dependency.fromProjectId)
  const upstreamGoals = workspace.goals.filter((goal) => goal.projectId === dependency.fromProjectId && goal.status !== 'archived')
  if (upstreamWorkItems.some((item) => item.status === 'failed' || item.status === 'cancelled') ||
      upstreamGoals.some((goal) => goal.status === 'failed' || goal.status === 'cancelled')) {
    return { dependencyId: dependency.id, state: 'blocked', sourceStatus: 'blocked' }
  }
  const hasDeliverables = upstreamWorkItems.length > 0 || upstreamGoals.length > 0
  const workItemsComplete = upstreamWorkItems.every((item) => item.status === 'done')
  const goalsComplete = upstreamGoals.every((goal) => goal.status === 'completed')
  if (hasDeliverables && workItemsComplete && goalsComplete) {
    return { dependencyId: dependency.id, state: 'satisfied', sourceStatus: 'completed' }
  }
  return { dependencyId: dependency.id, state: 'waiting', sourceStatus: 'active' }
}

export class ProjectPortfolioStore {
  private readonly filePath: string
  private state: ProjectPortfolioState | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly rootDir: string) {
    this.filePath = join(rootDir, FILE_NAME)
  }

  private async read(): Promise<ProjectPortfolioState> {
    if (this.state) return clone(this.state)
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') this.state = emptyState()
      else if (error instanceof SyntaxError) throw new Error(`Project Portfolio store is corrupt: ${error.message}`)
      else throw error
    }
    return clone(this.state)
  }

  private async mutate<T>(options: MutationOptions | undefined, callback: (state: ProjectPortfolioState, workspace: ProjectWorkspaceState, at: number) => T): Promise<T> {
    const previous = this.writeQueue
    let release!: () => void
    this.writeQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const state = await this.read()
      const workspace = await openProjectWorkspaceStore(this.rootDir).then((store) => store.getState())
      assertExpected(state.revision, options)
      const result = callback(state, workspace, now())
      state.revision += 1
      await writeDurableFile(this.filePath, `${canonicalJson(state)}\n`, { mode: 0o600 })
      this.state = state
      return clone(result)
    } finally {
      release()
    }
  }

  async getSnapshot(): Promise<ProjectPortfolioSnapshot> {
    const state = await this.read()
    const workspace = await openProjectWorkspaceStore(this.rootDir).then((store) => store.getState())
    const generatedAt = now()
    const projects = workspace.workspaces.filter((project) => project.status !== 'deleted')
    const activeDependencies = state.dependencies.filter((dependency) => dependency.status === 'active')
    const projectIds = new Set(projects.map((project) => project.id))
    const dependencies = activeDependencies.filter((dependency) => projectIds.has(dependency.fromProjectId) && projectIds.has(dependency.toProjectId))
    const dependencyHealth = dependencies.map((dependency) => evaluateDependencyHealth(dependency, workspace))
    const dependencyHealthById = new Map(dependencyHealth.map((item) => [item.dependencyId, item]))
    const targetWorkItemDependencies = new Map<string, ProjectPortfolioDependencyHealth[]>()
    for (const dependency of dependencies) {
      if (!dependency.toWorkItemId) continue
      const items = targetWorkItemDependencies.get(dependency.toWorkItemId) ?? []
      const health = dependencyHealthById.get(dependency.id)
      if (health) items.push(health)
      targetWorkItemDependencies.set(dependency.toWorkItemId, items)
    }
    const milestones = state.milestones.filter((milestone) => projectIds.has(milestone.projectId))
    const timeline: ProjectPortfolioTimelineEntry[] = []
    const summaries: ProjectPortfolioProjectSummary[] = []
    const ownerMap = new Map<string, ProjectPortfolioResourceLoad>()
    for (const project of projects) {
      const goals = workspace.goals.filter((goal) => goal.projectId === project.id && goal.status !== 'archived')
      const workItems = workspace.workItems.filter((item) => item.projectId === project.id)
      const projectMilestones = milestones.filter((milestone) => milestone.projectId === project.id)
      const projectDependencies = dependencies.filter((dependency) => dependency.fromProjectId === project.id || dependency.toProjectId === project.id)
      const incomingDependencyHealth = dependencies
        .filter((dependency) => dependency.toProjectId === project.id)
        .flatMap((dependency) => {
          const health = dependencyHealthById.get(dependency.id)
          return health ? [health] : []
        })
      const goalCounts = counts(goals, generatedAt, ['completed'])
      const workItemCounts = counts(workItems, generatedAt, ['done'])
      const dates = [...goals.flatMap((goal) => [goal.createdAt, goal.dueAt ?? goal.updatedAt]), ...workItems.flatMap((item) => [item.createdAt, item.dueAt ?? item.updatedAt]), ...projectMilestones.map((milestone) => milestone.dueAt)]
      const timelineStart = dates.length > 0 ? Math.min(...dates) : project.createdAt
      const timelineEnd = dates.length > 0 ? Math.max(...dates) : project.updatedAt
      const progress = workItems.length > 0 ? workItems.reduce((sum, item) => sum + itemProgress(item.status, ['done']), 0) / workItems.length : goals.length > 0 ? goals.reduce((sum, goal) => sum + itemProgress(goal.status, ['completed']), 0) / goals.length : 0
      summaries.push({ projectId: project.id, name: project.name, kind: project.kind, status: project.status, ownerId: project.ownerId, goalCounts, workItemCounts, milestoneCount: projectMilestones.length, dependencyCount: projectDependencies.length, waitingDependencyCount: incomingDependencyHealth.filter((item) => item.state === 'waiting').length, blockedDependencyCount: incomingDependencyHealth.filter((item) => item.state === 'blocked').length, timelineStart, timelineEnd, progress })
      for (const goal of goals) timeline.push(timelineEntryForGoal(goal, generatedAt))
      for (const item of workItems) {
        timeline.push(timelineEntryForWorkItem(item, generatedAt, targetWorkItemDependencies.get(item.id) ?? []))
        if (!item.owner) continue
        const key = `${item.owner.type}:${item.owner.id}`
        const load = ownerMap.get(key) ?? { ownerType: item.owner.type, ownerId: item.owner.id, displayName: item.owner.displayName, projectIds: [], activeWorkItems: 0, blockedWorkItems: 0, overdueWorkItems: 0 }
        if (!load.projectIds.includes(item.projectId)) load.projectIds.push(item.projectId)
        if (!['done', 'failed', 'cancelled'].includes(item.status)) load.activeWorkItems += 1
        if (item.status === 'blocked') load.blockedWorkItems += 1
        if (item.dueAt !== undefined && item.dueAt < generatedAt && !['done', 'failed', 'cancelled'].includes(item.status)) load.overdueWorkItems += 1
        ownerMap.set(key, load)
      }
      for (const milestone of projectMilestones) timeline.push(timelineEntryForMilestone(milestone, generatedAt))
    }
    timeline.sort((left, right) => left.startAt - right.startAt || left.id.localeCompare(right.id))
    const allDates = timeline.flatMap((entry) => [entry.startAt, entry.endAt])
    const rangeStart = allDates.length > 0 ? Math.min(...allDates) : generatedAt
    const rangeEnd = allDates.length > 0 ? Math.max(...allDates) : generatedAt
    const body = { schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION, portfolioRevision: state.revision, workspaceRevision: workspace.revision, generatedAt, rangeStart, rangeEnd, projects: summaries.sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId)), dependencies: dependencies.map(clone), dependencyHealth: dependencyHealth.sort((a, b) => a.dependencyId.localeCompare(b.dependencyId)), milestones: milestones.map(clone), timeline, resourceLoad: [...ownerMap.values()].sort((a, b) => (a.displayName ?? a.ownerId).localeCompare(b.displayName ?? b.ownerId) || a.ownerId.localeCompare(b.ownerId)) }
    return { ...body, snapshotDigest: digest(body) }
  }

  async exportProjectSlice(projectId: string): Promise<{
    dependencies: ProjectDependency[]
    milestones: ProjectMilestone[]
  }> {
    const id = requiredId(projectId, 'projectId')
    const state = await this.read()
    return {
      dependencies: state.dependencies.filter((dependency) => dependency.status === 'active' &&
        (dependency.fromProjectId === id || dependency.toProjectId === id)).map(clone),
      milestones: state.milestones.filter((milestone) => milestone.projectId === id).map(clone)
    }
  }

  purgeProject(projectId: string): Promise<{ dependencies: number; milestones: number }> {
    const id = requiredId(projectId, 'projectId')
    return this.mutate(undefined, (state) => {
      const dependencyCount = state.dependencies.filter((dependency) =>
        dependency.fromProjectId === id || dependency.toProjectId === id).length
      const milestoneCount = state.milestones.filter((milestone) => milestone.projectId === id).length
      state.dependencies = state.dependencies.filter((dependency) =>
        dependency.fromProjectId !== id && dependency.toProjectId !== id)
      state.milestones = state.milestones.filter((milestone) => milestone.projectId !== id)
      return { dependencies: dependencyCount, milestones: milestoneCount }
    })
  }

  async countProject(projectId: string): Promise<{ dependencies: number; milestones: number }> {
    const slice = await this.exportProjectSlice(projectId)
    return { dependencies: slice.dependencies.length, milestones: slice.milestones.length }
  }

  importProjectSlice(input: { dependencies: readonly ProjectDependency[]; milestones: readonly ProjectMilestone[] }): Promise<void> {
    return this.mutate(undefined, (state) => {
      for (const incoming of input.dependencies) {
        const existing = state.dependencies.find((candidate) => candidate.id === incoming.id)
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(incoming)) throw new Error(`Project Portfolio dependency identity conflict: ${incoming.id}`)
          continue
        }
        state.dependencies.push(normalizeDependency(incoming))
      }
      for (const incoming of input.milestones) {
        const existing = state.milestones.find((candidate) => candidate.id === incoming.id)
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(incoming)) throw new Error(`Project Portfolio milestone identity conflict: ${incoming.id}`)
          continue
        }
        state.milestones.push(normalizeMilestone(incoming))
      }
      assertDependencyAcyclic(state.dependencies)
    }).then(() => undefined)
  }

  createDependency(input: ProjectDependencyInput, options?: MutationOptions): Promise<ProjectDependency> {
    return this.mutate(options, (state, workspace, at) => {
      const fromProjectId = requiredId(input.fromProjectId, 'fromProjectId')
      const toProjectId = requiredId(input.toProjectId, 'toProjectId')
      if (fromProjectId === toProjectId) throw new Error('Project cannot depend on itself')
      assertProject(workspace, fromProjectId, 'from')
      assertProject(workspace, toProjectId, 'to')
      projectWorkItem(workspace, input.fromWorkItemId, fromProjectId, 'from')
      projectWorkItem(workspace, input.toWorkItemId, toProjectId, 'to')
      const existing = state.dependencies.find((dependency) => dependency.fromProjectId === fromProjectId && dependency.toProjectId === toProjectId && dependency.fromWorkItemId === input.fromWorkItemId && dependency.toWorkItemId === input.toWorkItemId)
      if (existing?.status === 'active') return existing
      const dependency: ProjectDependency = { schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION, id: optionalText(input.id, 'dependency id') ?? randomUUID(), fromProjectId, toProjectId, ...(input.fromWorkItemId ? { fromWorkItemId: requiredId(input.fromWorkItemId, 'fromWorkItemId') } : {}), ...(input.toWorkItemId ? { toWorkItemId: requiredId(input.toWorkItemId, 'toWorkItemId') } : {}), ...(optionalText(input.label, 'dependency label') ? { label: optionalText(input.label, 'dependency label') } : {}), status: 'active', createdAt: at, updatedAt: at, revision: 1 }
      if (state.dependencies.some((candidate) => candidate.id === dependency.id)) throw new Error(`Project dependency ${dependency.id} already exists`)
      state.dependencies.push(dependency)
      assertDependencyAcyclic(state.dependencies)
      return dependency
    })
  }

  removeDependency(id: string, options?: MutationOptions): Promise<ProjectDependency> {
    return this.mutate(options, (state, _workspace, at) => {
      const dependency = state.dependencies.find((candidate) => candidate.id === requiredId(id, 'dependency id'))
      if (!dependency) throw new Error(`Project dependency ${id} was not found`)
      assertEntityRevision(dependency.revision, options?.expectedRevision, 'Project dependency')
      if (dependency.status === 'removed') return dependency
      dependency.status = 'removed'; dependency.removedAt = at; dependency.updatedAt = at; dependency.revision += 1
      return dependency
    })
  }

  createMilestone(input: ProjectMilestoneInput, options?: MutationOptions): Promise<ProjectMilestone> {
    return this.mutate(options, (state, workspace, at) => {
      const projectId = requiredId(input.projectId, 'milestone projectId')
      assertProject(workspace, projectId, 'milestone')
      projectGoal(workspace, input.goalId, projectId, 'milestone')
      projectWorkItem(workspace, input.workItemId, projectId, 'milestone')
      const milestone: ProjectMilestone = { schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION, id: optionalText(input.id, 'milestone id') ?? randomUUID(), projectId, ...(input.goalId ? { goalId: requiredId(input.goalId, 'milestone goalId') } : {}), ...(input.workItemId ? { workItemId: requiredId(input.workItemId, 'milestone workItemId') } : {}), title: requiredText(input.title, 'milestone title'), dueAt: validDate(input.dueAt, 'milestone dueAt'), status: 'planned', createdAt: at, updatedAt: at, revision: 1 }
      if (state.milestones.some((candidate) => candidate.id === milestone.id)) throw new Error(`Project milestone ${milestone.id} already exists`)
      state.milestones.push(milestone)
      return milestone
    })
  }

  updateMilestone(id: string, patch: ProjectMilestonePatch, options?: MutationOptions): Promise<ProjectMilestone> {
    return this.mutate(options, (state, _workspace, at) => {
      const milestone = state.milestones.find((candidate) => candidate.id === requiredId(id, 'milestone id'))
      if (!milestone) throw new Error(`Project milestone ${id} was not found`)
      assertEntityRevision(milestone.revision, options?.expectedRevision, 'Project milestone')
      if (patch.title !== undefined) milestone.title = requiredText(patch.title, 'milestone title')
      if (patch.dueAt !== undefined) milestone.dueAt = validDate(patch.dueAt, 'milestone dueAt')
      if (patch.status !== undefined) {
        if (!['planned', 'reached', 'missed', 'cancelled'].includes(patch.status)) throw new Error('milestone status is invalid')
        milestone.status = patch.status
      }
      milestone.updatedAt = at; milestone.revision += 1
      return milestone
    })
  }

  deleteMilestone(id: string, options?: MutationOptions): Promise<boolean> {
    return this.mutate(options, (state, _workspace, _at) => {
      const index = state.milestones.findIndex((candidate) => candidate.id === requiredId(id, 'milestone id'))
      if (index < 0) return false
      assertEntityRevision(state.milestones[index].revision, options?.expectedRevision, 'Project milestone')
      state.milestones.splice(index, 1)
      return true
    })
  }
}

function timelineEntryForGoal(goal: Goal, at: number): ProjectPortfolioTimelineEntry {
  const endAt = goal.dueAt ?? goal.updatedAt
  return { id: goal.id, kind: 'goal', projectId: goal.projectId, title: goal.title, status: goal.status, startAt: goal.createdAt, endAt, dueAt: goal.dueAt, progress: itemProgress(goal.status, ['completed']), overdue: Boolean(goal.dueAt && goal.dueAt < at && !['completed', 'archived', 'cancelled'].includes(goal.status)), dependencyIds: [], crossProjectDependencyIds: [], waitingOnCrossProjectDependencyIds: [], blockedByCrossProjectDependencyIds: [] }
}

function timelineEntryForWorkItem(
  item: WorkItem,
  at: number,
  crossProjectDependencies: readonly ProjectPortfolioDependencyHealth[]
): ProjectPortfolioTimelineEntry {
  const endAt = item.dueAt ?? item.updatedAt
  return { id: item.id, kind: 'work_item', projectId: item.projectId, title: item.title, status: item.status, startAt: item.createdAt, endAt, dueAt: item.dueAt, progress: itemProgress(item.status, ['done']), overdue: Boolean(item.dueAt && item.dueAt < at && !['done', 'failed', 'cancelled'].includes(item.status)), dependencyIds: [...item.dependencyIds], crossProjectDependencyIds: crossProjectDependencies.map((dependency) => dependency.dependencyId), waitingOnCrossProjectDependencyIds: crossProjectDependencies.filter((dependency) => dependency.state === 'waiting').map((dependency) => dependency.dependencyId), blockedByCrossProjectDependencyIds: crossProjectDependencies.filter((dependency) => dependency.state === 'blocked').map((dependency) => dependency.dependencyId) }
}

function timelineEntryForMilestone(milestone: ProjectMilestone, at: number): ProjectPortfolioTimelineEntry {
  return { id: milestone.id, kind: 'milestone', projectId: milestone.projectId, title: milestone.title, status: milestone.status, startAt: milestone.createdAt, endAt: milestone.dueAt, dueAt: milestone.dueAt, progress: milestone.status === 'reached' ? 1 : 0, overdue: milestone.dueAt < at && milestone.status === 'planned', dependencyIds: [], crossProjectDependencyIds: [], waitingOnCrossProjectDependencyIds: [], blockedByCrossProjectDependencyIds: [] }
}

const stores = new Map<string, ProjectPortfolioStore>()

export function getProjectPortfolioStore(rootDir: string): ProjectPortfolioStore {
  const existing = stores.get(rootDir)
  if (existing) return existing
  const store = new ProjectPortfolioStore(rootDir)
  stores.set(rootDir, store)
  return store
}
