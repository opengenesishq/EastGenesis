import { createHash } from 'node:crypto'
import type {
  WorkflowAcceptanceInput,
  WorkflowAcceptanceRecord,
  WorkflowAcceptanceReviewAudit,
  WorkflowAcceptanceReviewInput,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowGoalRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { currentArtifactLineageLeafIds } from './artifact-lineage'
import {
  findWorkflowArtifact,
  findWorkflowAcceptance,
  readAcceptances,
  readArtifacts,
  readEvidenceLinks
} from './workflow-ledger-query'
import { listWorkflowEvidence } from './workflow-evidence-store'
import { resolveAcceptanceEvidenceRefs, type EvidenceResolution } from './workflow-acceptance-evidence-resolution'
import {
  assertAcceptanceCriterionEvidence,
  assertAcceptanceCriterionLink,
  workflowAcceptanceCriterionId
} from './workflow-acceptance-criterion-policy'
import {
  resolveDigitalWorkerAcceptanceContext,
  type DigitalWorkerAcceptanceContext
} from './workflow-acceptance-digital-worker-policy'
import {
  isManualWorkflowArtifactAcceptanceId,
  workflowArtifactAcceptanceIdentities
} from './workflow-artifact-acceptance'

/**
 * The shared Workflow types intentionally stay backwards compatible.  The
 * acceptance gate carries write-time authority in this main-process-only
 * type, so a model or replay cannot turn a waiver into a user decision by
 * merely filling in `waivedBy`.
 */
export type WorkflowAcceptanceCaller = 'user' | 'model' | 'automatic' | 'system' | 'unknown'

export interface WorkflowAcceptanceGateOptions {
  /** Explicit authority for the operation. `user` is required for waivers. */
  caller?: WorkflowAcceptanceCaller | string
  /** Alias accepted by internal callers migrating from actor terminology. */
  actorType?: WorkflowAcceptanceCaller | string
  /** Additional aliases used by older internal command callers. */
  callerType?: WorkflowAcceptanceCaller | string
  actor?: WorkflowAcceptanceCaller | { type?: WorkflowAcceptanceCaller | string; id?: string }
  actorId?: string
  /** Select one acceptance when a target has more than one acceptance record. */
  acceptanceId?: string
  /** Optional free-form reason retained in the returned audit object. */
  reason?: string
}

export type WorkflowAcceptanceTarget =
  | { kind: 'work_item'; record: WorkflowWorkItemRecord }
  | { kind: 'goal'; record: WorkflowGoalRecord }

export interface WorkflowAcceptanceAudit {
  gate: 'workflow_acceptance'
  decision: 'passed' | 'waived'
  caller: WorkflowAcceptanceCaller
  actorId?: string
  targetType: 'work_item' | 'goal'
  targetId: string
  projectId?: string
  acceptanceId: string
  acceptanceRevision: number
  evidenceRefs: string[]
  waiverReason?: string
  waivedBy?: string
  reason?: string
}

export interface WorkflowAcceptanceGateResult {
  allowed: true
  decision: 'passed' | 'waived'
  acceptance: WorkflowAcceptanceRecord
  audit: WorkflowAcceptanceAudit
}

export interface WorkflowAcceptanceReviewAuthority {
  actorId: string
  verifier: string
  reviewedAt: number
}

export interface WorkflowAcceptanceReviewPlan {
  acceptanceInputs: WorkflowAcceptanceInput[]
  evidenceLinks: WorkflowEvidenceLinkInput[]
  audit: WorkflowAcceptanceReviewAudit
}

export type WorkflowAcceptanceGateErrorCode =
  | 'WORKFLOW_ACCEPTANCE_REQUIRED'
  | 'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING'
  | 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID'
  | 'WORKFLOW_DIGITAL_WORKER_POLICY_DENIED'
  | 'WORKFLOW_ACCEPTANCE_WAIVER_INVALID'
  | 'WORKFLOW_ACCEPTANCE_WAIVER_UNAUTHORIZED'
  | 'WORKFLOW_PROJECT_BOUNDARY'
  | 'WORKFLOW_REVISION_CONFLICT'
  | 'WORKFLOW_TRANSITION_INVALID'

export interface WorkflowAcceptanceGateErrorDetails {
  operation?: string
  targetType?: 'work_item' | 'goal' | 'acceptance' | 'evidence_link'
  targetId?: string
  projectId?: string
  fromStatus?: string
  toStatus?: string
  expectedRevision?: number
  actualRevision?: number
  acceptanceId?: string
  evidenceId?: string
  caller?: WorkflowAcceptanceCaller
  actorId?: string
  reason?: string
  [key: string]: unknown
}

/**
 * Stable, serialisable error returned by the API for gate/CAS failures.
 * `audit` is deliberately duplicated under a named property so consumers can
 * log it without parsing the human-readable message.
 */
export class WorkflowAcceptanceGateError extends Error {
  readonly code: WorkflowAcceptanceGateErrorCode
  readonly details: WorkflowAcceptanceGateErrorDetails
  readonly audit: WorkflowAcceptanceGateErrorDetails

  constructor(
    code: WorkflowAcceptanceGateErrorCode,
    message: string,
    details: WorkflowAcceptanceGateErrorDetails = {}
  ) {
    super(message)
    this.name = 'WorkflowAcceptanceGateError'
    this.code = code
    this.details = { ...details }
    this.audit = { ...details, code, message }
  }

  toJSON(): { name: string; code: string; message: string; details: WorkflowAcceptanceGateErrorDetails; audit: WorkflowAcceptanceGateErrorDetails } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: { ...this.details },
      audit: { ...this.audit }
    }
  }
}

