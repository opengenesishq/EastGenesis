import type { BusinessLineBinding } from './business-line-types'
import type { TaskPlanStateView } from './task-plan-types'
/**
 * ProjectWorkspace is deliberately independent from the legacy path-centric
 * Project type. A workspace may have no resources at all; resources are
 * optional links and never form the workspace identity.
 */
export const PROJECT_WORKSPACE_SCHEMA_VERSION = 1 as const
export const MANAGED_PERSONAL_WORKSPACE_ID = 'caogen-managed-personal-workspace' as const

export type ProjectWorkspaceSchemaVersion = typeof PROJECT_WORKSPACE_SCHEMA_VERSION

export type ProjectWorkspaceKind =
  | 'personal'
  | 'office'
  | 'education'
  | 'research'
  | 'software'
  | 'opc'
  | 'custom'

export type ProjectWorkspaceStatus = 'active' | 'archived' | 'deleted'

export type ProjectResourceKind =
  | 'directory'
  | 'file_set'
  | 'repository'
  | 'knowledge_base'
  | 'connector'
  | 'url'
  | 'custom'

export type OutboundDataClass = 'S0' | 'S1' | 'S2' | 'S3' | 'S4'

/**
 * allow: any configured Provider may receive the resource.
 * local_only: only a loopback Provider may receive it.
 * deny: the resource is omitted from every Provider request.
 */
export type ProjectResourceEgressPolicy = 'allow' | 'local_only' | 'deny'

export type ConnectorResourceUsage = 'resource' | 'knowledge_source' | 'tool'
export type ConnectorDataDirection = 'read' | 'write' | 'bidirectional'
export type ConnectorAuthorizationSubject = 'personal' | 'shared'
export type ConnectorAuthorizationStatus = 'active' | 'revoked'
export type ConnectorRefreshStatus = 'idle' | 'requested' | 'running' | 'succeeded' | 'failed'
export type ConnectorCacheStatus = 'empty' | 'ready' | 'purging' | 'purged' | 'purge_failed'
export type ConnectorAutoRefreshInterval = 0 | 900_000 | 3_600_000 | 21_600_000 | 86_400_000

export interface ConnectorLatestCitation {
  projectId?: string
  resourceId?: string
  source: string
  version: string
  retrievedAt: number
  contentDigest?: string
}

export interface ConnectorResourceLifecycle {
  enabled: boolean
  refresh: {
    status: ConnectorRefreshStatus
    requestedAt?: number
    startedAt?: number
    completedAt?: number
    errorDigest?: string
    latestCitation?: ConnectorLatestCitation
  }
  autoRefresh?: {
    intervalMs: ConnectorAutoRefreshInterval
    nextAt?: number
  }
  cache?: {
    status: ConnectorCacheStatus
    /** Binds cached content to the exact Project authorization contract. */
    authorizationDigest?: string
    contentDigest?: string
    bytes?: number
    cachedAt?: number
    purgeRequestedAt?: number
    purgedAt?: number
    errorDigest?: string
  }
  revocation?: {
    status: 'blocking' | 'completed' | 'failed'
    requestedAt: number
    completedAt?: number
    pausedSessionIds: string[]
    pausedRunIds: string[]
    errorDigest?: string
  }
}

export interface ConnectorResourceContract {
  schemaVersion: 1
  /** Stable catalog identifier; credentials are still resolved outside this contract. */
  connectorId?: string
  usage: ConnectorResourceUsage[]
  capabilities: string[]
  dataDirection: ConnectorDataDirection
  authorization: {
    subject: ConnectorAuthorizationSubject
    principalId: string
    credentialRef?: string
    scopes: string[]
    status: ConnectorAuthorizationStatus
    grantedAt?: number
    revokedAt?: number
  }
  version: string
  revocation: {
    behavior: 'deny_new_operations'
    purgeCachedData: boolean
  }
  writePolicy: {
    effect: 'required'
    reconciliation: 'queryable' | 'manual_only'
  }
  lifecycle?: ConnectorResourceLifecycle
}

export type ProjectConnectorMutation =
  | { kind: 'set_enabled'; enabled: boolean }
  | { kind: 'set_authorization'; status: ConnectorAuthorizationStatus }
  | {
      kind: 'bind_authorization'
      principalId: string
      credentialRef: string
      subject?: ConnectorAuthorizationSubject
    }
  | { kind: 'set_auto_refresh'; intervalMs: ConnectorAutoRefreshInterval }
  | { kind: 'request_refresh' }
  | { kind: 'purge_cache' }

export interface ProjectConnectorCatalogEntry {
  id: string
  label: string
  defaultUri: string
  usage: ConnectorResourceUsage[]
  capabilities: string[]
  dataDirection: ConnectorDataDirection
  scopes: string[]
  version: string
  reconciliation: 'queryable' | 'manual_only'
}

