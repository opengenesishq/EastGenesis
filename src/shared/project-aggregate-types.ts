import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerLease,
  RoleTemplate
} from './digital-worker-types'
import type { LearningAuditEvent, LearningRecord } from './learning-types'
import type {
  Goal,
  ProjectMember,
  ProjectInvitation,
  ProjectSquad,
  ProjectResource,
  ProjectWorkspace,
  ProjectWorkspaceEvent,
  WorkItem,
  WorkItemComment,
  WorkItemSharedApproval,
  ProjectCollaborationInboxReceipt
} from './project-workspace-types'
import type { WorkflowLedgerExportSelection, WorkflowRunRecord } from './workflow-types'
import type { Routine, RoutineRunRecord } from './types'
import type { ModelAttemptRecord } from './model-attempt-types'
import type { TaskSnapshotRecord } from './types'
import type { ProjectDependency, ProjectMilestone } from './project-portfolio-types'
import type { MediaProjectSlice } from './media-types'
import type { ProjectSubmissionReceiptSlice } from './submission-receipt-portability-types'
import type { ProjectPreparationSlice } from './preparation-portability-types'

export const PROJECT_AGGREGATE_SCHEMA_VERSION = 1 as const
export const PROJECT_AGGREGATE_FORMAT = 'caogen.project-aggregate.v1' as const
export const PROJECT_AGGREGATE_EXPORT_FORMAT = 'caogen.project-aggregate.export.v1' as const

export const PROJECT_AGGREGATE_OBJECT_KINDS = [
  'project',
  'resource',
  'goal',
  'work_item',
  'squad',
  'member',
  'invitation',
  'comment',
  'shared_approval',
  'digital_worker',
  'assignment',
  'lease',
  'run',
  'artifact',
  'artifact_edge',
  'artifact_location',
  'evidence',
  'evidence_link',
  'acceptance',
  'memory',
  'budget',
  'policy',
  'audit'
] as const

export type ProjectAggregateObjectKind = typeof PROJECT_AGGREGATE_OBJECT_KINDS[number]

export type ProjectAggregateObjectCounts = Record<ProjectAggregateObjectKind, number>
export type ProjectAggregateObjectDigests = Record<ProjectAggregateObjectKind, Record<string, string>>

export interface ProjectAggregateMemoryRecord {
  id: string
  projectId: string
  namespace: 'project_id' | 'legacy_path'
  namespaceDigest: string
  record: LearningRecord
}

export interface ProjectAggregateLearningAudit {
  id: string
  projectId: string
  namespace: ProjectAggregateMemoryRecord['namespace']
  event: LearningAuditEvent
}

export interface ProjectAggregateBudgetRecord {
  id: string
  projectId: string
  ownerKind: 'project' | 'goal' | 'digital_worker'
  ownerId: string
  value: Record<string, unknown>
}

export interface ProjectAggregatePolicyRecord {
  id: string
  projectId: string
  ownerKind: 'project' | 'digital_worker'
  ownerId: string
  policyKind: string
  value: unknown
}

export interface ProjectAggregateAuditRecord {
  id: string
  projectId: string
  source: 'project_workspace' | 'workflow_ledger' | 'digital_worker' | 'learning'
  occurredAt: number | string
  value: unknown
}

export interface ProjectAggregateWorkflowSelection {
  /** Explicit Project export is restorable; credential fields are sanitized later. */
  runs: WorkflowRunRecord[]
  artifacts: WorkflowLedgerExportSelection['artifacts']['items']
  artifactEdges: WorkflowLedgerExportSelection['artifactEdges']['items']
  artifactLocations: WorkflowLedgerExportSelection['artifactLocations']['items']
  acceptances: WorkflowLedgerExportSelection['acceptances']['items']
  evidenceLinks: WorkflowLedgerExportSelection['evidenceLinks']['items']
  taskEvidence: WorkflowLedgerExportSelection['taskEvidence']['items']
  workflowEvidence: WorkflowLedgerExportSelection['workflowEvidence']['items']
}

export interface ProjectAggregateSnapshot {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  format: typeof PROJECT_AGGREGATE_FORMAT
  projectId: string
  identityDigest: string
  projectRevision: number
  workspace: ProjectWorkspace
  resources: ProjectResource[]
  goals: Goal[]
  workItems: WorkItem[]
  squads: ProjectSquad[]
  members: ProjectMember[]
  invitations: ProjectInvitation[]
  comments: WorkItemComment[]
  sharedApprovals: WorkItemSharedApproval[]
  /** Added compatibly to v1; legacy exports omit the collection. */
  inboxReceipts?: ProjectCollaborationInboxReceipt[]
  digitalWorkers: DigitalWorker[]
  assignments: DigitalWorkerAssignment[]
  leases: DigitalWorkerLease[]
  workflow: ProjectAggregateWorkflowSelection
  memory: ProjectAggregateMemoryRecord[]
  budgets: ProjectAggregateBudgetRecord[]
  policies: ProjectAggregatePolicyRecord[]
  audit: ProjectAggregateAuditRecord[]
  objectCounts: ProjectAggregateObjectCounts
  objectDigests: ProjectAggregateObjectDigests
  aggregateDigest: string
  sanitized: true
}

export interface ProjectAggregateSeal {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  projectId: string
  aggregateRevision: number
  projectRevision: number
  identityDigest: string
  aggregateDigest: string
  objectCounts: ProjectAggregateObjectCounts
  objectDigests: ProjectAggregateObjectDigests
  sealedAt: number
}

