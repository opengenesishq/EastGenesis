import type {
  AcceptanceResult,
  Goal,
  GoalContract,
  GoalInput,
  GoalPatch,
  GoalStatus,
  MutationOptions,
  ProjectMember,
  ProjectMemberInput,
  ProjectMemberPatch,
  ProjectInvitation,
  ProjectInvitationCreateResult,
  ProjectInvitationInput,
  ProjectSquad,
  ProjectSquadInput,
  ProjectSquadMemberInput,
  ProjectSquadPatch,
  ProjectWorkspace,
  ProjectWorkspaceInput,
  ProjectWorkspaceManifest,
  ProjectWorkspacePatch,
  ProjectWorkspaceState,
  ProjectCollaborationInboxItem,
  ProjectCollaborationInboxListOptions,
  ProjectCollaborationInboxMarkInput,
  ProjectCollaborationInboxReceipt,
  WorkItem,
  WorkItemComment,
  WorkItemCommentInput,
  WorkItemCommentPatch,
  WorkItemActor,
  WorkItemSharedApproval,
  WorkItemSharedApprovalDecisionInput,
  WorkItemSharedApprovalInput,
  WorkItemInput,
  WorkItemOwnerType,
  WorkItemPatch,
  WorkItemReorderPlacement,
  WorkItemStatus
} from '../../shared/project-workspace-types'
import { GoalRepository } from './goal-repository'
import {
  ProjectWorkspacePersistence,
  resolveProjectWorkspaceRoot
} from './persistence'
import type { ProjectWorkspaceBeforeCommit } from './persistence'
import type { DeleteOptions, LeaseOptions, ListOptions } from './repository-types'
import { WorkItemRepository } from './work-item-repository'
import { WorkspaceRepository } from './workspace-repository'
import { canonicalJson as canonicalProjectJson, normalizeInstitutionTemplate } from './codec'
import { ProjectCollaborationRepository } from './collaboration-repository'
import type { ProjectInstitutionMigrationApplyInput, ProjectInstitutionMigrationPreviewInput,
  ProjectInstitutionMigrationResult, ProjectInstitutionMigrationView } from '../../shared/project-institution-template'
import { assertInstitutionMigrationEvents } from './institution-migration'

export { canonicalJson } from './codec'
export { ProjectWorkspaceError } from './errors'
export {
  PROJECT_WORKSPACE_FORMAT,
  projectWorkspaceFile,
  projectWorkspaceLockFile
} from './persistence'
export type { DeleteOptions, LeaseOptions, ListOptions } from './repository-types'

export class ProjectWorkspaceStore {
  readonly rootDir: string
  readonly filePath: string
  private readonly persistence: ProjectWorkspacePersistence
  private readonly workspaces: WorkspaceRepository
  private readonly goals: GoalRepository
  private readonly workItems: WorkItemRepository
  private readonly collaboration: ProjectCollaborationRepository

  constructor(rootDir?: string) {
    this.persistence = new ProjectWorkspacePersistence(rootDir)
    this.rootDir = this.persistence.rootDir
    this.filePath = this.persistence.filePath
    this.workspaces = new WorkspaceRepository(this.persistence)
    this.goals = new GoalRepository(this.persistence)
    this.workItems = new WorkItemRepository(this.persistence)
    this.collaboration = new ProjectCollaborationRepository(this.persistence)
  }

  async open(): Promise<this> {
    await this.persistence.open()
    return this
  }

  getState(): Promise<ProjectWorkspaceState> {
    return this.persistence.read()
  }

  getRevision(): Promise<number> {
    return this.persistence.revision()
  }

