import { randomUUID } from 'node:crypto'
import type {
  Goal,
  MutationOptions,
  ProjectWorkspace,
  ProjectWorkspaceEvent,
  ProjectWorkspaceInput,
  ProjectWorkspaceKind,
  ProjectWorkspaceManifest,
  ProjectWorkspacePatch,
  ProjectMember,
  ProjectInvitation,
  ProjectSquad,
  WorkItem,
  WorkItemComment,
  WorkItemSharedApproval,
  ProjectCollaborationInboxReceipt
} from '../../shared/project-workspace-types'
import { isProjectWorkspaceKind, PROJECT_WORKSPACE_SCHEMA_VERSION } from '../../shared/project-workspace-types'
import { DEFAULT_PROJECT_INSTITUTION_TEMPLATE, PROJECT_INSTITUTION_MIGRATION_EVENT, projectInstitutionTemplate,
  type ProjectInstitutionMigrationApplyInput, type ProjectInstitutionMigrationEventPayload,
  type ProjectInstitutionMigrationPreviewInput, type ProjectInstitutionMigrationResult,
  type ProjectInstitutionMigrationView } from '../../shared/project-institution-template'
import {
  clone,
  digest,
  normalizeResources,
  normalizeInstitutionTemplate,
  optionalId,
  optionalText,
  redact,
  requiredText,
  requiredId,
  timestamp
} from './codec'
import { ProjectWorkspaceError } from './errors'
import { appendEvent, atomicWrite, ProjectWorkspacePersistence } from './persistence'
import type { DeleteOptions, ListOptions } from './repository-types'
import { activeWorkspaceFrom, workspaceFrom } from './state-access'
import { assertProjectAuthorized, projectMutationActor } from './project-authorization'
import { buildInstitutionMigrationPreview, institutionMigrationReplay,
  normalizeInstitutionMigrationApplyInput, normalizeInstitutionMigrationPreviewInput } from './institution-migration'

export class WorkspaceRepository {
  constructor(private readonly persistence: ProjectWorkspacePersistence) {}

  async create(input: ProjectWorkspaceInput, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.persistence.mutate(options, ({ state, now }) => {
      this.persistence.assertCreateRevision(state, options)
      const id = optionalId(input.id, 'workspace id') ?? randomUUID()
      if (state.workspaces.some((item) => item.id === id)) {
        throw new ProjectWorkspaceError('already_exists', `workspace ${id} already exists`)
      }
      if (state.events.some((event) =>
        event.projectId === id && event.entityType === 'workspace' &&
        event.entityId === id && event.kind === 'workspace.purged'
      )) {
        throw new ProjectWorkspaceError(
          'purged_id_reuse_forbidden',
          `workspace ${id} was purged and its identity cannot be reused`
        )
      }
      const workspace = buildWorkspace(input, id, now)
      state.workspaces.push(workspace)
      appendEvent(state, id, 'workspace', id, 'workspace.created', 1, workspace as unknown as Record<string, unknown>, now)
      return workspace
    })
  }

  async get(id: string): Promise<ProjectWorkspace | undefined> {
    const state = await this.persistence.read()
    const item = state.workspaces.find((workspace) => workspace.id === id)
    return item ? clone(item) : undefined
  }

  async list(options: ListOptions = {}): Promise<ProjectWorkspace[]> {
    const state = await this.persistence.read()
    return state.workspaces
      .filter((workspace) => options.includeDeleted || workspace.status !== 'deleted')
      .filter((workspace) => options.includeArchived !== false || workspace.status !== 'archived')
      .map(clone)
  }

