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
import {
  clone,
  digest,
  normalizeResources,
  optionalId,
  optionalText,
  redact,
  requiredText,
  timestamp
} from './codec'
import { ProjectWorkspaceError } from './errors'
import { appendEvent, atomicWrite, ProjectWorkspacePersistence } from './persistence'
import type { DeleteOptions, ListOptions } from './repository-types'
import { activeWorkspaceFrom, workspaceFrom } from './state-access'
import { assertProjectAuthorized, projectMutationActor } from './project-authorization'

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
      applyWorkspacePatch(workspace, patch)
      workspace.updatedAt = now
      workspace.revision += 1
      appendEvent(state, id, 'workspace', id, 'workspace.updated', workspace.revision, patch as unknown as Record<string, unknown>, now)
      return workspace
    })
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