export interface ConnectorSourceCitation {
  projectId: string
  resourceId: string
  source: string
  version: string
  retrievedAt: number
  contentDigest?: string
}

export interface ConnectorReadResult<T = unknown> {
  data: T
  citation: ConnectorSourceCitation
}

export interface ProjectKnowledgePreviewSource {
  resourceId: string
  resourceKind: ProjectResourceKind
  path: string
  digest: string
  bytes: number
  modifiedAt: number
  truncated: boolean
}

export interface ProjectKnowledgePreviewConnector {
  resourceId: string
  label: string
  connectorId?: string
  available: boolean
  reason?: string
  authorization: ConnectorAuthorizationStatus
  enabled: boolean
  refresh: ConnectorResourceLifecycle['refresh']
  autoRefresh?: ConnectorResourceLifecycle['autoRefresh']
  cache: NonNullable<ConnectorResourceLifecycle['cache']>
  revocation?: ConnectorResourceLifecycle['revocation']
}

export interface ProjectKnowledgePreview {
  projectId: string
  projectRevision: number
  policyDigest: string
  sources: ProjectKnowledgePreviewSource[]
  connectors: ProjectKnowledgePreviewConnector[]
}

export interface ProjectKnowledgeSearchInput {
  projectId: string
  query: string
  limit?: number
}

/** A bounded, citation-bearing match from Project-owned knowledge. */
export interface ProjectKnowledgeSearchResult {
  projectId: string
  projectRevision: number
  query: string
  queryDigest: string
  searchedAt: number
  results: ProjectKnowledgeSearchCitation[]
  connectors: ProjectKnowledgePreviewConnector[]
  connectorErrors: ProjectKnowledgeSearchConnectorError[]
}

export interface ProjectKnowledgeSearchConnectorError {
  resourceId: string
  reason: string
}

export interface ProjectKnowledgeSearchCitation {
  resourceId: string
  resourceKind: ProjectResourceKind
  path: string
  source: string
  version: string
  retrievedAt: number
  contentDigest: string
  snippet: string
  score: number
  evidenceId: string
}

export interface ProjectResource {
  id: string
  kind: ProjectResourceKind
  label?: string
  /** A source path is metadata only; deleting a workspace never removes it. */
  path?: string
  uri?: string
  /** Defaults to S2 for local content and S1 for metadata-only remote links. */
  dataClass?: OutboundDataClass
  /** Defaults to allow for backward compatibility; S3 is always denied. */
  egressPolicy?: ProjectResourceEgressPolicy
  /** Required for connector resources; credentials are referenced, never stored here. */
  connector?: ConnectorResourceContract
  metadata?: Record<string, unknown>
}

export interface ProjectResourceInput extends Omit<ProjectResource, 'id'> {
  id?: string
}

export type OutboundContextItemKind =
  | 'user_prompt'
  | 'image_attachment'
  | 'document_attachment'
  | 'project_resource'
  | 'project_resource_metadata'
  | 'conversation_context'
  | 'memory_context'
  | 'ide_context'
  | 'workflow_context'
  | 'tool_result'

export type OutboundContextItemDecision = 'included' | 'excluded'

export interface OutboundContextItemView {
  id: string
  kind: OutboundContextItemKind
  label: string
  dataClass: OutboundDataClass
  egressPolicy: ProjectResourceEgressPolicy
  decision: OutboundContextItemDecision
  resourceId?: string
  bytes?: number
  digest?: string
  reason?: string
}

export type OutboundReceiverLocality = 'local' | 'remote' | 'unknown'

export interface OutboundContextReceiverView {
  providerId: string
  providerName: string
  engine: string
  model: string
  endpointOrigin: string
  locality: OutboundReceiverLocality
}

/** Serializable and content-free projection of one Provider-bound request. */
export interface OutboundContextManifest {
  schemaVersion: 1
  generatedAt: number
  sessionId: string
  projectId?: string
  projectRevision?: number
  projectPolicyDigest?: string
  resourceContextDigest?: string
  receiver: OutboundContextReceiverView
  dataClasses: OutboundDataClass[]
  items: OutboundContextItemView[]
  /** Remains partial until every engine-owned system/tool context is projected. */
  scopeCompleteness: 'partial' | 'complete'
  blocked: boolean
  blockReasons: string[]
  failoverAllowed: boolean
  routingMayChangeReceiver: boolean
  manifestDigest: string
}

export type GoalRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface GoalBudget {
  amount?: number
  currency?: string
  maxTokens?: number
  maxRuns?: number
  /** Maximum non-terminal Runs owned by this Goal. Undefined means unlimited. */
  maxConcurrentRuns?: number
}

export interface AcceptanceSpec {
  id: string
  criterion: string
  required?: boolean
}

export type AcceptanceResultStatus = 'pending' | 'passed' | 'failed' | 'waived'