  async update(id: string, patch: ProjectWorkspacePatch, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const workspace = activeWorkspaceFrom(state, id)
      assertProjectAuthorized(state, workspace, projectMutationActor(options), 'edit', {
        allowDeleted: true
      })
      this.persistence.assertEntityRevision(workspace.revision, options, 'workspace')
      if (patch.institutionTemplate !== undefined) {
        const next = normalizeInstitutionTemplate(patch.institutionTemplate)
        const current = projectInstitutionTemplate(workspace.institutionTemplate).ref
        if (current.templateId !== next.templateId && (
          state.goals.some((goal) => goal.projectId === id) ||
          state.workItems.some((item) => item.projectId === id) ||
          state.events.some((event) => event.projectId === id && event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT)
        )) {
          throw new ProjectWorkspaceError('institution_migration_preview_only',
            '已有任务的项目必须先预览机构迁移，再显式应用到后续新目标。')
        }
      }
      applyWorkspacePatch(workspace, patch)
      workspace.updatedAt = now
      workspace.revision += 1
      appendEvent(state, id, 'workspace', id, 'workspace.updated', workspace.revision, patch as unknown as Record<string, unknown>, now)
      return workspace
    })
  }

  async previewInstitutionMigration(id: string, raw: ProjectInstitutionMigrationPreviewInput, options?: MutationOptions | number): Promise<ProjectInstitutionMigrationView> {
    const projectId = requiredId(id, 'project id'), input = normalizeInstitutionMigrationPreviewInput(raw)
    const state = await this.persistence.read(), workspace = activeWorkspaceFrom(state, projectId)
    assertProjectAuthorized(state, workspace, projectMutationActor(options), 'edit')
    this.persistence.assertEntityRevision(workspace.revision, options, 'workspace')
    return clone(buildInstitutionMigrationPreview(state, workspace, input))
  }

  async applyInstitutionMigration(id: string, raw: ProjectInstitutionMigrationApplyInput, options?: MutationOptions | number): Promise<ProjectInstitutionMigrationResult> {
    const projectId = requiredId(id, 'project id'), input = normalizeInstitutionMigrationApplyInput(raw)
    try {
      // Check optional CAS after receipt lookup so an exact replay cannot cause
      // a second mutation or fail solely because its first call already committed.
      return await this.persistence.mutate(undefined, ({ state, now }) => {
        const workspace = activeWorkspaceFrom(state, projectId)
        assertProjectAuthorized(state, workspace, projectMutationActor(options), 'edit')
        const replay = institutionMigrationReplay(state, projectId, input)
        if (replay) throw new InstitutionMigrationReplay({ workspace: clone(workspace), event: replay, replayed: true })
        this.persistence.assertGlobalRevision(state, typeof options === 'object' ? options?.expectedStoreRevision : undefined)
        this.persistence.assertEntityRevision(workspace.revision, options, 'workspace')
        this.persistence.assertEntityRevision(workspace.revision, input.expectedWorkspaceRevision, 'workspace')
        const preview = buildInstitutionMigrationPreview(state, workspace, input)
        if (preview.previewDigest !== input.previewDigest) {
          throw new ProjectWorkspaceError('institution_migration_preview_stale', '项目目标或任务已变化，请刷新机构迁移预览。')
        }
        if (!preview.canApply) throw new ProjectWorkspaceError('institution_migration_unchanged', '目标机构模板与角色映射均未变化。')
        const payload: ProjectInstitutionMigrationEventPayload = {
          schemaVersion: 1, scope: 'future_goals', fromTemplate: clone(preview.current.ref), toTemplate: clone(input.target),
          preservedGoalIds: preview.preservedGoalIds, preservedWorkItemIds: preview.preservedWorkItemIds,
          fromRoleMappings: preview.currentRoleMappings, toRoleMappings: preview.roleMappings,
          expectedWorkspaceRevision: input.expectedWorkspaceRevision, previewDigest: input.previewDigest
        }
        workspace.institutionTemplate = clone(input.target)
        workspace.updatedAt = now
        workspace.revision += 1
        appendEvent(state, projectId, 'workspace', projectId, PROJECT_INSTITUTION_MIGRATION_EVENT,
          workspace.revision, payload as unknown as Record<string, unknown>, now)
        return { workspace, event: state.events.at(-1)!, replayed: false }
      })
    } catch (error) {
      // The callback exits before the persistence layer changes any bytes or
      // revision. This also covers two identical requests waiting on the lock.
      if (error instanceof InstitutionMigrationReplay) return clone(error.result)
      throw error
    }
  }

  async archive(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const workspace = workspaceFrom(state, id)
      assertProjectAuthorized(state, workspace, projectMutationActor(options), 'edit', { allowInactive: true })
      this.persistence.assertEntityRevision(workspace.revision, options, 'workspace')
      if (workspace.status === 'deleted') throw new ProjectWorkspaceError('deleted', `workspace ${id} is deleted`)
      workspace.status = 'archived'
      workspace.archivedAt = now
      workspace.updatedAt = now
      workspace.revision += 1
      appendEvent(state, id, 'workspace', id, 'workspace.archived', workspace.revision, { status: workspace.status }, now)
      return workspace
    })
  }

  async restore(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const workspace = workspaceFrom(state, id)
      if (workspace.status === 'active') return workspace
      if (workspace.status !== 'archived' && workspace.status !== 'deleted') throw new ProjectWorkspaceError('project_inactive', `Project ${id} cannot be restored`)
      assertProjectAuthorized(state, workspace, projectMutationActor(options), 'edit', {
        allowDeleted: true,
        allowInactive: true
      })
      this.persistence.assertEntityRevision(workspace.revision, options, 'workspace')
      workspace.status = 'active'
      workspace.archivedAt = undefined
      workspace.deletedAt = undefined
      workspace.updatedAt = now
      workspace.revision += 1
      appendEvent(state, id, 'workspace', id, 'workspace.restored', workspace.revision, { status: workspace.status }, now)
      return workspace
    })
  }

  async delete(id: string, options: DeleteOptions = {}): Promise<ProjectWorkspace | undefined> {
    if (options.permanent) return this.purge(id, options)
    return this.persistence.mutate(options, ({ state, now }) => {
      const workspace = workspaceFrom(state, id)
      assertProjectAuthorized(state, workspace, projectMutationActor(options), 'edit', { allowInactive: true })
      this.persistence.assertEntityRevision(workspace.revision, options, 'workspace')
      if (workspace.status === 'deleted') return workspace
      workspace.status = 'deleted'
      workspace.deletedAt = now
      workspace.updatedAt = now
      workspace.revision += 1
      appendEvent(state, id, 'workspace', id, 'workspace.deleted', workspace.revision, { status: workspace.status }, now)
      return workspace
    })
  }

  async purge(id: string, options: MutationOptions | number = {}): Promise<undefined> {
    return this.persistence.mutate(options, ({ state, now }) => {
      const workspace = workspaceFrom(state, id)
      assertProjectAuthorized(state, workspace, projectMutationActor(options), 'edit', { allowDeleted: true })
      this.persistence.assertEntityRevision(workspace.revision, options, 'workspace')
      const purgeRevision = workspace.revision + 1
      state.goals = state.goals.filter((goal) => goal.projectId !== id)
      state.workItems = state.workItems.filter((item) => item.projectId !== id)
      state.squads = state.squads.filter((item) => item.projectId !== id)
      state.members = state.members.filter((item) => item.projectId !== id)
      state.invitations = state.invitations.filter((item) => item.projectId !== id)
      state.comments = state.comments.filter((item) => item.projectId !== id)
      state.sharedApprovals = state.sharedApprovals.filter((item) => item.projectId !== id)
      state.inboxReceipts = state.inboxReceipts.filter((item) => item.projectId !== id)
      state.events = state.events.filter((entry) => entry.projectId !== id)
      state.workspaces = state.workspaces.filter((candidate) => candidate.id !== id)
      appendEvent(state, id, 'workspace', id, 'workspace.purged', purgeRevision, { status: 'purged' }, now)
      return undefined
    })
  }

  async exportManifest(id: string, destinationPath?: string): Promise<ProjectWorkspaceManifest> {
    const state = await this.persistence.read()
    const workspace = workspaceFrom(state, id)
    const body = buildManifestBody(
      state.revision,
      workspace,
      state.goals,
      state.workItems,
      state.squads,
      state.members,
      state.invitations,
      state.comments,
      state.sharedApprovals,
      state.inboxReceipts,
      state.events
    )
    const manifest: ProjectWorkspaceManifest = { ...body, digest: digest(body) }
    if (destinationPath !== undefined) {
      if (typeof destinationPath !== 'string' || destinationPath.trim().length === 0) {
        throw new ProjectWorkspaceError('invalid_input', 'manifest destinationPath is required when supplied')
      }
      await atomicWrite(destinationPath, manifest)
    }
    return clone(manifest)
  }
}