  /**
   * Merge one already-verified Project aggregate without replaying user-facing
   * mutations. Import owns the original entity revisions and audit identities;
   * the containing store still advances exactly once.
   */
  importProjectSlice(input: {
    workspace: ProjectWorkspace
    goals: Goal[]
    workItems: WorkItem[]
    squads: ProjectSquad[]
    members: ProjectMember[]
    invitations: ProjectInvitation[]
    comments: WorkItemComment[]
    sharedApprovals: WorkItemSharedApproval[]
    inboxReceipts: ProjectCollaborationInboxReceipt[]
    events: ProjectWorkspaceState['events']
  }): Promise<{ revision: number; projectId: string }> {
    return this.persistence.read().then((current) => {
      // Import keeps missing legacy refs missing, and rejects unknown versions
      // before they could make the whole workspace store unreadable.
      if (input.workspace.institutionTemplate !== undefined) normalizeInstitutionTemplate(input.workspace.institutionTemplate)
      assertInstitutionMigrationEvents([input.workspace], input.events)
      const projectId = input.workspace.id
      const existingSlice = projectWorkspaceImportSlice(current, projectId)
      if (existingSlice.workspace) {
        if (canonicalProjectJson(existingSlice) === canonicalProjectJson({
          workspace: input.workspace,
          goals: input.goals,
          workItems: input.workItems,
          squads: input.squads,
          members: input.members,
          invitations: input.invitations,
          comments: input.comments,
          sharedApprovals: input.sharedApprovals,
          inboxReceipts: input.inboxReceipts,
          events: input.events
        })) return { revision: current.revision, projectId }
        throw new Error(`Project import identity conflict: ${projectId}`)
      }
      if (existingSlice.events.some((event) => !isImportablePurgeTombstone(event, projectId))) {
        throw new Error(`Project import found non-restorable orphan events: ${projectId}`)
      }
      const collisions = [
        ...sameKindConflicts(current.goals, input.goals),
        ...sameKindConflicts(current.workItems, input.workItems),
        ...sameKindConflicts(current.squads, input.squads),
        ...sameKindConflicts(current.members, input.members),
        ...sameKindConflicts(current.invitations, input.invitations),
        ...sameKindConflicts(current.comments, input.comments),
        ...sameKindConflicts(current.sharedApprovals, input.sharedApprovals),
        ...sameKindConflicts(current.inboxReceipts, input.inboxReceipts),
        ...sameKindConflicts(current.events, input.events)
      ]
      if (collisions.length > 0) {
        throw new Error(`Project import identity conflict: ${[...new Set(collisions)].sort().join(', ')}`)
      }
      return this.persistence.mutate({ expectedStoreRevision: current.revision }, ({ state, commitRevision }) => {
        state.events = state.events.filter((event) => !isImportablePurgeTombstone(event, projectId))
        state.workspaces.push(structuredClone(input.workspace))
        state.goals.push(...structuredClone(input.goals))
        state.workItems.push(...structuredClone(input.workItems))
        state.squads.push(...structuredClone(input.squads))
        state.members.push(...structuredClone(input.members))
        state.invitations.push(...structuredClone(input.invitations))
        state.comments.push(...structuredClone(input.comments))
        state.sharedApprovals.push(...structuredClone(input.sharedApprovals))
        state.inboxReceipts.push(...structuredClone(input.inboxReceipts))
        state.events.push(...structuredClone(input.events))
        return { revision: commitRevision, projectId }
      })
    })
  }

  createWorkspace(input: ProjectWorkspaceInput, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.create(input, options)
  }

  getWorkspace(id: string): Promise<ProjectWorkspace | undefined> {
    return this.workspaces.get(id)
  }

  listWorkspaces(options?: ListOptions): Promise<ProjectWorkspace[]> {
    return this.workspaces.list(options)
  }

  updateWorkspace(id: string, patch: ProjectWorkspacePatch, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.update(id, patch, options)
  }

  previewInstitutionMigration(id: string, input: ProjectInstitutionMigrationPreviewInput, options?: MutationOptions | number): Promise<ProjectInstitutionMigrationView> {
    return this.workspaces.previewInstitutionMigration(id, input, options)
  }

  applyInstitutionMigration(id: string, input: ProjectInstitutionMigrationApplyInput, options?: MutationOptions | number): Promise<ProjectInstitutionMigrationResult> {
    return this.workspaces.applyInstitutionMigration(id, input, options)
  }

  archiveWorkspace(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.archive(id, options)
  }

  restoreWorkspace(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.restore(id, options)
  }

  deleteWorkspace(id: string, options?: DeleteOptions): Promise<ProjectWorkspace | undefined> {
    return this.workspaces.delete(id, options)
  }

  purgeWorkspace(id: string, options?: MutationOptions | number): Promise<undefined> {
    return this.workspaces.purge(id, options)
  }

  reopenWorkspace(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.restore(id, options)
  }

  exportManifest(id: string, destinationPath?: string): Promise<ProjectWorkspaceManifest> {
    return this.workspaces.exportManifest(id, destinationPath)
  }

  exportWorkspaceManifest(id: string, destinationPath?: string): Promise<ProjectWorkspaceManifest> {
    return this.workspaces.exportManifest(id, destinationPath)
  }