export interface AcceptanceResult {
  status: AcceptanceResultStatus
  evidenceRefs: string[]
  verifiedBy?: string
  verifiedAt?: number
  waiverReason?: string
}

export interface GoalContract {
  objective: string
  background?: string
  constraints: string[]
  successCriteria: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel: GoalRiskLevel
  forbiddenActions: string[]
  acceptance: AcceptanceSpec[]
}

export type GoalContractInput = Partial<GoalContract>

export type GoalStatus =
  | 'draft'
  | 'planned'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived'

export interface ProjectWorkspace {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  name: string
  kind: ProjectWorkspaceKind
  status: ProjectWorkspaceStatus
  ownerId?: string
  resources: ProjectResource[]
  rulesRef?: string
  budgetPolicy?: Record<string, unknown>
  permissionPolicy?: Record<string, unknown>
  retentionPolicy?: Record<string, unknown>
  /** Missing on pre-template projects: preserve legacy identities and configuration. */
  institutionTemplate?: import('./project-institution-template').ProjectInstitutionTemplateRef
  createdAt: number
  updatedAt: number
  archivedAt?: number
  deletedAt?: number
  /** Entity revision, incremented exactly once for each persisted mutation. */
  revision: number
}

export interface ProjectWorkspaceInput {
  id?: string
  name: string
  kind?: ProjectWorkspaceKind
  ownerId?: string
  resources?: ProjectResourceInput[]
  rulesRef?: string
  budgetPolicy?: Record<string, unknown>
  permissionPolicy?: Record<string, unknown>
  retentionPolicy?: Record<string, unknown>
  /** New workspaces default to cabinet-six-ministries v1 when omitted. */
  institutionTemplate?: import('./project-institution-template').ProjectInstitutionTemplateRef
  createdAt?: number
  updatedAt?: number
}

export interface ProjectWorkspacePatch {
  name?: string
  kind?: ProjectWorkspaceKind
  ownerId?: string
  resources?: ProjectResourceInput[]
  rulesRef?: string
  budgetPolicy?: Record<string, unknown>
  permissionPolicy?: Record<string, unknown>
  retentionPolicy?: Record<string, unknown>
  institutionTemplate?: import('./project-institution-template').ProjectInstitutionTemplateRef
}

export interface Goal {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  title: string
  /** Flattened fields are retained for simple consumers; contract is canonical. */
  objective: string
  background?: string
  constraints: string[]
  successCriteria: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel: GoalRiskLevel
  forbiddenActions: string[]
  acceptance: AcceptanceSpec[]
  acceptanceResult?: AcceptanceResult
  contract: GoalContract
  status: GoalStatus
  createdBy?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
  archivedAt?: number
  /** Status immediately before archive, used by restore. */
  archivedFromStatus?: Exclude<GoalStatus, 'archived'>
  revision: number
}

export interface GoalInput {
  id?: string
  projectId: string
  title: string
  objective?: string
  background?: string
  constraints?: string[]
  successCriteria?: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel?: GoalRiskLevel
  forbiddenActions?: string[]
  acceptance?: AcceptanceSpec[]
  acceptanceResult?: AcceptanceResult
  contract?: GoalContractInput
  status?: GoalStatus
  createdBy?: string
  createdAt?: number
  updatedAt?: number
}

export interface GoalPatch {
  title?: string
  objective?: string
  background?: string
  constraints?: string[]
  successCriteria?: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel?: GoalRiskLevel
  forbiddenActions?: string[]
  acceptance?: AcceptanceSpec[]
  acceptanceResult?: AcceptanceResult
  contract?: GoalContractInput
  createdBy?: string
}

export type WorkItemType =
  | 'research'
  | 'analysis'
  | 'planning'
  | 'writing'
  | 'design'
  | 'coding'
  | 'review'
  | 'testing'
  | 'documentation'
  | 'operations'
  | 'delivery'
  | 'custom'

export type WorkItemStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export type WorkItemOwnerType = 'human' | 'digital_worker'

export interface WorkItemOwner {
  type: WorkItemOwnerType
  id: string
  displayName?: string
}

export type WorkItemActorType = 'local_user' | WorkItemOwnerType

export interface WorkItemActor {
  type: WorkItemActorType
  id: string
  displayName?: string
}

export type WorkItemCapability = 'view' | 'edit' | 'execute' | 'approve' | 'transfer'

export interface WorkItemAuthorizationView {
  projectId: string
  workItemId: string
  actor: WorkItemActor
  owner?: WorkItemOwner
  authorizationRevision: number
  projectAdministrator: boolean
  currentOwner: boolean
  capabilities: WorkItemCapability[]
}

export interface WorkItemTransferInput {
  requestId: string
  workItemId: string
  target: WorkItemOwner
  reason: string
  expectedRevision: number
}