export interface ProjectAggregateVerification {
  valid: true
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  projectId: string
  aggregateRevision: number
  identityDigest: string
  aggregateDigest: string
  objectCounts: ProjectAggregateObjectCounts
  sanitized: true
  sealed: true
}

/** Global records required to make the Project-owned aggregate usable after import. */
export interface ProjectAggregateDependencies {
  roleTemplates: RoleTemplate[]
}

export interface ProjectAggregateAutomation {
  routines: Routine[]
  runs: RoutineRunRecord[]
}

export interface ProjectAggregatePortfolio {
  dependencies: ProjectDependency[]
  milestones: ProjectMilestone[]
}

export interface ProjectAggregateArtifactBlob {
  digest: string
  sizeBytes: number
  encoding: 'base64'
  data: string
}

export interface ProjectAggregateArtifactSourceFile extends ProjectAggregateArtifactBlob {
  artifactId: string
  /** Safe extension only; source host paths and filenames are never used at the destination. */
  extension: string
}

export interface ProjectAggregatePortableFile {
  path: string
  digest: string
  sizeBytes: number
  encoding: 'base64'
  data: string
}

export interface ProjectAggregatePortableTaskPlan {
  sessionId: string
  value: unknown
}

export interface ProjectAggregateEffectArtifact {
  /** App-private relative path. Host userData paths are never exported as the portable identity. */
  artifactRef: string
  effectIds: string[]
  files: ProjectAggregatePortableFile[]
}

export interface ProjectAggregateExternalFileManifest {
  kind: 'learning_skill' | 'office_artifact'
  ownerId: string
  resourceId?: string
  /** POSIX-style path relative to the declared external owner root. */
  relativePath: string
  digest: string
  sizeBytes: number
  content: 'external_manifest_only' | 'artifact_source_bytes'
}

/** Recovery/runtime records that are Project-owned but not part of the sealed business aggregate. */
export interface ProjectAggregatePortableRuntime {
  schemaVersion: 1
  sessionIds: string[]
  sdkSessionIds: string[]
  sessionHistory: unknown[]
  activeSessions: unknown[]
  sessionCreationJournal: unknown[]
  taskPlans: ProjectAggregatePortableTaskPlan[]
  sessionFiles: ProjectAggregatePortableFile[]
  /** Optional for exports predating durable task submission and in-flight additions. */
  submissionReceipts?: ProjectSubmissionReceiptSlice
  /** Optional for bundles created before isolated preparation drafts were portable. */
  preparation?: ProjectPreparationSlice
  taskSnapshots: TaskSnapshotRecord[]
  modelAttempts: ModelAttemptRecord[]
  artifactLifecycles: unknown[]
  artifactPurges: unknown[]
  /** Optional for backward compatibility with exports created before mutable retention policies. */
  artifactRetentionRevisions?: unknown[]
  artifactBlobs: ProjectAggregateArtifactBlob[]
  /** Optional for backward compatibility with exports created before source_ref portability. */
  artifactSourceFiles?: ProjectAggregateArtifactSourceFile[]
  /** Optional only when the export contains no Effect target backed by an app-private artifact. */
  effectArtifacts?: ProjectAggregateEffectArtifact[]
  /** Optional for backward compatibility with exports created before external-file inventory. */
  externalFiles?: ProjectAggregateExternalFileManifest[]
  runtimeDigest: string
}

export interface ProjectAggregateExportBundle {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  format: typeof PROJECT_AGGREGATE_EXPORT_FORMAT
  projectId: string
  aggregateRevision: number
  aggregate: ProjectAggregateSnapshot
  dependencies: ProjectAggregateDependencies
  /** Project-owned local automation. Optional only for backward-compatible v1 imports. */
  automation?: ProjectAggregateAutomation
  /** Cross-Project dependency records touching this Project and its owned milestones. */
  portfolio?: ProjectAggregatePortfolio
  /** Project-owned video production and MediaJob state. Optional for backward-compatible v1 imports. */
  media?: MediaProjectSlice
  /** Optional only for backward-compatible exports created before runtime portability. */
  runtime?: ProjectAggregatePortableRuntime
  verification: ProjectAggregateVerification
  exportDigest: string
}

export interface ProjectAggregateExportResult {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  format: typeof PROJECT_AGGREGATE_EXPORT_FORMAT
  json: string
  exportDigest: string
  bundle: ProjectAggregateExportBundle
}

export interface ProjectAggregateDeliveryExportResult extends ProjectAggregateExportResult {
  workflowArtifactId: string
  workflowEvidenceId: string
  workflowAcceptanceId: string
  workflowGoalId: string
  workflowWorkItemId: string
  workflowRunId: string
}

export interface ProjectAggregateReference {
  kind: ProjectAggregateObjectKind
  id: string
}

export interface ProjectAggregateAuthorization {
  projectId: string
  aggregateRevision: number
  aggregateDigest: string
  references: ProjectAggregateReference[]
}

export interface ProjectAggregateRoots {
  workspaceRoot: string
  workflowRoot: string
  digitalWorkerRoot: string
  routineRoot: string
  learningRoot: string
  aggregateRoot: string
  /** Optional path-based namespaces are read for compatibility, never as Project identity. */
  legacyLearningRoots?: Record<string, string[]>
}

export interface ProjectAggregateSealOptions {
  expectedAggregateRevision?: number
  now?: number
}

export interface ProjectAggregateQueryOptions {
  expectedAggregateRevision?: number
  expectedAggregateDigest?: string
}

export type ProjectAggregateWorkspaceAudit = ProjectWorkspaceEvent
