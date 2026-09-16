import { ipcRenderer } from 'electron'
import type { ProjectInstitutionMigrationPreviewInput, ProjectInstitutionMigrationApplyInput } from '../shared/project-institution-template'
import type {
  AcceptanceResult,
  AgentDeskApi,
  GoalInput,
  GoalPatch,
  GoalStatus,
  MutationOptions,
  ProjectGoalTaskInput,
  ProjectGoalTaskPrepareInput,
  ProjectGoalTaskStartInput,
  ProjectMemberCreateInput,
  ProjectMemberPatch,
  ProjectInvitationInput,
  ProjectSquadCreateInput,
  ProjectSquadMemberInput,
  ProjectSquadPatch,
  ProjectWorkItemCommentCreateInput,
  ProjectWorkspaceDeleteOptions,
  ProjectWorkspaceContentsOptions,
  ProjectWorkspaceInput,
  ProjectWorkspaceLeaseOptions,
  ProjectWorkspaceListOptions,
  ProjectWorkspacePatch,
  ProjectConnectorMutation,
  ProjectKnowledgeSearchInput,
  ProjectCollaborationInboxListOptions,
  ProjectCollaborationInboxMarkInput,
  ProjectWorkItemSharedApprovalCreateInput,
  ProjectDependencyInput,
  ProjectMilestoneInput,
  ProjectMilestonePatch,
  ProjectWorkspaceTemplateApplyInput,
  WorkItemInput,
  WorkItemCommentPatch,
  WorkItemOwnerType,
  WorkItemTransferInput,
  WorkItemPatch,
  WorkItemReorderPlacement,
  WorkItemSharedApprovalDecisionInput,
  WorkItemStatus
} from '../shared/types'

const invokeProjectWorkspace = (action: string, ...args: unknown[]) =>
  ipcRenderer.invoke('projectWorkspace:invoke', action, ...args)

/** Renderer-safe bridge for the native ProjectWorkspace domain. */
export const projectWorkspaceApi: Pick<AgentDeskApi,
  | 'listProjectWorkspaces' | 'getProjectWorkspace' | 'createProjectWorkspace' | 'createProjectWorkspaceWithTemplate'
  | 'listProjectWorkspaceContents'
  | 'getProjectAuthorization'
  | 'previewProjectKnowledge'
  | 'searchProjectKnowledge'
  | 'getProjectPortfolio' | 'createProjectDependency' | 'removeProjectDependency'
  | 'createProjectMilestone' | 'updateProjectMilestone' | 'deleteProjectMilestone'
  | 'applyProjectWorkspaceTemplate'
  | 'updateProjectWorkspace' | 'archiveProjectWorkspace' | 'restoreProjectWorkspace'
  | 'mutateProjectConnector'
  | 'deleteProjectWorkspace' | 'purgeProjectWorkspace' | 'exportProjectWorkspaceManifest'
  | 'exportProjectWorkspaceData'
  | 'importProjectWorkspaceData'
  | 'listProjectGoals' | 'getProjectGoal' | 'createProjectGoal' | 'updateProjectGoal'
  | 'transitionProjectGoal' | 'archiveProjectGoal' | 'restoreProjectGoal'
  | 'setProjectGoalAcceptance' | 'listProjectWorkItems' | 'getProjectWorkItem'
  | 'createProjectWorkItem' | 'updateProjectWorkItem' | 'transitionProjectWorkItem'
  | 'transferProjectWorkItem'
  | 'createProjectGoalTask'
  | 'prepareProjectGoalTask'
  | 'startProjectGoalTask'
  | 'previewProjectInstitutionMigration'
  | 'getProjectInstitutionContext'
  | 'applyProjectInstitutionMigration'
  | 'reorderProjectWorkItem'
  | 'setProjectWorkItemAcceptance' | 'acquireProjectWorkItemLease'
  | 'renewProjectWorkItemLease' | 'releaseProjectWorkItemLease'
  | 'listProjectSquads' | 'getProjectSquad' | 'createProjectSquad' | 'updateProjectSquad'
  | 'archiveProjectSquad' | 'restoreProjectSquad' | 'addProjectSquadMember' | 'removeProjectSquadMember'
  | 'listProjectMembers' | 'getProjectMember' | 'createProjectMember' | 'updateProjectMember'
  | 'listProjectInvitations' | 'createProjectInvitation' | 'acceptProjectInvitation' | 'revokeProjectInvitation'
  | 'revokeProjectMember' | 'restoreProjectMember'
  | 'listProjectComments' | 'listProjectWorkItemComments' | 'createProjectWorkItemComment'
  | 'updateProjectWorkItemComment' | 'deleteProjectWorkItemComment'
  | 'listProjectSharedApprovals' | 'getProjectSharedApproval' | 'createProjectSharedApproval'
    | 'decideProjectSharedApproval' | 'revokeProjectSharedApproval'
    | 'listProjectCollaborationInbox' | 'markProjectCollaborationInbox'
