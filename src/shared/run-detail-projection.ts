import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowRunSummary,
  WorkflowWorkItemRecord
} from './workflow-types'
import type { TaskRunStatus } from './task-runtime-types'

/** The three destinations that share one Run identity in the Studio. */
export type RunDetailSection = 'run' | 'acceptance' | 'recovery'

export interface RunDetailRoute {
  kind: 'run-detail'
  runId: string
  section: RunDetailSection
}

export interface RunDetailCanonicalInput {
  runs: readonly WorkflowRunSummary[]
  workItems?: readonly WorkflowWorkItemRecord[]
  acceptances?: readonly WorkflowAcceptanceRecord[]
  artifacts?: readonly WorkflowArtifactRecord[]
  evidenceLinks?: readonly WorkflowEvidenceLinkRecord[]
}

export interface RunDetailEvidenceBinding {
  linkId: string
  evidenceId: string
  relation: WorkflowEvidenceLinkRecord['relation']
  criterionId?: string
  artifactId?: string
}

export type RunAcceptanceGateStatus =
  | 'missing'
  | 'pending'
  | 'verifying'
  | 'failed'
  | 'passed'
  | 'waived'
  | 'blocked'

export interface RunAcceptanceGate {
  status: RunAcceptanceGateStatus
  acceptanceId?: string
  acceptanceRevision?: number
  criteriaCount: number
  evidenceRefs: string[]
  boundEvidenceRefs: string[]
  missingEvidenceRefs: string[]
  blockers: Array<'acceptance_missing' | 'evidence_missing' | 'acceptance_failed'>
}

export type RunRecoveryState = 'available' | 'in_progress' | 'reconciliation_required' | 'unavailable'

export interface RunRecoveryProjection {
  state: RunRecoveryState
  action: 'recover' | 'reconcile' | 'none'
  reason?: 'run_failed' | 'run_recovering' | 'run_waiting_reconciliation' | 'run_not_failed'
}

/** Renderer-safe identity needed to select one persisted recovery snapshot. */
export interface RunRecoverySnapshotIdentity {
  id: string
  sessionId: string
  taskId: string
  run?: Pick<WorkflowRunSummary, 'id' | 'sessionId' | 'taskId' | 'status'>
}

/**
 * One renderer-safe Run detail assembled from canonical Ledger projections.
 * It intentionally carries no TaskRun payload, raw error, or fabricated
 * Evidence. Actions remain outside this pure projection.
 */
export interface RunDetailProjection {
  schemaVersion: 1
  route: RunDetailRoute
  run: Pick<WorkflowRunSummary, 'id' | 'projectId' | 'goalId' | 'workItemId' | 'sessionId' | 'taskId' | 'status' | 'revision' | 'attempt' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'> & {
    taskRunDigest: string
    errorDigest?: string
  }
  workItem?: Pick<WorkflowWorkItemRecord, 'id' | 'projectId' | 'goalId' | 'title' | 'description' | 'status' | 'revision' | 'currentRunId'>
  acceptance?: Pick<WorkflowAcceptanceRecord, 'id' | 'projectId' | 'goalId' | 'workItemId' | 'criteria' | 'criterionEvidence' | 'status' | 'revision' | 'evidenceRefs' | 'verifier' | 'verifiedAt' | 'updatedAt'>
  artifacts: WorkflowArtifactRecord[]
  evidenceLinks: RunDetailEvidenceBinding[]
  acceptanceGate: RunAcceptanceGate
  recovery: RunRecoveryProjection
}

export class RunDetailProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunDetailProjectionError'
  }
}

const RECOVERY_STATUSES = new Set<TaskRunStatus>(['failed', 'recovering', 'waiting_reconciliation'])

/** Encode a stable, deep-linkable destination without exposing payload data. */
export function createRunDetailRoute(runId: string, section: RunDetailSection = 'run'): string {
  const route = parseRunId(runId)
  return `run/${encodeURIComponent(route)}/${section}`
}

export function parseRunDetailRoute(value: string): RunDetailRoute | null {
  if (typeof value !== 'string') return null
  const match = /^run\/([^/]+)\/(run|acceptance|recovery)$/.exec(value)
  if (!match) return null
  try {
    const runId = decodeURIComponent(match[1])
    if (!runId || runId.includes('/')) return null
    return { kind: 'run-detail', runId, section: match[2] as RunDetailSection }
  } catch {
    return null
  }
}