  createGoal(input: GoalInput, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.create(input, options)
  }

  getGoal(id: string): Promise<Goal | undefined> {
    return this.goals.get(id)
  }

  listGoals(projectId?: string, options?: ListOptions): Promise<Goal[]> {
    return this.goals.list(projectId, options)
  }

  reviseGoalRequirements(id: string, input: import('../../shared/session-requirement-revision').SessionRequirementRevisionInput, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.reviseRequirements(id, input, options)
  }

  updateGoal(id: string, patch: GoalPatch, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.update(id, patch, options)
  }

  setGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.setAcceptance(id, result, options)
  }

  recordGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.setAcceptance(id, result, options)
  }

  transitionGoal(id: string, status: GoalStatus, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.transition(id, status, options)
  }

  archiveGoal(id: string, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.archive(id, options)
  }

  restoreGoal(id: string, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.restore(id, options)
  }

  createWorkItem(input: WorkItemInput, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.create(input, options)
  }

  getWorkItem(id: string): Promise<WorkItem | undefined> {
    return this.workItems.get(id)
  }

  listWorkItems(projectId?: string, options?: ListOptions): Promise<WorkItem[]> {
    return this.workItems.list(projectId, options)
  }

  updateWorkItem(id: string, patch: WorkItemPatch, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.update(id, patch, options)
  }

  reorderWorkItem(
    id: string,
    targetId: string,
    placement: WorkItemReorderPlacement,
    options?: MutationOptions | number
  ): Promise<WorkItem> {
    return this.workItems.reorder(id, targetId, placement, options)
  }

  setWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.setAcceptance(id, result, options)
  }

  recordWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.setAcceptance(id, result, options)
  }

  transitionWorkItem(id: string, status: WorkItemStatus, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.transition(id, status, options)
  }

  acquireWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    return this.workItems.acquireLease(id, options)
  }

  renewWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    return this.workItems.renewLease(id, options)
  }

  releaseWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    return this.workItems.releaseLease(id, options)
  }

  getEffectiveWorkItemContract(id: string): Promise<GoalContract | undefined> {
    return this.workItems.effectiveContract(id)
  }

  listSquads(projectId?: string, options?: ListOptions): Promise<ProjectSquad[]> {
    return this.collaboration.listSquads(projectId, options)
  }

  getSquad(id: string): Promise<ProjectSquad | undefined> {
    return this.collaboration.getSquad(id)
  }

  createSquad(input: ProjectSquadInput, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.collaboration.createSquad(input, options)
  }

  updateSquad(id: string, patch: ProjectSquadPatch, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.collaboration.updateSquad(id, patch, options)
  }

  archiveSquad(id: string, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.collaboration.archiveSquad(id, options)
  }

  restoreSquad(id: string, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.collaboration.restoreSquad(id, options)
  }

  addSquadMember(id: string, member: ProjectSquadMemberInput, options?: MutationOptions | number): Promise<ProjectSquad> {
    return this.collaboration.addSquadMember(id, member, options)
  }

  removeSquadMember(
    id: string,
    memberType: WorkItemOwnerType,
    memberId: string,
    options?: MutationOptions | number
  ): Promise<ProjectSquad> {
    return this.collaboration.removeSquadMember(id, memberType, memberId, options)
  }

  listMembers(projectId?: string, options?: ListOptions): Promise<ProjectMember[]> {
    return this.collaboration.listMembers(projectId, options)
  }

  getMember(id: string): Promise<ProjectMember | undefined> {
    return this.collaboration.getMember(id)
  }

  createMember(input: ProjectMemberInput, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.collaboration.createMember(input, options)
  }

  updateMember(id: string, patch: ProjectMemberPatch, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.collaboration.updateMember(id, patch, options)
  }

  revokeMember(id: string, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.collaboration.revokeMember(id, options)
  }

  restoreMember(id: string, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.collaboration.restoreMember(id, options)
  }

  listInvitations(projectId?: string, options?: ListOptions): Promise<ProjectInvitation[]> {
    return this.collaboration.listInvitations(projectId, options)
  }

  createInvitation(input: ProjectInvitationInput, options?: MutationOptions | number): Promise<ProjectInvitationCreateResult> {
    return this.collaboration.createInvitation(input, options)
  }

  acceptInvitation(projectId: string, token: string, options?: MutationOptions | number): Promise<ProjectMember> {
    return this.collaboration.acceptInvitation(projectId, token, options)
  }

  revokeInvitation(id: string, options?: MutationOptions | number): Promise<ProjectInvitation> {
    return this.collaboration.revokeInvitation(id, options)
  }

  listWorkItemComments(workItemId: string, options?: ListOptions): Promise<WorkItemComment[]> {
    return this.collaboration.listComments(workItemId, options)
  }

  listProjectComments(projectId?: string, options?: ListOptions): Promise<WorkItemComment[]> {
    return this.collaboration.listProjectComments(projectId, options)
  }

  getWorkItemComment(id: string): Promise<WorkItemComment | undefined> {
    return this.collaboration.getComment(id)
  }

  createWorkItemComment(input: WorkItemCommentInput, options?: MutationOptions | number): Promise<WorkItemComment> {
    return this.collaboration.createComment(input, options)
  }

  updateWorkItemComment(
    id: string,
    patch: WorkItemCommentPatch,
    options?: MutationOptions | number
  ): Promise<WorkItemComment> {
    return this.collaboration.updateComment(id, patch, options)
  }

  deleteWorkItemComment(id: string, options?: MutationOptions | number): Promise<WorkItemComment> {
    return this.collaboration.deleteComment(id, options)
  }

  listSharedApprovals(projectId?: string, options?: ListOptions): Promise<WorkItemSharedApproval[]> {
    return this.collaboration.listSharedApprovals(projectId, options)
  }

  getSharedApproval(id: string): Promise<WorkItemSharedApproval | undefined> {
    return this.collaboration.getSharedApproval(id)
  }

  createSharedApproval(
    input: WorkItemSharedApprovalInput,
    requester: WorkItemActor,
    options?: MutationOptions | number
  ): Promise<WorkItemSharedApproval> {
    return this.collaboration.createSharedApproval(input, requester, options)
  }

  decideSharedApproval(
    id: string,
    input: WorkItemSharedApprovalDecisionInput,
    options?: MutationOptions | number
  ): Promise<WorkItemSharedApproval> {
    return this.collaboration.decideSharedApproval(id, input, options)
  }

  revokeSharedApproval(id: string, options?: MutationOptions | number): Promise<WorkItemSharedApproval> {
    return this.collaboration.revokeSharedApproval(id, options)
  }

  listCollaborationInbox(
    projectId: string,
    options?: ProjectCollaborationInboxListOptions
  ): Promise<ProjectCollaborationInboxItem[]> {
    return this.collaboration.listCollaborationInbox(projectId, options)
  }

  markCollaborationInbox(
    input: ProjectCollaborationInboxMarkInput,
    options?: MutationOptions | number
  ): Promise<ProjectCollaborationInboxReceipt> {
    return this.collaboration.markCollaborationInbox(input, options)
  }

  withBeforeCommit<T>(hook: ProjectWorkspaceBeforeCommit, callback: () => Promise<T>): Promise<T> {
    return this.persistence.withBeforeCommit(hook, callback)
  }
}