export interface WorkItemTransferResult {
  requestId: string
  projectId: string
  workItemId: string
  previousOwner?: WorkItemOwner
  owner: WorkItemOwner
  previousAssignmentId?: string
  assignmentId: string
  workItem: WorkItem
  authorization: WorkItemAuthorizationView
  auditEventIds: string[]
  idempotentReplay: boolean
  continuation?: WorkItemTransferContinuation
}

export interface WorkItemTransferContinuation {
  status: 'not_required' | 'paused_for_human' | 'successor_created' | 'successor_failed'
  pausedSessionIds: string[]
  pausedRunIds: string[]
  releasedWorkerLeaseIds: string[]
  predecessorSessionId?: string
  predecessorRunId?: string
  successorSessionId?: string
  successorRunId?: string
  error?: string
}

export interface WorkItemLease {
  id: string
  ownerId: string
  acquiredAt: number
  expiresAt: number
  fencingToken: number
}

export interface WorkItem extends BusinessLineBinding {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  goalId?: string
  parentId?: string
  type: WorkItemType
  /** Stable task role; assigning a role does not assign a Worker or permission. */
  role?: string
  title: string
  description?: string
  dependencyIds: string[]
  priority: number
  /** Stable user-controlled order shared by List and Board projections. */
  boardOrder?: number
  owner?: WorkItemOwner
  status: WorkItemStatus
  dueAt?: number
  acceptanceSpec: AcceptanceSpec[]
  acceptance?: AcceptanceResult
  artifactRefs: string[]
  runRefs: string[]
  /** Immutable snapshot of the Goal Contract inherited at write time. */
  inheritedGoalContract?: GoalContract
  createdAt: number
  updatedAt: number
  revision: number
  lease?: WorkItemLease
}

export interface WorkItemInput extends BusinessLineBinding {
  id?: string
  projectId: string
  goalId?: string
  parentId?: string
  type?: WorkItemType
  role?: string
  title: string
  description?: string
  dependencyIds?: string[]
  priority?: number
  owner?: WorkItemOwner | string
  status?: WorkItemStatus
  dueAt?: number
  acceptanceSpec?: AcceptanceSpec[]
  artifactRefs?: string[]
  runRefs?: string[]
  createdAt?: number
  updatedAt?: number
}

export interface WorkItemPatch {
  title?: string
  description?: string
  type?: WorkItemType
  role?: string | null
  parentId?: string
  dependencyIds?: string[]
  priority?: number
  owner?: WorkItemOwner | string | null
  dueAt?: number
  acceptanceSpec?: AcceptanceSpec[]
  artifactRefs?: string[]
  runRefs?: string[]
}

export type ProjectSquadStatus = 'active' | 'archived'

export interface ProjectSquadMember {
  type: WorkItemOwnerType
  id: string
  /** Canonical Project member identity. Legacy Squad records may omit this. */
  memberId?: string
  displayName?: string
  role?: string
  joinedAt: number
}

export interface ProjectSquadMemberInput {
  type: WorkItemOwnerType
  id: string
  memberId?: string
  displayName?: string
  role?: string
  joinedAt?: number
}

export interface ProjectSquad {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  name: string
  description?: string
  members: ProjectSquadMember[]
  status: ProjectSquadStatus
  createdBy?: WorkItemActor
  createdAt: number
  updatedAt: number
  archivedAt?: number
  revision: number
}

export interface ProjectSquadInput {
  id?: string
  projectId: string
  name: string
  description?: string
  members?: ProjectSquadMemberInput[]
  createdBy?: WorkItemActor
  createdAt?: number
  updatedAt?: number
}

export interface ProjectSquadPatch {
  name?: string
  description?: string
}

export type ProjectSquadCreateInput = Omit<ProjectSquadInput, 'createdBy'>

/**
 * Project members are the durable identities used by collaboration features.
 * They intentionally reference an existing human principal or DigitalWorker
 * instead of creating a separate account or credential system.
 */
export type ProjectMemberRole = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer'
export type ProjectMemberStatus = 'active' | 'revoked'

export type ProjectAuthorizationCapability =
  | 'view'
  | 'edit'
  | 'execute'
  | 'comment'
  | 'approve'
  | 'transfer'
  | 'manage_squads'
  | 'manage_members'
  | 'manage_invitations'

export interface ProjectAuthorizationView {
  projectId: string
  actor: WorkItemActor
  role: ProjectMemberRole | 'local_admin' | 'owner' | 'unregistered'
  capabilities: ProjectAuthorizationCapability[]
  authorizationRevision: number
}

export interface ProjectMember {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  principal: WorkItemOwner
  role: ProjectMemberRole
  status: ProjectMemberStatus
  joinedAt: number
  updatedAt: number
  revokedAt?: number
  revision: number
}

