import type { WorkflowArtifactKind, WorkflowEventRecord } from '../../shared/workflow-types'
import {
  artifactBlobPath,
  assertRegularContent,
  isArtifactSourceProjectPath,
  pathExists
} from './artifact-lifecycle-content'
import type {
  ArtifactLifecycleRecord,
  ArtifactLifecycleVerification,
  ArtifactPurgeRecord,
  ArtifactRetentionRevisionRecord
} from './artifact-lifecycle-types'
import {
  findArtifactLifecycle,
  findArtifactPurge,
  readEffectiveArtifactRetention,
  readArtifactLifecycles,
  readArtifactPurges,
  readArtifactRetentionRevisions,
  setupArtifactLifecycleSchema
} from './artifact-lifecycle-store'
import {
  findWorkflowArtifact,
  findWorkflowRun
} from './workflow-ledger-store'
import {
  findWorkflowArtifactEdge,
  findWorkflowArtifactLocation
} from './workflow-ledger-artifact-graph'
import { verifyWorkflowArtifactGraph } from './workflow-ledger-artifact-graph-query'
import { findEventById } from './workflow-ledger-query'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { canonicalJson, digest } from './workflow-ledger-codec'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { hasApprovedArtifactSupersession } from './requirement-artifact-access'

export async function verifyArtifactLifecycle(
  db: WorkflowLedgerDatabase,
  rootDir: string,
  requiredKinds: readonly WorkflowArtifactKind[] = []
): Promise<ArtifactLifecycleVerification> {
  setupArtifactLifecycleSchema(db)
  verifyWorkflowArtifactGraph(db)
  const records = readArtifactLifecycles(db)
  const purges = readArtifactPurges(db)
  const retentionRevisions = readArtifactRetentionRevisions(db)
  for (const record of records) await verifyLifecycleRecord(db, rootDir, record)
  verifyRetentionRevisions(db, records, retentionRevisions)
  for (const purge of purges) verifyPurgeRecord(db, purge)
  assertRequiredKinds(records, requiredKinds)
  const purgeIds = new Set(purges.map((record) => record.artifactId))
  const kinds = [...new Set(records.map((record) => record.kind))].sort() as WorkflowArtifactKind[]
  return {
    valid: true,
    artifacts: records.length,
    available: records.filter((record) => !purgeIds.has(record.artifactId)).length,
    purged: purges.length,
    blobs: records.filter((record) => record.storageKind === 'blob').length,
    sourceRefs: records.filter((record) => record.storageKind === 'source_ref').length,
    kinds
  }
}

async function verifyLifecycleRecord(
  db: WorkflowLedgerDatabase,
  rootDir: string,
  record: ArtifactLifecycleRecord
): Promise<void> {
  assertLifecycleColumns(db, record)
  const artifact = findWorkflowArtifact(db, record.artifactId)
  if (!artifact || artifact.projectId !== record.projectId || artifact.goalId !== record.goalId ||
      artifact.workItemId !== record.workItemId || artifact.runId !== record.runId ||
      artifact.kind !== record.kind || artifact.version !== record.version ||
      artifact.digest !== record.digest || artifact.provenance !== record.provenance ||
      artifact.supersedesId !== record.supersedesId) {
    throw new WorkflowLedgerCorruptionError(`artifact lifecycle ${record.artifactId} differs from Artifact projection`)
  }
  assertCreatingRun(db, record)
  assertContentLocation(db, rootDir, record)
  assertSupersession(db, record)
  assertLifecycleEvent(db, record)
  const purge = findArtifactPurge(db, record.artifactId)
  if (!purge) await verifyAvailableContent(rootDir, record)
  else await verifyPurgedContent(db, rootDir, record, purge)
}

function assertCreatingRun(db: WorkflowLedgerDatabase, record: ArtifactLifecycleRecord): void {
  const run = findWorkflowRun(db, record.runId)
  if (!run || run.projectId !== record.projectId || run.goalId !== record.goalId ||
      run.workItemId !== record.workItemId || run.revision < record.runRevision) {
    throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} creating Run ownership is invalid`)
  }
}

function assertContentLocation(
  db: WorkflowLedgerDatabase,
  rootDir: string,
  record: ArtifactLifecycleRecord
): void {
  const location = findWorkflowArtifactLocation(db, record.locationId)
  const expectedPath = record.storageKind === 'blob'
    ? artifactBlobPath(rootDir, record.digest)
    : record.sourceRef
  if (!location || location.artifactId !== record.artifactId || location.projectId !== record.projectId ||
      location.runId !== record.runId || location.path !== expectedPath ||
      location.checksum !== record.digest || location.sizeBytes !== record.sizeBytes ||
      location.availability !== 'available') {
    throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} content location is invalid`)
  }
}

