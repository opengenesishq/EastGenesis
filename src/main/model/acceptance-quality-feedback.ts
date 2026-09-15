import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import { attemptObservationIdentity, deriveRouteObservationSnapshot } from './route-observation-feedback'
import { publishRouteObservationSnapshot, routeObservationKey } from './route-observation-signal'
import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowRunRecord
} from '../../shared/workflow-types'
import { readRawModelAttempts } from '../task/model-attempt-schema'
import { verifyModelAttemptLedger } from '../task/model-attempt-store'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { readAllWorkflowEvidenceForIntegrity } from '../task/workflow-evidence-store'
import {
  readAcceptances,
  readArtifacts,
  readEvidenceLinks,
  readRuns
} from '../task/workflow-ledger-query'
import {
  acceptanceQualitySignalKey,
  getAcceptanceQualitySignal,
  publishAcceptanceQualitySnapshot,
  type AcceptanceQualitySignal
} from './acceptance-quality-signal'

export { getAcceptanceQualitySignal, type AcceptanceQualitySignal } from './acceptance-quality-signal'

const PRIOR_SAMPLE_WEIGHT = 5
let configuredRootDir: string | undefined
let activeRefresh: Promise<void> | null = null
let queuedRefreshRoot: string | undefined

export function configureAcceptanceQualityFeedback(rootDir: string): void {
  configuredRootDir = rootDir
  publishAcceptanceQualitySnapshot(new Map())
  publishRouteObservationSnapshot(new Map())
  scheduleAcceptanceQualityFeedbackRefresh(rootDir)
}

/**
 * Rebuild from canonical records so the same Acceptance revision is never
 * accumulated twice. A refresh arriving during a scan queues one final scan.
 */
export function refreshAcceptanceQualityFeedback(rootDir = configuredRootDir): Promise<void> {
  if (activeRefresh) {
    queuedRefreshRoot = rootDir
    return activeRefresh
  }
  activeRefresh = rebuildSnapshot(rootDir)
    .then(({ acceptance, observations }) => {
      publishAcceptanceQualitySnapshot(acceptance)
      publishRouteObservationSnapshot(observations)
    })
    .catch((error) => {
      publishAcceptanceQualitySnapshot(new Map())
      publishRouteObservationSnapshot(new Map())
      throw error
    })
    .finally(() => {
      activeRefresh = null
      if (queuedRefreshRoot !== undefined) {
        const queuedRoot = queuedRefreshRoot
        queuedRefreshRoot = undefined
        scheduleAcceptanceQualityFeedbackRefresh(queuedRoot)
      }
    })
  return activeRefresh
}

export function scheduleAcceptanceQualityFeedbackRefresh(rootDir = configuredRootDir): void {
  void refreshAcceptanceQualityFeedback(rootDir).catch((error) => {
    console.error('[caogen] Acceptance quality feedback refresh failed:', error)
  })
}

/** Only the configured application ledger feeds request-path observations. */
export function scheduleModelRouteObservationRefresh(rootDir?: string): void {
  if (configuredRootDir && (rootDir === undefined || rootDir === configuredRootDir)) {
    scheduleAcceptanceQualityFeedbackRefresh(configuredRootDir)
  }
}

async function rebuildSnapshot(rootDir: string | undefined) {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    verifyModelAttemptLedger(db)
    const input = {
      acceptances: readAcceptances(db),
      artifacts: readArtifacts(db),
      evidence: readAllWorkflowEvidenceForIntegrity(db),
      evidenceLinks: readEvidenceLinks(db),
      runs: readRuns(db),
      attempts: readRawModelAttempts(db)
    }
    return { acceptance: deriveAcceptanceQualitySnapshot(input), observations: deriveRouteObservationSnapshot(input) }
  })
}

