import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEventRecord,
  WorkflowEvidenceRecord
} from '../../shared/workflow-types'
import { selectTaskEvidence, type TaskEvidenceRecord } from './task-evidence-store'
import { assertWorkflowEvidenceEventCoverage } from './workflow-evidence-event-coverage'
import { readAllWorkflowEvidenceForIntegrity } from './workflow-evidence-store'
import {
  assertWorkflowEvidenceArtifactByteIntegrity,
  WorkflowArtifactByteIntegrityError
} from './workflow-acceptance-artifact-integrity'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { assertEvidenceLinkReferences } from './workflow-ledger-relations'
import { readAndVerifyEvents, readEvidenceLinks } from './workflow-ledger-query'

type EvidenceResolutionErrorCode =
  | 'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING'
  | 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID'
  | 'WORKFLOW_PROJECT_BOUNDARY'

type EvidenceResolutionErrorFactory = (
  code: EvidenceResolutionErrorCode,
  message: string,
  details: Record<string, unknown>
) => Error

export interface EvidenceResolution {
  evidence: TaskEvidenceRecord | WorkflowEvidenceRecord
  link: WorkflowEvidenceLinkRecord
}

/** Resolve every Acceptance evidenceRef strictly through its link-declared origin. */
export function resolveAcceptanceEvidenceRefs(
  db: WorkflowLedgerDatabase,
  acceptance: WorkflowAcceptanceRecord,
  createError: EvidenceResolutionErrorFactory,
  deferFileReadsForArtifactIds?: ReadonlySet<string>
): readonly EvidenceResolution[] {
  if (acceptance.evidenceRefs.length === 0) return []

  const links = readEvidenceLinks(db)
  const resolutions: EvidenceResolution[] = []
  let taskEvidenceById: ReadonlyMap<string, TaskEvidenceRecord> | undefined
  let workflowEvidenceById: ReadonlyMap<string, WorkflowEvidenceRecord> | undefined
  let verifiedEvents: readonly WorkflowEventRecord[] | undefined
  const loadTaskEvidence = (): ReadonlyMap<string, TaskEvidenceRecord> => {
    if (taskEvidenceById) return taskEvidenceById
    try {
      taskEvidenceById = new Map(selectTaskEvidence(db).map((item) => [item.evidenceId, item]))
      return taskEvidenceById
    } catch {
      throw createError(
        'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
        `acceptance ${acceptance.id} cannot resolve Task evidence`,
        evidenceDetails(acceptance, undefined, 'task_evidence_unavailable')
      )
    }
  }
  const loadWorkflowEvidence = (): ReadonlyMap<string, WorkflowEvidenceRecord> => {
    if (workflowEvidenceById) return workflowEvidenceById
    workflowEvidenceById = new Map(
      readAllWorkflowEvidenceForIntegrity(db).map((item) => [item.evidenceId, item])
    )
    return workflowEvidenceById
  }
  const loadVerifiedEvents = (): readonly WorkflowEventRecord[] => {
    if (verifiedEvents) return verifiedEvents
    verifiedEvents = readAndVerifyEvents(db)
    return verifiedEvents
  }
  for (const evidenceId of acceptance.evidenceRefs) {
    const matchingLinks = links.filter((candidate) =>
      candidate.acceptanceId === acceptance.id && candidate.evidenceId === evidenceId
    )
    if (matchingLinks.length === 0) {
      throw createError(
        'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING',
        `acceptance ${acceptance.id} is missing evidence link ${evidenceId}`,
        evidenceDetails(acceptance, evidenceId, 'evidence_link_missing')
      )
    }
    const origins = new Set(matchingLinks.map((link) => link.evidenceOrigin ?? 'task_effect'))
    if (origins.size > 1) {
      throw createError(
        'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
        `acceptance ${acceptance.id} evidence ${evidenceId} has ambiguous origins`,
        evidenceDetails(acceptance, evidenceId, 'evidence_origin_ambiguous')
      )
    }
    for (const link of matchingLinks) {
      const record = link.evidenceOrigin === 'workflow'
        ? resolveWorkflowEvidence(db, acceptance, link, loadWorkflowEvidence, loadVerifiedEvents, createError, deferFileReadsForArtifactIds)
        : resolveTaskEffectEvidence(acceptance, link, loadTaskEvidence, loadVerifiedEvents, createError)
      resolutions.push({ evidence: record, link })
    }
  }
  return resolutions
}