function assertSupersession(db: WorkflowLedgerDatabase, record: ArtifactLifecycleRecord): void {
  if (record.version === 1 && !record.supersedesId) return
  if (!record.supersedesId) throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} lacks predecessor`)
  const previous = findArtifactLifecycle(db, record.supersedesId)
  const edge = findWorkflowArtifactEdge(db, `artifact-supersedes:${record.artifactId}:${record.supersedesId}`)
  if (!previous || previous.projectId !== record.projectId || previous.lineageId !== record.lineageId ||
      previous.kind !== record.kind || previous.version + 1 !== record.version ||
      ((previous.workItemId !== record.workItemId || previous.goalId !== record.goalId) &&
        !(record.kind === 'custom' && record.lineageId === `lineage:project-portable-export:${record.projectId}`) &&
        !hasApprovedArtifactSupersession(db, previous, record)) ||
      !edge || edge.fromArtifactId !== record.artifactId || edge.toArtifactId !== previous.artifactId ||
      edge.relation !== 'supersedes') {
    throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} supersession chain is invalid`)
  }
}

function assertLifecycleEvent(db: WorkflowLedgerDatabase, record: ArtifactLifecycleRecord): void {
  const event = findEventById(db, `workflow:artifact-lifecycle:${record.artifactId}`)
  assertEventMatches(event, record, 'workflow.artifact.lifecycle.registered', record.artifactId)
}

function verifyPurgeRecord(db: WorkflowLedgerDatabase, purge: ArtifactPurgeRecord): void {
  assertPurgeColumns(db, purge)
  const lifecycle = findArtifactLifecycle(db, purge.artifactId)
  if (!lifecycle || lifecycle.projectId !== purge.projectId) {
    throw new WorkflowLedgerCorruptionError(`artifact purge ${purge.artifactId} lacks lifecycle ownership`)
  }
  const tombstone = findWorkflowArtifactLocation(db, `${lifecycle.locationId}:purged`)
  if (!tombstone || tombstone.availability !== 'deleted' || tombstone.artifactId !== purge.artifactId) {
    throw new WorkflowLedgerCorruptionError(`artifact purge ${purge.artifactId} lacks deleted location tombstone`)
  }
  const event = findEventById(db, `workflow:artifact-purge:${purge.artifactId}`)
  assertEventMatches(event, purge, 'workflow.artifact.content.purged', purge.artifactId)
  const effective = readEffectiveArtifactRetention(db, lifecycle)
  if (effective.policy.mode !== 'expire' || effective.policy.retainUntil > purge.purgedAt) {
    throw new WorkflowLedgerCorruptionError(`artifact purge ${purge.artifactId} did not use its latest effective retention policy`)
  }
}

function verifyRetentionRevisions(
  db: WorkflowLedgerDatabase,
  lifecycles: readonly ArtifactLifecycleRecord[],
  revisions: readonly ArtifactRetentionRevisionRecord[]
): void {
  const lifecycleById = new Map(lifecycles.map((record) => [record.artifactId, record] as const))
  const latestById = new Map<string, number>()
  for (const record of revisions) {
    const lifecycle = lifecycleById.get(record.artifactId)
    if (!lifecycle || lifecycle.projectId !== record.projectId) {
      throw new WorkflowLedgerCorruptionError(`artifact retention ${record.artifactId} lacks lifecycle ownership`)
    }
    const expected = (latestById.get(record.artifactId) ?? 0) + 1
    if (record.revision !== expected) {
      throw new WorkflowLedgerCorruptionError(`artifact retention ${record.artifactId} revision chain is invalid`)
    }
    assertRetentionRevisionColumns(db, record)
    const event = findEventById(db, `workflow:artifact-retention:${record.artifactId}:revision:${record.revision}`)
    assertEventMatches(event, record, 'workflow.artifact.retention.revised', record.artifactId)
    latestById.set(record.artifactId, record.revision)
  }
}

async function verifyAvailableContent(rootDir: string, record: ArtifactLifecycleRecord): Promise<void> {
  const filePath = record.storageKind === 'blob'
    ? artifactBlobPath(rootDir, record.digest)
    : requiredSourceRef(record)
  await assertRegularContent(filePath, record.digest, record.sizeBytes)
}