/**
 * Convert a renderer-safe review intent into main-owned Acceptance writes.
 * The caller persists the returned links and revisions in one transaction.
 */
export function planWorkflowAcceptanceReview(
  db: WorkflowLedgerDatabase,
  input: WorkflowAcceptanceReviewInput,
  authority: WorkflowAcceptanceReviewAuthority
): WorkflowAcceptanceReviewPlan {
  const acceptanceId = requiredReviewText(input.acceptanceId, 'acceptanceId')
  const acceptance = findWorkflowAcceptance(db, acceptanceId)
  if (!acceptance) {
    throw reviewError(
      'WORKFLOW_ACCEPTANCE_REQUIRED',
      `acceptance ${acceptanceId} was not found`,
      acceptanceId,
      undefined,
      'acceptance_not_found'
    )
  }
  const normalizedAuthority = normalizeReviewAuthority(authority, acceptance)
  const notes = optionalReviewText(input.notes, 'notes')
  const waiverReason = optionalReviewText(input.waiverReason, 'waiverReason')
  if (input.decision !== 'waived' && waiverReason) {
    throw reviewError(
      'WORKFLOW_TRANSITION_INVALID',
      'waiverReason is only valid for a waived decision',
      acceptance.id,
      acceptance.projectId,
      'waiver_reason_without_waiver'
    )
  }

  if (input.decision === 'retest') {
    assertNoCriterionSelections(input, acceptance, 'retest')
    if (acceptance.status !== 'failed') {
      throw invalidReviewTransition(acceptance, input.decision)
    }
    const acceptanceInputs: WorkflowAcceptanceInput[] = [{
      ...acceptance,
      status: 'verifying',
      evidenceRefs: [],
      criterionEvidence: undefined,
      verifier: undefined,
      verifiedAt: undefined,
      waiverReason: undefined,
      waivedBy: undefined,
      notes: notes ?? acceptance.notes,
      revision: acceptance.revision + 1,
      updatedAt: normalizedAuthority.reviewedAt
    }]
    return reviewPlan(acceptance, input, normalizedAuthority, acceptanceInputs, [], [])
  }

  if (input.decision === 'waived') {
    assertNoCriterionSelections(input, acceptance, 'waiver')
    if (acceptance.status !== 'pending') throw invalidReviewTransition(acceptance, input.decision)
    if (!waiverReason) {
      throw reviewError(
        'WORKFLOW_ACCEPTANCE_WAIVER_INVALID',
        `acceptance ${acceptance.id} waiver requires a reason`,
        acceptance.id,
        acceptance.projectId,
        'waiver_reason_missing'
      )
    }
    const acceptanceInputs: WorkflowAcceptanceInput[] = [{
      ...acceptance,
      status: 'waived',
      waiverReason,
      waivedBy: normalizedAuthority.actorId,
      notes: notes ?? acceptance.notes,
      revision: acceptance.revision + 1,
      updatedAt: normalizedAuthority.reviewedAt
    }]
    return reviewPlan(acceptance, input, normalizedAuthority, acceptanceInputs, [], [])
  }

  if (input.decision !== 'passed' && input.decision !== 'failed') {
    throw invalidReviewTransition(acceptance, String(input.decision))
  }
  if (acceptance.status !== 'pending' && acceptance.status !== 'verifying') {
    throw invalidReviewTransition(acceptance, input.decision)
  }

  const coverage = resolveReviewCriterionCoverage(db, acceptance, input)
  const common: WorkflowAcceptanceInput = {
    ...acceptance,
    evidenceRefs: coverage.evidenceRefs,
    criterionEvidence: coverage.criterionEvidence,
    verifier: undefined,
    verifiedAt: undefined,
    waiverReason: undefined,
    waivedBy: undefined,
    notes: notes ?? acceptance.notes,
    updatedAt: normalizedAuthority.reviewedAt
  }
  const acceptanceInputs: WorkflowAcceptanceInput[] = []
  let nextRevision = acceptance.revision
  if (acceptance.status === 'pending') {
    nextRevision += 1
    acceptanceInputs.push({ ...common, status: 'verifying', revision: nextRevision })
  }
  nextRevision += 1
  acceptanceInputs.push({
    ...common,
    status: input.decision,
    verifier: normalizedAuthority.verifier,
    verifiedAt: normalizedAuthority.reviewedAt,
    revision: nextRevision
  })
  return reviewPlan(
    acceptance,
    input,
    normalizedAuthority,
    acceptanceInputs,
    coverage.evidenceLinks,
    coverage.evidenceRefs
  )
}

