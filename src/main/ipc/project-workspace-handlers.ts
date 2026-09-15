import { app, ipcMain } from 'electron'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  openProjectWorkspaceStore,
  type DeleteOptions,
  type LeaseOptions
} from '../project-workspace/store'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import {
  createProjectWorkspaceReadService,
  type ProjectWorkspaceReadService
} from '../project-workspace/canonical-read-service'
import {
  isGoalRiskLevel,
  isGoalStatus,
  isProjectWorkspaceKind,
  isWorkItemStatus,
  isWorkItemType,
  MANAGED_PERSONAL_WORKSPACE_ID,
  type AcceptanceResult,
  type GoalInput,
  type GoalPatch,
  type MutationOptions,
  type ProjectGoalTaskInput,
  type ProjectSquadCreateInput,
  type ProjectSquadInput,
  type ProjectSquadMemberInput,
  type ProjectSquadPatch,
  type ProjectMemberInput,
  type ProjectMemberPatch,
  type ProjectInvitationInput,
  type ProjectCollaborationInboxListOptions,
  type ProjectCollaborationInboxMarkInput,
  type ProjectWorkItemCommentCreateInput,
  type ProjectWorkspaceDeleteOptions,
  type ProjectWorkspaceInput,
  type ProjectWorkspaceLeaseOptions,
  type ProjectWorkspacePatch,
  type ProjectWorkspaceTemplateApplyInput,
  type ProjectConnectorMutation,
  type ProjectKnowledgeSearchInput,
  type WorkItemInput,
  type WorkItemCommentInput,
  type WorkItemCommentPatch,
  type WorkItemSharedApprovalInput,
  type WorkItemSharedApprovalDecisionInput,
  type WorkItemOwner,
  type WorkItemOwnerType,
  type WorkItemPatch,
  type WorkItemReorderPlacement
} from '../../shared/project-workspace-types'
import { createProjectGoalTask } from '../project-workspace/goal-task-service'
import { createWorkItemTransferService } from '../project-workspace/work-item-transfer-service'
import { LOCAL_USER_ACTOR } from '../project-workspace/work-item-authorization'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import {
  startAssignmentOwnerReadiness,
  withAssignmentOwnerReadAccess,
  withAssignmentOwnerWriteAccess
} from '../assignment-owner-coordinator'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { normalizeOwner, normalizeResources } from '../project-workspace/codec'
import {
  projectIdFromMutationResult,
  verifyProductionProjectMutation
} from '../project-aggregate/project-mutation-ingress'
import { executeProjectPermanentDeletionEffect } from '../project-deletion-effect'
import { projectImportReadiness } from './project-import-readiness'
import { prewarmFirstActiveProject } from './project-workspace-readiness'
import { normalizeContentsOptions, normalizeListOptions } from './project-workspace-read-options'
import { sessionManager } from '../sessionManager'
import { invalidateHistoryCache } from '../history'
import { applyProjectWorkspaceTemplate, createProjectWorkspaceWithTemplate } from '../project-workspace/template-service'
import { executeProjectPortableExportEffect } from '../project-export-effect'
import { executeProjectPortableImportEffect } from '../project-import-effect'
import { mutateProjectConnector } from '../project-workspace/project-connector-lifecycle'
import { purgeProjectConnectorCache } from '../project-workspace/project-connector-cache'
import { previewProjectKnowledge } from '../project-workspace/project-knowledge-preview'
import { searchProjectKnowledge } from '../project-workspace/project-knowledge-search'
import { getProjectPortfolioStore } from '../project-portfolio/store'
import { inspectProjectAuthorization } from '../project-workspace/project-authorization'
import type { ProjectDependencyInput, ProjectMilestoneInput, ProjectMilestonePatch } from '../../shared/project-portfolio-types'

