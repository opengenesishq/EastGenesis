import type {
  WorkflowAcceptanceStatus,
  WorkflowArtifactKind,
  WorkflowArtifactLocationAvailability,
  WorkflowArtifactLocationKind,
  WorkflowEvidenceKind,
  WorkflowEvidenceSource
} from './workflow-types'
import type { GoalRiskLevel, GoalStatus, ProjectWorkspaceKind, ProjectWorkspaceStatus, WorkItemStatus, WorkItemType } from './project-workspace-types'
import type { TaskRunStatus } from './types'

export const STUDIO_RESULT_SCHEMA_VERSION = 1 as const
export const STUDIO_RESULT_FORMAT = 'caogen.studio-result.v1' as const
export const STUDIO_RESULT_EXPORT_FORMAT = 'caogen.studio-result.export.v1' as const

export type StudioResultState = 'unbound' | 'ready'
export type StudioResultBindingLevel = 'conversation' | 'project' | 'goal' | 'work_item'

export interface StudioResultScope {
  sessionId: string
  level: StudioResultBindingLevel
  workspaceId?: string
  goalId?: string
  workItemId?: string
}

export interface StudioResultWorkspace {
  id: string
  name: string
  kind: ProjectWorkspaceKind
  status: ProjectWorkspaceStatus
  revision: number
}

export interface StudioResultGoal {
  id: string
  title: string
  objective: string
  status: GoalStatus
  riskLevel: GoalRiskLevel
  constraints: string[]
  successCriteria: string[]
  dueAt?: number
  revision: number
}

export interface StudioResultWorkItem {
  id: string
  goalId?: string
  parentId?: string
  title: string
  description?: string
  type: WorkItemType
  status: WorkItemStatus
  priority: number
  dueAt?: number
  ownerLabel?: string
  runRefs: string[]
  artifactRefs: string[]
  revision: number
}

export interface StudioResultRun {
  id: string
  sessionId: string
  workItemId: string
  status: TaskRunStatus
  attempt: number
  revision: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  taskRunDigest: string
  errorDigest?: string
  costUsd?: number
  /** Recorded request cost coverage; values may include the runtime's price estimate. */
  costCoverage?: 'complete' | 'partial' | 'unavailable'
}

export interface StudioResultArtifactLocation {
  id: string
  kind: WorkflowArtifactLocationKind
  availability: WorkflowArtifactLocationAvailability
  uri?: string
  path?: string
  checksum?: string
  sizeBytes?: number
  mediaType?: string
}

export type StudioResultDeliveryCategory = 'office' | 'code' | 'media' | 'report' | 'package' | 'other'
export type StudioResultArtifactDeliveryStatus =
  | 'ready'
  | 'verification_pending'
  | 'evidence_missing'
  | 'failed'
  | 'unavailable'
  | 'superseded'

export interface StudioResultArtifact {
  id: string
  runId?: string
  workItemId?: string
  title: string
  kind: WorkflowArtifactKind
  version: number
  digest: string
  mediaType?: string
  deliveryCategory: StudioResultDeliveryCategory
  deliveryStatus: StudioResultArtifactDeliveryStatus
  supersedesId?: string
  /** Current deliverable leaf versions for this Artifact's retained lineage. */
  currentArtifactIds: string[]
  deliveryScope: 'current' | 'historical'
  createdAt: number
  updatedAt: number
  locations: StudioResultArtifactLocation[]
  inboundRelations: number
  outboundRelations: number
  evidenceIds: string[]
  acceptanceIds: string[]
}

export interface StudioResultEvidence {
  id: string
  origin: 'workflow' | 'task_effect'
  kind?: WorkflowEvidenceKind | string
  source?: WorkflowEvidenceSource
  title: string
  summary?: string
  /** Recorded research source, restricted to credential-free HTTP(S). Never inferred from prose. */
  sourceUri?: string
  sourceContentKind?: 'search_snippet'
  runId?: string
  artifactId?: string
  observedAt: number
  verifier: string
  contentDigest: string
}

