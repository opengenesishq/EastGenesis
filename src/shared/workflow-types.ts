import type { TaskRunRecord, TaskRunStatus } from './types'
import type { BusinessLineBinding } from './business-line-types'
export type WorkflowGoalStatus =
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
export type WorkflowWorkItemStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'
export type WorkflowWorkItemType =
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

export type WorkflowProjectionSource = 'explicit' | 'dag' | 'legacy-derived' | 'recovery'

export type WorkflowEventEntityType = 'goal' | 'work_item' | 'run' | 'artifact' | 'acceptance' | 'system'

export type WorkflowArtifactKind =
  | 'report'
  | 'source'
  | 'requirement'
  | 'design'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'code'
  | 'patch'
  | 'diff'
  | 'test_report'
  | 'screenshot'
  | 'pull_request'
  | 'issue'
  | 'release_package'
  | 'custom'

export type WorkflowAcceptanceStatus = 'pending' | 'verifying' | 'passed' | 'failed' | 'waived'

export type WorkflowEvidenceKind =
  | 'research_source'
  | 'review_result'
  | 'test_result'
  | 'approval'
  | 'observation'
  | 'metric'
  | 'security_scan'
  | 'delivery_check'
  | 'custom'

export type WorkflowEvidenceSource = 'runtime' | 'human' | 'imported' | 'recovery'

export interface WorkflowEvidenceInput {
  evidenceId: string
  projectId: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  kind: WorkflowEvidenceKind
  source?: WorkflowEvidenceSource
  title: string
  summary?: string
  uri?: string
  mediaType?: string
  verifier: string
  observedAt?: number
  contentDigest: string
  metadata?: Record<string, unknown>
}

/** Renderer-safe evidence input. Trusted provenance is assigned in main. */
export type WorkflowEvidenceCreateInput = Omit<
  WorkflowEvidenceInput,
  'source' | 'verifier' | 'observedAt'
>

export interface WorkflowEvidenceRecord extends WorkflowEvidenceInput {
  schemaVersion: 1
  seq: number
  id: string
  source: WorkflowEvidenceSource
  observedAt: number
  createdAt: number
  prevDigest: string
  digest: string
}

export interface WorkflowEvidenceScope {
  evidenceId?: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  kind?: WorkflowEvidenceKind
  limit?: number
  /** Opaque decimal offset returned as nextCursor. */
  cursor?: string
}

export interface WorkflowEvidenceVerification {
  valid: true
  count: number
  lastSeq: number
  lastDigest: string
}
export interface WorkflowAcceptanceCriterionEvidence {
  criterionId: string
  criterionIndex: number
  evidenceRefs: string[]
}

export interface WorkflowAcceptanceCriterionPolicy {
  criterionId: string; criterionIndex: number
  evidenceKind: WorkflowEvidenceKind; allowedSources: WorkflowEvidenceSource[]
}
export interface WorkflowArtifactRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactKind
  title: string
  uri?: string
  version: number
  digest: string
  mediaType?: string
  provenance: WorkflowProjectionSource
  createdAt: number
  updatedAt: number
  supersedesId?: string
  metadata?: Record<string, unknown>
}

export type WorkflowArtifactEdgeRelation =
  | 'derived_from'
  | 'produced_from'
  | 'input_to'
  | 'output_of'
  | 'supports'
  | 'verifies'
  | 'supersedes'
  | 'annotates'
  | 'references'
  | 'depends_on'
  | 'related_to'
  | 'custom'

export type WorkflowArtifactLocationKind =
  | 'blob'
  | 'file'
  | 'workspace'
  | 'url'
  | 'git'
  | 'attachment'
  | 'preview'
  | 'external'
  | 'custom'

export type WorkflowArtifactLocationAvailability =
  | 'available'
  | 'pending'
  | 'unavailable'
  | 'deleted'
  | 'unknown'

export interface WorkflowArtifactGraphScope {
  projectId?: string
  artifactId?: string
  fromArtifactId?: string
  toArtifactId?: string
  relation?: WorkflowArtifactEdgeRelation
  kind?: WorkflowArtifactLocationKind
  availability?: WorkflowArtifactLocationAvailability
  cursor?: string
  limit?: number
}