export interface ProjectMemberInput {
  id?: string
  projectId: string
  principal: WorkItemOwner
  role?: ProjectMemberRole
  joinedAt?: number
  updatedAt?: number
}

export interface ProjectMemberPatch {
  displayName?: string
  role?: ProjectMemberRole
}

export type ProjectMemberCreateInput = ProjectMemberInput

export type ProjectInvitationRole = Exclude<ProjectMemberRole, 'owner'>
export type ProjectInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export interface ProjectInvitation {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  principal: WorkItemOwner
  role: ProjectInvitationRole
  tokenDigest: string
  status: ProjectInvitationStatus
  expiresAt: number
  acceptedMemberId?: string
  createdAt: number
  updatedAt: number
  acceptedAt?: number
  revokedAt?: number
  revision: number
}

export interface ProjectInvitationInput {
  id?: string
  projectId: string
  principal: WorkItemOwner
  role: ProjectInvitationRole
  expiresAt?: number
  createdAt?: number
}

export interface ProjectInvitationCreateResult {
  invitation: ProjectInvitation
  /** Returned once to the caller; only tokenDigest is durable. */
  token: string
}

export type WorkItemSharedApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'
export type WorkItemSharedApprovalDecisionStatus = 'approved' | 'rejected'

export interface WorkItemSharedApprovalDecision {
  memberId: string
  decision: WorkItemSharedApprovalDecisionStatus
  comment?: string
  decidedAt: number
}

/**
 * A quorum-based collaboration approval. It is scoped to canonical Project
 * records and preserves each member decision for audit/export/recovery.
 */
export interface WorkItemSharedApproval {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  workItemId: string
  goalId?: string
  acceptanceId?: string
  effectId?: string
  title: string
  requester: WorkItemActor
  approverMemberIds: string[]
  requiredApprovals: number
  decisions: WorkItemSharedApprovalDecision[]
  status: WorkItemSharedApprovalStatus
  expiresAt?: number
  createdAt: number
  updatedAt: number
  resolvedAt?: number
  revokedAt?: number
  revision: number
}

export interface WorkItemSharedApprovalInput {
  id?: string
  projectId: string
  workItemId: string
  goalId?: string
  acceptanceId?: string
  effectId?: string
  title: string
  approverMemberIds: string[]
  requiredApprovals?: number
  expiresAt?: number
  createdAt?: number
  updatedAt?: number
}

export interface WorkItemSharedApprovalDecisionInput {
  memberId: string
  decision: WorkItemSharedApprovalDecisionStatus
  comment?: string
}

export type ProjectWorkItemSharedApprovalCreateInput = WorkItemSharedApprovalInput

export type WorkItemCommentStatus = 'active' | 'deleted'

export interface WorkItemComment {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  workItemId: string
  author: WorkItemActor
  body: string
  mentions: WorkItemActor[]
  status: WorkItemCommentStatus
  createdAt: number
  updatedAt: number
  deletedAt?: number
  revision: number
}

export interface WorkItemCommentInput {
  id?: string
  projectId: string
  workItemId: string
  author: WorkItemActor
  body: string
  mentions?: WorkItemActor[]
  createdAt?: number
  updatedAt?: number
}

export interface WorkItemCommentPatch {
  body?: string
  mentions?: WorkItemActor[]
}

export type ProjectWorkItemCommentCreateInput = Omit<WorkItemCommentInput, 'author'>

export type ProjectCollaborationInboxSourceKind =
  | 'work_item_assignment'
  | 'comment_mention'
  | 'shared_approval'

export type ProjectCollaborationInboxState = 'unread' | 'read' | 'handled'
export type ProjectCollaborationInboxPriority = 'urgent' | 'normal'
export type ProjectCollaborationInboxAction = 'open_work_item' | 'review_comment' | 'decide_approval'

/**
 * A collaboration Inbox item is derived from canonical WorkItems, comments,
 * approvals and members. It is never persisted as a second copy of that data.
 */
export interface ProjectCollaborationInboxItem {
  id: string
  projectId: string
  memberId: string
  sourceKind: ProjectCollaborationInboxSourceKind
  sourceId: string
  sourceRevision: number
  workItemId: string
  title: string
  detail?: string
  actor?: WorkItemActor
  state: ProjectCollaborationInboxState
  priority: ProjectCollaborationInboxPriority
  action: ProjectCollaborationInboxAction
  createdAt: number
  updatedAt: number
  receiptRevision?: number
}

/** Only the user's read/handled acknowledgement is durable. */
export interface ProjectCollaborationInboxReceipt {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  memberId: string
  sourceKind: ProjectCollaborationInboxSourceKind
  sourceId: string
  sourceRevision: number
  status: Exclude<ProjectCollaborationInboxState, 'unread'>
  readAt: number
  handledAt?: number
  updatedAt: number
  revision: number
}

