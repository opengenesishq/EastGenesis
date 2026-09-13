import type {
  WorkflowAcceptanceStatus,
  WorkflowArtifactLocationKind,
  WorkflowEvidenceKind,
  WorkflowEvidenceSource
} from '../../shared/workflow-types'
import {
  registerPersistedArtifactLifecycleAtomically,
  resolveLifecycleRoots
} from './artifact-lifecycle-api'
import { assertSha256Digest } from './artifact-lifecycle-content'
import type {
  ArtifactLifecycleRegistrationInput,
  ArtifactLifecycleRegistrationResult,
  ArtifactLifecycleRootInput
} from './artifact-lifecycle-types'
import { recordWorkflowEvidence } from './workflow-ledger-api'
import {
  findWorkflowAcceptance,
  linkWorkflowEvidence,
  projectWorkflowAcceptance,
  setupWorkflowLedgerSchema
} from './workflow-ledger-store'
import { recordWorkflowArtifactLocation } from './workflow-ledger-artifact-graph'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import {
  applyProducedArtifactStageAttachment,
  getPreparedProducedArtifactStageAttachment,
  recordPreparedProducedArtifactStageAttachment,
  resolveProducedArtifactStageAttachment,
  type ProducedArtifactStageAttachment
} from './workflow-stage-handoff'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { scheduleAcceptanceQualityFeedbackRefresh } from '../model/acceptance-quality-feedback'

export interface CanonicalProducedArtifactEvidence {
  id: string
  kind: WorkflowEvidenceKind
  title: string
  summary: string
  source?: WorkflowEvidenceSource
  verifier: string
  uri?: string
  metadata?: Record<string, unknown>
}

export interface CanonicalProducedArtifactAcceptance {
  id: string
  criterionId: string
  criterion: string
  status: Extract<WorkflowAcceptanceStatus, 'passed' | 'failed'>
  verifier: string
  /** Create a separate Goal/WorkItem Acceptance for a canonical system operation. */
  authorizesWorkflowStage?: boolean
}

export interface CanonicalProducedArtifactExternalLocation {
  id: string
  kind?: Extract<WorkflowArtifactLocationKind, 'url' | 'git' | 'external' | 'preview'>
  uri: string
  metadata?: Record<string, unknown>
}

export interface CanonicalProducedArtifactInput {
  lifecycle: ArtifactLifecycleRegistrationInput & { workItemId: string }
  evidence: CanonicalProducedArtifactEvidence
  acceptance?: CanonicalProducedArtifactAcceptance
  externalLocation?: CanonicalProducedArtifactExternalLocation
  attachToStage?: boolean
}

export interface CanonicalProducedArtifactResult extends ArtifactLifecycleRegistrationResult {
  evidenceId: string
  acceptanceId?: string
}

/**
 * Shared production boundary for all first-class outputs. It deliberately reuses
 * the lifecycle, graph, Evidence, Acceptance, export and recovery stores instead
 * of creating a producer-specific persistence path.
 */
export async function registerCanonicalProducedArtifact(
  input: CanonicalProducedArtifactInput,
  rootInput?: ArtifactLifecycleRootInput
): Promise<CanonicalProducedArtifactResult> {
  const roots = resolveLifecycleRoots(rootInput)
  const policyInput = enforceArtifactProjectionPolicy(input)
  const existingStageAttachment = policyInput.attachToStage
    ? await getPreparedProducedArtifactStageAttachment(input.lifecycle.id, roots.workflowRoot)
    : undefined
  const observedAt = input.lifecycle.createdAt ?? existingStageAttachment?.observedAt ?? Date.now()
  const normalizedInput: CanonicalProducedArtifactInput = {
    ...policyInput,
    lifecycle: { ...input.lifecycle, createdAt: observedAt }
  }
  const plannedStageAttachment = normalizedInput.attachToStage
    ? existingStageAttachment ??
      await resolveProducedArtifactStageAttachment({
        artifactId: input.lifecycle.id,
        projectId: input.lifecycle.projectId,
        workItemId: input.lifecycle.workItemId,
        runId: input.lifecycle.runId,
        rootDir: roots.workflowRoot,
        observedAt
      })
    : undefined
  const committed = await registerPersistedArtifactLifecycleAtomically(
    normalizedInput.lifecycle,
    (db, registered) => projectProducedArtifactRecords(
      db,
      normalizedInput,
      registered,
      plannedStageAttachment
    ),
    roots
  )
  const { registered, evidence, acceptance, stageAttachment } = committed
  if (stageAttachment) {
    await applyProducedArtifactStageAttachment(stageAttachment, roots.workflowRoot)
  }
  if (acceptance?.status === 'passed' || acceptance?.status === 'failed') {
    scheduleAcceptanceQualityFeedbackRefresh(roots.workflowRoot)
  }

  return {
    ...registered,
    evidenceId: evidence.evidenceId,
    ...(acceptance ? { acceptanceId: acceptance.id } : {})
  }
}