export interface WorkflowArtifactEdgeInput {
  id: string
  fromArtifactId: string
  toArtifactId: string
  relation: WorkflowArtifactEdgeRelation
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  metadata?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

export interface WorkflowArtifactEdgeRecord {
  schemaVersion: 1
  id: string
  fromArtifactId: string
  toArtifactId: string
  relation: WorkflowArtifactEdgeRelation
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface WorkflowArtifactLocationInput {
  id?: string
  artifactId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactLocationKind
  uri?: string
  path?: string
  availability?: WorkflowArtifactLocationAvailability
  checksum?: string
  sizeBytes?: number
  mediaType?: string
  metadata?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

export interface WorkflowArtifactLocationRecord {
  schemaVersion: 1
  id: string
  artifactId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactLocationKind
  uri?: string
  path?: string
  availability: WorkflowArtifactLocationAvailability
  checksum?: string
  sizeBytes?: number
  mediaType?: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface WorkflowArtifactNeighborhood {
  artifact: WorkflowArtifactRecord
  inbound: WorkflowArtifactEdgeRecord[]
  outbound: WorkflowArtifactEdgeRecord[]
  locations: WorkflowArtifactLocationRecord[]
}

export interface WorkflowArtifactGraphVerification {
  valid: true
  artifacts: number
  edges: number
  locations: number
  events: number
  lastSeq: number
  lastDigest: string
}

export interface WorkflowArtifactGraphSelection {
  edges: WorkflowLedgerPage<WorkflowArtifactEdgeRecord>
  locations: WorkflowLedgerPage<WorkflowArtifactLocationRecord>
}

export interface WorkflowAcceptanceRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  criteria: string[]
  criterionPolicies?: WorkflowAcceptanceCriterionPolicy[]
  status: WorkflowAcceptanceStatus
  evidenceRefs: string[]
  criterionEvidence?: WorkflowAcceptanceCriterionEvidence[]
  verifier?: string
  verifiedAt?: number
  waiverReason?: string
  waivedBy?: string
  notes?: string
  revision: number
  createdAt: number
  updatedAt: number
}
export interface WorkflowEvidenceLinkRecord {
  schemaVersion: 1
  id: string
  evidenceId: string
  projectId?: string
  runId?: string
  artifactId?: string
  acceptanceId?: string
  /** Criterion covered by this link when relation is `verifies`. */
  criterionId?: string
  /** Omitted legacy records always reference TaskRun Effect evidence. */
  evidenceOrigin?: 'task_effect' | 'workflow'
  relation: 'supports' | 'verifies' | 'supersedes'
  createdAt: number
}

export interface WorkflowGoalRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  title: string
  objective: string
  status: WorkflowGoalStatus
  revision: number
  source: WorkflowProjectionSource
  createdAt: number
  updatedAt: number
  dueAt?: number
  archivedAt?: number
}

export interface WorkflowWorkItemRecord extends BusinessLineBinding {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  parentId?: string
  type: WorkflowWorkItemType
  title: string
  description?: string
  role?: string
  status: WorkflowWorkItemStatus
  revision: number
  source: WorkflowProjectionSource
  runIds: string[]
  currentRunId?: string
  createdAt: number
  updatedAt: number
  dueAt?: number
}
export interface WorkflowRunRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  workItemId: string
  sessionId: string
  taskId: string
  /** Acceptance revision that owned this Run when first projected. */ acceptanceId?: string; acceptanceRevision?: number
  status: TaskRunStatus
  revision: number
  attempt: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  /** Full validated TaskRun payload remains available for recovery/effect readers. */
  taskRun: TaskRunRecord
}

export interface WorkflowProjectionContext {
  projectId?: string
  goalId?: string
  workItemId?: string
  workItemTitle?: string
  workItemDescription?: string
  workItemType?: WorkflowWorkItemType
  parentWorkItemId?: string
  role?: string
  source?: WorkflowProjectionSource
  /** The rich ProjectWorkspace source, not TaskRun projection, owns WorkItem mutations. */
  canonicalSourceAuthority?: boolean
  goalTitle?: string
  goalObjective?: string
  event?: WorkflowEventInput
}

export interface WorkflowGoalProjectionInput {
  id: string
  projectId?: string
  title: string
  objective: string
  status?: WorkflowGoalStatus
  revision?: number
  source?: WorkflowProjectionSource
  createdAt?: number
  updatedAt?: number
  dueAt?: number
  archivedAt?: number
}

export interface WorkflowArtifactInput {
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactKind
  title: string
  uri?: string
  version?: number
  digest: string
  mediaType?: string
  provenance?: WorkflowProjectionSource
  createdAt?: number
  updatedAt?: number
  supersedesId?: string
  metadata?: Record<string, unknown>
}

export interface WorkflowAcceptanceInput {
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  criteria: string[]
  criterionPolicies?: WorkflowAcceptanceCriterionPolicy[]
  status?: WorkflowAcceptanceStatus
  evidenceRefs?: string[]
  criterionEvidence?: WorkflowAcceptanceCriterionEvidence[]
  verifier?: string
  verifiedAt?: number
  waiverReason?: string
  waivedBy?: string
  notes?: string
  revision?: number
  createdAt?: number
  updatedAt?: number
}

export interface WorkflowArtifactAcceptanceCreateInput {
  artifactId: string
}

export interface WorkflowArtifactAcceptanceCreateResult {
  acceptance: WorkflowAcceptanceRecord
  bindingEvidence: WorkflowEvidenceRecord
  bindingLink: WorkflowEvidenceLinkRecord
  disposition: 'created' | 'existing'
}

export interface WorkflowArtifactExportInput {
  artifactId: string
}

export type WorkflowArtifactExportResult =
  | { canceled: true }
  | {
      canceled: false
      artifactId: string
      fileName: string
      sizeBytes: number
      digest: string
    }

export interface WorkflowArtifactCompareInput {
  baseArtifactId: string
  targetArtifactId: string
}

export interface WorkflowArtifactCompareSide {
  artifactId: string
  title: string
  version: number
  digest: string
  sizeBytes: number
}

export interface WorkflowArtifactTextChange {
  kind: 'context' | 'added' | 'removed'
  text: string
}

export interface WorkflowArtifactCompareResult {
  base: WorkflowArtifactCompareSide
  target: WorkflowArtifactCompareSide
  comparison: 'identical' | 'text' | 'binary'
  sizeDeltaBytes: number
  addedLines: number
  removedLines: number
  changes: WorkflowArtifactTextChange[]
  truncated: boolean
}

export interface WorkflowArtifactIntegrityInput {
  artifactId: string
}

export type WorkflowArtifactIntegrityCheckKind =
  | 'canonical_ownership'
  | 'artifact_graph'
  | 'current_version'
  | 'local_location'
  | 'content_identity'
  | 'evidence_binding'
  | 'acceptance_status'

export interface WorkflowArtifactIntegrityCheck {
  kind: WorkflowArtifactIntegrityCheckKind
  status: 'passed' | 'blocked'
  message: string
}

export interface WorkflowArtifactIntegrityBlocker {
  code:
    | 'HISTORICAL_VERSION'
    | 'LOCAL_LOCATION_UNVERIFIED'
    | 'EVIDENCE_MISSING'
    | 'ACCEPTANCE_MISSING'
    | 'ACCEPTANCE_PENDING'
    | 'ACCEPTANCE_FAILED'
  message: string
}

export interface WorkflowArtifactIntegrityEvidence {
  evidenceId: string
  kind: WorkflowEvidenceKind
  source: WorkflowEvidenceSource
  verifier: string
  observedAt: number
  contentDigest: string
}

export interface WorkflowArtifactIntegrityAcceptance {
  acceptanceId: string
  status: WorkflowAcceptanceStatus
  revision: number
  evidenceRefs: string[]
  verifier?: string
  verifiedAt?: number
}

/** Renderer-safe verification result. It intentionally excludes source paths and bytes. */
export interface WorkflowArtifactIntegrityReport {
  schemaVersion: 1
  format: 'caogen.artifact-integrity-report.v1'
  artifact: {
    id: string
    projectId: string
    title: string
    kind: WorkflowArtifactKind
    version: number
    digest: string
    mediaType?: string
    sizeBytes?: number
  }
  lineage: {
    predecessorArtifactId?: string
    successorArtifactIds: string[]
    currentArtifactIds: string[]
    lineageArtifactIds: string[]
    current: boolean
  }
  locations: {
    total: number
    available: number
    availableLocal: number
    byteVerified: boolean
  }
  evidence: WorkflowArtifactIntegrityEvidence[]
  acceptances: WorkflowArtifactIntegrityAcceptance[]
  checks: WorkflowArtifactIntegrityCheck[]
  blockers: WorkflowArtifactIntegrityBlocker[]
  verdict: 'ready' | 'blocked'
  verifiedAt: number
}

export interface WorkflowArtifactManifestExportInput {
  artifactId: string
}

export type WorkflowArtifactManifestExportResult =
  | { canceled: true }
  | {
      canceled: false
      artifactId: string
      fileName: string
      sizeBytes: number
      manifestDigest: string
      verdict: WorkflowArtifactIntegrityReport['verdict']
    }

export interface WorkflowProjectDeliveryIntegrityInput {
  projectId: string
}

export interface WorkflowProjectDeliveryBlockerCount {
  code: WorkflowArtifactIntegrityBlocker['code']
  count: number
}

export interface WorkflowProjectDeliveryIntegrityReport {
  schemaVersion: 1
  format: 'caogen.project-delivery-integrity-report.v1'
  projectId: string
  generatedAt: number
  verdict: 'ready' | 'blocked'
  summary: {
    currentArtifactCount: number
    readyArtifactCount: number
    blockedArtifactCount: number
    verifiedBytes: number
    blockerCounts: WorkflowProjectDeliveryBlockerCount[]
  }
  artifacts: WorkflowArtifactIntegrityReport[]
}

export interface WorkflowProjectDeliveryManifestExportInput {
  projectId: string
}

export type WorkflowProjectDeliveryManifestExportResult =
  | { canceled: true }
  | {
      canceled: false
      projectId: string
      fileName: string
      sizeBytes: number
      manifestDigest: string
      verdict: WorkflowProjectDeliveryIntegrityReport['verdict']
      readyArtifactCount: number
      blockedArtifactCount: number
    }

export interface WorkflowProjectDeliveryPackageExportInput {
  projectId: string
}

export type WorkflowProjectDeliveryPackageExportResult =
  | { canceled: true }
  | {
      canceled: false
      projectId: string
      fileName: string
      sizeBytes: number
      packageDigest: string
      manifestDigest: string
      signatureStatus: 'valid'
      signingIdentityFingerprint: string
      identityTrust: 'local_identity'
      verdict: WorkflowProjectDeliveryIntegrityReport['verdict']
      includedArtifactCount: number
      blockedArtifactCount: number
    }

export type WorkflowProjectDeliveryPackageVerificationBlockerCode =
  | 'FILE_UNREADABLE'
  | 'FILE_CHANGED'
  | 'ZIP_INVALID'
  | 'ZIP_ENTRY_LIMIT'
  | 'ZIP_SIZE_LIMIT'
  | 'ZIP_PATH_INVALID'
  | 'ZIP_DUPLICATE_PATH'
  | 'ZIP_ENTRY_UNSAFE'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_DUPLICATE'
  | 'MANIFEST_TOO_LARGE'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_DIGEST_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_REQUIRED'
  | 'IDENTITY_NOT_TRUSTED'
  | 'IDENTITY_REVOKED'
  | 'TRUST_POLICY_UNAVAILABLE'
  | 'ENTRY_UNDECLARED'
  | 'ARTIFACT_ENTRY_MISSING'
  | 'ARTIFACT_SIZE_MISMATCH'
  | 'ARTIFACT_DIGEST_MISMATCH'

export interface WorkflowProjectDeliveryPackageVerificationBlocker {
  code: WorkflowProjectDeliveryPackageVerificationBlockerCode
  message: string
  entry?: string
}

/** Renderer-safe offline package verdict. Local paths and entry bytes are intentionally excluded. */
export type WorkflowProjectDeliveryPackageVerificationResult =
  | { canceled: true }
  | {
      canceled: false
      schemaVersion: 1
      format: 'caogen.project-delivery-package-verification.v1'
      verificationId: string
      verdict: 'verified' | 'rejected'
      byteIntegrity: 'verified' | 'rejected'
      signatureStatus: 'valid' | 'invalid' | 'unsigned'
      identityTrust: 'local_identity' | 'trusted_identity' | 'revoked_identity' | 'unknown_identity' | 'unsigned'
      trustPolicyMode: WorkflowDeliveryTrustPolicyMode
      trustPolicyVerdict: 'passed' | 'blocked'
      signingIdentityFingerprint?: string
      signingIdentityLabel?: string
      fileName: string
      verifiedAt: number
      sizeBytes?: number
      packageDigest?: string
      projectId?: string
      manifestDigest?: string
      manifestVerdict?: WorkflowProjectDeliveryIntegrityReport['verdict']
      entryCount?: number
      declaredArtifactCount?: number
      verifiedArtifactCount?: number
      verifiedArtifactBytes?: number
      blockers: WorkflowProjectDeliveryPackageVerificationBlocker[]
    }

export interface WorkflowProjectDeliveryPackageVerificationReceiptSaveInput {
  verificationId: string
}

export interface WorkflowDeliveryTrustedIdentityView {
  fingerprint: string
  label: string
  status: 'trusted' | 'revoked'
  trustedAt: number
  updatedAt: number
  lastVerifiedAt: number
  lastProjectId?: string
  revokedAt?: number
}

export interface WorkflowDeliveryIdentityTrustSnapshot {
  schemaVersion: 1
  format: 'caogen.workflow-delivery-identity-trust-view.v1'
  revision: number
  identities: WorkflowDeliveryTrustedIdentityView[]
  localIdentityStatus: 'available' | 'protected_storage_unavailable'
  localIdentity?: WorkflowDeliveryLocalIdentityView
  policy: WorkflowDeliveryTrustPolicyView
}
export type WorkflowDeliveryTrustPolicyMode =
  | 'audit_only'
  | 'require_valid_signature'
  | 'require_trusted_identity'

export interface WorkflowDeliveryTrustPolicyView {
  mode: WorkflowDeliveryTrustPolicyMode
  updatedAt: number
}

export interface WorkflowDeliveryTrustPolicyUpdateInput {
  mode: WorkflowDeliveryTrustPolicyMode
  expectedRevision: number
}

export interface WorkflowDeliveryRetiredLocalIdentityView {
  fingerprint: string
  retiredAt: number
  reason: 'rotated' | 'restored'
}

export interface WorkflowDeliveryLocalIdentityView {
  fingerprint: string
  createdAt: number
  retiredIdentities: WorkflowDeliveryRetiredLocalIdentityView[]
}

export interface WorkflowDeliveryIdentityTrustInput {
  verificationId: string
  label: string
  expectedRevision: number
}

export interface WorkflowDeliveryIdentityRevokeInput {
  fingerprint: string
  expectedRevision: number
}

export interface WorkflowDeliveryIdentityPassphraseInput {
  passphrase: string
}

export interface WorkflowDeliveryIdentityRotateInput {
  expectedFingerprint?: string
}

export type WorkflowDeliveryIdentityFileExportResult =
  | { canceled: true }
  | {
      canceled: false
      fileName: string
      sizeBytes: number
      fileDigest: string
      identityFingerprint: string
      identityCount?: number
    }

export type WorkflowDeliveryIdentityTrustImportResult =
  | { canceled: true }
  | {
      canceled: false
      signerTrust: 'local_identity' | 'trusted_identity'
      signerFingerprint: string
      importedCount: number
      updatedCount: number
      unchangedCount: number
      snapshot: WorkflowDeliveryIdentityTrustSnapshot
    }

export type WorkflowDeliveryIdentityRestoreResult =
  | { canceled: true }
  | {
      canceled: false
      disposition: 'restored' | 'reinstalled'
      previousFingerprint?: string
      snapshot: WorkflowDeliveryIdentityTrustSnapshot
    }

export interface WorkflowDeliveryIdentityRotateResult {
  previousFingerprint?: string
  snapshot: WorkflowDeliveryIdentityTrustSnapshot
}

export interface WorkflowDeliveryIdentityTrustMutationResult {
  snapshot: WorkflowDeliveryIdentityTrustSnapshot
  verification?: Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>
}

export type WorkflowProjectDeliveryPackageVerificationReceiptSaveResult =
  | { canceled: true }
  | {
      canceled: false
      fileName: string
      sizeBytes: number
      receiptDigest: string
      verdict: 'verified' | 'rejected'
      projectId?: string
    }

export type WorkflowAcceptanceReviewDecision = 'passed' | 'failed' | 'retest' | 'waived'
/** Renderer selection only; criterion identity and authority are assigned in main. */
export interface WorkflowAcceptanceCriterionSelection {
  criterionIndex: number
  evidenceRefs: string[]
}

export interface WorkflowAcceptanceReviewInput {
  acceptanceId: string
  criterionEvidence: WorkflowAcceptanceCriterionSelection[]
  decision: WorkflowAcceptanceReviewDecision
  notes?: string
  waiverReason?: string
}

export interface WorkflowAcceptanceReviewAudit {
  gate: 'workflow_acceptance_review'
  authority: 'user'
  acceptanceId: string
  acceptanceRevision: number
  projectId?: string
  decision: WorkflowAcceptanceReviewDecision
  actorId: string
  evidenceRefs: string[]
  verifier?: string
  verifiedAt?: number
  waivedBy?: string
}

export interface WorkflowAcceptanceReviewResult {
  acceptance: WorkflowAcceptanceRecord
  evidenceLinks: WorkflowEvidenceLinkRecord[]
  audit: WorkflowAcceptanceReviewAudit
  repair?: { workItemId: string; acceptanceId: string; failedAcceptanceRevision: number; disposition: 'created' | 'existing' | 'completed' }
}

export interface WorkflowAcceptanceRepairStartResult {
  workItemId: string
  disposition: 'started' | 'existing' | 'blocked'
  sessionId?: string
  reason?: string
}

export interface WorkflowProjectDeliveryArtifact {
  artifact: WorkflowArtifactRecord
  locations: WorkflowArtifactLocationRecord[]
  evidenceIds: string[]
  acceptanceIds: string[]
  isCurrent: boolean
  predecessorArtifactId?: string
  successorArtifactIds: string[]
  currentArtifactIds: string[]
  lineageArtifactIds: string[]
  available: boolean
}

export interface WorkflowProjectDeliverySummary {
  artifactCount: number
  currentArtifactCount: number
  availableArtifactCount: number
  evidenceCount: number
  unlinkedEvidenceCount: number
  acceptanceCount: number
  pendingAcceptanceCount: number
  failedAcceptanceCount: number
  passedAcceptanceCount: number
  waivedAcceptanceCount: number
}

/** Project-wide delivery projection used by the Studio review/repair workbench. */
export interface WorkflowProjectDeliveryWorkbench {
  projectId: string
  generatedAt: number
  summary: WorkflowProjectDeliverySummary
  artifacts: WorkflowProjectDeliveryArtifact[]
  evidence: WorkflowEvidenceRecord[]
  acceptances: WorkflowAcceptanceRecord[]
  evidenceLinks: WorkflowEvidenceLinkRecord[]
}

export interface WorkflowEvidenceLinkInput {
  id: string
  evidenceId: string
  projectId?: string
  runId?: string
  artifactId?: string
  acceptanceId?: string
  criterionId?: string
  evidenceOrigin?: WorkflowEvidenceLinkRecord['evidenceOrigin']
  relation: WorkflowEvidenceLinkRecord['relation']
  createdAt?: number
}

export interface WorkflowWorkItemProjectionInput extends BusinessLineBinding {
  id: string
  projectId?: string
  goalId?: string
  parentId?: string
  type?: WorkflowWorkItemType
  title: string
  description?: string
  role?: string
  status?: WorkflowWorkItemStatus
  revision?: number
  source?: WorkflowProjectionSource
  runIds?: string[]
  currentRunId?: string
  createdAt?: number
  updatedAt?: number
  dueAt?: number
}

export interface WorkflowEventInput {
  eventId: string
  streamId: string
  entityType: WorkflowEventEntityType
  entityId: string
  kind: string
  payload: Record<string, unknown>
  occurredAt?: number
  seq?: number
  schemaVersion?: 1
  causationId?: string
  correlationId?: string
}

export interface WorkflowEventRecord extends WorkflowEventInput {
  schemaVersion: 1
  seq: number
  occurredAt: number
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  sessionId?: string
  prevDigest: string
  digest: string
}

export interface WorkflowLedgerScope {
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  sessionId?: string
  entityType?: WorkflowEventEntityType
  entityId?: string
  eventKind?: string
  artifactId?: string
  acceptanceId?: string
  limit?: number
  /** Opaque decimal offset returned as nextCursor. */
  cursor?: string
}

export interface WorkflowLedgerPage<T> {
  items: T[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export interface WorkflowLedgerSelection {
  goals: WorkflowLedgerPage<WorkflowGoalRecord>
  workItems: WorkflowLedgerPage<WorkflowWorkItemRecord>
  runs: WorkflowLedgerPage<WorkflowRunRecord>
  artifacts: WorkflowLedgerPage<WorkflowArtifactRecord>
  acceptances: WorkflowLedgerPage<WorkflowAcceptanceRecord>
  evidenceLinks: WorkflowLedgerPage<WorkflowEvidenceLinkRecord>
  events: WorkflowLedgerPage<WorkflowEventRecord>
}

/**
 * Renderer-safe Run projection.  The full TaskRun remains an internal
 * recovery/effect record; renderer IPC receives only immutable run metadata
 * plus a digest binding the omitted payload.
 */
export type WorkflowRunSummary = Omit<WorkflowRunRecord, 'taskRun' | 'error'> & {
  taskRunDigest: string
  /** Error text can contain provider material; expose only its digest. */
  errorDigest?: string
}

export type WorkflowLedgerRendererSelection = Omit<WorkflowLedgerSelection, 'runs'> & {
  runs: WorkflowLedgerPage<WorkflowRunSummary>
}

export interface WorkflowLedgerVerification {
  valid: true
  goals: number
  workItems: number
  runs: number
  artifacts: number
  acceptances: number
  evidenceLinks: number
  workflowEvidence: number
  events: number
  lastSeq: number
  lastDigest: string
  /** Additive verification for the Artifact Graph shadow tables. */
  artifactGraph?: WorkflowArtifactGraphVerification
}

/**
 * A scope accepted by the maintenance/export surface. Pagination is
 * deliberately excluded. Unlike table-local list filters, export treats the
 * matching records as seeds and includes their project-safe owner/related
 * closure so exported events and evidence do not dangle.
 */
export type WorkflowLedgerExportScope = Omit<WorkflowLedgerScope, 'limit' | 'cursor'>

export interface WorkflowLedgerExportOptions {
  scope?: WorkflowLedgerExportScope
}

/**
 * TaskRun payloads may contain prompts, tool arguments, or provider material.
 * The user-auditable export keeps the projection metadata but never carries
 * the full TaskRun payload.
 */
export type WorkflowLedgerExportRunRecord = Omit<WorkflowRunRecord, 'taskRun'> & {
  /** Digest binds the omitted TaskRun payload without exposing it. */
  taskRunDigest: string
}

/** Evidence-chain metadata suitable for export; raw TaskRun/effect payloads are omitted. */
export interface WorkflowLedgerExportTaskEvidenceRecord {
  schemaVersion: 1
  seq: number
  id: string
  evidenceId: string
  sessionId: string
  runId: string
  taskId: string
  effectId: string
  operationId?: string
  projectId?: string
  kind?: string
  generation: number
  observedAt: number
  verifier: string
  evidenceDigest: string
  effectKey: string
  targetDigest: string
  prevDigest: string
  digest: string
}

export interface WorkflowLedgerExportSelection {
  goals: WorkflowLedgerPage<WorkflowGoalRecord>
  workItems: WorkflowLedgerPage<WorkflowWorkItemRecord>
  runs: WorkflowLedgerPage<WorkflowLedgerExportRunRecord>
  artifacts: WorkflowLedgerPage<WorkflowArtifactRecord>
  /** Immutable Artifact Graph relations included in a complete export. */
  artifactEdges: WorkflowLedgerPage<WorkflowArtifactEdgeRecord>
  /** Immutable Artifact Graph locators included in a complete export. */
  artifactLocations: WorkflowLedgerPage<WorkflowArtifactLocationRecord>
  acceptances: WorkflowLedgerPage<WorkflowAcceptanceRecord>
  evidenceLinks: WorkflowLedgerPage<WorkflowEvidenceLinkRecord>
  events: WorkflowLedgerPage<WorkflowEventRecord>
  taskEvidence: WorkflowLedgerPage<WorkflowLedgerExportTaskEvidenceRecord>
  workflowEvidence: WorkflowLedgerPage<WorkflowEvidenceRecord>
}

export interface WorkflowLedgerExportVerification {
  valid: true
  /** Verification of the Workflow Ledger event/projection tables. */
  ledger: WorkflowLedgerVerification
  /** Verification of the additive Artifact Graph tables and their events. */
  artifactGraph: WorkflowArtifactGraphVerification
  /** Verification of the independent TaskRun Effect evidence chain. */
  taskEvidence: WorkflowLedgerTaskEvidenceVerification
  /** Verification of the independent general Workflow evidence chain. */
  workflowEvidence: WorkflowEvidenceVerification
  sanitized: true
  exportDigest: string
}

export interface WorkflowLedgerTaskEvidenceVerification {
  valid: true
  count: number
  lastSeq: number
  lastDigest: string
}

export interface WorkflowLedgerExportBundle {
  schemaVersion: 1
  format: 'caogen.workflow-ledger.export.v1'
  scope: WorkflowLedgerExportScope
  ledger: WorkflowLedgerExportSelection
  verification: WorkflowLedgerExportVerification
  exportDigest: string
}

export interface WorkflowLedgerExportResult {
  schemaVersion: 1
  format: 'caogen.workflow-ledger.export.v1'
  json: string
  exportDigest: string
  ledger: WorkflowLedgerExportSelection
  verification: WorkflowLedgerExportVerification
}

export type WorkflowLedgerRepairStatus = 'healthy' | 'repair_required' | 'unavailable'
export type WorkflowLedgerRepairSeverity = 'error' | 'warning' | 'info'

export interface WorkflowLedgerRepairDiagnostic {
  code: string
  severity: WorkflowLedgerRepairSeverity
  message: string
  table?: string
  rowId?: string
  seq?: number
}

export type WorkflowLedgerRepairActionKind =
  | 'backup_database'
  | 'restore_verified_backup'
  | 'rebuild_shadow_projection'
  | 'manual_review'

export interface WorkflowLedgerRepairAction {
  kind: WorkflowLedgerRepairActionKind
  mode: 'recommendation'
  requiresExplicitApproval: true
  mutatesLedger: false
  reason: string
}

export interface WorkflowLedgerBackupRecommendation {
  recommended: true
  sourcePath: string
  suggestedPath: string
  reason: string
}

/**
 * Repair is intentionally a plan/diagnostic result. No implementation of
 * this contract may rewrite rows, recompute a digest, or append to the chain.
 */
export interface WorkflowLedgerRepairPlan {
  schemaVersion: 1
  format: 'caogen.workflow-ledger.repair-plan.v1'
  status: WorkflowLedgerRepairStatus
  readOnly: true
  canAutoRepair: false
  writesPerformed: false
  chainPreserved: true
  digestRecomputed: false
  eventsAppended: false
  databaseExists: boolean
  databasePath: string
  verification?: {
    ledger: WorkflowLedgerVerification
    taskEvidence: WorkflowLedgerTaskEvidenceVerification
    workflowEvidence: WorkflowEvidenceVerification
    artifactGraph: WorkflowArtifactGraphVerification
  }
  verificationError?: {
    code: string
    message: string
    seq?: number
  }
  taskEvidenceVerificationError?: {
    code: string
    message: string
    seq?: number
  }
  workflowEvidenceVerificationError?: {
    code: string
    message: string
    seq?: number
  }
  artifactGraphVerificationError?: {
    code: string
    message: string
    seq?: number
  }
  diagnostics: WorkflowLedgerRepairDiagnostic[]
  backupRecommendation: WorkflowLedgerBackupRecommendation
  proposedActions: WorkflowLedgerRepairAction[]
  mutations: []
}

export interface WorkflowLedgerApi {
  listWorkflowLedger(scope?: WorkflowLedgerScope): Promise<WorkflowLedgerRendererSelection>
  getProjectDeliveryWorkbench(projectId: string): Promise<WorkflowProjectDeliveryWorkbench>
  verifyWorkflowLedger(): Promise<WorkflowLedgerVerification>
  exportWorkflowLedger(options?: WorkflowLedgerExportOptions): Promise<WorkflowLedgerExportResult>
  diagnoseWorkflowLedger(): Promise<WorkflowLedgerRepairPlan>
  planWorkflowLedgerRepair(): Promise<WorkflowLedgerRepairPlan>
  saveWorkflowAcceptance(input: WorkflowAcceptanceInput): Promise<WorkflowAcceptanceRecord>
  createWorkflowArtifactAcceptance(input: WorkflowArtifactAcceptanceCreateInput): Promise<WorkflowArtifactAcceptanceCreateResult>
  exportWorkflowArtifact(input: WorkflowArtifactExportInput): Promise<WorkflowArtifactExportResult>
  compareWorkflowArtifacts(input: WorkflowArtifactCompareInput): Promise<WorkflowArtifactCompareResult>
  verifyWorkflowArtifactIntegrity(input: WorkflowArtifactIntegrityInput): Promise<WorkflowArtifactIntegrityReport>
  exportWorkflowArtifactManifest(input: WorkflowArtifactManifestExportInput): Promise<WorkflowArtifactManifestExportResult>
  verifyWorkflowProjectDelivery(input: WorkflowProjectDeliveryIntegrityInput): Promise<WorkflowProjectDeliveryIntegrityReport>
  exportWorkflowProjectDeliveryManifest(input: WorkflowProjectDeliveryManifestExportInput): Promise<WorkflowProjectDeliveryManifestExportResult>
  exportWorkflowProjectDeliveryPackage(input: WorkflowProjectDeliveryPackageExportInput): Promise<WorkflowProjectDeliveryPackageExportResult>
  verifyWorkflowProjectDeliveryPackage(): Promise<WorkflowProjectDeliveryPackageVerificationResult>
  listWorkflowDeliveryTrustedIdentities(): Promise<WorkflowDeliveryIdentityTrustSnapshot>
  trustWorkflowDeliveryIdentity(input: WorkflowDeliveryIdentityTrustInput): Promise<WorkflowDeliveryIdentityTrustMutationResult>
  revokeWorkflowDeliveryIdentity(input: WorkflowDeliveryIdentityRevokeInput): Promise<WorkflowDeliveryIdentityTrustMutationResult>
  updateWorkflowDeliveryTrustPolicy(input: WorkflowDeliveryTrustPolicyUpdateInput): Promise<WorkflowDeliveryIdentityTrustMutationResult>
  exportWorkflowDeliveryIdentityTrustBundle(): Promise<WorkflowDeliveryIdentityFileExportResult>
  importWorkflowDeliveryIdentityTrustBundle(expectedRevision: number): Promise<WorkflowDeliveryIdentityTrustImportResult>
  exportWorkflowDeliveryIdentityBackup(input: WorkflowDeliveryIdentityPassphraseInput): Promise<WorkflowDeliveryIdentityFileExportResult>
  restoreWorkflowDeliveryIdentityBackup(input: WorkflowDeliveryIdentityPassphraseInput): Promise<WorkflowDeliveryIdentityRestoreResult>
  rotateWorkflowDeliveryIdentity(input: WorkflowDeliveryIdentityRotateInput): Promise<WorkflowDeliveryIdentityRotateResult>
  saveWorkflowProjectDeliveryPackageVerificationReceipt(
    input: WorkflowProjectDeliveryPackageVerificationReceiptSaveInput
  ): Promise<WorkflowProjectDeliveryPackageVerificationReceiptSaveResult>
  createWorkflowArtifact(input: WorkflowArtifactInput): Promise<WorkflowArtifactRecord>
  createWorkflowArtifactEdge(input: WorkflowArtifactEdgeInput): Promise<WorkflowArtifactEdgeRecord>
  createWorkflowArtifactLocation(input: WorkflowArtifactLocationInput): Promise<WorkflowArtifactLocationRecord>
  listWorkflowArtifactEdges(scope?: WorkflowArtifactGraphScope): Promise<WorkflowLedgerPage<WorkflowArtifactEdgeRecord>>
  listWorkflowArtifactLocations(scope?: WorkflowArtifactGraphScope): Promise<WorkflowLedgerPage<WorkflowArtifactLocationRecord>>
  queryWorkflowArtifactGraph(artifactId: string): Promise<WorkflowArtifactNeighborhood>
  verifyWorkflowArtifactGraph(): Promise<WorkflowArtifactGraphVerification>
  createWorkflowEvidence(input: WorkflowEvidenceCreateInput): Promise<WorkflowEvidenceRecord>
  listWorkflowEvidence(scope?: WorkflowEvidenceScope): Promise<WorkflowEvidenceRecord[]>
  queryWorkflowEvidence(scope?: WorkflowEvidenceScope): Promise<WorkflowLedgerPage<WorkflowEvidenceRecord>>
  verifyWorkflowEvidence(): Promise<WorkflowEvidenceVerification>
  reviewWorkflowAcceptance(input: WorkflowAcceptanceReviewInput): Promise<WorkflowAcceptanceReviewResult>
  startWorkflowAcceptanceRepair(acceptanceId: string): Promise<WorkflowAcceptanceRepairStartResult>
  createWorkflowEvidenceLink(input: WorkflowEvidenceLinkInput): Promise<WorkflowEvidenceLinkRecord>
}