const WORKSPACE_KEYS = new Set([
  'id', 'name', 'kind', 'ownerId', 'resources', 'rulesRef',
  'budgetPolicy', 'permissionPolicy', 'retentionPolicy', 'createdAt', 'updatedAt'
])
const WORKSPACE_PATCH_KEYS = new Set([
  'name', 'kind', 'ownerId', 'resources', 'rulesRef',
  'budgetPolicy', 'permissionPolicy', 'retentionPolicy'
])
const GOAL_KEYS = new Set([
  'id', 'projectId', 'title', 'objective', 'background', 'constraints',
  'successCriteria', 'budget', 'dueAt', 'riskLevel', 'forbiddenActions',
  'acceptance', 'acceptanceResult', 'contract', 'status', 'createdBy',
  'createdAt', 'updatedAt'
])
const GOAL_PATCH_KEYS = new Set([
  'title', 'objective', 'background', 'constraints', 'successCriteria',
  'budget', 'dueAt', 'riskLevel', 'forbiddenActions', 'acceptance',
  'acceptanceResult', 'contract', 'createdBy'
])
const WORK_ITEM_KEYS = new Set([
  'id', 'projectId', 'goalId', 'parentId', 'businessLineId', 'type', 'role', 'title', 'description',
  'dependencyIds', 'priority', 'owner', 'status', 'dueAt', 'acceptanceSpec',
  'artifactRefs', 'runRefs', 'createdAt', 'updatedAt'
])
const WORK_ITEM_PATCH_KEYS = new Set([
  'title', 'description', 'type', 'role', 'parentId', 'dependencyIds', 'priority',
  'owner', 'dueAt', 'acceptanceSpec', 'artifactRefs', 'runRefs'
])
const GOAL_TASK_KEYS = new Set(['requestId', 'projectId', 'objective', 'businessLineId'])
const PROJECT_TEMPLATE_APPLY_KEYS = new Set(['requestId', 'projectId', 'templateId'])
const PROJECT_KNOWLEDGE_SEARCH_KEYS = new Set(['projectId', 'query', 'limit'])
const PROJECT_DEPENDENCY_KEYS = new Set(['id', 'fromProjectId', 'toProjectId', 'fromWorkItemId', 'toWorkItemId', 'label'])
const PROJECT_MILESTONE_KEYS = new Set(['id', 'projectId', 'goalId', 'workItemId', 'title', 'dueAt'])
const PROJECT_MILESTONE_PATCH_KEYS = new Set(['title', 'dueAt', 'status'])
const WORK_ITEM_TRANSFER_KEYS = new Set(['requestId', 'workItemId', 'target', 'reason', 'expectedRevision'])
const WORK_ITEM_TRANSFER_TARGET_KEYS = new Set(['type', 'id', 'displayName'])
const SQUAD_KEYS = new Set([
  'id', 'projectId', 'name', 'description', 'members', 'createdAt', 'updatedAt'
])
const SQUAD_PATCH_KEYS = new Set(['name', 'description'])
const SQUAD_MEMBER_KEYS = new Set(['type', 'id', 'memberId', 'displayName', 'role', 'joinedAt'])
const MEMBER_KEYS = new Set(['id', 'projectId', 'principal', 'role', 'joinedAt', 'updatedAt'])
const MEMBER_PATCH_KEYS = new Set(['displayName', 'role'])
const MEMBER_PRINCIPAL_KEYS = new Set(['type', 'id', 'displayName'])
const INVITATION_KEYS = new Set(['id', 'projectId', 'principal', 'role', 'expiresAt', 'createdAt'])
const SHARED_APPROVAL_KEYS = new Set(['id', 'projectId', 'workItemId', 'goalId', 'acceptanceId', 'effectId', 'title', 'approverMemberIds', 'requiredApprovals', 'expiresAt', 'createdAt', 'updatedAt'])
const SHARED_APPROVAL_DECISION_KEYS = new Set(['memberId', 'decision', 'comment'])
const COMMENT_CREATE_KEYS = new Set(['id', 'projectId', 'workItemId', 'body', 'mentions', 'createdAt', 'updatedAt'])
const COMMENT_PATCH_KEYS = new Set(['body', 'mentions'])
const COLLABORATION_INBOX_LIST_KEYS = new Set(['memberId', 'includeHandled'])
const COLLABORATION_INBOX_MARK_KEYS = new Set(['projectId', 'itemId', 'sourceRevision', 'status'])
const PROJECT_WORKSPACE_MUTATIONS = new Set([
  'create', 'createWithTemplate', 'update', 'archive', 'restore', 'delete', 'purge', 'import:data',
  'templates:apply',
  'goals:create', 'goals:update', 'goals:transition', 'goals:archive', 'goals:restore', 'goals:acceptance',
  'workItems:create', 'workItems:update', 'workItems:transfer', 'workItems:reorder', 'workItems:transition', 'workItems:acceptance',
  'workItems:lease:acquire', 'workItems:lease:renew', 'workItems:lease:release',
  'squads:create', 'squads:update', 'squads:archive', 'squads:restore',
  'squads:members:add', 'squads:members:remove',
  'members:create', 'members:update', 'members:revoke', 'members:restore',
  'invitations:create', 'invitations:accept', 'invitations:revoke',
  'comments:create', 'comments:update', 'comments:delete',
  'sharedApprovals:create', 'sharedApprovals:decide', 'sharedApprovals:revoke',
  'collaborationInbox:mark',
  'goalTask:create', 'connectors:mutate', 'knowledge:search'
])
const WORKSPACE_ID_MUTATIONS = new Set(['update', 'archive', 'restore', 'delete', 'purge'])
const PROJECT_INPUT_MUTATIONS = new Set([
  'goals:create', 'workItems:create', 'squads:create', 'members:create',
  'invitations:create', 'comments:create', 'sharedApprovals:create'
])
type ProjectWorkspaceHandler = (...args: unknown[]) => unknown