function enforceArtifactProjectionPolicy(
  input: CanonicalProducedArtifactInput
): CanonicalProducedArtifactInput {
  if (input.lifecycle.provenance !== 'legacy-derived') return input
  return {
    ...input,
    attachToStage: false,
    ...(input.acceptance ? {
      acceptance: { ...input.acceptance, authorizesWorkflowStage: false }
    } : {})
  }
}

function projectProducedArtifactRecords(
  db: WorkflowLedgerDatabase,
  input: CanonicalProducedArtifactInput,
  registered: ArtifactLifecycleRegistrationResult,
  plannedStageAttachment: ProducedArtifactStageAttachment | undefined
): {
  registered: ArtifactLifecycleRegistrationResult
  evidence: ReturnType<typeof recordWorkflowEvidence>
  acceptance?: ReturnType<typeof projectWorkflowAcceptance>
  stageAttachment?: ProducedArtifactStageAttachment
} {
  setupWorkflowLedgerSchema(db)
  const lifecycle = registered.lifecycle
  const observedAt = lifecycle.createdAt
  if (input.externalLocation) {
    recordWorkflowArtifactLocation(db, {
      id: input.externalLocation.id,
      artifactId: lifecycle.artifactId,
      projectId: lifecycle.projectId,
      goalId: lifecycle.goalId,
      workItemId: lifecycle.workItemId,
      runId: lifecycle.runId,
      kind: input.externalLocation.kind ?? 'url',
      uri: input.externalLocation.uri,
      availability: 'available',
      metadata: input.externalLocation.metadata,
      createdAt: observedAt,
      updatedAt: observedAt
    })
  }
  let acceptance = input.acceptance
    ? ensureArtifactAcceptance(db, input, observedAt)
    : undefined
  const evidence = recordWorkflowEvidence(db, {
    evidenceId: input.evidence.id,
    projectId: lifecycle.projectId,
    goalId: lifecycle.goalId,
    workItemId: lifecycle.workItemId,
    runId: lifecycle.runId,
    artifactId: lifecycle.artifactId,
    kind: input.evidence.kind,
    title: input.evidence.title,
    summary: input.evidence.summary,
    uri: input.evidence.uri,
    mediaType: registered.artifact.mediaType,
    contentDigest: evidenceContentDigest(lifecycle.digest),
    metadata: {
      producer: input.lifecycle.metadata?.producer,
      ...input.evidence.metadata
    }
  }, {
    source: input.evidence.source ?? 'runtime',
    verifier: input.evidence.verifier,
    observedAt
  })
  if (input.acceptance && acceptance) {
    linkWorkflowEvidence(db, {
      id: `${input.acceptance.id}:link:${input.acceptance.criterionId}`,
      evidenceId: evidence.evidenceId,
      projectId: lifecycle.projectId,
      runId: lifecycle.runId,
      artifactId: lifecycle.artifactId,
      acceptanceId: acceptance.id,
      criterionId: input.acceptance.criterionId,
      evidenceOrigin: 'workflow',
      relation: 'verifies',
      createdAt: observedAt
    })
    acceptance = finalizeArtifactAcceptance(db, input, acceptance, evidence.evidenceId, observedAt)
    if (input.acceptance.authorizesWorkflowStage) {
      projectWorkflowStageAcceptance(db, input, evidence.evidenceId, observedAt)
    }
  }
  const stageAttachment = plannedStageAttachment && (!acceptance || acceptance.status === 'passed')
    ? recordPreparedProducedArtifactStageAttachment(db, plannedStageAttachment)
    : undefined
  return {
    registered,
    evidence,
    ...(acceptance ? { acceptance } : {}),
    ...(stageAttachment ? { stageAttachment } : {})
  }
}

