import { app } from 'electron'
import type { EffectTarget, MediaJobStatus } from '../../shared/types'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from '../task/effect-reconciliation-result'
import { queryWorkflowEvidence } from '../task/workflow-ledger-api'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findWorkflowAcceptance } from '../task/workflow-ledger-store'
import { getMediaStore } from './media-store'
import { reconcileUnappliedMediaCancellation } from './media-cancel-reconciliation'

export type MediaJobOperationTarget = Extract<EffectTarget, { kind: 'media_job_operation' }>

const OPERATIONS: MediaJobOperationTarget['operation'][] = ['submit', 'poll', 'download', 'cancel', 'asset_import', 'compose', 'continuity_check']
const STATUSES: MediaJobOperationTarget['expectedStatus'][] = [
  'submitting', 'running', 'downloading', 'succeeded', 'failed', 'cancelled', 'waiting_reconciliation'
]

export function buildMediaJobOperationTarget(input: Record<string, unknown>): MediaJobOperationTarget {
  const target = input as Partial<MediaJobOperationTarget>
  const ids = [target.mediaJobId, target.externalJobId, target.projectId, target.goalId, target.workItemId, target.runId]
  const artifactIds = [target.artifactId, target.evidenceId, target.acceptanceId]
  const hasArtifactIds = artifactIds.every(isId)
  const hasNoArtifactIds = artifactIds.every((value) => value === undefined)
  if (target.kind !== 'media_job_operation' || !OPERATIONS.includes(target.operation as MediaJobOperationTarget['operation']) ||
      !STATUSES.includes(target.expectedStatus as MediaJobOperationTarget['expectedStatus']) || !ids.every(isId) ||
      !isSha256(target.idempotencyKeyDigest) ||
      (operationCreatesArtifact(target.operation as MediaJobOperationTarget['operation']) ? !hasArtifactIds : !hasArtifactIds && !hasNoArtifactIds)) {
    throw new Error('MediaJob operation EffectTarget is invalid')
  }
  return JSON.parse(JSON.stringify(target)) as MediaJobOperationTarget
}

export async function reconcileMediaJobOperationTarget(
  target: MediaJobOperationTarget,
  rootDir: string = app.getPath('userData')
): Promise<EffectReconciliationResult> {
  if (target.operation === 'asset_import' || target.operation === 'compose' || target.operation === 'continuity_check') {
    return reconcileLocalMediaArtifact(target, rootDir)
  }
  const job = await getMediaStore(rootDir).getMediaJob(target.mediaJobId)
  if (!job) {
    return notApplied({ kind: target.kind, mediaJobId: target.mediaJobId, state: 'missing' }, 'MediaJob does not exist')
  }
  if (job.projectId !== target.projectId || job.goalId !== target.goalId ||
      job.workItemId !== target.workItemId || job.externalJobId !== target.externalJobId) {
    return unresolved({ kind: target.kind, mediaJobId: target.mediaJobId, reason: 'MediaJob ownership differs from the frozen target' })
  }
  const operationApplied = job.statusHistory.some((event) => event.runId === target.runId)
  if (!operationApplied) {
    return notApplied({ kind: target.kind, mediaJobId: target.mediaJobId, status: job.status }, 'MediaJob operation has no durable status event')
  }
  if (job.status === 'waiting_reconciliation' || target.expectedStatus === 'waiting_reconciliation') {
    return unresolved({
      kind: target.kind,
      mediaJobId: target.mediaJobId,
      status: job.status,
      externalJobId: target.externalJobId,
      reason: 'Media provider result is unknown and requires explicit reconciliation'
    })
  }
  const cancellationOutcome = await reconcileUnappliedMediaCancellation(target, job, rootDir)
  if (cancellationOutcome) return cancellationOutcome
  if (!statusSatisfies(job.status, target.expectedStatus)) {
    return unresolved({
      kind: target.kind,
      mediaJobId: target.mediaJobId,
      expectedStatus: target.expectedStatus,
      status: job.status,
      reason: 'MediaJob status differs from the frozen postcondition'
    })
  }
  if (target.operation !== 'download') {
    return confirmed(mediaObservation(target, job.status), 'MediaJob status transition is durably recorded')
  }
  return reconcileDownloadedArtifact(target, job.status, rootDir)
}