/**
 * Validate every evidenceRef against both sides of the chain.  A link row by
 * itself is not sufficient: it must resolve from the source declared by the
 * link and it must belong to the same project as the Acceptance. The function
 * is used on every Acceptance write, not only on `passed`, so a later
 * transition cannot hide a dangling reference behind a pending state.
 */
export function assertAcceptanceEvidenceRefs(
  db: WorkflowLedgerDatabase,
  acceptance: WorkflowAcceptanceRecord,
  deferFileReadsForArtifactIds?: ReadonlySet<string>
): readonly EvidenceResolution[] {
  const resolutions = resolveAcceptanceEvidenceRefs(
    db,
    acceptance,
    (code, message, details) => new WorkflowAcceptanceGateError(code, message, details),
    deferFileReadsForArtifactIds
  )
  assertAcceptanceCriterionEvidence(
    acceptance,
    resolutions,
    (reason, message, details) => criterionCoverageError(acceptance, reason, message, details)
  )
  assertPassedAcceptanceVerification(acceptance, resolutions)
  return resolutions
}

function assertPassedAcceptanceVerification(
  acceptance: WorkflowAcceptanceRecord,
  resolutions: readonly EvidenceResolution[]
): void {
  if (acceptance.status !== 'passed' || resolutions.length === 0) return
  if (!normalizeOptional(acceptance.verifier)) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} cannot pass without a verifier`,
      {
        targetType: 'acceptance',
        targetId: acceptance.id,
        projectId: acceptance.projectId,
        acceptanceId: acceptance.id,
        reason: 'verifier_missing'
      }
    )
  }
  if (acceptance.verifiedAt === undefined) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} cannot pass without verifiedAt`,
      {
        targetType: 'acceptance',
        targetId: acceptance.id,
        projectId: acceptance.projectId,
        acceptanceId: acceptance.id,
        reason: 'verified_at_missing'
      }
    )
  }
  if (!resolutions.some(({ link }) =>
    link.acceptanceId === acceptance.id &&
    link.projectId === acceptance.projectId &&
    link.relation === 'verifies'
  )) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} cannot pass without a verifies evidence link`,
      {
        targetType: 'acceptance',
        targetId: acceptance.id,
        projectId: acceptance.projectId,
        acceptanceId: acceptance.id,
        reason: 'verification_link_missing'
      }
    )
  }
}

function criterionCoverageError(
  acceptance: WorkflowAcceptanceRecord,
  reason: string,
  message: string,
  details: WorkflowAcceptanceGateErrorDetails = {}
): WorkflowAcceptanceGateError {
  return new WorkflowAcceptanceGateError(
    'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
    message,
    {
      targetType: 'acceptance',
      targetId: acceptance.id,
      projectId: acceptance.projectId,
      acceptanceId: acceptance.id,
      reason,
      ...details
    }
  )
}

/** Enforce waiver authority at the Acceptance write boundary itself. */
export function assertAcceptanceWriteAuthorization(
  acceptance: WorkflowAcceptanceRecord,
  options: WorkflowAcceptanceGateOptions = {}
): void {
  if (acceptance.status !== 'waived') return
  const caller = normalizeCaller(options)
  if (!acceptance.waiverReason || !acceptance.waivedBy) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_WAIVER_INVALID',
      `acceptance ${acceptance.id} waiver requires reason and actor`,
      {
        targetType: 'acceptance',
        targetId: acceptance.id,
        projectId: acceptance.projectId,
        acceptanceId: acceptance.id,
        caller,
        actorId: options.actorId,
        reason: 'waiver_fields_missing'
      }
    )
  }
  if (caller !== 'user') {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_WAIVER_UNAUTHORIZED',
      `acceptance ${acceptance.id} waiver requires an explicit user caller; ${caller} cannot waive`,
      {
        targetType: 'acceptance',
        targetId: acceptance.id,
        projectId: acceptance.projectId,
        acceptanceId: acceptance.id,
        caller,
        actorId: options.actorId,
        reason: 'non_user_waiver'
      }
    )
  }
}

/** Validate a link before/after the lower-level relation checks. */
export function assertEvidenceLinkProjectBoundary(
  db: WorkflowLedgerDatabase,
  link: WorkflowEvidenceLinkRecord
): void {
  const acceptance = link.acceptanceId ? findWorkflowAcceptance(db, link.acceptanceId) : null
  const artifact = link.artifactId ? findWorkflowArtifact(db, link.artifactId) : null
  if (link.acceptanceId && !acceptance) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `evidence link ${link.id} references missing acceptance ${link.acceptanceId}`,
      { targetType: 'evidence_link', targetId: link.id, acceptanceId: link.acceptanceId, reason: 'acceptance_missing' }
    )
  }
  if (acceptance && acceptance.projectId !== link.projectId) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_PROJECT_BOUNDARY',
      `evidence link ${link.id} crosses project boundary`,
      {
        targetType: 'evidence_link',
        targetId: link.id,
        projectId: link.projectId,
        acceptanceId: acceptance.id,
        reason: 'acceptance_project_mismatch'
      }
    )
  }
  if (acceptance) {
    assertAcceptanceCriterionLink(
      acceptance,
      link,
      (reason, message, details) => criterionCoverageError(acceptance, reason, message, {
        targetType: 'evidence_link',
        targetId: link.id,
        evidenceId: link.evidenceId,
        ...details
      })
    )
  }
  if (link.criterionId && (!acceptance || link.relation !== 'verifies')) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `evidence link ${link.id} criterionId requires a verifies Acceptance link`,
      {
        targetType: 'evidence_link',
        targetId: link.id,
        projectId: link.projectId,
        acceptanceId: link.acceptanceId,
        evidenceId: link.evidenceId,
        criterionId: link.criterionId,
        reason: 'criterion_link_invalid'
      }
    )
  }
  if (link.artifactId && !artifact) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `evidence link ${link.id} references missing artifact ${link.artifactId}`,
      { targetType: 'evidence_link', targetId: link.id, reason: 'artifact_missing' }
    )
  }
  if (artifact && artifact.projectId !== link.projectId) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_PROJECT_BOUNDARY',
      `evidence link ${link.id} crosses project boundary`,
      {
        targetType: 'evidence_link',
        targetId: link.id,
        projectId: link.projectId,
        reason: 'artifact_project_mismatch'
      }
    )
  }
}

/**
 * Resolve and authorize the Acceptance that backs a terminal transition.
 * Passed Acceptances are self-authenticating through their evidence chain;
 * waived Acceptances additionally require an explicit user caller at the
 * transition boundary.
 */
export function assertWorkflowAcceptanceGate(
  db: WorkflowLedgerDatabase,
  target: WorkflowAcceptanceTarget,
  options: WorkflowAcceptanceGateOptions = {}
): WorkflowAcceptanceGateResult {
  const targetId = target.record.id
  const targetType = target.kind
  const projectId = target.record.projectId
  const acceptanceId = normalizeOptional(options.acceptanceId)
  const candidates = readAcceptances(db).filter((acceptance) => {
    const attached = targetType === 'work_item'
      ? acceptance.workItemId === targetId
      : acceptance.goalId === targetId
    return attached && acceptance.projectId === projectId
  })
  const acceptance = acceptanceId
    ? candidates.find((candidate) => candidate.id === acceptanceId)
    : [...candidates].sort(compareAcceptance).at(-1)

  if (!acceptance) {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_ACCEPTANCE_REQUIRED',
      `${targetType} ${targetId} cannot reach terminal state without passed or user-waived Acceptance`,
      {
        targetType,
        targetId,
        projectId,
        acceptanceId,
        reason: acceptanceId ? 'requested_acceptance_not_found' : 'acceptance_missing'
      }
    )
  }

  const caller = normalizeCaller(options)
  const resolutions = assertAcceptanceEvidenceRefs(db, acceptance)
  if (acceptance.status === 'passed') {
    if (resolutions.length === 0) {
      throw new WorkflowAcceptanceGateError(
        'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING',
        `acceptance ${acceptance.id} cannot pass without resolved evidence`,
        {
          targetType,
          targetId,
          projectId,
          acceptanceId: acceptance.id,
          reason: 'passed_without_evidence'
        }
      )
    }
    assertDigitalWorkerAcceptancePolicy(target, acceptance, resolutions, caller, options)
    assertTerminalArtifactAcceptances(db, target)
    return {
      allowed: true,
      decision: 'passed',
      acceptance,
      audit: buildAudit(target, acceptance, caller, 'passed', options)
    }
  }

  if (acceptance.status === 'waived') {
    if (!acceptance.waiverReason || !acceptance.waivedBy) {
      throw new WorkflowAcceptanceGateError(
        'WORKFLOW_ACCEPTANCE_WAIVER_INVALID',
        `acceptance ${acceptance.id} waiver requires reason and actor`,
        {
          targetType,
          targetId,
          projectId,
          acceptanceId: acceptance.id,
          caller,
          actorId: options.actorId,
          reason: 'waiver_fields_missing'
        }
      )
    }
    // A waiver is authorised when it is written (the write boundary above
    // requires caller=user). A subsequent projection may be automatic and
    // does not need to repeat the human decision. Explicit model/automatic
    // callers are still denied, which prevents self-waiving.
    const explicitCaller = hasExplicitCaller(options)
    if (explicitCaller && caller !== 'user') {
      throw new WorkflowAcceptanceGateError(
        'WORKFLOW_ACCEPTANCE_WAIVER_UNAUTHORIZED',
        `acceptance ${acceptance.id} waiver requires an explicit user caller; ${caller} cannot waive`,
        {
          targetType,
          targetId,
          projectId,
          acceptanceId: acceptance.id,
          caller,
          actorId: options.actorId,
          reason: 'non_user_waiver'
        }
      )
    }
    assertTerminalArtifactAcceptances(db, target)
    return {
      allowed: true,
      decision: 'waived',
      acceptance,
      audit: buildAudit(target, acceptance, explicitCaller ? caller : 'user', 'waived', options)
    }
  }

  throw new WorkflowAcceptanceGateError(
    'WORKFLOW_ACCEPTANCE_REQUIRED',
    `${targetType} ${targetId} cannot reach terminal state without passed or waived Acceptance (Acceptance ${acceptance.id} is in ${acceptance.status} state)`,
    {
      targetType,
      targetId,
      projectId,
      acceptanceId: acceptance.id,
      caller,
      reason: `acceptance_${acceptance.status}`
    }
  )
}

/**
 * A target Acceptance authorizes the terminal transition; Artifact-scoped
 * Acceptances are additional delivery integrity gates and can never substitute
 * for that target Acceptance. Only current lineage leaves participate, so a
 * retained failed version stops blocking once an accepted successor exists.
 */
function assertTerminalArtifactAcceptances(
  db: WorkflowLedgerDatabase,
  target: WorkflowAcceptanceTarget
): void {
  const projectId = target.record.projectId
  const runIds = target.kind === 'work_item' ? new Set(target.record.runIds) : undefined
  const artifacts = readArtifacts(db).filter((artifact) =>
    artifact.projectId === projectId && (target.kind === 'work_item'
      ? artifact.workItemId === target.record.id || Boolean(artifact.runId && runIds?.has(artifact.runId))
      : artifact.goalId === target.record.id))
  if (artifacts.length === 0) return

  const leafIds = currentArtifactLineageLeafIds(artifacts)
  const acceptances = new Map(readAcceptances(db).map((acceptance) => [acceptance.id, acceptance]))
  const links = readEvidenceLinks(db)
  for (const artifact of artifacts.filter((candidate) => leafIds.has(candidate.id))) {
    const acceptanceIds = new Set(links.flatMap((link) =>
      link.artifactId === artifact.id && link.acceptanceId ? [link.acceptanceId] : []))
    if (acceptanceIds.size === 0) {
      throw new WorkflowAcceptanceGateError(
        'WORKFLOW_ACCEPTANCE_REQUIRED',
        `current Artifact ${artifact.id} cannot be delivered without Artifact Acceptance`,
        {
          targetType: target.kind,
          targetId: target.record.id,
          projectId,
          artifactId: artifact.id,
          reason: 'artifact_acceptance_missing'
        }
      )
    }
    for (const acceptanceId of acceptanceIds) {
      const artifactAcceptance = acceptances.get(acceptanceId)
      if (!artifactAcceptance || artifactAcceptance.projectId !== projectId ||
          (artifactAcceptance.status !== 'passed' && artifactAcceptance.status !== 'waived')) {
        throw new WorkflowAcceptanceGateError(
          'WORKFLOW_ACCEPTANCE_REQUIRED',
          `current Artifact ${artifact.id} has unresolved Acceptance ${acceptanceId}`,
          {
            targetType: target.kind,
            targetId: target.record.id,
            projectId,
            artifactId: artifact.id,
            acceptanceId,
            reason: artifactAcceptance ? `artifact_acceptance_${artifactAcceptance.status}` : 'artifact_acceptance_missing'
          }
        )
      }
      assertAcceptanceEvidenceRefs(db, artifactAcceptance)
    }
  }
}

function assertDigitalWorkerAcceptancePolicy(
  target: WorkflowAcceptanceTarget,
  acceptance: WorkflowAcceptanceRecord,
  resolutions: readonly EvidenceResolution[],
  caller: WorkflowAcceptanceCaller,
  options: WorkflowAcceptanceGateOptions
): void {
  const resolution = resolveDigitalWorkerAcceptanceContext(
    target.kind === 'work_item' ? target.record : undefined
  )
  if (resolution.status === 'not_applicable') return
  if (resolution.status === 'denied') {
    throw new WorkflowAcceptanceGateError(
      'WORKFLOW_DIGITAL_WORKER_POLICY_DENIED',
      resolution.message,
      {
        targetType: target.kind,
        targetId: target.record.id,
        projectId: target.record.projectId,
        ...resolution.details,
        reason: resolution.reason
      }
    )
  }
  const context = resolution.context
  const evidenceCount = new Set(resolutions.map(({ evidence }) => evidence.evidenceId)).size
  if (evidenceCount < context.minimumEvidenceCount) {
    throw digitalWorkerPolicyError(
      target,
      acceptance,
      context,
      'minimum_evidence_count',
      `DigitalWorker ${context.worker.id} requires ${context.minimumEvidenceCount} distinct evidence records; ${evidenceCount} resolved`,
      { evidenceCount }
    )
  }
  const actorId = normalizeOptional(options.actorId)
  if (context.requireUserApproval && (caller !== 'user' || !actorId)) {
    throw digitalWorkerPolicyError(
      target,
      acceptance,
      context,
      'user_approval_required',
      `DigitalWorker ${context.worker.id} requires explicit main-process user approval`,
      { caller, actorId }
    )
  }
}

function digitalWorkerPolicyError(
  target: WorkflowAcceptanceTarget,
  acceptance: WorkflowAcceptanceRecord,
  context: DigitalWorkerAcceptanceContext,
  reason: string,
  message: string,
  details: Record<string, unknown>
): WorkflowAcceptanceGateError {
  return new WorkflowAcceptanceGateError(
    'WORKFLOW_DIGITAL_WORKER_POLICY_DENIED',
    message,
    {
      targetType: target.kind,
      targetId: target.record.id,
      projectId: target.record.projectId,
      acceptanceId: acceptance.id,
      assignmentId: context.assignment.id,
      workerId: context.worker.id,
      reason,
      ...details
    }
  )
}

/** Convenience predicate used by verification code and focused smoke tests. */
export function hasSatisfiedWorkflowAcceptance(
  db: WorkflowLedgerDatabase,
  target: WorkflowAcceptanceTarget,
  options: WorkflowAcceptanceGateOptions = {}
): boolean {
  try {
    assertWorkflowAcceptanceGate(db, target, options)
    return true
  } catch {
    return false
  }
}

export function normalizeWorkflowCaller(value: unknown): WorkflowAcceptanceCaller {
  const callerType = unwrapWorkflowCallerType(value)
  const raw = typeof callerType === 'string' ? callerType.trim().toLowerCase() : ''
  return WORKFLOW_CALLER_ALIASES[raw] ?? 'unknown'
}

const WORKFLOW_CALLER_ALIASES: Readonly<Record<string, WorkflowAcceptanceCaller>> = {
  user: 'user',
  human: 'user',
  manual: 'user',
  'explicit-user': 'user',
  model: 'model',
  agent: 'model',
  llm: 'model',
  automatic: 'automatic',
  automated: 'automatic',
  'system-automatic': 'automatic',
  system: 'system',
  internal: 'system'
}

function unwrapWorkflowCallerType(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('type' in value)) return value
  return unwrapWorkflowCallerType((value as { type?: unknown }).type)
}

/** Convert legacy string errors into a stable API error without losing text. */
export function toWorkflowAcceptanceError(
  error: unknown,
  details: WorkflowAcceptanceGateErrorDetails = {}
): Error {
  if (isWorkflowRepairError(error)) return error
  if (error instanceof WorkflowAcceptanceGateError) {
    // Add the API operation/target context at the facade boundary while
    // preserving the original gate reason and code.
    if (Object.keys(details).length === 0) return error
    const definedDetails = Object.fromEntries(
      Object.entries(details).filter(([, value]) => value !== undefined)
    ) as WorkflowAcceptanceGateErrorDetails
    return new WorkflowAcceptanceGateError(
      error.code,
      error.message,
      { ...error.details, ...definedDetails }
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('stale_revision') || lower.includes('revision')) {
    return new WorkflowAcceptanceGateError('WORKFLOW_REVISION_CONFLICT', message, details)
  }
  if (lower.includes('cross') && lower.includes('project') || lower.includes('project boundary') || lower.includes('ownership differs')) {
    return new WorkflowAcceptanceGateError('WORKFLOW_PROJECT_BOUNDARY', message, details)
  }
  if (error instanceof WorkflowLedgerCorruptionError) return error
  if (lower.includes('without passed or waived acceptance') || lower.includes('acceptance')) {
    return new WorkflowAcceptanceGateError('WORKFLOW_ACCEPTANCE_REQUIRED', message, details)
  }
  return error instanceof Error ? error : new Error(message)
}

function isWorkflowRepairError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error) || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('WORKFLOW_REPAIR_')
}

function buildAudit(
  target: WorkflowAcceptanceTarget,
  acceptance: WorkflowAcceptanceRecord,
  caller: WorkflowAcceptanceCaller,
  decision: 'passed' | 'waived',
  options: WorkflowAcceptanceGateOptions
): WorkflowAcceptanceAudit {
  return {
    gate: 'workflow_acceptance',
    decision,
    caller,
    ...(options.actorId?.trim() ? { actorId: options.actorId.trim() } : {}),
    targetType: target.kind,
    targetId: target.record.id,
    projectId: target.record.projectId,
    acceptanceId: acceptance.id,
    acceptanceRevision: acceptance.revision,
    evidenceRefs: [...acceptance.evidenceRefs],
    ...(acceptance.waiverReason ? { waiverReason: acceptance.waiverReason } : {}),
    ...(acceptance.waivedBy ? { waivedBy: acceptance.waivedBy } : {}),
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {})
  }
}

interface ReviewCriterionCoverage {
  criterionEvidence: NonNullable<WorkflowAcceptanceInput['criterionEvidence']>
  evidenceLinks: WorkflowEvidenceLinkInput[]
  evidenceRefs: string[]
}

function resolveReviewCriterionCoverage(
  db: WorkflowLedgerDatabase,
  acceptance: WorkflowAcceptanceRecord,
  input: WorkflowAcceptanceReviewInput
): ReviewCriterionCoverage {
  if (!Array.isArray(input.criterionEvidence) || input.criterionEvidence.length !== acceptance.criteria.length) {
    throw reviewError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} review must cover every criterion`,
      acceptance.id,
      acceptance.projectId,
      'criterion_coverage_incomplete'
    )
  }
  if (!acceptance.projectId) {
    throw reviewError(
      'WORKFLOW_PROJECT_BOUNDARY',
      `acceptance ${acceptance.id} has no project ownership`,
      acceptance.id,
      acceptance.projectId,
      'acceptance_project_missing'
    )
  }

  const seenIndexes = new Set<number>()
  const evidenceById = new Map<string, WorkflowEvidenceRecord>()
  const evidenceRefs = new Set<string>()
  const criterionEvidence: ReviewCriterionCoverage['criterionEvidence'] = []
  const evidenceLinks: WorkflowEvidenceLinkInput[] = []

  for (const selection of input.criterionEvidence) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      throw reviewError(
        'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
        `acceptance ${acceptance.id} criterion selection is invalid`,
        acceptance.id,
        acceptance.projectId,
        'criterion_selection_invalid'
      )
    }
    const criterionIndex = selection.criterionIndex
    if (!Number.isSafeInteger(criterionIndex) || criterionIndex < 0 || criterionIndex >= acceptance.criteria.length ||
        seenIndexes.has(criterionIndex)) {
      throw reviewError(
        'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
        `acceptance ${acceptance.id} criterion index is invalid or duplicated`,
        acceptance.id,
        acceptance.projectId,
        'criterion_index_invalid',
        { criterionIndex }
      )
    }
    seenIndexes.add(criterionIndex)
    if (!Array.isArray(selection.evidenceRefs) || selection.evidenceRefs.length === 0) {
      throw reviewError(
        'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING',
        `acceptance ${acceptance.id} criterion ${criterionIndex} requires evidence`,
        acceptance.id,
        acceptance.projectId,
        'criterion_evidence_missing',
        { criterionIndex }
      )
    }

    const selectedEvidenceIds = [...new Set(selection.evidenceRefs.map((value) =>
      requiredReviewText(value, 'evidence id')
    ))]
    const criterionId = workflowAcceptanceCriterionId(acceptance, criterionIndex)
    criterionEvidence.push({ criterionId, criterionIndex, evidenceRefs: selectedEvidenceIds })

    for (const evidenceId of selectedEvidenceIds) {
      let evidence = evidenceById.get(evidenceId)
      if (!evidence) {
        evidence = findReviewEvidence(db, acceptance, evidenceId)
        evidenceById.set(evidenceId, evidence)
      }
      assertReviewEvidenceScope(acceptance, evidence)
      evidenceRefs.add(evidenceId)
      evidenceLinks.push({
        id: reviewEvidenceLinkId(acceptance.id, criterionIndex, evidenceId),
        evidenceId,
        projectId: acceptance.projectId,
        acceptanceId: acceptance.id,
        criterionId,
        evidenceOrigin: 'workflow',
        relation: 'verifies'
      })
    }
  }

  return {
    criterionEvidence: criterionEvidence.sort((left, right) => left.criterionIndex - right.criterionIndex),
    evidenceLinks,
    evidenceRefs: [...evidenceRefs]
  }
}

