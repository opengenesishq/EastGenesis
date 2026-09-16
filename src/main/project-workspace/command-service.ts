import { randomUUID } from 'node:crypto'
import { newBusinessLineId } from '../business-line-ownership'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import type {
  AcceptanceResult,
  Goal,
  GoalInput,
  GoalPatch,
  GoalStatus,
  MutationOptions,
  WorkItem,
  WorkItemInput,
  WorkItemPatch,
  WorkItemReorderPlacement,
  WorkItemStatus
} from '../../shared/project-workspace-types'
import { optionalId, requiredId } from './codec'
import {
  createProjectWorkspaceLedgerShadowBoundary,
  type ProjectWorkspaceLedgerShadowBoundary
} from './ledger-shadow-write'
import type {
  ProjectWorkspaceLedgerShadowOptions,
  ProjectWorkspaceLedgerShadowReadiness
} from './ledger-shadow-types'
import {
  createProjectWorkspaceCanonicalWriteBoundary,
  type ProjectWorkspaceCanonicalWriteBoundary,
  type ProjectWorkspaceCanonicalWriteOptions,
  type ProjectWorkspaceCanonicalWriteReadiness
} from './canonical-write'
import type { ProjectWorkspaceBeforeCommit } from './persistence'
import {
  openProjectWorkspaceStore,
  type LeaseOptions
} from './store'

/**
 * Goal/WorkItem command persistence boundary. ProjectWorkspace JSON remains
 * the write source, but durable commands do not report success until the
 * Workflow Ledger shadow projection has committed as well.
 */
export interface ProjectWorkspaceCommandRepository {
  readonly rootDir?: string
  createGoal(input: GoalInput, options?: MutationOptions | number): Promise<Goal>
  updateGoal(id: string, patch: GoalPatch, options?: MutationOptions | number): Promise<Goal>
  reviseGoalRequirements?(id: string, input: import('../../shared/session-requirement-revision').SessionRequirementRevisionInput, options?: MutationOptions | number): Promise<Goal>
  setGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<Goal>
  transitionGoal(id: string, status: GoalStatus, options?: MutationOptions | number): Promise<Goal>
  archiveGoal(id: string, options?: MutationOptions | number): Promise<Goal>
  restoreGoal(id: string, options?: MutationOptions | number): Promise<Goal>
  createWorkItem(input: WorkItemInput, options?: MutationOptions | number): Promise<WorkItem>
  getWorkItem?(id: string): Promise<WorkItem | undefined>
  updateWorkItem(id: string, patch: WorkItemPatch, options?: MutationOptions | number): Promise<WorkItem>
  reorderWorkItem(id: string, targetId: string, placement: WorkItemReorderPlacement, options?: MutationOptions | number): Promise<WorkItem>
  setWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<WorkItem>
  transitionWorkItem(id: string, status: WorkItemStatus, options?: MutationOptions | number): Promise<WorkItem>
  acquireWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem>
  renewWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem>
  releaseWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem>
  withBeforeCommit?<T>(hook: ProjectWorkspaceBeforeCommit, callback: () => Promise<T>): Promise<T>
}

export interface ProjectWorkspaceCommandServiceOptions {
  rootDir?: string
  ledgerShadow?: false | ProjectWorkspaceLedgerShadowOptions
  shadowBoundary?: ProjectWorkspaceLedgerShadowBoundary
  canonicalWrite?: false | ProjectWorkspaceCanonicalWriteOptions
  canonicalBoundary?: ProjectWorkspaceCanonicalWriteBoundary
}

export class ProjectWorkspaceCommandService {
  constructor(
    private readonly repository: ProjectWorkspaceCommandRepository,
    private readonly shadowBoundary?: ProjectWorkspaceLedgerShadowBoundary,
    private readonly canonicalBoundary?: ProjectWorkspaceCanonicalWriteBoundary
  ) {}