async function verifyPurgedContent(
  db: WorkflowLedgerDatabase,
  rootDir: string,
  record: ArtifactLifecycleRecord,
  purge: ArtifactPurgeRecord
): Promise<void> {
  if (purge.disposition === 'source_detached') {
    if (record.storageKind !== 'source_ref') throw new WorkflowLedgerCorruptionError('source detach disposition is invalid')
    if (record.sourceRef && isArtifactSourceProjectPath(rootDir, record.projectId, record.sourceRef) &&
        await pathExists(record.sourceRef)) {
      throw new WorkflowLedgerCorruptionError(`purged portable artifact source still exists: ${record.artifactId}`)
    }
    return
  }
  if (record.storageKind !== 'blob') throw new WorkflowLedgerCorruptionError('blob purge disposition is invalid')
  const blobPath = artifactBlobPath(rootDir, record.digest)
  if (purge.disposition === 'blob_deleted') {
    if (await pathExists(blobPath)) throw new WorkflowLedgerCorruptionError(`purged artifact blob still exists: ${record.artifactId}`)
    return
  }
  const shared = readArtifactLifecycles(db).some((candidate) =>
    candidate.artifactId !== record.artifactId && candidate.blobRef === record.blobRef &&
    !findArtifactPurge(db, candidate.artifactId))
  if (shared) {
    await assertRegularContent(blobPath, record.digest, record.sizeBytes)
    return
  }
  const laterDeletion = readArtifactLifecycles(db).some((candidate) => {
    if (candidate.artifactId === record.artifactId || candidate.blobRef !== record.blobRef) return false
    const candidatePurge = findArtifactPurge(db, candidate.artifactId)
    return candidatePurge?.disposition === 'blob_deleted' && candidatePurge.purgedAt >= purge.purgedAt
  })
  if (!laterDeletion || await pathExists(blobPath)) {
    throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} shared blob disposition is inconsistent`)
  }
}

function assertEventMatches(
  event: WorkflowEventRecord | null,
  payload: object,
  kind: string,
  artifactId: string
): void {
  if (!event || event.kind !== kind || event.entityId !== artifactId || digest(event.payload) !== digest(payload)) {
    throw new WorkflowLedgerCorruptionError(`artifact lifecycle event is invalid: ${artifactId}`)
  }
}

function assertLifecycleColumns(db: WorkflowLedgerDatabase, record: ArtifactLifecycleRecord): void {
  const row = selectRow(db, 'SELECT * FROM workflow_artifact_lifecycles WHERE artifact_id = ?', record.artifactId)
  const columns = {
    artifact_id: record.artifactId, project_id: record.projectId, run_id: record.runId,
    lineage_id: record.lineageId, kind: record.kind, version: record.version,
    storage_kind: record.storageKind, source_ref: record.sourceRef ?? null,
    blob_ref: record.blobRef ?? null, digest: record.digest, location_id: record.locationId,
    retention_mode: record.retention.mode,
    retain_until: record.retention.mode === 'expire' ? record.retention.retainUntil : null,
    supersedes_id: record.supersedesId ?? null, created_at: record.createdAt,
    payload: canonicalJson(record)
  }
  assertColumns(row, columns, `artifact lifecycle ${record.artifactId}`)
}

function assertPurgeColumns(db: WorkflowLedgerDatabase, record: ArtifactPurgeRecord): void {
  const row = selectRow(db, 'SELECT * FROM workflow_artifact_purges WHERE artifact_id = ?', record.artifactId)
  assertColumns(row, {
    artifact_id: record.artifactId, project_id: record.projectId, purged_at: record.purgedAt,
    disposition: record.disposition, payload: canonicalJson(record)
  }, `artifact purge ${record.artifactId}`)
}

function assertRetentionRevisionColumns(
  db: WorkflowLedgerDatabase,
  record: ArtifactRetentionRevisionRecord
): void {
  const row = selectRowWithParameters(
    db,
    'SELECT * FROM workflow_artifact_retention_revisions WHERE artifact_id = ? AND revision = ?',
    [record.artifactId, record.revision],
    `artifact retention ${record.artifactId}:${record.revision}`
  )
  assertColumns(row, {
    artifact_id: record.artifactId, project_id: record.projectId, revision: record.revision,
    retention_mode: record.policy.mode,
    retain_until: record.policy.mode === 'expire' ? record.policy.retainUntil : null,
    created_at: record.createdAt, payload: canonicalJson(record)
  }, `artifact retention ${record.artifactId}:${record.revision}`)
}

function assertRequiredKinds(
  records: readonly ArtifactLifecycleRecord[],
  requiredKinds: readonly WorkflowArtifactKind[]
): void {
  const present = new Set(records.map((record) => record.kind))
  const missing = requiredKinds.filter((kind) => !present.has(kind))
  if (missing.length > 0) throw new WorkflowLedgerCorruptionError(`artifact lifecycle kinds missing: ${missing.join(', ')}`)
}

function requiredSourceRef(record: ArtifactLifecycleRecord): string {
  if (!record.sourceRef) throw new WorkflowLedgerCorruptionError(`artifact ${record.artifactId} sourceRef is missing`)
  return record.sourceRef
}

function selectRow(db: WorkflowLedgerDatabase, sql: string, id: string): Record<string, unknown> {
  return selectRowWithParameters(db, sql, [id], id)
}

function selectRowWithParameters(
  db: WorkflowLedgerDatabase,
  sql: string,
  parameters: (string | number)[],
  label: string
): Record<string, unknown> {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(parameters)
    if (!stmt.step()) throw new WorkflowLedgerCorruptionError(`artifact lifecycle row is missing: ${label}`)
    return stmt.getAsObject()
  } finally {
    stmt.free()
  }
}

function assertColumns(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string
): void {
  for (const [column, value] of Object.entries(expected)) {
    if (actual[column] !== value) throw new WorkflowLedgerCorruptionError(`${label} payload differs from ${column}`)
  }
}