function projectWorkspaceImportSlice(state: ProjectWorkspaceState, projectId: string) {
  return {
    workspace: state.workspaces.find((item) => item.id === projectId),
    goals: state.goals.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    workItems: state.workItems.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    squads: state.squads.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    members: state.members.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    invitations: state.invitations.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    comments: state.comments.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    sharedApprovals: state.sharedApprovals.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    inboxReceipts: state.inboxReceipts.filter((item) => item.projectId === projectId).sort((left, right) => left.id.localeCompare(right.id)),
    events: state.events.filter((item) => item.projectId === projectId).sort((left, right) =>
      left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
  }
}

function isImportablePurgeTombstone(
  event: ProjectWorkspaceState['events'][number],
  projectId: string
): boolean {
  return event.projectId === projectId &&
    event.entityType === 'workspace' &&
    event.entityId === projectId &&
    event.kind === 'workspace.purged' &&
    event.payload?.status === 'purged'
}

function sameKindConflicts<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): string[] {
  const ids = new Set(existing.map((item) => item.id))
  return incoming.filter((item) => ids.has(item.id)).map((item) => item.id)
}

const stores = new Map<string, ProjectWorkspaceStore>()

export function getProjectWorkspaceStore(rootDir?: string): ProjectWorkspaceStore {
  const normalizedRoot = resolveProjectWorkspaceRoot(rootDir)
  const existing = stores.get(normalizedRoot)
  if (existing) return existing
  const store = new ProjectWorkspaceStore(normalizedRoot)
  stores.set(normalizedRoot, store)
  return store
}