export interface ProjectCollaborationInboxListOptions {
  memberId?: string
  includeHandled?: boolean
}

export interface ProjectCollaborationInboxMarkInput {
  projectId: string
  itemId: string
  sourceRevision: number
  status: Exclude<ProjectCollaborationInboxState, 'unread'>
}

export type WorkItemReorderPlacement = 'before' | 'after'

export interface ProjectWorkspaceEvent {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  entityType: 'workspace' | 'goal' | 'work_item' | 'squad' | 'member' | 'invitation' | 'comment' | 'shared_approval' | 'inbox_receipt'
  entityId: string
  kind: string
  revision: number
  occurredAt: number
  payload: Record<string, unknown>
}

export interface ProjectWorkspaceState {
  schemaVersion: ProjectWorkspaceSchemaVersion
  revision: number
  workspaces: ProjectWorkspace[]
  goals: Goal[]
  workItems: WorkItem[]
  squads: ProjectSquad[]
  members: ProjectMember[]
  invitations: ProjectInvitation[]
  comments: WorkItemComment[]
  sharedApprovals: WorkItemSharedApproval[]
  inboxReceipts: ProjectCollaborationInboxReceipt[]
  events: ProjectWorkspaceEvent[]
}

export interface ProjectWorkspaceManifest {
  schemaVersion: ProjectWorkspaceSchemaVersion
  format: 'caogen.project-workspace-manifest.v1'
  exportedAt: number
  projectId: string
  stateRevision: number
  workspace: ProjectWorkspace
  goals: Goal[]
  workItems: WorkItem[]
  squads: ProjectSquad[]
  members: ProjectMember[]
  invitations: ProjectInvitation[]
  comments: WorkItemComment[]
  sharedApprovals: WorkItemSharedApproval[]
  inboxReceipts: ProjectCollaborationInboxReceipt[]
  events: ProjectWorkspaceEvent[]
  digest: string
}

export interface MutationOptions {
  /** Entity revision expected by the caller (optimistic concurrency). */
  expectedRevision?: number
  /** Optional global store revision CAS for callers coordinating a batch. */
  expectedStoreRevision?: number
  /** Principal performing the mutation; omitted desktop calls use the local administrator. */
  actor?: WorkItemActor
}

/** Renderer-facing contract for the native ProjectWorkspace domain. */
import type { ProjectWorkspaceContents, ProjectWorkspaceContentsOptions, ProjectWorkspaceListOptions } from './project-workspace-contents-types'
export type { ProjectWorkspaceContents, ProjectWorkspaceContentsOptions, ProjectWorkspaceListOptions }

export interface ProjectWorkspaceDeleteOptions extends MutationOptions {
  permanent?: boolean
}

export interface ProjectWorkspaceLeaseOptions extends MutationOptions {
  leaseId?: string
  ownerId?: string
  durationMs?: number
  fencingToken?: number
}

export interface ProjectGoalTaskInput extends BusinessLineBinding {
  /** Stable across retries of one user action; never reused for a different objective. */
  requestId: string
  projectId: string
  objective: string
}

export interface ProjectGoalTaskResult {
  requestId: string
  goal: Goal
  workItem: WorkItem
  recovered: boolean
}

export interface ProjectGoalTaskPrepareInput extends ProjectGoalTaskInput {
  template: 'auto' | 'product-launch'
  /** Recovery hints from the old renderer journal; never authority to create an ID. */
  legacySessionId?: string
  legacyCreationClaimed?: boolean
}

export interface ProjectGoalTaskPrepared extends ProjectGoalTaskResult {
  sessionId: string
  plan: TaskPlanStateView
}

export interface ProjectGoalTaskStartInput extends ProjectGoalTaskPrepareInput {
  mode: 'auto' | 'plan'
}

/** Frozen when reserving the submission; text classification never grants execution authority. */
export interface ProjectGoalTaskStartDecision {
  schemaVersion: 1
  mode: 'auto' | 'plan'
  kind: 'direct' | 'plan'
  reason: string
  taskStrategy: 'view' | 'plan'
}

export type ProjectGoalTaskStarted =
  | (ProjectGoalTaskPrepared & { kind: 'plan'; decision: ProjectGoalTaskStartDecision })
  | (ProjectGoalTaskResult & {
      kind: 'direct'
      sessionId: string
      decision: ProjectGoalTaskStartDecision
      input: import('./session-input-types').SessionInputRecord
    })

export interface ProjectWorkspaceTemplateResourceSuggestion {
  kind: ProjectResourceKind
  label: string
  dataClass: OutboundDataClass
  egressPolicy: ProjectResourceEgressPolicy
  reason: string
}

export interface ProjectWorkspaceTemplateWorkItemPreset {
  key: string
  type: WorkItemType
  title: string
  description: string
  dependencyKeys: string[]
  expectedArtifactKinds: import('./workflow-types').WorkflowArtifactKind[]
  acceptance: string[]
}