/**
 * Resolve a Run route against the current canonical selection. Unknown Runs
 * return null so stale inbox links cannot create a synthetic detail page.
 */
export function projectRunDetail(
  input: RunDetailCanonicalInput,
  route: string | RunDetailRoute
): RunDetailProjection | null {
  const parsed = typeof route === 'string' ? parseRunDetailRoute(route) : route
  if (!parsed || parsed.kind !== 'run-detail') return null
  assertUnique(input.runs, 'run')
  const run = input.runs.find((candidate) => candidate.id === parsed.runId)
  if (!run) return null

  const projectId = run.projectId
  const workItem = (input.workItems ?? []).find((candidate) =>
    candidate.id === run.workItemId && sameProject(candidate.projectId, projectId)
  )
  const acceptance = selectAcceptance(input.acceptances ?? [], run, projectId)
  const artifacts = (input.artifacts ?? [])
    .filter((artifact) => sameProject(artifact.projectId, projectId) &&
      (artifact.runId === run.id || artifact.workItemId === run.workItemId))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const relevantLinks = (input.evidenceLinks ?? [])
    .filter((link) => sameProject(link.projectId, projectId) &&
      // A link carrying another Run identity must never satisfy this Run's
      // gate, even if it happens to point at the same Acceptance.
      (!link.runId || link.runId === run.id) &&
      (link.runId === run.id ||
        (acceptance !== undefined && link.acceptanceId === acceptance.id) ||
        (link.artifactId !== undefined && artifactIds.has(link.artifactId))))
    .sort((left, right) => left.id.localeCompare(right.id))
  const evidenceLinks: RunDetailEvidenceBinding[] = relevantLinks.map((link) => ({
    linkId: link.id,
    evidenceId: link.evidenceId,
    relation: link.relation,
    ...(link.criterionId ? { criterionId: link.criterionId } : {}),
    ...(link.artifactId ? { artifactId: link.artifactId } : {})
  }))
  const acceptanceGate = projectAcceptanceGate(acceptance, evidenceLinks)
  return {
    schemaVersion: 1,
    route: parsed,
    run: {
      id: run.id,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      ...(run.goalId ? { goalId: run.goalId } : {}),
      workItemId: run.workItemId,
      sessionId: run.sessionId,
      taskId: run.taskId,
      status: run.status,
      revision: run.revision,
      attempt: run.attempt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      taskRunDigest: run.taskRunDigest,
      ...(run.errorDigest ? { errorDigest: run.errorDigest } : {})
    },
    ...(workItem ? { workItem: {
      id: workItem.id,
      ...(workItem.projectId ? { projectId: workItem.projectId } : {}),
      ...(workItem.goalId ? { goalId: workItem.goalId } : {}),
      title: workItem.title,
      ...(workItem.description ? { description: workItem.description } : {}),
      status: workItem.status,
      revision: workItem.revision,
      ...(workItem.currentRunId ? { currentRunId: workItem.currentRunId } : {})
    } } : {}),
    ...(acceptance ? { acceptance: {
      id: acceptance.id,
      ...(acceptance.projectId ? { projectId: acceptance.projectId } : {}),
      ...(acceptance.goalId ? { goalId: acceptance.goalId } : {}),
      ...(acceptance.workItemId ? { workItemId: acceptance.workItemId } : {}),
      criteria: [...acceptance.criteria],
      ...(acceptance.criterionEvidence ? { criterionEvidence: acceptance.criterionEvidence.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs] })) } : {}),
      status: acceptance.status,
      revision: acceptance.revision,
      evidenceRefs: [...acceptance.evidenceRefs],
      ...(acceptance.verifier ? { verifier: acceptance.verifier } : {}),
      ...(acceptance.verifiedAt !== undefined ? { verifiedAt: acceptance.verifiedAt } : {}),
      updatedAt: acceptance.updatedAt
    } } : {}),
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
    evidenceLinks,
    acceptanceGate,
    recovery: projectRecovery(run.status)
  }
}

/**
 * Resolve a failed canonical Run to exactly one matching local snapshot.
 * Ambiguous, stale, cross-session, and cross-task records fail closed before
 * the renderer can invoke recoverTaskSnapshot.
 */