class InstitutionMigrationReplay extends Error {
  constructor(readonly result: ProjectInstitutionMigrationResult) { super('institution migration already applied') }
}

function buildWorkspace(input: ProjectWorkspaceInput, id: string, now: number): ProjectWorkspace {
  const kind: ProjectWorkspaceKind = input.kind ?? 'personal'
  if (!isProjectWorkspaceKind(kind)) throw new ProjectWorkspaceError('invalid_input', 'workspace kind is invalid')
  const createdAt = timestamp(input.createdAt, 'workspace createdAt', now)
  return {
    schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    id,
    name: requiredText(input.name, 'workspace name'),
    kind,
    status: 'active',
    ownerId: optionalId(input.ownerId, 'workspace ownerId'),
    resources: normalizeResources(input.resources),
    rulesRef: optionalText(input.rulesRef, 'workspace rulesRef'),
    budgetPolicy: sanitizePolicy(input.budgetPolicy),
    permissionPolicy: sanitizePolicy(input.permissionPolicy),
    retentionPolicy: sanitizePolicy(input.retentionPolicy),
    institutionTemplate: normalizeInstitutionTemplate(input.institutionTemplate === undefined ? DEFAULT_PROJECT_INSTITUTION_TEMPLATE : input.institutionTemplate),
    createdAt,
    updatedAt: timestamp(input.updatedAt, 'workspace updatedAt', createdAt),
    revision: 1
  }
}