function resolveTaskEffectEvidence(
  acceptance: WorkflowAcceptanceRecord,
  link: WorkflowEvidenceLinkRecord,
  loadEvidence: () => ReadonlyMap<string, TaskEvidenceRecord>,
  loadVerifiedEvents: () => readonly WorkflowEventRecord[],
  createError: EvidenceResolutionErrorFactory
): TaskEvidenceRecord {
  const record = loadEvidence().get(link.evidenceId)
  if (!record) {
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING',
      `acceptance ${acceptance.id} references missing Task evidence ${link.evidenceId}`,
      evidenceDetails(acceptance, link.evidenceId, 'task_evidence_missing')
    )
  }
  if (link.projectId !== acceptance.projectId ||
      (record.projectId !== undefined && record.projectId !== acceptance.projectId)) {
    throw createError(
      'WORKFLOW_PROJECT_BOUNDARY',
      `acceptance ${acceptance.id} evidence ${link.evidenceId} crosses project boundary`,
      evidenceDetails(acceptance, link.evidenceId, 'evidence_project_mismatch')
    )
  }
  if (!link.runId || link.runId !== record.runId) {
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} evidence link ${link.id} has no matching Run`,
      evidenceDetails(acceptance, link.evidenceId, 'evidence_run_mismatch')
    )
  }
  try {
    loadVerifiedEvents()
  } catch (error) {
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} Task evidence ${link.evidenceId} event binding is invalid`,
      {
        ...evidenceDetails(acceptance, link.evidenceId, 'task_evidence_event_invalid'),
        cause: validationCause(error)
      }
    )
  }
  return record
}

function resolveWorkflowEvidence(
  db: WorkflowLedgerDatabase,
  acceptance: WorkflowAcceptanceRecord,
  link: WorkflowEvidenceLinkRecord,
  loadEvidence: () => ReadonlyMap<string, WorkflowEvidenceRecord>,
  loadVerifiedEvents: () => readonly WorkflowEventRecord[],
  createError: EvidenceResolutionErrorFactory,
  deferFileReadsForArtifactIds?: ReadonlySet<string>
): WorkflowEvidenceRecord {
  let record: WorkflowEvidenceRecord | undefined
  try {
    record = loadEvidence().get(link.evidenceId)
  } catch (error) {
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} cannot resolve Workflow evidence`,
      {
        ...evidenceDetails(acceptance, link.evidenceId, 'workflow_evidence_unavailable'),
        cause: error instanceof Error ? error.message : String(error)
      }
    )
  }
  if (!record) {
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING',
      `acceptance ${acceptance.id} references missing Workflow evidence ${link.evidenceId}`,
      evidenceDetails(acceptance, link.evidenceId, 'workflow_evidence_missing')
    )
  }
  if (link.projectId !== acceptance.projectId || record.projectId !== acceptance.projectId) {
    throw createError(
      'WORKFLOW_PROJECT_BOUNDARY',
      `acceptance ${acceptance.id} Workflow evidence ${link.evidenceId} crosses project boundary`,
      evidenceDetails(acceptance, link.evidenceId, 'workflow_evidence_project_mismatch')
    )
  }
  try {
    assertEvidenceLinkReferences(db, link)
  } catch (error) {
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} Workflow evidence ${link.evidenceId} ownership is invalid`,
      {
        ...evidenceDetails(acceptance, link.evidenceId, 'workflow_evidence_ownership_invalid'),
        cause: error instanceof Error ? error.message : String(error)
      }
    )
  }
  let events: readonly WorkflowEventRecord[]
  try {
    events = loadVerifiedEvents()
    assertWorkflowEvidenceEventCoverage([record], events)
  } catch (error) {
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} Workflow evidence ${link.evidenceId} event binding is invalid`,
      {
        ...evidenceDetails(acceptance, link.evidenceId, 'workflow_evidence_event_invalid'),
        cause: validationCause(error)
      }
    )
  }
  try {
    assertWorkflowEvidenceArtifactByteIntegrity(db, acceptance, record, events, deferFileReadsForArtifactIds)
  } catch (error) {
    const reason = error instanceof WorkflowArtifactByteIntegrityError
      ? error.reason
      : 'workflow_evidence_artifact_graph_invalid'
    throw createError(
      'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
      `acceptance ${acceptance.id} Workflow evidence ${link.evidenceId} artifact bytes are invalid`,
      evidenceDetails(acceptance, link.evidenceId, reason)
    )
  }
  return record
}

function validationCause(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown validation error'
}

function evidenceDetails(
  acceptance: WorkflowAcceptanceRecord,
  evidenceId: string | undefined,
  reason: string
): Record<string, unknown> {
  return {
    targetType: 'acceptance',
    targetId: acceptance.id,
    projectId: acceptance.projectId,
    acceptanceId: acceptance.id,
    ...(evidenceId === undefined ? {} : { evidenceId }),
    reason
  }
}