function findReviewEvidence(
  db: WorkflowLedgerDatabase,
  acceptance: WorkflowAcceptanceRecord,
  evidenceId: string
): WorkflowEvidenceRecord {
  let evidence: WorkflowEvidenceRecord | undefined
  try {
    evidence = listWorkflowEvidence(db, { evidenceId })[0]
  } catch (error) {
    throw reviewError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} cannot read Workflow evidence`,
      acceptance.id,
      acceptance.projectId,
      'workflow_evidence_unavailable',
      { evidenceId, cause: error instanceof Error ? error.message : String(error) }
    )
  }
  if (!evidence) {
    throw reviewError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING',
      `acceptance ${acceptance.id} references missing Workflow evidence ${evidenceId}`,
      acceptance.id,
      acceptance.projectId,
      'workflow_evidence_missing',
      { evidenceId }
    )
  }
  return evidence
}

function assertReviewEvidenceScope(
  acceptance: WorkflowAcceptanceRecord,
  evidence: WorkflowEvidenceRecord
): void {
  const artifactMismatch = isManualWorkflowArtifactAcceptanceId(acceptance.id) && (
    !evidence.artifactId ||
    workflowArtifactAcceptanceIdentities(evidence.artifactId).acceptanceId !== acceptance.id
  )
  const ownershipMismatch = evidence.projectId !== acceptance.projectId ||
    (acceptance.goalId !== undefined && evidence.goalId !== undefined && evidence.goalId !== acceptance.goalId) ||
    (acceptance.workItemId !== undefined && evidence.workItemId !== undefined &&
      evidence.workItemId !== acceptance.workItemId) || artifactMismatch
  if (!ownershipMismatch) return
  throw reviewError(
    'WORKFLOW_PROJECT_BOUNDARY',
    `acceptance ${acceptance.id} evidence ${evidence.evidenceId} crosses its ownership boundary`,
    acceptance.id,
    acceptance.projectId,
    'review_evidence_scope_mismatch',
    { evidenceId: evidence.evidenceId }
  )
}

function assertNoCriterionSelections(
  input: WorkflowAcceptanceReviewInput,
  acceptance: WorkflowAcceptanceRecord,
  action: string
): void {
  if (Array.isArray(input.criterionEvidence) && input.criterionEvidence.length === 0) return
  throw reviewError(
    'WORKFLOW_TRANSITION_INVALID',
    `${action} does not accept criterion evidence selections`,
    acceptance.id,
    acceptance.projectId,
    'criterion_selection_not_allowed'
  )
}

function reviewPlan(
  acceptance: WorkflowAcceptanceRecord,
  input: WorkflowAcceptanceReviewInput,
  authority: WorkflowAcceptanceReviewAuthority,
  acceptanceInputs: WorkflowAcceptanceInput[],
  evidenceLinks: WorkflowEvidenceLinkInput[],
  evidenceRefs: string[]
): WorkflowAcceptanceReviewPlan {
  const finalInput = acceptanceInputs.at(-1)
  if (!finalInput?.revision) throw new Error('Acceptance review plan has no final revision')
  return {
    acceptanceInputs,
    evidenceLinks,
    audit: {
      gate: 'workflow_acceptance_review',
      authority: 'user',
      acceptanceId: acceptance.id,
      acceptanceRevision: finalInput.revision,
      projectId: acceptance.projectId,
      decision: input.decision,
      actorId: authority.actorId,
      evidenceRefs: [...evidenceRefs],
      ...(input.decision === 'passed' || input.decision === 'failed'
        ? { verifier: authority.verifier, verifiedAt: authority.reviewedAt }
        : {}),
      ...(input.decision === 'waived' ? { waivedBy: authority.actorId } : {})
    }
  }
}

function normalizeReviewAuthority(
  authority: WorkflowAcceptanceReviewAuthority,
  acceptance: WorkflowAcceptanceRecord
): WorkflowAcceptanceReviewAuthority {
  const actorId = requiredReviewText(authority.actorId, 'review actor id')
  const verifier = requiredReviewText(authority.verifier, 'review verifier')
  if (!Number.isSafeInteger(authority.reviewedAt) || authority.reviewedAt < 0) {
    throw reviewError(
      'WORKFLOW_TRANSITION_INVALID',
      'reviewedAt must be a non-negative safe integer',
      acceptance.id,
      acceptance.projectId,
      'review_timestamp_invalid'
    )
  }
  return { actorId, verifier, reviewedAt: authority.reviewedAt }
}

function invalidReviewTransition(
  acceptance: WorkflowAcceptanceRecord,
  decision: string
): WorkflowAcceptanceGateError {
  return reviewError(
    'WORKFLOW_TRANSITION_INVALID',
    `acceptance ${acceptance.id} cannot apply ${decision} from ${acceptance.status}`,
    acceptance.id,
    acceptance.projectId,
    'review_transition_invalid',
    { fromStatus: acceptance.status, toStatus: decision }
  )
}

function reviewError(
  code: WorkflowAcceptanceGateErrorCode,
  message: string,
  acceptanceId: string,
  projectId: string | undefined,
  reason: string,
  details: WorkflowAcceptanceGateErrorDetails = {}
): WorkflowAcceptanceGateError {
  return new WorkflowAcceptanceGateError(code, message, {
    operation: 'reviewWorkflowAcceptance',
    targetType: 'acceptance',
    targetId: acceptanceId,
    acceptanceId,
    projectId,
    reason,
    ...details
  })
}

function reviewEvidenceLinkId(acceptanceId: string, criterionIndex: number, evidenceId: string): string {
  const digest = createHash('sha256')
    .update(`${acceptanceId}\0${criterionIndex}\0${evidenceId}`)
    .digest('hex')
  return `acceptance-review:${digest}`
}

function requiredReviewText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function optionalReviewText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 2000 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function compareAcceptance(left: WorkflowAcceptanceRecord, right: WorkflowAcceptanceRecord): number {
  return left.revision - right.revision || left.updatedAt - right.updatedAt || left.id.localeCompare(right.id)
}

function normalizeCaller(options: WorkflowAcceptanceGateOptions): WorkflowAcceptanceCaller {
  return normalizeWorkflowCaller(
    options.caller ?? options.callerType ?? options.actorType ?? options.actor
  )
}

function hasExplicitCaller(options: WorkflowAcceptanceGateOptions): boolean {
  return options.caller !== undefined || options.callerType !== undefined ||
    options.actorType !== undefined || options.actor !== undefined
}

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

// Kept as a named helper for callers that want to inspect a persisted record
// without importing query internals.
export function findAcceptanceForTarget(
  db: WorkflowLedgerDatabase,
  target: WorkflowAcceptanceTarget,
  acceptanceId?: string
): WorkflowAcceptanceRecord | null {
  const id = normalizeOptional(acceptanceId)
  if (id) return findWorkflowAcceptance(db, id)
  return readAcceptances(db)
    .filter((candidate) => target.kind === 'work_item'
      ? candidate.workItemId === target.record.id
      : candidate.goalId === target.record.id)
    .sort(compareAcceptance)
    .at(-1) ?? null
}