function deriveAcceptanceQualitySnapshot(input: {
  acceptances: readonly WorkflowAcceptanceRecord[]
  artifacts: readonly WorkflowArtifactRecord[]
  evidence: readonly WorkflowEvidenceRecord[]
  evidenceLinks: readonly WorkflowEvidenceLinkRecord[]
  runs: readonly WorkflowRunRecord[]
  attempts: readonly ModelAttemptRecord[]
}): Map<string, AcceptanceQualitySignal> {
  const artifactsById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]))
  const evidenceById = new Map(input.evidence.map((record) => [record.evidenceId, record]))
  const attemptsByRun = groupAttemptsByRun(input.attempts)
  const runsById = new Map(input.runs.map((run) => [run.id, run]))
  const result = new Map<string, AcceptanceQualitySignal>()

  for (const acceptance of input.acceptances) {
    if (acceptance.status !== 'passed' && acceptance.status !== 'failed') continue
    const runIds = acceptanceRunIds(
      acceptance,
      input.runs,
      input.evidenceLinks,
      artifactsById,
      evidenceById
    )
    const creditedModels = new Map<string, Pick<ModelAttemptRecord, 'providerId' | 'model'>>()
    for (const runId of runIds) {
      for (const attempt of attemptsByRun.get(runId) ?? []) {
        if (attempt.status !== 'succeeded') continue
        creditedModels.set(acceptanceQualitySignalKey(attempt.providerId, attempt.model), attempt)
        const identity = attemptObservationIdentity(attempt, runsById.get(runId))
        if (identity) creditedModels.set(routeObservationKey(identity), attempt)
      }
    }
    for (const [key, identity] of creditedModels) {
      const current = result.get(key) ?? {
        providerId: identity.providerId,
        model: identity.model,
        passed: 0,
        failed: 0,
        samples: 0,
        score: 0.5
      }
      if (acceptance.status === 'passed') current.passed += 1
      else current.failed += 1
      current.samples += 1
      current.lastAcceptanceAt = Math.max(current.lastAcceptanceAt ?? 0, acceptance.updatedAt)
      current.score = shrinkAcceptanceScore(current.passed, current.failed)
      result.set(key, current)
    }
  }
  return result
}

function acceptanceRunIds(
  acceptance: WorkflowAcceptanceRecord,
  runs: readonly WorkflowRunRecord[],
  evidenceLinks: readonly WorkflowEvidenceLinkRecord[],
  artifactsById: ReadonlyMap<string, WorkflowArtifactRecord>,
  evidenceById: ReadonlyMap<string, WorkflowEvidenceRecord>
): Set<string> {
  const runIds = new Set<string>()
  const linkedEvidenceIds = new Set(acceptance.evidenceRefs)
  for (const link of evidenceLinks) {
    if (link.acceptanceId !== acceptance.id) continue
    linkedEvidenceIds.add(link.evidenceId)
    if (link.runId) runIds.add(link.runId)
    if (link.artifactId) addArtifactRun(runIds, artifactsById.get(link.artifactId))
  }
  for (const evidenceId of linkedEvidenceIds) {
    const evidence = evidenceById.get(evidenceId)
    if (!evidence) continue
    if (evidence.runId) runIds.add(evidence.runId)
    if (evidence.artifactId) addArtifactRun(runIds, artifactsById.get(evidence.artifactId))
  }
  for (const run of runs) {
    if (run.acceptanceId === acceptance.id) runIds.add(run.id)
  }
  // Legacy Acceptance records may predate explicit Run/Evidence bindings.
  if (runIds.size === 0 && acceptance.workItemId) {
    for (const run of runs) {
      if (run.workItemId === acceptance.workItemId &&
          (!acceptance.projectId || run.projectId === acceptance.projectId) &&
          (!acceptance.goalId || run.goalId === acceptance.goalId)) {
        runIds.add(run.id)
      }
    }
  }
  return runIds
}

function addArtifactRun(runIds: Set<string>, artifact: WorkflowArtifactRecord | undefined): void {
  if (artifact?.runId) runIds.add(artifact.runId)
}

function groupAttemptsByRun(
  attempts: readonly ModelAttemptRecord[]
): Map<string, ModelAttemptRecord[]> {
  const grouped = new Map<string, ModelAttemptRecord[]>()
  for (const attempt of attempts) {
    const values = grouped.get(attempt.runId) ?? []
    values.push(attempt)
    grouped.set(attempt.runId, values)
  }
  return grouped
}

function shrinkAcceptanceScore(passed: number, failed: number): number {
  const samples = passed + failed
  return (passed + PRIOR_SAMPLE_WEIGHT * 0.5) / (samples + PRIOR_SAMPLE_WEIGHT)
}