export interface StudioResultAcceptance {
  id: string
  goalId?: string
  workItemId?: string
  status: WorkflowAcceptanceStatus
  deliveryScope?: 'blocking' | 'historical'
  criteria: string[]
  coveredCriteria: number
  evidenceRefs: string[]
  verifier?: string
  verifiedAt?: number
  waiverReason?: string
  waivedBy?: string
  notes?: string
  repairWorkItemId?: string
  repairWorkItemStatus?: WorkItemStatus
  revision: number
  updatedAt: number
}

export type StudioResultTestStatus = 'passed' | 'failed' | 'recorded'

export interface StudioResultTest {
  id: string
  title: string
  status: StudioResultTestStatus
  source: 'artifact' | 'evidence'
  artifactId?: string
  evidenceId?: string
  digest: string
  observedAt: number
}

export type StudioResultIssueSeverity = 'info' | 'warning' | 'critical'

export interface StudioResultIssue {
  id: string
  kind: 'risk' | 'open_item' | 'approval'
  severity: StudioResultIssueSeverity
  title: string
  status: string
  refType: 'goal' | 'work_item' | 'run' | 'artifact' | 'acceptance' | 'evidence'
  refId: string
}

export interface StudioResultTimelineItem {
  id: string
  source: 'project_workspace' | 'workflow_ledger' | 'digital_worker' | 'learning'
  occurredAt: number
  kind: string
  entityType?: string
  entityId?: string
}

export type StudioAuditTimelineState = 'ready' | 'unbound' | 'integrity_error'
export type StudioAuditTimelineCategory =
  | 'domain'
  | 'run'
  | 'model_attempt'
  | 'tool'
  | 'effect'
  | 'approval'
  | 'evidence'
  | 'acceptance'
  | 'integrity'

export interface StudioAuditActor {
  kind: 'digital_worker' | 'human' | 'system'
  label: string
  role?: string
  workerId?: string
  assignmentId?: string
}

/** Renderer-safe audit projection. Raw prompts, tool inputs/outputs and Effect targets never enter this contract. */
export interface StudioAuditTimelineItem {
  id: string
  occurredAt: number
  category: StudioAuditTimelineCategory
  action: string
  status: string
  actor: StudioAuditActor
  projectId: string
  goalId?: string
  workItemId?: string
  runId?: string
  entityType?: string
  entityId?: string
  reason?: string
  providerId?: string
  model?: string
  protocol?: string
  keyLabel?: string
  /** Persisted adapter version; this is not an executor identity. */
  adapterVersion?: string
  executorReceipt?: import('./model-attempt-types').ModelExecutorReceipt
  executionDomain?: string
  requestId?: string
  permissionDecision?: 'allow' | 'deny'
  approvalResolvedEventId?: string
  effectId?: string
  costUsd?: number
  costCoverage?: 'complete' | 'partial' | 'unavailable'
  toolName?: string
  targetKind?: string
  resultDigest?: string
  evidenceId?: string
  acceptanceId?: string
  integrity: 'verified' | 'missing_reference'
}

export interface StudioAuditTimelineQuery {
  runId?: string
  limit?: number
  cursor?: string
}

export interface StudioAuditTimelineIntegrity {
  projectAggregate: 'verified' | 'unavailable' | 'failed'
  modelAttemptLedger: 'verified' | 'unavailable' | 'failed'
  missingReferences: number
  sourceDigest?: string
  pageDigest?: string
}

export interface StudioAuditTimelinePage {
  schemaVersion: 1
  format: 'caogen.studio-audit-timeline.v1'
  state: StudioAuditTimelineState
  scope: StudioResultScope
  items: StudioAuditTimelineItem[]
  total: number
  hasMore: boolean
  nextCursor?: string
  integrity: StudioAuditTimelineIntegrity
  errorCode?: 'PROJECT_INTEGRITY' | 'MODEL_ATTEMPT_INTEGRITY'
}

/** Coverage describes persisted sources, not successful execution or acceptance. */
export interface StudioExecutionAuditCoverage {
  status: 'complete' | 'partial' | 'unavailable'
  /** Runs for model/executor coverage; tool executions for permission coverage. */
  recorded: number
  total: number
  missingRunIds: string[]
}

