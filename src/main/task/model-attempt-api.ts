import type {
  ModelAttemptCompleteInput,
  ModelAttemptLedgerVerification,
  ModelAttemptQuery,
  ModelAttemptRecord,
  ModelAttemptReconciliationQuery,
  ModelAttemptReconciliationResolution,
  ModelAttemptReconciliationView,
  ModelAttemptSelection,
  ModelAttemptStartInput
} from '../../shared/model-attempt-types'
import {
  completeModelAttempt as completeInDatabase,
  getModelAttempt as getFromDatabase,
  selectModelAttempts,
  startModelAttempt as startInDatabase,
  verifyModelAttemptLedger
} from './model-attempt-store'
import {
  getModelAttemptReconciliation,
  getModelAttemptRetryAuthorization,
  hasModelAttemptReconciliation,
  hasModelAttemptRetryAuthorization,
  listModelAttemptReconciliations,
  listModelAttemptRetryAuthorizations,
  resolveModelAttemptReconciliation
} from './model-attempt-reconciliation'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from './task-snapshot'
import { scheduleModelRouteObservationRefresh } from '../model/acceptance-quality-feedback'

export function startPersistedModelAttempt(
  input: ModelAttemptStartInput,
  rootDir?: string
): Promise<ModelAttemptRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => startInDatabase(db, input))
}

export async function completePersistedModelAttempt(
  attemptId: string,
  input: ModelAttemptCompleteInput,
  rootDir?: string
): Promise<ModelAttemptRecord> {
  const result = await mutateTaskSnapshotDatabase(rootDir, (db) => completeInDatabase(db, attemptId, input))
  scheduleModelRouteObservationRefresh(rootDir)
  return result
}

export function getPersistedModelAttempt(
  attemptId: string,
  rootDir?: string
): Promise<ModelAttemptRecord | null> {
  return readTaskSnapshotDatabase(rootDir, (db) => getFromDatabase(db, attemptId))
}

export function queryPersistedModelAttempts(
  query: ModelAttemptQuery = {},
  rootDir?: string
): Promise<ModelAttemptSelection> {
  return readTaskSnapshotDatabase(rootDir, (db) => selectModelAttempts(db, query))
}

export function verifyPersistedModelAttemptLedger(
  rootDir?: string
): Promise<ModelAttemptLedgerVerification> {
  return readTaskSnapshotDatabase(rootDir, verifyModelAttemptLedger)
}

export function listPersistedModelAttemptReconciliations(
  query: ModelAttemptReconciliationQuery = {},
  rootDir?: string
): Promise<ModelAttemptReconciliationView[]> {
  return readTaskSnapshotDatabase(rootDir, (db) => listModelAttemptReconciliations(db, query))
}

export function getPersistedModelAttemptReconciliation(
  attemptId: string,
  rootDir?: string
): Promise<ModelAttemptReconciliationView | null> {
  return readTaskSnapshotDatabase(rootDir, (db) => getModelAttemptReconciliation(db, attemptId))
}

export function hasPersistedModelAttemptReconciliation(
  query: ModelAttemptReconciliationQuery,
  rootDir?: string
): Promise<boolean> {
  return readTaskSnapshotDatabase(rootDir, (db) => hasModelAttemptReconciliation(db, query))
}

export function listPersistedModelAttemptRetryAuthorizations(
  query: ModelAttemptReconciliationQuery = {},
  rootDir?: string
): Promise<ModelAttemptReconciliationView[]> {
  return readTaskSnapshotDatabase(rootDir, (db) => listModelAttemptRetryAuthorizations(db, query))
}

export function getPersistedModelAttemptRetryAuthorization(
  query: ModelAttemptReconciliationQuery,
  rootDir?: string
): Promise<ModelAttemptReconciliationView | null> {
  return readTaskSnapshotDatabase(rootDir, (db) => getModelAttemptRetryAuthorization(db, query))
}

export function hasPersistedModelAttemptRetryAuthorization(
  query: ModelAttemptReconciliationQuery,
  rootDir?: string
): Promise<boolean> {
  return readTaskSnapshotDatabase(rootDir, (db) => hasModelAttemptRetryAuthorization(db, query))
}

export function resolvePersistedModelAttemptReconciliation(
  attemptId: string,
  expectedRevision: number,
  resolution: ModelAttemptReconciliationResolution,
  rootDir?: string
): Promise<ModelAttemptReconciliationView> {
  return mutateTaskSnapshotDatabase(rootDir, (db) =>
    resolveModelAttemptReconciliation(db, attemptId, expectedRevision, resolution))
}