  createGoal(input: GoalInput, options?: MutationOptions | number): Promise<Goal> {
    const id = optionalId(input.id, 'goal id') ?? randomUUID()
    const projectId = requiredId(input.projectId, 'goal projectId')
    const normalized = { ...input, id, projectId }
    return this.execute(
      { command: 'goal.create', entityType: 'goal', entityId: id, workspaceId: projectId },
      () => this.repository.createGoal(normalized, options)
    )
  }

  updateGoal(id: string, patch: GoalPatch, options?: MutationOptions | number): Promise<Goal> {
    const entityId = requiredId(id, 'goal id')
    return this.execute(
      { command: 'goal.update', entityType: 'goal', entityId },
      () => this.repository.updateGoal(entityId, patch, options)
    )
  }

  reviseGoalRequirements(id: string, input: import('../../shared/session-requirement-revision').SessionRequirementRevisionInput, options?: MutationOptions | number): Promise<Goal> {
    if (!this.repository.reviseGoalRequirements) throw new Error('Canonical requirement revision repository is unavailable')
    const entityId = requiredId(id, 'goal id')
    return this.execute({ command: 'goal.update', entityType: 'goal', entityId },
      () => this.repository.reviseGoalRequirements!(entityId, input, options))
  }

  setGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<Goal> {
    const entityId = requiredId(id, 'goal id')
    return this.execute(
      { command: 'goal.acceptance.set', entityType: 'goal', entityId },
      () => this.repository.setGoalAcceptance(entityId, result, options)
    )
  }

  transitionGoal(id: string, status: GoalStatus, options?: MutationOptions | number): Promise<Goal> {
    const entityId = requiredId(id, 'goal id')
    return this.execute(
      {
        command: 'goal.transition',
        entityType: 'goal',
        entityId,
        requiresCanonicalAcceptance: status === 'completed'
      },
      () => this.repository.transitionGoal(entityId, status, options)
    )
  }

  archiveGoal(id: string, options?: MutationOptions | number): Promise<Goal> {
    const entityId = requiredId(id, 'goal id')
    return this.execute(
      { command: 'goal.archive', entityType: 'goal', entityId },
      () => this.repository.archiveGoal(entityId, options)
    )
  }

  restoreGoal(id: string, options?: MutationOptions | number): Promise<Goal> {
    const entityId = requiredId(id, 'goal id')
    return this.execute(
      { command: 'goal.restore', entityType: 'goal', entityId },
      () => this.repository.restoreGoal(entityId, options)
    )
  }

  async createWorkItem(input: WorkItemInput, options?: MutationOptions | number): Promise<WorkItem> {
    const id = optionalId(input.id, 'work item id') ?? randomUUID()
    const projectId = requiredId(input.projectId, 'work item projectId')
    const parent = input.parentId ? await this.repository.getWorkItem?.(input.parentId) : undefined
    const businessLineId = newBusinessLineId(input.businessLineId, parent ? parent.businessLineId ?? 'studio' : undefined)
    assertActiveBusinessLine(businessLineId, this.repository.rootDir)
    const normalized = { ...input, id, projectId, businessLineId }
    return this.execute(
      { command: 'work_item.create', entityType: 'work_item', entityId: id, workspaceId: projectId },
      () => this.repository.createWorkItem(normalized, options)
    )
  }

  updateWorkItem(id: string, patch: WorkItemPatch, options?: MutationOptions | number): Promise<WorkItem> {
    const entityId = requiredId(id, 'work item id')
    return this.execute(
      { command: 'work_item.update', entityType: 'work_item', entityId },
      () => this.repository.updateWorkItem(entityId, patch, options)
    )
  }

  reorderWorkItem(
    id: string,
    targetId: string,
    placement: WorkItemReorderPlacement,
    options?: MutationOptions | number
  ): Promise<WorkItem> {
    const entityId = requiredId(id, 'work item id')
    const reorderTargetId = requiredId(targetId, 'work item reorder targetId')
    return this.execute(
      { command: 'work_item.reorder', entityType: 'work_item', entityId },
      () => this.repository.reorderWorkItem(entityId, reorderTargetId, placement, options)
    )
  }

  setWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<WorkItem> {
    const entityId = requiredId(id, 'work item id')
    return this.execute(
      { command: 'work_item.acceptance.set', entityType: 'work_item', entityId },
      () => this.repository.setWorkItemAcceptance(entityId, result, options)
    )
  }

  transitionWorkItem(id: string, status: WorkItemStatus, options?: MutationOptions | number): Promise<WorkItem> {
    const entityId = requiredId(id, 'work item id')
    return this.execute(
      {
        command: 'work_item.transition',
        entityType: 'work_item',
        entityId,
        requiresCanonicalAcceptance: status === 'done'
      },
      () => this.repository.transitionWorkItem(entityId, status, options)
    )
  }

  acquireWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    const entityId = requiredId(id, 'work item id')
    return this.execute(
      { command: 'work_item.lease.acquire', entityType: 'work_item', entityId },
      () => this.repository.acquireWorkItemLease(entityId, options)
    )
  }

  renewWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    const entityId = requiredId(id, 'work item id')
    return this.execute(
      { command: 'work_item.lease.renew', entityType: 'work_item', entityId },
      () => this.repository.renewWorkItemLease(entityId, options)
    )
  }

  releaseWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    const entityId = requiredId(id, 'work item id')
    return this.execute(
      { command: 'work_item.lease.release', entityType: 'work_item', entityId },
      () => this.repository.releaseWorkItemLease(entityId, options)
    )
  }

  async reconcileShadowProjection(): Promise<
    ProjectWorkspaceCanonicalWriteReadiness | ProjectWorkspaceLedgerShadowReadiness | undefined
  > {
    await this.shadowBoundary?.reconcile()
    return this.canonicalBoundary?.reconcile() ?? this.shadowBoundary?.readiness()
  }

  getShadowProjectionReadiness(): Promise<
    ProjectWorkspaceCanonicalWriteReadiness | ProjectWorkspaceLedgerShadowReadiness | undefined
  > {
    return this.canonicalBoundary?.readiness() ?? this.shadowBoundary?.readiness() ?? Promise.resolve(undefined)
  }

  private execute<T extends Goal | WorkItem>(
    mutation: Parameters<ProjectWorkspaceLedgerShadowBoundary['execute']>[0],
    writeSource: () => Promise<T>
  ): Promise<T> {
    if (this.canonicalBoundary && this.repository.withBeforeCommit) {
      return this.canonicalBoundary.execute(
        mutation,
        (hook) => this.repository.withBeforeCommit!(hook, writeSource)
      )
    }
    return this.shadowBoundary ? this.shadowBoundary.execute(mutation, writeSource) : writeSource()
  }
}

export function createProjectWorkspaceCommandService(
  repository: ProjectWorkspaceCommandRepository,
  options: ProjectWorkspaceCommandServiceOptions = {}
): ProjectWorkspaceCommandService {
  const rootDir = options.rootDir ?? repository.rootDir
  const legacyExplicit = Object.hasOwn(options, 'ledgerShadow') || options.shadowBoundary !== undefined
  const shadowBoundary = options.shadowBoundary ?? (
    rootDir && options.ledgerShadow !== false
      ? createProjectWorkspaceLedgerShadowBoundary(rootDir, options.ledgerShadow)
      : undefined
  )
  const canonicalBoundary = options.canonicalBoundary ?? (
    rootDir && !legacyExplicit && options.canonicalWrite !== false && repository.withBeforeCommit
      ? createProjectWorkspaceCanonicalWriteBoundary(rootDir, options.canonicalWrite || undefined)
      : undefined
  )
  return new ProjectWorkspaceCommandService(repository, shadowBoundary, canonicalBoundary)
}

export async function openProjectWorkspaceCommandService(
  rootDir?: string
): Promise<ProjectWorkspaceCommandService> {
  const service = createProjectWorkspaceCommandService(await openProjectWorkspaceStore(rootDir), { rootDir })
  await service.reconcileShadowProjection()
  return service
}