export interface StudioExecutionAudit {
  schemaVersion: 1
  format: 'caogen.studio-execution-audit.v1'
  scope: StudioResultScope
  generatedAt: number
  aggregateDigest: string
  resultDigest: string
  sourceDigest: string
  items: StudioAuditTimelineItem[]
  total: number
  missingReferences: number
  coverage: {
    modelAttempts: StudioExecutionAuditCoverage
    executors: StudioExecutionAuditCoverage
    permissions: StudioExecutionAuditCoverage
  }
}

export interface StudioDeliverySummary {
  includedArtifacts: number
  omittedArtifacts: number
  auditItems: number
  acceptanceSummary: { total: number; passed: number; waived: number; pending: number; verifying: number; failed: number }
}

export interface StudioResultCostSummary {
  /** ModelAttempt records only; never a verified supplier invoice or all execution expenses. */
  source?: 'model_attempt_records'
  knownUsd: number
  knownRunCount: number
  totalRunCount: number
  coverage: 'complete' | 'partial' | 'unavailable'
}

export interface StudioResultSummary {
  runs: number
  artifacts: number
  currentArtifacts: number
  historicalArtifacts: number
  availableArtifacts: number
  readyArtifacts: number
  attentionArtifacts: number
  evidence: number
  acceptances: number
  passedAcceptances: number
  tests: number
  changes: number
  openItems: number
  approvals: number
  risks: number
}

export interface StudioResultVerification {
  canonicalAggregateVerified: boolean
  sanitized: true
  identityDigest?: string
  aggregateDigest?: string
  resultDigest: string
}

export interface StudioResultSnapshot {
  schemaVersion: typeof STUDIO_RESULT_SCHEMA_VERSION
  format: typeof STUDIO_RESULT_FORMAT
  state: StudioResultState
  generatedAt: number
  scope: StudioResultScope
  workspace?: StudioResultWorkspace
  goal?: StudioResultGoal
  workItems: StudioResultWorkItem[]
  runs: StudioResultRun[]
  artifacts: StudioResultArtifact[]
  evidence: StudioResultEvidence[]
  acceptances: StudioResultAcceptance[]
  tests: StudioResultTest[]
  risks: StudioResultIssue[]
  openItems: StudioResultIssue[]
  approvals: StudioResultIssue[]
  timeline: StudioResultTimelineItem[]
  cost: StudioResultCostSummary
  summary: StudioResultSummary
  verification: StudioResultVerification
}

export interface StudioResultExportBundle {
  schemaVersion: typeof STUDIO_RESULT_SCHEMA_VERSION
  format: typeof STUDIO_RESULT_EXPORT_FORMAT
  snapshot: StudioResultSnapshot
  executionAudit?: StudioExecutionAudit
  verification: StudioResultVerification
  exportDigest: string
}

export interface StudioResultExportResult {
  schemaVersion: typeof STUDIO_RESULT_SCHEMA_VERSION
  format: typeof STUDIO_RESULT_EXPORT_FORMAT
  json: string
  exportDigest: string
  bundle: StudioResultExportBundle
}

export interface StudioResultSaveResult extends Partial<StudioDeliverySummary> {
  canceled: boolean
  filePath?: string
  exportDigest?: string
  workflowArtifactId?: string
  workflowEvidenceId?: string
  workflowAcceptanceId?: string
}

export interface StudioResultApi {
  checkStudioResultFiles(sessionId: string): Promise<import('./studio-result-file-change-types').StudioResultFileCheck>
  previewStudioResultRerun(sessionId: string, input: import('./studio-result-rerun-types').StudioResultRerunInput): Promise<import('./studio-result-rerun-types').StudioResultRerunPreview>
  confirmStudioResultRerun(sessionId: string, input: import('./studio-result-rerun-types').StudioResultRerunConfirmInput): Promise<import('./studio-result-rerun-types').StudioResultRerunResult>
  getStudioResultSnapshot(sessionId: string): Promise<StudioResultSnapshot>
  queryStudioAuditTimeline(
    sessionId: string,
    query?: StudioAuditTimelineQuery
  ): Promise<StudioAuditTimelinePage>
  exportStudioResultSnapshot(sessionId: string): Promise<StudioResultExportResult>
  saveStudioResultSnapshot(sessionId: string): Promise<StudioResultSaveResult>
}