export async function openProjectWorkspaceStore(rootDir?: string): Promise<ProjectWorkspaceStore> {
  return getProjectWorkspaceStore(rootDir).open()
}

export async function createProjectWorkspace(
  input: ProjectWorkspaceInput,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).createWorkspace(input, options)
}

export async function getProjectWorkspace(id: string, rootDir?: string): Promise<ProjectWorkspace | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getWorkspace(id)
}

export async function listProjectWorkspaces(rootDir?: string, options?: ListOptions): Promise<ProjectWorkspace[]> {
  return (await openProjectWorkspaceStore(rootDir)).listWorkspaces(options)
}

export async function updateProjectWorkspace(
  id: string,
  patch: ProjectWorkspacePatch,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).updateWorkspace(id, patch, options)
}

export async function archiveProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).archiveWorkspace(id, options)
}

export async function restoreProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).restoreWorkspace(id, options)
}

export async function reopenProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
  return restoreProjectWorkspace(id, rootDir, options)
}

export async function deleteProjectWorkspace(id: string, rootDir?: string, options?: DeleteOptions): Promise<ProjectWorkspace | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).deleteWorkspace(id, options)
}

export async function purgeProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<undefined> {
  return (await openProjectWorkspaceStore(rootDir)).purgeWorkspace(id, options)
}

export async function exportProjectWorkspaceManifest(
  id: string,
  rootDir?: string,
  destinationPath?: string
): Promise<ProjectWorkspaceManifest> {
  return (await openProjectWorkspaceStore(rootDir)).exportManifest(id, destinationPath)
}

export async function createGoal(input: GoalInput, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).createGoal(input, options)
}

export async function getGoal(id: string, rootDir?: string): Promise<Goal | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getGoal(id)
}

export async function listGoals(projectId?: string, rootDir?: string, options?: ListOptions): Promise<Goal[]> {
  return (await openProjectWorkspaceStore(rootDir)).listGoals(projectId, options)
}

export async function updateGoal(id: string, patch: GoalPatch, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).updateGoal(id, patch, options)
}

export async function transitionGoal(id: string, status: GoalStatus, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).transitionGoal(id, status, options)
}

export async function archiveGoal(id: string, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).archiveGoal(id, options)
}

export async function restoreGoal(id: string, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).restoreGoal(id, options)
}

export async function setGoalAcceptance(
  id: string,
  result: AcceptanceResult,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).setGoalAcceptance(id, result, options)
}

export async function createWorkItem(input: WorkItemInput, rootDir?: string, options?: MutationOptions | number): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).createWorkItem(input, options)
}

export async function getWorkItem(id: string, rootDir?: string): Promise<WorkItem | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getWorkItem(id)
}

export async function listWorkItems(projectId?: string, rootDir?: string, options?: ListOptions): Promise<WorkItem[]> {
  return (await openProjectWorkspaceStore(rootDir)).listWorkItems(projectId, options)
}

export async function updateWorkItem(
  id: string,
  patch: WorkItemPatch,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).updateWorkItem(id, patch, options)
}

export async function reorderWorkItem(
  id: string,
  targetId: string,
  placement: WorkItemReorderPlacement,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).reorderWorkItem(id, targetId, placement, options)
}

export async function transitionWorkItem(
  id: string,
  status: WorkItemStatus,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).transitionWorkItem(id, status, options)
}

export async function setWorkItemAcceptance(
  id: string,
  result: AcceptanceResult,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).setWorkItemAcceptance(id, result, options)
}

export async function acquireWorkItemLease(id: string, rootDir?: string, options?: LeaseOptions): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).acquireWorkItemLease(id, options)
}

export async function renewWorkItemLease(id: string, rootDir?: string, options?: LeaseOptions): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).renewWorkItemLease(id, options)
}

export async function releaseWorkItemLease(id: string, rootDir?: string, options?: LeaseOptions): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).releaseWorkItemLease(id, options)
}

export async function getEffectiveWorkItemContract(id: string, rootDir?: string): Promise<GoalContract | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getEffectiveWorkItemContract(id)
}

export { ProjectWorkspaceStore as ProjectWorkspaceRepository }