function projectWorkflowStageAcceptance(
  db: WorkflowLedgerDatabase,
  input: CanonicalProducedArtifactInput & { acceptance?: CanonicalProducedArtifactAcceptance },
  evidenceId: string,
  observedAt: number
): void {
  const spec = input.acceptance
  if (!spec) return
  const lifecycle = input.lifecycle
  if (!lifecycle.goalId || !lifecycle.workItemId) {
    throw new WorkflowLedgerCorruptionError(
      `Workflow stage Acceptance requires Goal and WorkItem ownership: ${lifecycle.id}`
    )
  }
  const acceptanceId = `${spec.id}:workflow-stage`
  const criterionId = `${spec.criterionId}:workflow-stage`
  const acceptance = findOrCreateStageAcceptance(db, input, acceptanceId, criterionId, observedAt)
  assertStageAcceptanceScope(acceptance, lifecycle, spec)
  linkWorkflowEvidence(db, {
    id: `${acceptanceId}:link:${criterionId}`,
    evidenceId,
    projectId: lifecycle.projectId,
    runId: lifecycle.runId,
    acceptanceId,
    criterionId,
    evidenceOrigin: 'workflow',
    relation: 'verifies',
    createdAt: observedAt
  })
  if (acceptance.status === 'verifying') {
    finalizeStageAcceptance(db, acceptance, spec, criterionId, evidenceId, observedAt)
    return
  }
  assertStageAcceptanceResult(acceptance, spec, evidenceId)
}

function findOrCreateStageAcceptance(
  db: WorkflowLedgerDatabase,
  input: CanonicalProducedArtifactInput,
  acceptanceId: string,
  criterionId: string,
  observedAt: number
) {
  const existing = findWorkflowAcceptance(db, acceptanceId)
  if (existing) return existing
  const spec = input.acceptance
  if (!spec || !input.lifecycle.goalId || !input.lifecycle.workItemId) {
    throw new WorkflowLedgerCorruptionError(`Workflow stage Acceptance lacks required scope: ${acceptanceId}`)
  }
  return projectWorkflowAcceptance(db, {
    id: acceptanceId,
    projectId: input.lifecycle.projectId,
    goalId: input.lifecycle.goalId,
    workItemId: input.lifecycle.workItemId,
    criteria: [spec.criterion],
    criterionPolicies: [{
      criterionId,
      criterionIndex: 0,
      evidenceKind: input.evidence.kind,
      allowedSources: [input.evidence.source ?? 'runtime']
    }],
    status: 'verifying', evidenceRefs: [], revision: 1,
    createdAt: observedAt, updatedAt: observedAt
  }, { caller: 'automatic', actorId: spec.verifier })
}

function assertStageAcceptanceScope(acceptance: ReturnType<typeof findWorkflowAcceptance>, lifecycle: CanonicalProducedArtifactInput['lifecycle'], spec: CanonicalProducedArtifactAcceptance): void {
  if (!acceptance || acceptance.projectId !== lifecycle.projectId || acceptance.goalId !== lifecycle.goalId ||
      acceptance.workItemId !== lifecycle.workItemId || acceptance.criteria.length !== 1 ||
      acceptance.criteria[0] !== spec.criterion) {
    throw new WorkflowLedgerCorruptionError(
      `Workflow stage Acceptance replay differs from producer scope: ${acceptance?.id ?? spec.id}`
    )
  }
}