export interface ProjectWorkspaceTemplateDefinition {
  schemaVersion: 1
  id: ProjectWorkspaceKind
  name: string
  summary: string
  goal: {
    title: string
    objective: string
    constraints: string[]
    successCriteria: string[]
    forbiddenActions: string[]
    riskLevel: GoalRiskLevel
    acceptance: string[]
  }
  workItems: ProjectWorkspaceTemplateWorkItemPreset[]
  resourceSuggestions: ProjectWorkspaceTemplateResourceSuggestion[]
}

export interface ProjectWorkspaceTemplateApplyInput {
  requestId: string
  projectId: string
  templateId: ProjectWorkspaceKind
}

export interface ProjectWorkspaceTemplateApplyResult {
  requestId: string
  projectId: string
  templateId: ProjectWorkspaceKind
  templateDigest: string
  goal: Goal
  workItems: WorkItem[]
  resourceSuggestions: ProjectWorkspaceTemplateResourceSuggestion[]
}

export interface ProjectDeletionResult {
  operationId: string
  projectId: string
  phase: 'completed'
  backupPath: string
  backupDigest: string
  exportDigest: string
  proofPath: string
  proofDigest: string
  sessionIds: string[]
  sdkSessionIds: string[]
  residuals: Record<string, number>
}

export interface ProjectWorkspaceApi {
  listProjectWorkspaces(options?: ProjectWorkspaceListOptions): Promise<ProjectWorkspace[]>
  getProjectWorkspace(id: string): Promise<ProjectWorkspace | undefined>
  listProjectWorkspaceContents(projectId: string, options?: ProjectWorkspaceContentsOptions): Promise<ProjectWorkspaceContents>
  getProjectAuthorization(projectId: string): Promise<ProjectAuthorizationView>
  previewProjectKnowledge(projectId: string): Promise<ProjectKnowledgePreview>
  searchProjectKnowledge(input: ProjectKnowledgeSearchInput): Promise<ProjectKnowledgeSearchResult>
  createProjectWorkspace(input: ProjectWorkspaceInput, options?: MutationOptions): Promise<ProjectWorkspace>
  createProjectWorkspaceWithTemplate(input: ProjectWorkspaceInput, options?: MutationOptions): Promise<ProjectWorkspace>
  applyProjectWorkspaceTemplate(input: ProjectWorkspaceTemplateApplyInput): Promise<ProjectWorkspaceTemplateApplyResult>
  updateProjectWorkspace(id: string, patch: ProjectWorkspacePatch, options?: MutationOptions): Promise<ProjectWorkspace>
  mutateProjectConnector(
    projectId: string,
    resourceId: string,
    mutation: ProjectConnectorMutation,
    options?: MutationOptions
  ): Promise<ProjectWorkspace>
  archiveProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectWorkspace>
  restoreProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectWorkspace>
  deleteProjectWorkspace(id: string, options?: ProjectWorkspaceDeleteOptions): Promise<ProjectWorkspace | undefined>
  purgeProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectDeletionResult>
  exportProjectWorkspaceManifest(id: string, destinationPath?: string): Promise<ProjectWorkspaceManifest>
  listProjectGoals(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<Goal[]>
  getProjectGoal(id: string): Promise<Goal | undefined>
  createProjectGoal(input: GoalInput, options?: MutationOptions): Promise<Goal>
  updateProjectGoal(id: string, patch: GoalPatch, options?: MutationOptions): Promise<Goal>
  transitionProjectGoal(id: string, status: GoalStatus, options?: MutationOptions): Promise<Goal>
  archiveProjectGoal(id: string, options?: MutationOptions): Promise<Goal>
  restoreProjectGoal(id: string, options?: MutationOptions): Promise<Goal>
  setProjectGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions): Promise<Goal>
  listProjectWorkItems(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<WorkItem[]>
  getProjectWorkItem(id: string): Promise<WorkItem | undefined>
  createProjectWorkItem(input: WorkItemInput, options?: MutationOptions): Promise<WorkItem>
  createProjectGoalTask(input: ProjectGoalTaskInput): Promise<ProjectGoalTaskResult>
  prepareProjectGoalTask(input: ProjectGoalTaskPrepareInput): Promise<ProjectGoalTaskPrepared>
  startProjectGoalTask(input: ProjectGoalTaskStartInput): Promise<ProjectGoalTaskStarted>
  updateProjectWorkItem(id: string, patch: WorkItemPatch, options?: MutationOptions): Promise<WorkItem>
  transferProjectWorkItem(input: WorkItemTransferInput): Promise<WorkItemTransferResult>
  reorderProjectWorkItem(id: string, targetId: string, placement: WorkItemReorderPlacement, options?: MutationOptions): Promise<WorkItem>
  transitionProjectWorkItem(id: string, status: WorkItemStatus, options?: MutationOptions): Promise<WorkItem>
  setProjectWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions): Promise<WorkItem>
  acquireProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  renewProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  releaseProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  listProjectSquads(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<ProjectSquad[]>
  getProjectSquad(id: string): Promise<ProjectSquad | undefined>
  createProjectSquad(input: ProjectSquadCreateInput, options?: MutationOptions): Promise<ProjectSquad>
  updateProjectSquad(id: string, patch: ProjectSquadPatch, options?: MutationOptions): Promise<ProjectSquad>
  archiveProjectSquad(id: string, options?: MutationOptions): Promise<ProjectSquad>
  restoreProjectSquad(id: string, options?: MutationOptions): Promise<ProjectSquad>
  addProjectSquadMember(id: string, member: ProjectSquadMemberInput, options?: MutationOptions): Promise<ProjectSquad>
  removeProjectSquadMember(id: string, memberType: WorkItemOwnerType, memberId: string, options?: MutationOptions): Promise<ProjectSquad>
  listProjectMembers(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<ProjectMember[]>
  getProjectMember(id: string): Promise<ProjectMember | undefined>
  createProjectMember(input: ProjectMemberCreateInput, options?: MutationOptions): Promise<ProjectMember>
  updateProjectMember(id: string, patch: ProjectMemberPatch, options?: MutationOptions): Promise<ProjectMember>
  revokeProjectMember(id: string, options?: MutationOptions): Promise<ProjectMember>
  restoreProjectMember(id: string, options?: MutationOptions): Promise<ProjectMember>
  listProjectInvitations(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<ProjectInvitation[]>
  createProjectInvitation(input: ProjectInvitationInput, options?: MutationOptions): Promise<ProjectInvitationCreateResult>
  acceptProjectInvitation(projectId: string, token: string, options?: MutationOptions): Promise<ProjectMember>
  revokeProjectInvitation(id: string, options?: MutationOptions): Promise<ProjectInvitation>
  listProjectComments(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<WorkItemComment[]>
  listProjectWorkItemComments(workItemId: string, options?: ProjectWorkspaceListOptions): Promise<WorkItemComment[]>
  createProjectWorkItemComment(input: ProjectWorkItemCommentCreateInput, options?: MutationOptions): Promise<WorkItemComment>
  updateProjectWorkItemComment(id: string, patch: WorkItemCommentPatch, options?: MutationOptions): Promise<WorkItemComment>
  deleteProjectWorkItemComment(id: string, options?: MutationOptions): Promise<WorkItemComment>
  listProjectSharedApprovals(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<WorkItemSharedApproval[]>
  getProjectSharedApproval(id: string): Promise<WorkItemSharedApproval | undefined>
  createProjectSharedApproval(input: ProjectWorkItemSharedApprovalCreateInput, options?: MutationOptions): Promise<WorkItemSharedApproval>
  decideProjectSharedApproval(id: string, input: WorkItemSharedApprovalDecisionInput, options?: MutationOptions): Promise<WorkItemSharedApproval>
  revokeProjectSharedApproval(id: string, options?: MutationOptions): Promise<WorkItemSharedApproval>
  listProjectCollaborationInbox(
    projectId: string,
    options?: ProjectCollaborationInboxListOptions
  ): Promise<ProjectCollaborationInboxItem[]>
  markProjectCollaborationInbox(
    input: ProjectCollaborationInboxMarkInput,
    options?: MutationOptions
  ): Promise<ProjectCollaborationInboxReceipt>
}

export function isProjectWorkspaceKind(value: unknown): value is ProjectWorkspaceKind {
  return value === 'personal' || value === 'office' || value === 'education' ||
    value === 'research' || value === 'software' || value === 'opc' || value === 'custom'
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return value === 'draft' || value === 'planned' || value === 'running' ||
    value === 'waiting_approval' || value === 'blocked' || value === 'verifying' ||
    value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'archived'
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return value === 'backlog' || value === 'ready' || value === 'running' ||
    value === 'waiting_approval' || value === 'blocked' || value === 'verifying' ||
    value === 'done' || value === 'failed' || value === 'cancelled'
}

export function isWorkItemType(value: unknown): value is WorkItemType {
  return value === 'research' || value === 'analysis' || value === 'planning' ||
    value === 'writing' || value === 'design' || value === 'coding' || value === 'review' ||
    value === 'testing' || value === 'documentation' || value === 'operations' ||
    value === 'delivery' || value === 'custom'
}

export function isGoalRiskLevel(value: unknown): value is GoalRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
}

export function isAcceptanceSatisfied(value: AcceptanceResult | undefined): boolean {
  return value?.status === 'passed' || value?.status === 'waived'
}