export function resolveRunRecoverySnapshotId(
  run: Pick<WorkflowRunSummary, 'id' | 'sessionId' | 'taskId' | 'status'>,
  snapshots: readonly RunRecoverySnapshotIdentity[]
): string {
  if (run.status !== 'failed') throw new RunDetailProjectionError('Run is not failed and cannot be recovered')
  const candidates = snapshots.filter((snapshot) =>
    snapshot.id.trim() !== '' && snapshot.run?.id === run.id &&
    snapshot.sessionId === run.sessionId && snapshot.taskId === run.taskId &&
    snapshot.run.sessionId === run.sessionId && snapshot.run.taskId === run.taskId &&
    snapshot.run.status === 'failed'
  )
  if (candidates.length !== 1) {
    throw new RunDetailProjectionError(candidates.length === 0
      ? 'No recovery snapshot matches the canonical Run identity'
      : 'Multiple recovery snapshots match the canonical Run identity')
  }
  return candidates[0].id
}

function selectAcceptance(
  acceptances: readonly WorkflowAcceptanceRecord[],
  run: WorkflowRunSummary,
  projectId: string | undefined
): WorkflowAcceptanceRecord | undefined {
  assertUnique(acceptances, 'acceptance')
  const candidates = acceptances.filter((acceptance) =>
    sameProject(acceptance.projectId, projectId) &&
    acceptance.workItemId === run.workItemId &&
    (!run.acceptanceId || acceptance.id === run.acceptanceId)
  )
  if (run.acceptanceId && !candidates.some((acceptance) => acceptance.id === run.acceptanceId)) return undefined
  return candidates.sort((left, right) => right.revision - left.revision || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0]
}

function projectAcceptanceGate(
  acceptance: WorkflowAcceptanceRecord | undefined,
  links: readonly RunDetailEvidenceBinding[]
): RunAcceptanceGate {
  if (!acceptance) return {
    status: 'missing', criteriaCount: 0, evidenceRefs: [], boundEvidenceRefs: [], missingEvidenceRefs: [], blockers: ['acceptance_missing']
  }
  const evidenceRefs = [...new Set([
    ...acceptance.evidenceRefs,
    ...(acceptance.criterionEvidence ?? []).flatMap((item) => item.evidenceRefs)
  ])].sort()
  const linkEvidenceRefs = new Set(links.map((link) => link.evidenceId))
  const boundEvidenceRefs = evidenceRefs.filter((id) => linkEvidenceRefs.has(id))
  const missingEvidenceRefs = evidenceRefs.filter((id) => !linkEvidenceRefs.has(id))
  const blockers: RunAcceptanceGate['blockers'] = []
  if (acceptance.status === 'failed') blockers.push('acceptance_failed')
  if (missingEvidenceRefs.length > 0) blockers.push('evidence_missing')
  const status: RunAcceptanceGateStatus = acceptance.status === 'passed' && missingEvidenceRefs.length > 0
    ? 'blocked'
    : acceptance.status
  return {
    status,
    acceptanceId: acceptance.id,
    acceptanceRevision: acceptance.revision,
    criteriaCount: acceptance.criteria.length,
    evidenceRefs,
    boundEvidenceRefs,
    missingEvidenceRefs,
    blockers
  }
}

function projectRecovery(status: TaskRunStatus): RunRecoveryProjection {
  if (status === 'failed') return { state: 'available', action: 'recover', reason: 'run_failed' }
  if (status === 'recovering') return { state: 'in_progress', action: 'none', reason: 'run_recovering' }
  if (status === 'waiting_reconciliation') return { state: 'reconciliation_required', action: 'reconcile', reason: 'run_waiting_reconciliation' }
  return { state: 'unavailable', action: 'none', reason: 'run_not_failed' }
}

function sameProject(left: string | undefined, right: string | undefined): boolean {
  return left === right || (left === undefined && right === undefined)
}

function parseRunId(runId: string): string {
  if (typeof runId !== 'string' || !runId.trim() || runId.includes('/')) throw new RunDetailProjectionError('runId must be a non-empty path-safe string')
  return runId
}

function assertUnique(records: readonly { id: string }[], kind: string): void {
  const ids = new Set<string>()
  for (const record of records) {
    if (!record.id || ids.has(record.id)) throw new RunDetailProjectionError(`duplicate ${kind} id: ${record.id}`)
    ids.add(record.id)
  }
}

// Keep this export referenced by contract tests so status coverage cannot drift silently.
export const RUN_DETAIL_RECOVERY_STATUSES = [...RECOVERY_STATUSES]