const PROJECT_WORKSPACE_HANDLERS: Record<string, ProjectWorkspaceHandler> = {
  list: (rawOptions) => withStore(async (store) => {
    const workspaces = (await store.listWorkspaces(normalizeListOptions(rawOptions)))
      .filter((workspace) => workspace.id !== MANAGED_PERSONAL_WORKSPACE_ID)
    prewarmFirstActiveProject(workspaces, app.getPath('userData'))
    return workspaces
  }),
  get: (rawId) => withStore((store) => store.getWorkspace(assertUserManagedWorkspaceId(rawId))),
  'authorization:get': (rawId) => withStore(async (store) => {
    const projectId = assertUserManagedWorkspaceId(rawId, 'authorization')
    const state = await store.getState()
    const project = state.workspaces.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error(`Project not found:${projectId}`)
    return inspectProjectAuthorization(state, project, { type: 'local_user', id: 'caogen:local-user', displayName: 'Local user' })
  }),
  'knowledge:preview': (rawId) => previewProjectKnowledge(
    app.getPath('userData'),
    assertUserManagedWorkspaceId(rawId, 'knowledge preview')
  ),
  'knowledge:search': (rawInput) => searchProjectKnowledge(
    app.getPath('userData'),
    normalizeKnowledgeSearchInput(rawInput)
  ),
  'portfolio:get': () => getProjectPortfolioStore(app.getPath('userData')).getSnapshot(),
  'portfolio:dependencies:create': (rawInput, rawOptions) => getProjectPortfolioStore(app.getPath('userData')).createDependency(
    normalizeInput<ProjectDependencyInput>(rawInput, PROJECT_DEPENDENCY_KEYS, 'project dependency'),
    normalizeMutationOptions(rawOptions)
  ),
  'portfolio:dependencies:remove': (rawId, rawOptions) => getProjectPortfolioStore(app.getPath('userData')).removeDependency(
    requiredString(rawId, 'project dependency id'), normalizeMutationOptions(rawOptions)
  ),
  'portfolio:milestones:create': (rawInput, rawOptions) => getProjectPortfolioStore(app.getPath('userData')).createMilestone(
    normalizeInput<ProjectMilestoneInput>(rawInput, PROJECT_MILESTONE_KEYS, 'project milestone'),
    normalizeMutationOptions(rawOptions)
  ),
  'portfolio:milestones:update': (rawId, rawPatch, rawOptions) => getProjectPortfolioStore(app.getPath('userData')).updateMilestone(
    requiredString(rawId, 'project milestone id'),
    normalizeInput<ProjectMilestonePatch>(rawPatch, PROJECT_MILESTONE_PATCH_KEYS, 'project milestone patch'),
    normalizeMutationOptions(rawOptions)
  ),
  'portfolio:milestones:delete': (rawId, rawOptions) => getProjectPortfolioStore(app.getPath('userData')).deleteMilestone(
    requiredString(rawId, 'project milestone id'), normalizeMutationOptions(rawOptions)
  ),
  create: (rawInput, rawOptions) => withStore((store) => {
    const input = normalizeInput<ProjectWorkspaceInput>(rawInput, WORKSPACE_KEYS, 'workspace')
    if (input.id === MANAGED_PERSONAL_WORKSPACE_ID) throw managedPersonalWorkspaceMutationError('create')
    return store.createWorkspace(input, normalizeMutationOptions(rawOptions))
  }),
  createWithTemplate: async (rawInput, rawOptions) => {
    const input = normalizeInput<ProjectWorkspaceInput>(rawInput, WORKSPACE_KEYS, 'workspace')
    if (input.id === MANAGED_PERSONAL_WORKSPACE_ID) throw managedPersonalWorkspaceMutationError('createWithTemplate')
    return createProjectWorkspaceWithTemplate(app.getPath('userData'), input, normalizeMutationOptions(rawOptions))
  },
  'templates:apply': (rawInput) => applyProjectWorkspaceTemplate(
    app.getPath('userData'),
    normalizeProjectTemplateApplyInput(rawInput)
  ),
  update: (rawId, rawPatch, rawOptions) => updateWorkspaceWithConnectorCleanup(
    assertUserManagedWorkspaceId(rawId, 'update'),
    normalizeInput<ProjectWorkspacePatch>(rawPatch, WORKSPACE_PATCH_KEYS, 'workspace patch'),
    normalizeMutationOptions(rawOptions)
  ),
  archive: (rawId, rawOptions) => mutateWorkspaceWithoutActiveAssignments(
    'archive', rawId, rawOptions
  ),
  restore: (rawId, rawOptions) => withStore((store) => store.restoreWorkspace(
    assertUserManagedWorkspaceId(rawId, 'restore'), normalizeMutationOptions(rawOptions)
  )),
  delete: (rawId, rawOptions) => mutateWorkspaceWithoutActiveAssignments(
    'delete', rawId, rawOptions
  ),
  purge: (rawId, rawOptions) => mutateWorkspaceWithoutActiveAssignments(
    'purge', rawId, rawOptions
  ),
  export: (rawId, rawDestination) => withStore((store) => store.exportManifest(
    requiredString(rawId, 'workspace id'), safeDestination(rawDestination)
  )),
  'export:data': (rawId) => exportProjectData(requiredString(rawId, 'workspace id')),
  'connectors:mutate': (rawProjectId, rawResourceId, rawMutation, rawOptions) => mutateProjectConnector(
    app.getPath('userData'),
    assertUserManagedWorkspaceId(rawProjectId, 'connector mutation'),
    requiredString(rawResourceId, 'connector resource id'),
    normalizeConnectorMutation(rawMutation),
    normalizeMutationOptions(rawOptions),
    {
      blockRevokedSource: (projectId, resourceId) =>
        sessionManager.blockRevokedConnectorSource(projectId, resourceId)
    }
  ),
  'import:data': (rawSource) => executeProjectPortableImportEffect(rawSource, app.getPath('userData')),
  'goals:list': (rawProjectId, rawOptions) => withReadService((reads) => reads.listGoals(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'contents:list': (rawProjectId, rawOptions) => withReadService((reads) => reads.listWorkspaceContents(
    requiredString(rawProjectId, 'project contents project id'),
    normalizeContentsOptions(rawOptions)
  )),
  'goals:get': (rawId) => withReadService((reads) => reads.getGoal(requiredString(rawId, 'goal id'))),
  'goals:create': (rawInput, rawOptions) => withCommandService((commands) => commands.createGoal(
    normalizeGoalInput(rawInput), normalizeMutationOptions(rawOptions)
  )),
  'goals:update': (rawId, rawPatch, rawOptions) => withCommandService((commands) => commands.updateGoal(
    requiredString(rawId, 'goal id'),
    normalizeInput<GoalPatch>(rawPatch, GOAL_PATCH_KEYS, 'goal patch'),
    normalizeMutationOptions(rawOptions)
  )),
  'goals:transition': (rawId, rawStatus, rawOptions) => transitionGoal(rawId, rawStatus, rawOptions),
  'goals:archive': (rawId, rawOptions) => withCommandService((commands) => commands.archiveGoal(
    requiredString(rawId, 'goal id'), normalizeMutationOptions(rawOptions)
  )),
  'goals:restore': (rawId, rawOptions) => withCommandService((commands) => commands.restoreGoal(
    requiredString(rawId, 'goal id'), normalizeMutationOptions(rawOptions)
  )),
  'goals:acceptance': (rawId, rawResult, rawOptions) => withCommandService((commands) => commands.setGoalAcceptance(
    requiredString(rawId, 'goal id'), normalizeAcceptance(rawResult), normalizeMutationOptions(rawOptions)
  )),
  'workItems:list': (rawProjectId, rawOptions) => withReadService((reads) => reads.listWorkItems(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'workItems:get': (rawId) => withReadService((reads) => reads.getWorkItem(requiredString(rawId, 'work item id'))),
  'workItems:create': (rawInput, rawOptions) => withCommandService((commands) => commands.createWorkItem(
    normalizeWorkItemInput(rawInput), normalizeMutationOptions(rawOptions)
  )),
  'goalTask:create': (rawInput) => createProjectGoalTask(
    normalizeInput<ProjectGoalTaskInput>(rawInput, GOAL_TASK_KEYS, 'goal task'),
    app.getPath('userData')
  ),
  'workItems:update': (rawId, rawPatch, rawOptions) => updateWorkItem(rawId, rawPatch, rawOptions),
  'workItems:transfer': (rawInput) => createWorkItemTransferService(app.getPath('userData'), {
    prepare: (input) => sessionManager.prepareWorkItemTransfer(input),
    continue: (input) => sessionManager.continueWorkItemTransfer(input)
  }).transfer(normalizeWorkItemTransferInput(rawInput), LOCAL_USER_ACTOR),
  'workItems:reorder': (rawId, rawTargetId, rawPlacement, rawOptions) => withCommandService((commands) =>
    commands.reorderWorkItem(
      requiredString(rawId, 'work item id'),
      requiredString(rawTargetId, 'work item reorder target id'),
      normalizeReorderPlacement(rawPlacement),
      normalizeMutationOptions(rawOptions)
    )),
  'workItems:transition': (rawId, rawStatus, rawOptions) => transitionWorkItem(rawId, rawStatus, rawOptions),
  'workItems:acceptance': (rawId, rawResult, rawOptions) => withCommandService((commands) => commands.setWorkItemAcceptance(
    requiredString(rawId, 'work item id'), normalizeAcceptance(rawResult), normalizeMutationOptions(rawOptions)
  )),
  'workItems:lease:acquire': (rawId, rawOptions) => withCommandService((commands) => commands.acquireWorkItemLease(
    requiredString(rawId, 'work item id'), normalizeLeaseOptions(rawOptions)
  )),
  'workItems:lease:renew': (rawId, rawOptions) => withCommandService((commands) => commands.renewWorkItemLease(
    requiredString(rawId, 'work item id'), normalizeLeaseOptions(rawOptions)
  )),
  'workItems:lease:release': (rawId, rawOptions) => withCommandService((commands) => commands.releaseWorkItemLease(
    requiredString(rawId, 'work item id'), normalizeLeaseOptions(rawOptions)
  )),
  'squads:list': (rawProjectId, rawOptions) => withStore((store) => store.listSquads(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'squads:get': (rawId) => withStore((store) => store.getSquad(requiredString(rawId, 'squad id'))),
  'squads:create': (rawInput, rawOptions) => withStore((store) => store.createSquad(
    normalizeSquadInput(rawInput),
    normalizeMutationOptions(rawOptions)
  )),
  'squads:update': (rawId, rawPatch, rawOptions) => withStore((store) => store.updateSquad(
    requiredString(rawId, 'squad id'),
    normalizeInput<ProjectSquadPatch>(rawPatch, SQUAD_PATCH_KEYS, 'squad patch'),
    normalizeMutationOptions(rawOptions)
  )),
  'squads:archive': (rawId, rawOptions) => withStore((store) => store.archiveSquad(
    requiredString(rawId, 'squad id'), normalizeMutationOptions(rawOptions)
  )),
  'squads:restore': (rawId, rawOptions) => withStore((store) => store.restoreSquad(
    requiredString(rawId, 'squad id'), normalizeMutationOptions(rawOptions)
  )),
  'squads:members:add': (rawId, rawMember, rawOptions) => withStore((store) => store.addSquadMember(
    requiredString(rawId, 'squad id'),
    normalizeInput<ProjectSquadMemberInput>(rawMember, SQUAD_MEMBER_KEYS, 'squad member'),
    normalizeMutationOptions(rawOptions)
  )),
  'squads:members:remove': (rawId, rawType, rawMemberId, rawOptions) => withStore((store) => store.removeSquadMember(
    requiredString(rawId, 'squad id'),
    normalizeOwnerType(rawType),
    requiredString(rawMemberId, 'squad member id'),
    normalizeMutationOptions(rawOptions)
  )),
  'members:list': (rawProjectId, rawOptions) => withStore((store) => store.listMembers(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'members:get': (rawId) => withStore((store) => store.getMember(requiredString(rawId, 'member id'))),
  'members:create': (rawInput, rawOptions) => withStore((store) => store.createMember(
    normalizeMemberInput(rawInput), normalizeMutationOptions(rawOptions)
  )),
  'members:update': (rawId, rawPatch, rawOptions) => withStore((store) => store.updateMember(
    requiredString(rawId, 'member id'),
    normalizeInput<ProjectMemberPatch>(rawPatch, MEMBER_PATCH_KEYS, 'member patch'),
    normalizeMutationOptions(rawOptions)
  )),
  'members:revoke': (rawId, rawOptions) => withStore((store) => store.revokeMember(
    requiredString(rawId, 'member id'), normalizeMutationOptions(rawOptions)
  )),
  'members:restore': (rawId, rawOptions) => withStore((store) => store.restoreMember(
    requiredString(rawId, 'member id'), normalizeMutationOptions(rawOptions)
  )),
  'invitations:list': (rawProjectId, rawOptions) => withStore((store) => store.listInvitations(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'invitations:create': (rawInput, rawOptions) => withStore((store) => store.createInvitation(
    normalizeInvitationInput(rawInput), normalizeMutationOptions(rawOptions)
  )),
  'invitations:accept': (rawProjectId, rawToken, rawOptions) => withStore((store) => store.acceptInvitation(
    requiredString(rawProjectId, 'invitation project id'),
    requiredString(rawToken, 'invitation token'),
    normalizeMutationOptions(rawOptions)
  )),
  'invitations:revoke': (rawId, rawOptions) => withStore((store) => store.revokeInvitation(
    requiredString(rawId, 'invitation id'), normalizeMutationOptions(rawOptions)
  )),
  'comments:list': (rawWorkItemId, rawOptions) => withStore((store) => store.listWorkItemComments(
    requiredString(rawWorkItemId, 'comment work item id'), normalizeListOptions(rawOptions)
  )),
  'comments:listProject': (rawProjectId, rawOptions) => withStore((store) => store.listProjectComments(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'comments:create': (rawInput, rawOptions) => withStore((store) => store.createWorkItemComment(
    normalizeCommentInput(rawInput), normalizeMutationOptions(rawOptions)
  )),
  'comments:update': (rawId, rawPatch, rawOptions) => withStore((store) => store.updateWorkItemComment(
    requiredString(rawId, 'comment id'),
    normalizeInput<WorkItemCommentPatch>(rawPatch, COMMENT_PATCH_KEYS, 'comment patch'),
    normalizeMutationOptions(rawOptions)
  )),
  'comments:delete': (rawId, rawOptions) => withStore((store) => store.deleteWorkItemComment(
    requiredString(rawId, 'comment id'), normalizeMutationOptions(rawOptions)
  )),
  'sharedApprovals:list': (rawProjectId, rawOptions) => withStore((store) => store.listSharedApprovals(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'sharedApprovals:get': (rawId) => withStore((store) => store.getSharedApproval(requiredString(rawId, 'shared approval id'))),
  'sharedApprovals:create': (rawInput, rawOptions) => withStore((store) => store.createSharedApproval(
    normalizeInput<WorkItemSharedApprovalInput>(rawInput, SHARED_APPROVAL_KEYS, 'shared approval'),
    LOCAL_USER_ACTOR,
    normalizeMutationOptions(rawOptions)
  )),
  'sharedApprovals:decide': (rawId, rawInput, rawOptions) => withStore((store) => store.decideSharedApproval(
    requiredString(rawId, 'shared approval id'),
    normalizeInput<WorkItemSharedApprovalDecisionInput>(rawInput, SHARED_APPROVAL_DECISION_KEYS, 'shared approval decision'),
    normalizeMutationOptions(rawOptions)
  )),
  'sharedApprovals:revoke': (rawId, rawOptions) => withStore((store) => store.revokeSharedApproval(
    requiredString(rawId, 'shared approval id'), normalizeMutationOptions(rawOptions)
  )),
  'collaborationInbox:list': (rawProjectId, rawOptions) => withStore((store) => store.listCollaborationInbox(
    requiredString(rawProjectId, 'collaboration inbox project id'),
    normalizeCollaborationInboxListOptions(rawOptions)
  )),
  'collaborationInbox:mark': (rawInput, rawOptions) => withStore((store) => store.markCollaborationInbox(
    normalizeCollaborationInboxMarkInput(rawInput),
    normalizeMutationOptions(rawOptions)
  ))
}

async function exportProjectData(projectId: string) {
  return executeProjectPortableExportEffect(projectId, app.getPath('userData'))
}

export function registerProjectWorkspaceIpc(): void {
  const userDataRoot = app.getPath('userData')
  startAssignmentOwnerReadiness(userDataRoot)
  projectImportReadiness(userDataRoot)
  ipcMain.handle('projectWorkspace:invoke', async (event, rawAction: unknown, ...args: unknown[]) => {
    assertTrustedWorkflowLedgerSender(event)
    await projectImportReadiness(userDataRoot)
    const action = requiredString(rawAction, 'project workspace action')
    const handler = PROJECT_WORKSPACE_HANDLERS[action]
    if (!handler) throw new Error(`project workspace action is not supported: ${action}`)
    const mutation = PROJECT_WORKSPACE_MUTATIONS.has(action)
    const invoke = async () => {
      const result = await handler(...args)
      if (mutation) await verifyProjectWorkspaceMutation(action, args, result)
      return result
    }
    return mutation
      ? await withAssignmentOwnerWriteAccess(userDataRoot, invoke)
      : await withAssignmentOwnerReadAccess(userDataRoot, invoke)
  })
}

async function verifyProjectWorkspaceMutation(action: string, args: unknown[], result: unknown): Promise<void> {
  const projectId = projectIdFromMutationResult(result) ?? workspaceMutationProjectId(action, args, result)
  if (!projectId) throw new Error(`project workspace mutation ${action} did not resolve a Project ID`)
  await verifyProductionProjectMutation(app.getPath('userData'), projectId, {
    allowMissingProject: action === 'purge' || action === 'delete'
  })
}

function workspaceMutationProjectId(action: string, args: unknown[], result: unknown): string | undefined {
  if (action === 'create' || action === 'createWithTemplate') return recordId(result)
  if (action === 'templates:apply') {
    return isRecord(args[0]) ? optionalString(args[0].projectId) : undefined
  }
  if (WORKSPACE_ID_MUTATIONS.has(action)) {
    return optionalString(args[0])
  }
  if (action === 'connectors:mutate') return optionalString(args[0])
  if (action === 'knowledge:search') return isRecord(args[0]) ? optionalString(args[0].projectId) : undefined
  if (PROJECT_INPUT_MUTATIONS.has(action)) {
    return isRecord(args[0]) ? optionalString(args[0].projectId) : undefined
  }
  if (action === 'goalTask:create') {
    return isRecord(args[0]) ? optionalString(args[0].projectId) : undefined
  }
  return undefined
}

function normalizeCommentInput(value: unknown): WorkItemCommentInput {
  const input = normalizeInput<ProjectWorkItemCommentCreateInput>(value, COMMENT_CREATE_KEYS, 'comment')
  return { ...input, author: LOCAL_USER_ACTOR }
}

function normalizeMemberInput(value: unknown): ProjectMemberInput {
  const input = normalizeInput<ProjectMemberInput>(value, MEMBER_KEYS, 'member')
  const principal = normalizeInput<WorkItemOwner>(input.principal, MEMBER_PRINCIPAL_KEYS, 'member principal')
  if (principal.type !== 'human' && principal.type !== 'digital_worker') throw new Error('member principal type is invalid')
  return { ...input, principal }
}

function normalizeInvitationInput(value: unknown): ProjectInvitationInput {
  const input = normalizeInput<ProjectInvitationInput>(value, INVITATION_KEYS, 'invitation')
  requiredString(input.projectId, 'invitation projectId')
  if (input.role !== 'admin' && input.role !== 'editor' && input.role !== 'reviewer' && input.role !== 'viewer') {
    throw new Error('invitation role is invalid')
  }
  const principal = normalizeInput<WorkItemOwner>(input.principal, MEMBER_PRINCIPAL_KEYS, 'invitation principal')
  if (principal.type !== 'human' && principal.type !== 'digital_worker') throw new Error('invitation principal type is invalid')
  return { ...input, principal }
}

function normalizeProjectTemplateApplyInput(value: unknown): ProjectWorkspaceTemplateApplyInput {
  const input = normalizeInput<ProjectWorkspaceTemplateApplyInput>(
    value,
    PROJECT_TEMPLATE_APPLY_KEYS,
    'project template apply'
  )
  const templateId = input.templateId
  if (!isProjectWorkspaceKind(templateId)) throw new Error('project template id is invalid')
  return {
    requestId: requiredString(input.requestId, 'project template requestId'),
    projectId: requiredString(input.projectId, 'project template projectId'),
    templateId
  }
}

function normalizeSquadInput(value: unknown): ProjectSquadInput {
  const input = normalizeInput<ProjectSquadCreateInput>(value, SQUAD_KEYS, 'squad')
  return { ...input, createdBy: LOCAL_USER_ACTOR }
}

function normalizeOwnerType(value: unknown): WorkItemOwnerType {
  if (value !== 'human' && value !== 'digital_worker') throw new Error('squad member type is invalid')
  return value
}

function recordId(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.id) : undefined
}

function transitionGoal(rawId: unknown, rawStatus: unknown, rawOptions: unknown): unknown {
  if (!isGoalStatus(rawStatus)) throw new Error('goal status is invalid')
  return withCommandService((commands) => commands.transitionGoal(
    requiredString(rawId, 'goal id'), rawStatus, normalizeMutationOptions(rawOptions)
  ))
}

function transitionWorkItem(rawId: unknown, rawStatus: unknown, rawOptions: unknown): unknown {
  if (!isWorkItemStatus(rawStatus)) throw new Error('work item status is invalid')
  const id = requiredString(rawId, 'work item id')
  if (rawStatus === 'done' || rawStatus === 'failed' || rawStatus === 'cancelled') {
    assertNoActiveWorkItemAssignment(id, `transition to ${rawStatus}`)
  }
  return withCommandService((commands) => commands.transitionWorkItem(
    id, rawStatus, normalizeMutationOptions(rawOptions)
  ))
}

async function updateWorkItem(rawId: unknown, rawPatch: unknown, rawOptions: unknown): Promise<unknown> {
  const id = requiredString(rawId, 'work item id')
  const patch = normalizeInput<WorkItemPatch>(rawPatch, WORK_ITEM_PATCH_KEYS, 'work item patch')
  if (Object.hasOwn(patch, 'owner')) assertActiveAssignmentOwner(id, patch.owner)
  return withCommandService((commands) => commands.updateWorkItem(id, patch, normalizeMutationOptions(rawOptions)))
}

function assertActiveAssignmentOwner(workItemId: string, rawOwner: WorkItemPatch['owner']): void {
  const assignments = new DigitalWorkerStore(app.getPath('userData')).read().assignments
  const active = assignments.find(
    (assignment) => assignment.workItemId === workItemId && assignment.status === 'active'
  )
  if (!active) return
  const owner = normalizeOwner(rawOwner)
  if (owner?.type !== active.assigneeKind || owner.id !== active.assigneeId) {
    throw new Error(`WorkItem ${workItemId} owner is controlled by active Assignment ${active.id}`)
  }
}

async function mutateWorkspaceWithoutActiveAssignments(
  action: 'archive' | 'delete' | 'purge',
  rawId: unknown,
  rawOptions: unknown
): Promise<unknown> {
  const id = assertUserManagedWorkspaceId(rawId, action)
  assertNoActiveProjectAssignment(id, action)
  if (action === 'archive') {
    return withStore((store) => store.archiveWorkspace(id, normalizeMutationOptions(rawOptions)))
  }
  if (action === 'delete') {
    return withStore((store) => store.deleteWorkspace(id, normalizeDeleteOptions(rawOptions)))
  }
  const activeSession = sessionManager.list().find((session) =>
    session.workspaceId === id || session.projectId === id)
  if (activeSession) {
    throw new Error(`Project ${id} cannot purge while Session ${activeSession.id} is active`)
  }
  const result = await executeProjectPermanentDeletionEffect(
    id,
    app.getPath('userData'),
    normalizeMutationOptions(rawOptions)
  )
  invalidateHistoryCache()
  return result
}

function assertUserManagedWorkspaceId(rawId: unknown, action = 'access'): string {
  const id = requiredString(rawId, 'workspace id')
  if (id === MANAGED_PERSONAL_WORKSPACE_ID) throw managedPersonalWorkspaceMutationError(action)
  return id
}

function managedPersonalWorkspaceMutationError(action: string): Error {
  return new Error(`managed personal Workspace is reserved and cannot ${action}`)
}

function assertNoActiveProjectAssignment(projectId: string, action: string): void {
  const active = activeAssignments().find((assignment) => assignment.projectId === projectId)
  if (active) throw new Error(`Project ${projectId} cannot ${action} with active Assignment ${active.id}`)
}

function assertNoActiveWorkItemAssignment(workItemId: string, action: string): void {
  const active = activeAssignments().find((assignment) => assignment.workItemId === workItemId)
  if (active) throw new Error(`WorkItem ${workItemId} cannot ${action} with active Assignment ${active.id}`)
}

function activeAssignments() {
  return new DigitalWorkerStore(app.getPath('userData')).read().assignments
    .filter((assignment) => assignment.status === 'active')
}

async function withStore<T>(callback: (store: Awaited<ReturnType<typeof openProjectWorkspaceStore>>) => Promise<T> | T): Promise<T> {
  const store = await openProjectWorkspaceStore(app.getPath('userData'))
  return callback(store)
}

async function withCommandService<T>(
  callback: (commands: Awaited<ReturnType<typeof openProjectWorkspaceCommandService>>) => Promise<T> | T
): Promise<T> {
  const commands = await openProjectWorkspaceCommandService(app.getPath('userData'))
  return callback(commands)
}

function withReadService<T>(
  callback: (reads: ProjectWorkspaceReadService) => Promise<T> | T
): Promise<T> | T {
  return callback(createProjectWorkspaceReadService(app.getPath('userData')))
}

function normalizeInput<T>(value: unknown, keys: ReadonlySet<string>, label: string): T {
  const record = asRecord(value, `${label} input`)
  assertAllowedKeys(record, keys, label)
  return record as T
}

function normalizeGoalInput(value: unknown): GoalInput {
  const record = normalizeInput<GoalInput>(value, GOAL_KEYS, 'goal')
  if (!requiredString(record.projectId, 'goal projectId') || !requiredString(record.title, 'goal title')) {
    throw new Error('goal projectId and title are required')
  }
  if (record.riskLevel !== undefined && !isGoalRiskLevel(record.riskLevel)) throw new Error('goal riskLevel is invalid')
  if (record.status !== undefined && !isGoalStatus(record.status)) throw new Error('goal status is invalid')
  return record
}

function normalizeWorkItemInput(value: unknown): WorkItemInput {
  const record = normalizeInput<WorkItemInput>(value, WORK_ITEM_KEYS, 'work item')
  requiredString(record.projectId, 'work item projectId')
  requiredString(record.title, 'work item title')
  if (record.type !== undefined && !isWorkItemType(record.type)) throw new Error('work item type is invalid')
  if (record.status !== undefined && !isWorkItemStatus(record.status)) throw new Error('work item status is invalid')
  return record
}

function normalizeWorkItemTransferInput(value: unknown) {
  const record = normalizeInput<Record<string, unknown>>(value, WORK_ITEM_TRANSFER_KEYS, 'work item transfer')
  const targetRecord = normalizeInput<Record<string, unknown>>(
    record.target,
    WORK_ITEM_TRANSFER_TARGET_KEYS,
    'work item transfer target'
  )
  if (targetRecord.type !== 'human' && targetRecord.type !== 'digital_worker') {
    throw new Error('work item transfer target type is invalid')
  }
  const target: WorkItemOwner = {
    type: targetRecord.type,
    id: requiredString(targetRecord.id, 'work item transfer target id'),
    ...(targetRecord.displayName === undefined
      ? {}
      : { displayName: requiredString(targetRecord.displayName, 'work item transfer target displayName') })
  }
  return {
    requestId: requiredString(record.requestId, 'work item transfer requestId'),
    workItemId: requiredString(record.workItemId, 'work item transfer workItemId'),
    target,
    reason: requiredString(record.reason, 'work item transfer reason'),
    expectedRevision: positiveInteger(record.expectedRevision, 'work item transfer expectedRevision')
  }
}

function normalizeReorderPlacement(value: unknown): WorkItemReorderPlacement {
  if (value !== 'before' && value !== 'after') throw new Error('work item reorder placement must be before or after')
  return value
}

function normalizeCollaborationInboxListOptions(value: unknown): ProjectCollaborationInboxListOptions {
  if (value === undefined || value === null) return {}
  const record = normalizeInput<Record<string, unknown>>(
    value,
    COLLABORATION_INBOX_LIST_KEYS,
    'collaboration inbox list options'
  )
  if (record.includeHandled !== undefined && typeof record.includeHandled !== 'boolean') {
    throw new Error('collaboration inbox includeHandled must be boolean')
  }
  return {
    memberId: optionalString(record.memberId),
    includeHandled: record.includeHandled as boolean | undefined
  }
}

function normalizeCollaborationInboxMarkInput(value: unknown): ProjectCollaborationInboxMarkInput {
  const record = normalizeInput<Record<string, unknown>>(
    value,
    COLLABORATION_INBOX_MARK_KEYS,
    'collaboration inbox mark'
  )
  if (record.status !== 'read' && record.status !== 'handled') {
    throw new Error('collaboration inbox status is invalid')
  }
  return {
    projectId: requiredString(record.projectId, 'collaboration inbox project id'),
    itemId: requiredString(record.itemId, 'collaboration inbox item id'),
    sourceRevision: positiveInteger(record.sourceRevision, 'collaboration inbox sourceRevision'),
    status: record.status
  }
}

function normalizeMutationOptions(value: unknown): MutationOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'mutation options')
  assertAllowedKeys(record, new Set(['expectedRevision', 'expectedStoreRevision']), 'mutation options')
  return {
    ...(record.expectedRevision === undefined ? {} : { expectedRevision: nonNegativeInteger(record.expectedRevision, 'expectedRevision') }),
    ...(record.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: nonNegativeInteger(record.expectedStoreRevision, 'expectedStoreRevision') })
  }
}

function normalizeConnectorMutation(value: unknown): ProjectConnectorMutation {
  const record = asRecord(value, 'connector mutation')
  assertAllowedKeys(record, new Set(['kind', 'enabled', 'status', 'principalId', 'credentialRef', 'subject', 'intervalMs']), 'connector mutation')
  if (record.kind === 'set_enabled') {
    if (typeof record.enabled !== 'boolean') throw new Error('connector enabled must be boolean')
    return { kind: 'set_enabled', enabled: record.enabled }
  }
  if (record.kind === 'set_authorization') {
    if (record.status !== 'active' && record.status !== 'revoked') throw new Error('connector authorization status is invalid')
    return { kind: 'set_authorization', status: record.status }
  }
  if (record.kind === 'bind_authorization') {
    const principalId = requiredString(record.principalId, 'connector authorization principalId')
    const credentialRef = requiredString(record.credentialRef, 'connector authorization credentialRef')
    if (!/^oauth:[^/\s]+\/[^/\s]+$/.test(credentialRef) && !/^provider:[^/\s]+\/[^/\s]+$/.test(credentialRef)) {
      throw new Error('connector authorization credentialRef is invalid')
    }
    if (record.subject !== undefined && record.subject !== 'personal' && record.subject !== 'shared') {
      throw new Error('connector authorization subject is invalid')
    }
    return {
      kind: 'bind_authorization',
      principalId,
      credentialRef,
      ...(record.subject === undefined ? {} : { subject: record.subject })
    }
  }
  if (record.kind === 'set_auto_refresh') {
    if (typeof record.intervalMs !== 'number' || ![0, 900_000, 3_600_000, 21_600_000, 86_400_000].includes(record.intervalMs)) {
      throw new Error('connector auto-refresh interval is invalid')
    }
    return { kind: 'set_auto_refresh', intervalMs: record.intervalMs as 0 | 900_000 | 3_600_000 | 21_600_000 | 86_400_000 }
  }
  if (record.kind === 'request_refresh') return { kind: 'request_refresh' }
  if (record.kind === 'purge_cache') return { kind: 'purge_cache' }
  throw new Error('connector mutation kind is invalid')
}

async function updateWorkspaceWithConnectorCleanup(
  projectId: string,
  patch: ProjectWorkspacePatch,
  options: MutationOptions
) {
  const store = await openProjectWorkspaceStore(app.getPath('userData'))
  if (patch.resources === undefined) return store.updateWorkspace(projectId, patch, options)
  const resources = normalizeResources(patch.resources)
  const current = await store.getWorkspace(projectId)
  if (!current) throw new Error(`Project not found:${projectId}`)
  if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
    throw new Error(`Project revision conflict:${projectId}`)
  }
  const retained = new Set(resources.map((resource) => resource.id))
  const removedConnectorIds = current.resources
    .filter((resource) => resource.kind === 'connector' && !retained.has(resource.id))
    .map((resource) => resource.id)
  const updated = await store.updateWorkspace(projectId, { ...patch, resources }, options)
  const cleanup = await Promise.allSettled(removedConnectorIds.map((resourceId) =>
    purgeProjectConnectorCache(app.getPath('userData'), projectId, resourceId)
  ))
  for (const failure of cleanup.filter((result) => result.status === 'rejected')) {
    console.error(`[caogen] Removed Connector cache cleanup failed for Project ${projectId}:`, failure.reason)
  }
  return updated
}

function normalizeKnowledgeSearchInput(value: unknown): ProjectKnowledgeSearchInput {
  const record = asRecord(value, 'knowledge search')
  assertAllowedKeys(record, PROJECT_KNOWLEDGE_SEARCH_KEYS, 'knowledge search')
  const projectId = requiredString(record.projectId, 'knowledge search projectId')
  const query = requiredString(record.query, 'knowledge search query')
  if (query.length > 512) throw new Error('knowledge search query exceeds 512 characters')
  return {
    projectId,
    query,
    ...(record.limit === undefined ? {} : { limit: positiveInteger(record.limit, 'knowledge search limit') })
  }
}

function normalizeDeleteOptions(value: unknown): DeleteOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'delete options')
  assertAllowedKeys(record, new Set(['expectedRevision', 'expectedStoreRevision', 'permanent']), 'delete options')
  const mutation = normalizeMutationOptions(record)
  if (record.permanent !== undefined && typeof record.permanent !== 'boolean') throw new Error('permanent must be boolean')
  return { ...mutation, permanent: record.permanent as boolean | undefined }
}

function normalizeLeaseOptions(value: unknown): LeaseOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'lease options')
  assertAllowedKeys(record, new Set(['expectedRevision', 'expectedStoreRevision', 'leaseId', 'ownerId', 'durationMs', 'fencingToken']), 'lease options')
  const mutation = normalizeMutationOptions({
    ...(record.expectedRevision === undefined ? {} : { expectedRevision: record.expectedRevision }),
    ...(record.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: record.expectedStoreRevision })
  })
  return {
    ...mutation,
    leaseId: optionalString(record.leaseId),
    ownerId: optionalString(record.ownerId),
    ...(record.durationMs === undefined ? {} : { durationMs: positiveNumber(record.durationMs, 'durationMs') }),
    ...(record.fencingToken === undefined ? {} : { fencingToken: positiveInteger(record.fencingToken, 'fencingToken') })
  }
}

function normalizeAcceptance(value: unknown): AcceptanceResult {
  const record = asRecord(value, 'acceptance')
  assertAllowedKeys(record, new Set(['status', 'evidenceRefs', 'verifiedBy', 'verifiedAt', 'waiverReason']), 'acceptance')
  if (record.status !== 'pending' && record.status !== 'passed' && record.status !== 'failed' && record.status !== 'waived') throw new Error('acceptance status is invalid')
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('acceptance evidenceRefs must be non-empty strings')
  return {
    status: record.status,
    evidenceRefs: record.evidenceRefs.map((item) => item.trim()),
    ...(record.verifiedBy === undefined ? {} : { verifiedBy: requiredString(record.verifiedBy, 'verifiedBy') }),
    ...(record.verifiedAt === undefined ? {} : { verifiedAt: finiteNumber(record.verifiedAt, 'verifiedAt') }),
    ...(record.waiverReason === undefined ? {} : { waiverReason: requiredString(record.waiverReason, 'waiverReason') })
  }
}

function safeDestination(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const candidate = requiredString(value, 'destinationPath')
  const root = resolve(app.getPath('userData'))
  const target = resolve(candidate)
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('destinationPath must remain inside CaoGen user data')
  return target
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function assertAllowedKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown field: ${key}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown, label = 'value'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, label)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`)
  return value as number
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}