function finalizeStageAcceptance(
  db: WorkflowLedgerDatabase,
  acceptance: NonNullable<ReturnType<typeof findWorkflowAcceptance>>,
  spec: CanonicalProducedArtifactAcceptance,
  criterionId: string,
  evidenceId: string,
  observedAt: number
): void {
  projectWorkflowAcceptance(db, {
    ...acceptance,
    status: spec.status,
    evidenceRefs: [evidenceId],
    criterionEvidence: [{ criterionId, criterionIndex: 0, evidenceRefs: [evidenceId] }],
    verifier: spec.verifier,
    verifiedAt: observedAt,
    revision: acceptance.revision + 1,
    updatedAt: observedAt
  }, { caller: 'automatic', actorId: spec.verifier })
}

function assertStageAcceptanceResult(
  acceptance: NonNullable<ReturnType<typeof findWorkflowAcceptance>>,
  spec: CanonicalProducedArtifactAcceptance,
  evidenceId: string
): void {
  if (acceptance.status !== spec.status || acceptance.verifier !== spec.verifier ||
      acceptance.evidenceRefs.length !== 1 || acceptance.evidenceRefs[0] !== evidenceId) {
    throw new WorkflowLedgerCorruptionError(
      `Workflow stage Acceptance replay differs from persisted result: ${acceptance.id}`
    )
  }
}

function ensureArtifactAcceptance(
  db: WorkflowLedgerDatabase,
  input: CanonicalProducedArtifactInput & { acceptance?: CanonicalProducedArtifactAcceptance },
  observedAt: number
) {
  const spec = input.acceptance
  if (!spec) return undefined
  const lifecycle = input.lifecycle
  let existing = findWorkflowAcceptance(db, spec.id)
  if (!existing) {
    return projectWorkflowAcceptance(db, {
      id: spec.id,
      projectId: lifecycle.projectId,
      criteria: [spec.criterion],
      criterionPolicies: [{
        criterionId: spec.criterionId,
        criterionIndex: 0,
        evidenceKind: input.evidence.kind,
        allowedSources: [input.evidence.source ?? 'runtime']
      }],
      status: 'verifying',
      evidenceRefs: [],
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt
    }, { caller: 'automatic', actorId: spec.verifier })
  }
  if (existing.projectId !== lifecycle.projectId || existing.goalId !== undefined ||
      existing.workItemId !== undefined || existing.criteria.length !== 1 ||
      existing.criteria[0] !== spec.criterion) {
    throw new WorkflowLedgerCorruptionError(
      `Artifact Acceptance replay differs from producer scope: ${existing.id}`
    )
  }
  if (existing.status === 'pending') {
    existing = projectWorkflowAcceptance(db, {
      ...existing,
      status: 'verifying',
      revision: existing.revision + 1,
      updatedAt: observedAt
    }, { caller: 'automatic', actorId: spec.verifier })
  }
  return existing
}

function finalizeArtifactAcceptance(
  db: WorkflowLedgerDatabase,
  input: CanonicalProducedArtifactInput & { acceptance?: CanonicalProducedArtifactAcceptance },
  acceptance: NonNullable<ReturnType<typeof ensureArtifactAcceptance>>,
  evidenceId: string,
  observedAt: number
) {
  const spec = input.acceptance
  if (!spec) return acceptance
  if (acceptance.status === 'verifying') {
    return projectWorkflowAcceptance(db, {
      ...acceptance,
      status: spec.status,
      evidenceRefs: [evidenceId],
      criterionEvidence: [{
        criterionId: spec.criterionId,
        criterionIndex: 0,
        evidenceRefs: [evidenceId]
      }],
      verifier: spec.verifier,
      verifiedAt: observedAt,
      revision: acceptance.revision + 1,
      updatedAt: observedAt
    }, { caller: 'automatic', actorId: spec.verifier })
  }
  if (acceptance.status !== spec.status || acceptance.verifier !== spec.verifier ||
      acceptance.evidenceRefs.length !== 1 || acceptance.evidenceRefs[0] !== evidenceId) {
    throw new WorkflowLedgerCorruptionError(
      `Artifact Acceptance replay differs from persisted result: ${acceptance.id}`
    )
  }
  return acceptance
}

function evidenceContentDigest(value: string): string {
  return assertSha256Digest(value, 'produced Artifact digest').slice('sha256:'.length)
}