> = {
  listProjectWorkspaces: (options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('list', options),
  getProjectWorkspace: (id: string) => invokeProjectWorkspace('get', id),
  listProjectWorkspaceContents: (projectId: string, options?: ProjectWorkspaceContentsOptions) =>
    invokeProjectWorkspace('contents:list', projectId, options),
  getProjectAuthorization: (projectId: string) => invokeProjectWorkspace('authorization:get', projectId),
  previewProjectKnowledge: (projectId: string) => invokeProjectWorkspace('knowledge:preview', projectId),
  searchProjectKnowledge: (input: ProjectKnowledgeSearchInput) => invokeProjectWorkspace('knowledge:search', input),
  getProjectPortfolio: () => invokeProjectWorkspace('portfolio:get'),
  createProjectDependency: (input: ProjectDependencyInput, options?: MutationOptions) =>
    invokeProjectWorkspace('portfolio:dependencies:create', input, options),
  removeProjectDependency: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('portfolio:dependencies:remove', id, options),
  createProjectMilestone: (input: ProjectMilestoneInput, options?: MutationOptions) =>
    invokeProjectWorkspace('portfolio:milestones:create', input, options),
  updateProjectMilestone: (id: string, patch: ProjectMilestonePatch, options?: MutationOptions) =>
    invokeProjectWorkspace('portfolio:milestones:update', id, patch, options),
  deleteProjectMilestone: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('portfolio:milestones:delete', id, options),
  createProjectWorkspace: (input: ProjectWorkspaceInput, options?: MutationOptions) =>
    invokeProjectWorkspace('create', input, options),
  createProjectWorkspaceWithTemplate: (input: ProjectWorkspaceInput, options?: MutationOptions) =>
    invokeProjectWorkspace('createWithTemplate', input, options),
  applyProjectWorkspaceTemplate: (input: ProjectWorkspaceTemplateApplyInput) =>
    invokeProjectWorkspace('templates:apply', input),
  updateProjectWorkspace: (id: string, patch: ProjectWorkspacePatch, options?: MutationOptions) =>
    invokeProjectWorkspace('update', id, patch, options),
  previewProjectInstitutionMigration: (id: string, input: ProjectInstitutionMigrationPreviewInput) =>
    invokeProjectWorkspace('institutions:preview', id, input),
  getProjectInstitutionContext: (input) => invokeProjectWorkspace('institutions:context', input),
  applyProjectInstitutionMigration: (id: string, input: ProjectInstitutionMigrationApplyInput) =>
    invokeProjectWorkspace('institutions:apply', id, input),
  mutateProjectConnector: (projectId: string, resourceId: string, mutation: ProjectConnectorMutation, options?: MutationOptions) =>
    invokeProjectWorkspace('connectors:mutate', projectId, resourceId, mutation, options),
  archiveProjectWorkspace: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('archive', id, options),
  restoreProjectWorkspace: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('restore', id, options),
  deleteProjectWorkspace: (id: string, options?: ProjectWorkspaceDeleteOptions) =>
    invokeProjectWorkspace('delete', id, options),
  purgeProjectWorkspace: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('purge', id, options),
  exportProjectWorkspaceManifest: (id: string, destinationPath?: string) =>
    invokeProjectWorkspace('export', id, destinationPath),
  exportProjectWorkspaceData: (projectId: string) =>
    invokeProjectWorkspace('export:data', projectId),
  importProjectWorkspaceData: (source) =>
    invokeProjectWorkspace('import:data', source),
  listProjectGoals: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('goals:list', projectId, options),
  getProjectGoal: (id: string) => invokeProjectWorkspace('goals:get', id),
  createProjectGoal: (input: GoalInput, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:create', input, options),
  updateProjectGoal: (id: string, patch: GoalPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:update', id, patch, options),
  transitionProjectGoal: (id: string, status: GoalStatus, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:transition', id, status, options),
  archiveProjectGoal: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:archive', id, options),
  restoreProjectGoal: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:restore', id, options),
  setProjectGoalAcceptance: (id: string, result: AcceptanceResult, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:acceptance', id, result, options),
  listProjectWorkItems: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('workItems:list', projectId, options),
  getProjectWorkItem: (id: string) => invokeProjectWorkspace('workItems:get', id),
  createProjectWorkItem: (input: WorkItemInput, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:create', input, options),
  createProjectGoalTask: (input: ProjectGoalTaskInput) =>
    invokeProjectWorkspace('goalTask:create', input),
  prepareProjectGoalTask: (input: ProjectGoalTaskPrepareInput) =>
    invokeProjectWorkspace('goalTask:prepare', input),
  startProjectGoalTask: (input: ProjectGoalTaskStartInput) =>
    invokeProjectWorkspace('goalTask:start', input),
  updateProjectWorkItem: (id: string, patch: WorkItemPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:update', id, patch, options),
  transferProjectWorkItem: (input: WorkItemTransferInput) =>
    invokeProjectWorkspace('workItems:transfer', input),
  reorderProjectWorkItem: (id: string, targetId: string, placement: WorkItemReorderPlacement, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:reorder', id, targetId, placement, options),
  transitionProjectWorkItem: (id: string, status: WorkItemStatus, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:transition', id, status, options),
  setProjectWorkItemAcceptance: (id: string, result: AcceptanceResult, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:acceptance', id, result, options),
  acquireProjectWorkItemLease: (id: string, options?: ProjectWorkspaceLeaseOptions) =>
    invokeProjectWorkspace('workItems:lease:acquire', id, options),
  renewProjectWorkItemLease: (id: string, options?: ProjectWorkspaceLeaseOptions) =>
    invokeProjectWorkspace('workItems:lease:renew', id, options),
  releaseProjectWorkItemLease: (id: string, options?: ProjectWorkspaceLeaseOptions) =>
    invokeProjectWorkspace('workItems:lease:release', id, options),
  listProjectSquads: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('squads:list', projectId, options),
  getProjectSquad: (id: string) => invokeProjectWorkspace('squads:get', id),
  createProjectSquad: (input: ProjectSquadCreateInput, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:create', input, options),
  updateProjectSquad: (id: string, patch: ProjectSquadPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:update', id, patch, options),
  archiveProjectSquad: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:archive', id, options),
  restoreProjectSquad: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:restore', id, options),
  addProjectSquadMember: (id: string, member: ProjectSquadMemberInput, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:members:add', id, member, options),
  removeProjectSquadMember: (id: string, memberType: WorkItemOwnerType, memberId: string, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:members:remove', id, memberType, memberId, options),
  listProjectMembers: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('members:list', projectId, options),
  getProjectMember: (id: string) => invokeProjectWorkspace('members:get', id),
  createProjectMember: (input: ProjectMemberCreateInput, options?: MutationOptions) =>
    invokeProjectWorkspace('members:create', input, options),
  updateProjectMember: (id: string, patch: ProjectMemberPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('members:update', id, patch, options),
  revokeProjectMember: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('members:revoke', id, options),
  restoreProjectMember: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('members:restore', id, options),
  listProjectInvitations: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('invitations:list', projectId, options),
  createProjectInvitation: (input: ProjectInvitationInput, options?: MutationOptions) =>
    invokeProjectWorkspace('invitations:create', input, options),
  acceptProjectInvitation: (projectId: string, token: string, options?: MutationOptions) =>
    invokeProjectWorkspace('invitations:accept', projectId, token, options),
  revokeProjectInvitation: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('invitations:revoke', id, options),
  listProjectWorkItemComments: (workItemId: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('comments:list', workItemId, options),
  listProjectComments: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('comments:listProject', projectId, options),
  createProjectWorkItemComment: (input: ProjectWorkItemCommentCreateInput, options?: MutationOptions) =>
    invokeProjectWorkspace('comments:create', input, options),
  updateProjectWorkItemComment: (id: string, patch: WorkItemCommentPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('comments:update', id, patch, options),
  deleteProjectWorkItemComment: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('comments:delete', id, options),
  listProjectSharedApprovals: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('sharedApprovals:list', projectId, options),
  getProjectSharedApproval: (id: string) => invokeProjectWorkspace('sharedApprovals:get', id),
  createProjectSharedApproval: (input: ProjectWorkItemSharedApprovalCreateInput, options?: MutationOptions) =>
    invokeProjectWorkspace('sharedApprovals:create', input, options),
  decideProjectSharedApproval: (id: string, input: WorkItemSharedApprovalDecisionInput, options?: MutationOptions) =>
    invokeProjectWorkspace('sharedApprovals:decide', id, input, options),
  revokeProjectSharedApproval: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('sharedApprovals:revoke', id, options),
  listProjectCollaborationInbox: (projectId: string, options?: ProjectCollaborationInboxListOptions) =>
    invokeProjectWorkspace('collaborationInbox:list', projectId, options),
  markProjectCollaborationInbox: (input: ProjectCollaborationInboxMarkInput, options?: MutationOptions) =>
    invokeProjectWorkspace('collaborationInbox:mark', input, options)
}