function sanitizePolicy(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value ? redact(value) as Record<string, unknown> : undefined
}

function applyWorkspacePatch(workspace: ProjectWorkspace, patch: ProjectWorkspacePatch): void {
  if (patch.name !== undefined) workspace.name = requiredText(patch.name, 'workspace name')
  if (patch.kind !== undefined) {
    if (!isProjectWorkspaceKind(patch.kind)) throw new ProjectWorkspaceError('invalid_input', 'workspace kind is invalid')
    workspace.kind = patch.kind
  }
  if (patch.ownerId !== undefined) workspace.ownerId = optionalId(patch.ownerId, 'workspace ownerId')
  if (patch.resources !== undefined) workspace.resources = normalizeResources(patch.resources)
  if (patch.rulesRef !== undefined) workspace.rulesRef = optionalText(patch.rulesRef, 'workspace rulesRef')
  if (patch.budgetPolicy !== undefined) workspace.budgetPolicy = sanitizePolicy(patch.budgetPolicy)
  if (patch.permissionPolicy !== undefined) workspace.permissionPolicy = sanitizePolicy(patch.permissionPolicy)
  if (patch.retentionPolicy !== undefined) workspace.retentionPolicy = sanitizePolicy(patch.retentionPolicy)
  if (patch.institutionTemplate !== undefined) workspace.institutionTemplate = normalizeInstitutionTemplate(patch.institutionTemplate)
}

function buildManifestBody(
  stateRevision: number,
  workspace: ProjectWorkspace,
  goals: Goal[],
  workItems: WorkItem[],
  squads: ProjectSquad[],
  members: ProjectMember[],
  invitations: ProjectInvitation[],
  comments: WorkItemComment[],
  sharedApprovals: WorkItemSharedApproval[],
  inboxReceipts: ProjectCollaborationInboxReceipt[],
  events: ProjectWorkspaceEvent[]
): Omit<ProjectWorkspaceManifest, 'digest'> {
  const projectId = workspace.id
  return {
    schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    format: 'caogen.project-workspace-manifest.v1',
    exportedAt: Date.now(),
    projectId,
    stateRevision,
    workspace: redact(workspace) as ProjectWorkspace,
    goals: redact(goals.filter((goal) => goal.projectId === projectId)) as Goal[],
    workItems: redact(workItems.filter((item) => item.projectId === projectId)) as WorkItem[],
    squads: redact(squads.filter((squad) => squad.projectId === projectId)) as ProjectSquad[],
    members: redact(members.filter((member) => member.projectId === projectId)) as ProjectMember[],
    invitations: redact(invitations.filter((invitation) => invitation.projectId === projectId)) as ProjectInvitation[],
    comments: redact(comments.filter((comment) => comment.projectId === projectId)) as WorkItemComment[],
    sharedApprovals: redact(sharedApprovals.filter((approval) => approval.projectId === projectId)) as WorkItemSharedApproval[],
    inboxReceipts: redact(inboxReceipts.filter((receipt) => receipt.projectId === projectId)) as ProjectCollaborationInboxReceipt[],
    events: redact(events.filter((entry) => entry.projectId === projectId)) as ProjectWorkspaceEvent[]
  }
}