async function reconcileLocalMediaArtifact(
  target: MediaJobOperationTarget,
  rootDir: string
): Promise<EffectReconciliationResult> {
  if (!target.artifactId || !target.evidenceId || !target.acceptanceId) {
    return unresolved({ ...mediaObservation(target, target.expectedStatus), reason: 'Local media target lacks output identities' })
  }
  const lifecycle = await getPersistedArtifactLifecycle(target.artifactId, rootDir)
  if (!lifecycle) return notApplied(mediaObservation(target, target.expectedStatus), 'Local media Artifact does not exist')
  const evidence = await queryWorkflowEvidence({ evidenceId: target.evidenceId, limit: 2 }, rootDir)
  const acceptance = await readTaskSnapshotDatabase(rootDir, (db) => findWorkflowAcceptance(db, target.acceptanceId!))
  const valid = lifecycle.projectId === target.projectId && lifecycle.goalId === target.goalId &&
    lifecycle.workItemId === target.workItemId && lifecycle.runId === target.runId &&
    lifecycle.kind === 'custom' && (target.operation === 'continuity_check' ? lifecycle.storageKind === 'blob' : lifecycle.storageKind === 'source_ref') &&
    evidence.items.length === 1 && evidence.items[0].artifactId === target.artifactId &&
    acceptance?.status === (target.operation === 'continuity_check' ? target.expectedStatus : 'passed') &&
    acceptance.evidenceRefs.includes(target.evidenceId)
  const observation = {
    ...mediaObservation(target, target.expectedStatus),
    artifactId: target.artifactId,
    lifecycleDigest: lifecycle.digest,
    acceptanceStatus: acceptance?.status
  }
  return valid
    ? confirmed(observation, 'Local media Artifact, Evidence and Acceptance are committed')
    : unresolved({ ...observation, reason: 'Local media output records differ from the frozen target' })
}

async function reconcileDownloadedArtifact(
  target: MediaJobOperationTarget,
  status: MediaJobStatus,
  rootDir: string
): Promise<EffectReconciliationResult> {
  if (!target.artifactId || !target.evidenceId || !target.acceptanceId) {
    return unresolved({ ...mediaObservation(target, status), reason: 'Media download target lacks canonical output identities' })
  }
  const lifecycle = await getPersistedArtifactLifecycle(target.artifactId, rootDir)
  if (!lifecycle) {
    return unresolved({ ...mediaObservation(target, status), reason: 'Media output Artifact is missing' })
  }
  const evidence = await queryWorkflowEvidence({ evidenceId: target.evidenceId, limit: 2 }, rootDir)
  const acceptance = await readTaskSnapshotDatabase(rootDir, (db) => findWorkflowAcceptance(db, target.acceptanceId!))
  const valid = lifecycle.projectId === target.projectId && lifecycle.goalId === target.goalId &&
    lifecycle.workItemId === target.workItemId && lifecycle.runId === target.runId &&
    lifecycle.kind === 'custom' && (lifecycle.storageKind === 'blob' || lifecycle.storageKind === 'source_ref') &&
    evidence.items.length === 1 && evidence.items[0].artifactId === target.artifactId &&
    evidence.items[0].runId === target.runId && acceptance?.status === 'passed' &&
    acceptance.evidenceRefs.length === 1 && acceptance.evidenceRefs[0] === target.evidenceId
  const observation = {
    ...mediaObservation(target, status),
    artifactId: target.artifactId,
    lifecycleDigest: lifecycle.digest,
    evidenceDigest: evidence.items[0]?.digest,
    acceptanceStatus: acceptance?.status
  }
  return valid
    ? confirmed(observation, 'Media output Artifact, Evidence and Acceptance are committed')
    : unresolved({ ...observation, reason: 'Media output records differ from the frozen target' })
}

function statusSatisfies(actual: MediaJobStatus, expected: MediaJobOperationTarget['expectedStatus']): boolean {
  if (expected === 'cancelled') return actual === 'cancelled'
  if (actual === expected) return true
  if (actual === 'failed' || actual === 'cancelled') return expected !== 'waiting_reconciliation'
  const order: MediaJobStatus[] = ['requested', 'submitting', 'running', 'downloading', 'succeeded']
  const actualIndex = order.indexOf(actual)
  const expectedIndex = order.indexOf(expected)
  return actualIndex >= 0 && expectedIndex >= 0 && actualIndex >= expectedIndex
}

function mediaObservation(target: MediaJobOperationTarget, status: MediaJobStatus): Record<string, unknown> {
  return {
    kind: target.kind,
    operation: target.operation,
    mediaJobId: target.mediaJobId,
    externalJobId: target.externalJobId,
    status
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 256 && !/[\0-\x1f\x7f]/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function operationCreatesArtifact(operation: MediaJobOperationTarget['operation']): boolean {
  return operation === 'download' || operation === 'asset_import' || operation === 'compose' || operation === 'continuity_check'
}
