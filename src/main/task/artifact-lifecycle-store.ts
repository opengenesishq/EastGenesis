import { hasApprovedArtifactSupersession } from './requirement-artifact-access'
import type {
  ArtifactLifecyclePurgeInput,
  ArtifactLifecyclePurgeResult,
  ArtifactLifecycleRecord,
  ArtifactLifecycleRegistrationInput,
  ArtifactLifecycleRegistrationResult,
  ArtifactProjectOwnership,
  ArtifactPurgeDisposition,
  ArtifactPurgeRecord,
  ArtifactRetentionRevisionInput,
  ArtifactRetentionRevisionRecord,
  ArtifactEffectiveRetention,
  ArtifactRetentionPolicy,
  PreparedArtifactContent
} from './artifact-lifecycle-types'
import type { WorkflowArtifactInput, WorkflowProjectionSource } from '../../shared/workflow-types'
import {
  appendWorkflowEvent,
  findWorkflowArtifact,
  findWorkflowRun,
  registerWorkflowArtifact
} from './workflow-ledger-store'
import {
  findWorkflowArtifactEdge,
  findWorkflowArtifactLocation,
  recordWorkflowArtifactLocation,
  registerWorkflowArtifactEdge
} from './workflow-ledger-artifact-graph'
import { setupWorkflowArtifactGraphSchema } from './workflow-ledger-artifact-graph-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import {
  canonicalJson,
  digest,
  finiteTimestamp,
  requiredId,
  requiredText
} from './workflow-ledger-codec'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { assertSha256Digest } from './artifact-lifecycle-content'

const PROVENANCE = new Set<WorkflowProjectionSource>(['explicit', 'dag', 'legacy-derived', 'recovery'])

export interface ArtifactPurgePlan {
  lifecycle: ArtifactLifecycleRecord
  existing?: ArtifactPurgeRecord
  disposition: ArtifactPurgeDisposition
  deleteBlob: boolean
}

export function setupArtifactLifecycleSchema(db: WorkflowLedgerDatabase): void {
  setupWorkflowArtifactGraphSchema(db)
  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_artifact_lifecycles (
      artifact_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      lineage_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      storage_kind TEXT NOT NULL,
      source_ref TEXT,
      blob_ref TEXT,
      digest TEXT NOT NULL,
      location_id TEXT NOT NULL,
      retention_mode TEXT NOT NULL,
      retain_until INTEGER,
      supersedes_id TEXT,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(project_id, lineage_id, version)
    );
    CREATE TABLE IF NOT EXISTS workflow_artifact_purges (
      artifact_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      purged_at INTEGER NOT NULL,
      disposition TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_artifact_retention_revisions (
      artifact_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      retention_mode TEXT NOT NULL,
      retain_until INTEGER,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(artifact_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_lifecycle_project
      ON workflow_artifact_lifecycles(project_id, created_at, artifact_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_lifecycle_lineage
      ON workflow_artifact_lifecycles(project_id, lineage_id, version);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_lifecycle_blob
      ON workflow_artifact_lifecycles(blob_ref, artifact_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_artifact_lifecycle_successor
      ON workflow_artifact_lifecycles(supersedes_id) WHERE supersedes_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_retention_project
      ON workflow_artifact_retention_revisions(project_id, created_at, artifact_id, revision);
  `)
}

export function registerArtifactLifecycle(
  db: WorkflowLedgerDatabase,
  input: ArtifactLifecycleRegistrationInput,
  content: PreparedArtifactContent,
  ownership: ArtifactProjectOwnership
): ArtifactLifecycleRegistrationResult {
  setupArtifactLifecycleSchema(db)
  const existing = findArtifactLifecycle(db, requiredId(input.id, 'artifact id'))
  const normalized = normalizeRegistration(db, input, content, ownership, existing)
  if (existing) return resolveIdempotentRegistration(db, normalized, existing)
  assertLineageTransition(db, normalized.lifecycle)
  const artifact = registerWorkflowArtifact(db, normalized.artifact)
  const location = recordWorkflowArtifactLocation(db, normalized.location)
  const supersedesEdge = normalized.edge
    ? registerWorkflowArtifactEdge(db, normalized.edge)
    : undefined
  insertLifecycle(db, normalized.lifecycle)
  appendLifecycleEvent(db, normalized.lifecycle)
  return { artifact, lifecycle: normalized.lifecycle, location, ...(supersedesEdge ? { supersedesEdge } : {}) }
}

export function planArtifactPurge(
  db: WorkflowLedgerDatabase,
  input: ArtifactLifecyclePurgeInput
): ArtifactPurgePlan {
  setupArtifactLifecycleSchema(db)
  const artifactId = requiredId(input.artifactId, 'artifact purge artifactId')
  const projectId = requiredId(input.projectId, 'artifact purge projectId')
  const lifecycle = findArtifactLifecycle(db, artifactId)
  if (!lifecycle) throw new WorkflowLedgerCorruptionError(`artifact lifecycle not found: ${artifactId}`)
  if (lifecycle.projectId !== projectId) {
    throw new WorkflowLedgerCorruptionError(`artifact ${artifactId} purge crosses project boundary`)
  }
  const existing = findArtifactPurge(db, artifactId)
  if (existing) {
    return { lifecycle, existing, disposition: existing.disposition, deleteBlob: false }
  }
  const purgedAt = finiteTimestamp(input.purgedAt ?? Date.now(), 'artifact purgedAt')
  assertRetentionExpired(readEffectiveArtifactRetention(db, lifecycle).policy, purgedAt)
  const sharedBlob = lifecycle.blobRef ? hasOtherLiveBlobReference(db, lifecycle) : false
  const disposition: ArtifactPurgeDisposition = lifecycle.storageKind === 'source_ref'
    ? 'source_detached'
    : sharedBlob
      ? 'shared_blob_retained'
      : 'blob_deleted'
  return { lifecycle, disposition, deleteBlob: disposition === 'blob_deleted' }
}

export function recordArtifactPurge(
  db: WorkflowLedgerDatabase,
  input: ArtifactLifecyclePurgeInput,
  plan: ArtifactPurgePlan
): ArtifactLifecyclePurgeResult {
  setupArtifactLifecycleSchema(db)
  const existing = findArtifactPurge(db, plan.lifecycle.artifactId)
  if (existing) return resolveIdempotentPurge(db, input, plan.lifecycle, existing)
  const purge: ArtifactPurgeRecord = {
    schemaVersion: 1,
    artifactId: plan.lifecycle.artifactId,
    projectId: plan.lifecycle.projectId,
    purgedAt: finiteTimestamp(input.purgedAt ?? Date.now(), 'artifact purgedAt'),
    reason: requiredText(input.reason, 'artifact purge reason'),
    disposition: plan.disposition
  }
  assertRetentionExpired(readEffectiveArtifactRetention(db, plan.lifecycle).policy, purge.purgedAt)
  const tombstone = recordPurgeTombstone(db, plan.lifecycle, purge.purgedAt)
  insertPurge(db, purge)
  appendPurgeEvent(db, plan.lifecycle, purge)
  return { lifecycle: plan.lifecycle, purge, tombstone }
}

export function findArtifactLifecycle(
  db: WorkflowLedgerDatabase,
  artifactId: string
): ArtifactLifecycleRecord | null {
  setupArtifactLifecycleSchema(db)
  return selectOne(db, 'SELECT payload FROM workflow_artifact_lifecycles WHERE artifact_id = ? LIMIT 1', artifactId, decodeLifecycle)
}

export function findArtifactPurge(
  db: WorkflowLedgerDatabase,
  artifactId: string
): ArtifactPurgeRecord | null {
  setupArtifactLifecycleSchema(db)
  return selectOne(db, 'SELECT payload FROM workflow_artifact_purges WHERE artifact_id = ? LIMIT 1', artifactId, decodePurge)
}

export function readArtifactLifecycles(db: WorkflowLedgerDatabase): ArtifactLifecycleRecord[] {
  setupArtifactLifecycleSchema(db)
  return selectMany(db, 'SELECT payload FROM workflow_artifact_lifecycles ORDER BY created_at, artifact_id', decodeLifecycle)
}

export function readArtifactPurges(db: WorkflowLedgerDatabase): ArtifactPurgeRecord[] {
  setupArtifactLifecycleSchema(db)
  return selectMany(db, 'SELECT payload FROM workflow_artifact_purges ORDER BY purged_at, artifact_id', decodePurge)
}

export function readArtifactRetentionRevisions(
  db: WorkflowLedgerDatabase,
  artifactId?: string
): ArtifactRetentionRevisionRecord[] {
  setupArtifactLifecycleSchema(db)
  return artifactId
    ? selectMany(db, 'SELECT payload FROM workflow_artifact_retention_revisions WHERE artifact_id = ? ORDER BY revision', decodeRetentionRevision, artifactId)
    : selectMany(db, 'SELECT payload FROM workflow_artifact_retention_revisions ORDER BY created_at, artifact_id, revision', decodeRetentionRevision)
}

export function readEffectiveArtifactRetention(
  db: WorkflowLedgerDatabase,
  lifecycleOrId: ArtifactLifecycleRecord | string
): ArtifactEffectiveRetention {
  const lifecycle = typeof lifecycleOrId === 'string'
    ? findArtifactLifecycle(db, lifecycleOrId)
    : lifecycleOrId
  if (!lifecycle) throw new WorkflowLedgerCorruptionError(`artifact lifecycle not found: ${lifecycleOrId}`)
  const latest = readArtifactRetentionRevisions(db, lifecycle.artifactId).at(-1)
  return latest
    ? { policy: latest.policy, revision: latest.revision, revisedAt: latest.createdAt }
    : { policy: lifecycle.retention, revision: 0 }
}

export function appendArtifactRetentionRevision(
  db: WorkflowLedgerDatabase,
  input: ArtifactRetentionRevisionInput
): ArtifactRetentionRevisionRecord {
  setupArtifactLifecycleSchema(db)
  const artifactId = requiredId(input.artifactId, 'artifact retention artifactId')
  const projectId = requiredId(input.projectId, 'artifact retention projectId')
  const lifecycle = findArtifactLifecycle(db, artifactId)
  if (!lifecycle || lifecycle.projectId !== projectId) {
    throw new WorkflowLedgerCorruptionError(`artifact ${artifactId} retention crosses project boundary`)
  }
  if (findArtifactPurge(db, artifactId)) throw new WorkflowLedgerCorruptionError('purged Artifact retention cannot be revised')
  const policy = normalizeRetention(input.policy)
  const reason = requiredText(input.reason, 'artifact retention reason')
  const revisions = readArtifactRetentionRevisions(db, artifactId)
  const latest = revisions.at(-1)
  if (latest && canonicalJson(latest.policy) === canonicalJson(policy) && latest.reason === reason) return latest
  const record: ArtifactRetentionRevisionRecord = {
    schemaVersion: 1,
    artifactId,
    projectId,
    revision: (latest?.revision ?? 0) + 1,
    policy,
    reason,
    createdAt: finiteTimestamp(input.createdAt ?? Date.now(), 'artifact retention createdAt')
  }
  db.run(
    `INSERT INTO workflow_artifact_retention_revisions(
       artifact_id, project_id, revision, retention_mode, retain_until, created_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [record.artifactId, record.projectId, record.revision, record.policy.mode,
      record.policy.mode === 'expire' ? record.policy.retainUntil : null,
      record.createdAt, canonicalJson(record)]
  )
  appendWorkflowEvent(db, {
    eventId: `workflow:artifact-retention:${artifactId}:revision:${record.revision}`,
    streamId: `artifact:${artifactId}`,
    entityType: 'artifact',
    entityId: artifactId,
    kind: 'workflow.artifact.retention.revised',
    payload: record as unknown as Record<string, unknown>,
    occurredAt: record.createdAt,
    correlationId: lifecycle.runId
  }, { projectId, goalId: lifecycle.goalId, workItemId: lifecycle.workItemId, runId: lifecycle.runId })
  return record
}

export function importArtifactLifecycleSlice(
  db: WorkflowLedgerDatabase,
  lifecycleValues: readonly unknown[],
  purgeValues: readonly unknown[] = [],
  retentionRevisionValues: readonly unknown[] = []
): { lifecycles: ArtifactLifecycleRecord[]; purges: ArtifactPurgeRecord[]; retentionRevisions: ArtifactRetentionRevisionRecord[] } {
  setupArtifactLifecycleSchema(db)
  const lifecycles = lifecycleValues
    .map((value) => decodeLifecycle(canonicalJson(value)))
    .sort((left, right) => left.createdAt - right.createdAt || left.version - right.version ||
      left.artifactId.localeCompare(right.artifactId))
  for (const record of lifecycles) {
    const existing = findArtifactLifecycle(db, record.artifactId)
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new WorkflowLedgerCorruptionError(`artifact lifecycle import conflicts with ${record.artifactId}`)
      }
      continue
    }
    if (!findWorkflowRun(db, record.runId) || !findWorkflowArtifact(db, record.artifactId) ||
        !findWorkflowArtifactLocation(db, record.locationId)) {
      throw new WorkflowLedgerCorruptionError(`artifact lifecycle import is not closed over ${record.artifactId}`)
    }
    assertLineageTransition(db, record)
    insertLifecycle(db, record)
  }
  const retentionRevisions = retentionRevisionValues
    .map((value) => decodeRetentionRevision(canonicalJson(value)))
    .sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision)
  for (const record of retentionRevisions) {
    const lifecycle = findArtifactLifecycle(db, record.artifactId)
    if (!lifecycle || lifecycle.projectId !== record.projectId) {
      throw new WorkflowLedgerCorruptionError(`artifact retention import is missing lifecycle ${record.artifactId}`)
    }
    const existing = readArtifactRetentionRevisions(db, record.artifactId).find((candidate) => candidate.revision === record.revision)
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) throw new WorkflowLedgerCorruptionError(`artifact retention import conflicts with ${record.artifactId}`)
      continue
    }
    db.run(
      `INSERT INTO workflow_artifact_retention_revisions(
         artifact_id, project_id, revision, retention_mode, retain_until, created_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.artifactId, record.projectId, record.revision, record.policy.mode,
        record.policy.mode === 'expire' ? record.policy.retainUntil : null, record.createdAt, canonicalJson(record)]
    )
  }
  const purges = purgeValues
    .map((value) => decodePurge(canonicalJson(value)))
    .sort((left, right) => left.purgedAt - right.purgedAt || left.artifactId.localeCompare(right.artifactId))
  for (const record of purges) {
    const existing = findArtifactPurge(db, record.artifactId)
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new WorkflowLedgerCorruptionError(`artifact purge import conflicts with ${record.artifactId}`)
      }
      continue
    }
    const lifecycle = findArtifactLifecycle(db, record.artifactId)
    if (!lifecycle || lifecycle.projectId !== record.projectId) {
      throw new WorkflowLedgerCorruptionError(`artifact purge import is missing lifecycle ${record.artifactId}`)
    }
    insertPurge(db, record)
  }
  return { lifecycles, purges, retentionRevisions }
}

function normalizeRegistration(
  db: WorkflowLedgerDatabase,
  input: ArtifactLifecycleRegistrationInput,
  content: PreparedArtifactContent,
  ownership: ArtifactProjectOwnership,
  existing: ArtifactLifecycleRecord | null
) {
  const id = requiredId(input.id, 'artifact id')
  const projectId = requiredId(input.projectId, 'artifact projectId')
  const runId = requiredId(input.runId, 'artifact creating runId')
  const run = findWorkflowRun(db, runId)
  if (!run) throw new WorkflowLedgerCorruptionError(`artifact ${id} references missing creating Run ${runId}`)
  assertRegistrationOwnership(input, ownership, run)
  const version = positiveVersion(input.version)
  const lineageId = requiredId(input.lineageId, 'artifact lineageId')
  if (!PROVENANCE.has(input.provenance)) throw new WorkflowLedgerCorruptionError('artifact provenance is required')
  const retention = normalizeRetention(input.retention)
  const createdAt = existing?.createdAt ?? finiteTimestamp(input.createdAt ?? Date.now(), 'artifact createdAt')
  const locationId = `artifact-content:${id}`
  const storageReference = content.storageKind === 'source_ref'
    ? { sourceRef: content.sourceRef }
    : { blobRef: content.blobRef }
  const lifecycle: ArtifactLifecycleRecord = {
    schemaVersion: 1, artifactId: id, projectId,
    projectRevision: existing?.projectRevision ?? ownership.projectRevision,
    ...(run.goalId ? { goalId: run.goalId } : {}), workItemId: run.workItemId, runId,
    runRevision: existing?.runRevision ?? run.revision, lineageId, kind: input.kind, version,
    provenance: input.provenance, ...(input.supersedesId ? { supersedesId: requiredId(input.supersedesId, 'supersedesId') } : {}),
    storageKind: content.storageKind, ...storageReference, digest: assertSha256Digest(content.digest),
    sizeBytes: content.sizeBytes, locationId, retention, createdAt
  }
  const previous = lifecycle.supersedesId ? findArtifactLifecycle(db, lifecycle.supersedesId) : null
  return buildRegistrationRecords(input, content, lifecycle, previous)
}

function buildRegistrationRecords(
  input: ArtifactLifecycleRegistrationInput,
  content: PreparedArtifactContent,
  lifecycle: ArtifactLifecycleRecord,
  previous: ArtifactLifecycleRecord | null
) {
  const artifact: WorkflowArtifactInput = {
    id: lifecycle.artifactId, projectId: lifecycle.projectId, goalId: lifecycle.goalId,
    workItemId: lifecycle.workItemId, runId: lifecycle.runId, kind: lifecycle.kind,
    title: requiredText(input.title, 'artifact title'), version: lifecycle.version,
    digest: lifecycle.digest, mediaType: input.mediaType, provenance: lifecycle.provenance,
    createdAt: lifecycle.createdAt, updatedAt: lifecycle.createdAt,
    supersedesId: lifecycle.supersedesId,
    metadata: { ...input.metadata, artifactLifecycle: lifecycleMetadata(lifecycle) }
  }
  const location = {
    id: lifecycle.locationId, artifactId: lifecycle.artifactId, projectId: lifecycle.projectId,
    goalId: lifecycle.goalId, workItemId: lifecycle.workItemId, runId: lifecycle.runId,
    kind: lifecycle.storageKind === 'blob' ? 'blob' as const : 'file' as const,
    path: content.locationPath, availability: 'available' as const, checksum: lifecycle.digest,
    sizeBytes: lifecycle.sizeBytes, mediaType: input.mediaType,
    metadata: { storageKind: lifecycle.storageKind }, createdAt: lifecycle.createdAt,
    updatedAt: lifecycle.createdAt
  }
  const edge = lifecycle.supersedesId ? {
    id: `artifact-supersedes:${lifecycle.artifactId}:${lifecycle.supersedesId}`,
    fromArtifactId: lifecycle.artifactId, toArtifactId: lifecycle.supersedesId,
    relation: 'supersedes' as const, projectId: lifecycle.projectId,
    ...(previous?.goalId === lifecycle.goalId ? { goalId: lifecycle.goalId } : {}),
    ...(previous?.workItemId === lifecycle.workItemId ? { workItemId: lifecycle.workItemId } : {}),
    createdAt: lifecycle.createdAt, updatedAt: lifecycle.createdAt
  } : undefined
  return { artifact, lifecycle, location, edge }
}

function assertRegistrationOwnership(
  input: ArtifactLifecycleRegistrationInput,
  owner: ArtifactProjectOwnership,
  run: NonNullable<ReturnType<typeof findWorkflowRun>>
): void {
  if (owner.projectId !== input.projectId || run.projectId !== input.projectId) {
    throw new WorkflowLedgerCorruptionError(`artifact ${input.id} crosses Project ownership boundary`)
  }
  if (owner.workItemId !== run.workItemId || (input.workItemId && input.workItemId !== run.workItemId)) {
    throw new WorkflowLedgerCorruptionError(`artifact ${input.id} creating Run/WorkItem ownership differs`)
  }
  if (owner.goalId !== run.goalId || (input.goalId && input.goalId !== run.goalId)) {
    throw new WorkflowLedgerCorruptionError(`artifact ${input.id} creating Run/Goal ownership differs`)
  }
}

function assertLineageTransition(db: WorkflowLedgerDatabase, lifecycle: ArtifactLifecycleRecord): void {
  if (lifecycle.version === 1) {
    if (lifecycle.supersedesId) throw new WorkflowLedgerCorruptionError('artifact version 1 cannot supersede another Artifact')
    return
  }
  if (!lifecycle.supersedesId) throw new WorkflowLedgerCorruptionError('artifact version greater than 1 requires supersedesId')
  const previous = findArtifactLifecycle(db, lifecycle.supersedesId)
  if (!previous) throw new WorkflowLedgerCorruptionError(`superseded Artifact lacks lifecycle: ${lifecycle.supersedesId}`)
  if (previous.projectId !== lifecycle.projectId || previous.lineageId !== lifecycle.lineageId ||
      previous.kind !== lifecycle.kind || previous.version + 1 !== lifecycle.version ||
      (!isProjectPortableExportLineage(lifecycle) &&
        (previous.workItemId !== lifecycle.workItemId || previous.goalId !== lifecycle.goalId) &&
        !hasApprovedArtifactSupersession(db, previous, lifecycle))) {
    throw new WorkflowLedgerCorruptionError(`artifact ${lifecycle.artifactId} supersession lineage is incompatible`)
  }
  if (findSuccessor(db, previous.artifactId)) {
    throw new WorkflowLedgerCorruptionError(`artifact ${previous.artifactId} already has a successor`)
  }
}

function isProjectPortableExportLineage(lifecycle: ArtifactLifecycleRecord): boolean {
  return lifecycle.kind === 'custom' &&
    lifecycle.lineageId === `lineage:project-portable-export:${lifecycle.projectId}`
}

function resolveIdempotentRegistration(
  db: WorkflowLedgerDatabase,
  normalized: ReturnType<typeof normalizeRegistration>,
  existing: ArtifactLifecycleRecord
): ArtifactLifecycleRegistrationResult {
  if (digest(existing) !== digest(normalized.lifecycle)) {
    throw new WorkflowLedgerCorruptionError(`artifact lifecycle ${existing.artifactId} immutable content changed`)
  }
  const artifact = registerWorkflowArtifact(db, normalized.artifact)
  const location = recordWorkflowArtifactLocation(db, normalized.location)
  const supersedesEdge = normalized.edge ? registerWorkflowArtifactEdge(db, normalized.edge) : undefined
  appendLifecycleEvent(db, existing)
  return { artifact, lifecycle: existing, location, ...(supersedesEdge ? { supersedesEdge } : {}) }
}

function resolveIdempotentPurge(
  db: WorkflowLedgerDatabase,
  input: ArtifactLifecyclePurgeInput,
  lifecycle: ArtifactLifecycleRecord,
  existing: ArtifactPurgeRecord
): ArtifactLifecyclePurgeResult {
  if (existing.projectId !== input.projectId || existing.reason !== requiredText(input.reason, 'artifact purge reason')) {
    throw new WorkflowLedgerCorruptionError(`artifact purge ${existing.artifactId} immutable content changed`)
  }
  const tombstone = recordPurgeTombstone(db, lifecycle, existing.purgedAt)
  appendPurgeEvent(db, lifecycle, existing)
  return { lifecycle, purge: existing, tombstone }
}

function recordPurgeTombstone(db: WorkflowLedgerDatabase, lifecycle: ArtifactLifecycleRecord, purgedAt: number) {
  const location = findWorkflowArtifactLocation(db, lifecycle.locationId)
  if (!location) throw new WorkflowLedgerCorruptionError(`artifact ${lifecycle.artifactId} content location is missing`)
  return recordWorkflowArtifactLocation(db, {
    ...location, id: `${lifecycle.locationId}:purged`, availability: 'deleted',
    createdAt: purgedAt, updatedAt: purgedAt, metadata: { lifecycleState: 'purged' }
  })
}

function appendLifecycleEvent(db: WorkflowLedgerDatabase, record: ArtifactLifecycleRecord): void {
  appendWorkflowEvent(db, {
    eventId: `workflow:artifact-lifecycle:${record.artifactId}`,
    streamId: `artifact:${record.artifactId}`, entityType: 'artifact', entityId: record.artifactId,
    kind: 'workflow.artifact.lifecycle.registered', payload: record as unknown as Record<string, unknown>,
    occurredAt: record.createdAt, correlationId: record.runId
  }, { projectId: record.projectId, goalId: record.goalId, workItemId: record.workItemId, runId: record.runId })
}

function appendPurgeEvent(db: WorkflowLedgerDatabase, lifecycle: ArtifactLifecycleRecord, purge: ArtifactPurgeRecord): void {
  appendWorkflowEvent(db, {
    eventId: `workflow:artifact-purge:${purge.artifactId}`,
    streamId: `artifact:${purge.artifactId}`, entityType: 'artifact', entityId: purge.artifactId,
    kind: 'workflow.artifact.content.purged', payload: purge as unknown as Record<string, unknown>,
    occurredAt: purge.purgedAt, correlationId: lifecycle.runId
  }, { projectId: lifecycle.projectId, goalId: lifecycle.goalId, workItemId: lifecycle.workItemId, runId: lifecycle.runId })
}

function insertLifecycle(db: WorkflowLedgerDatabase, record: ArtifactLifecycleRecord): void {
  db.run(
    `INSERT INTO workflow_artifact_lifecycles(
       artifact_id, project_id, run_id, lineage_id, kind, version, storage_kind,
       source_ref, blob_ref, digest, location_id, retention_mode, retain_until,
       supersedes_id, created_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.artifactId, record.projectId, record.runId, record.lineageId, record.kind, record.version,
      record.storageKind, record.sourceRef ?? null, record.blobRef ?? null, record.digest,
      record.locationId, record.retention.mode,
      record.retention.mode === 'expire' ? record.retention.retainUntil : null,
      record.supersedesId ?? null, record.createdAt, canonicalJson(record)]
  )
}

function insertPurge(db: WorkflowLedgerDatabase, record: ArtifactPurgeRecord): void {
  db.run(
    `INSERT INTO workflow_artifact_purges(artifact_id, project_id, purged_at, disposition, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [record.artifactId, record.projectId, record.purgedAt, record.disposition, canonicalJson(record)]
  )
}

function hasOtherLiveBlobReference(db: WorkflowLedgerDatabase, record: ArtifactLifecycleRecord): boolean {
  const stmt = db.prepare(
    `SELECT COUNT(*) AS count FROM workflow_artifact_lifecycles lifecycle
     LEFT JOIN workflow_artifact_purges purge ON purge.artifact_id = lifecycle.artifact_id
     WHERE lifecycle.blob_ref = ? AND lifecycle.artifact_id != ? AND purge.artifact_id IS NULL`
  )
  try {
    stmt.bind([record.blobRef ?? null, record.artifactId])
    return stmt.step() && Number(stmt.getAsObject().count) > 0
  } finally {
    stmt.free()
  }
}

function findSuccessor(db: WorkflowLedgerDatabase, artifactId: string): ArtifactLifecycleRecord | null {
  return selectOne(
    db,
    'SELECT payload FROM workflow_artifact_lifecycles WHERE supersedes_id = ? LIMIT 1',
    artifactId,
    decodeLifecycle
  )
}

function normalizeRetention(value: ArtifactRetentionPolicy): ArtifactRetentionPolicy {
  if (value?.mode === 'retain') return { mode: 'retain' }
  if (value?.mode === 'expire') {
    return { mode: 'expire', retainUntil: finiteTimestamp(value.retainUntil, 'artifact retainUntil') }
  }
  throw new WorkflowLedgerCorruptionError('artifact retention policy is invalid')
}

function assertRetentionExpired(retention: ArtifactRetentionPolicy, now: number): void {
  if (retention.mode === 'retain') throw new WorkflowLedgerCorruptionError('artifact retention policy forbids purge')
  if (now < retention.retainUntil) throw new WorkflowLedgerCorruptionError('artifact retention period has not expired')
}

function lifecycleMetadata(record: ArtifactLifecycleRecord): Record<string, unknown> {
  return {
    schemaVersion: 1, lineageId: record.lineageId, storageKind: record.storageKind,
    retention: record.retention, creatingRunId: record.runId
  }
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WorkflowLedgerCorruptionError('artifact version must be a positive safe integer')
  }
  return value as number
}

function decodeLifecycle(payload: unknown): ArtifactLifecycleRecord {
  const record = parseCanonicalPayload(payload, 'artifact lifecycle') as unknown as ArtifactLifecycleRecord
  if (record.schemaVersion !== 1 || !record.artifactId || !record.projectId || !record.runId ||
      !record.workItemId || !record.lineageId || !record.locationId ||
      !Number.isSafeInteger(record.projectRevision) || !Number.isSafeInteger(record.runRevision) ||
      !Number.isSafeInteger(record.version) || !Number.isSafeInteger(record.sizeBytes) ||
      !PROVENANCE.has(record.provenance) || !['blob', 'source_ref'].includes(record.storageKind)) {
    throw new WorkflowLedgerCorruptionError('artifact lifecycle payload is invalid')
  }
  assertSha256Digest(record.digest)
  normalizeRetention(record.retention)
  return record
}

function decodePurge(payload: unknown): ArtifactPurgeRecord {
  const record = parseCanonicalPayload(payload, 'artifact purge') as unknown as ArtifactPurgeRecord
  if (record.schemaVersion !== 1 || !record.artifactId || !record.projectId || !record.reason ||
      !Number.isFinite(record.purgedAt) ||
      !['blob_deleted', 'shared_blob_retained', 'source_detached'].includes(record.disposition)) {
    throw new WorkflowLedgerCorruptionError('artifact purge payload is invalid')
  }
  return record
}

function decodeRetentionRevision(payload: unknown): ArtifactRetentionRevisionRecord {
  const record = parseCanonicalPayload(payload, 'artifact retention revision') as unknown as ArtifactRetentionRevisionRecord
  if (record.schemaVersion !== 1) throw new WorkflowLedgerCorruptionError('artifact retention revision schema is invalid')
  requiredId(record.artifactId, 'artifact retention artifactId')
  requiredId(record.projectId, 'artifact retention projectId')
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new WorkflowLedgerCorruptionError('artifact retention revision is invalid')
  normalizeRetention(record.policy)
  requiredText(record.reason, 'artifact retention reason')
  finiteTimestamp(record.createdAt, 'artifact retention createdAt')
  return record
}

function parseCanonicalPayload(payload: unknown, label: string): Record<string, unknown> {
  if (typeof payload !== 'string') throw new WorkflowLedgerCorruptionError(`${label} payload is not text`)
  const value: unknown = JSON.parse(payload)
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value) !== canonicalJson(value)) {
    throw new WorkflowLedgerCorruptionError(`${label} payload is not canonical JSON`)
  }
  return value as Record<string, unknown>
}

function selectOne<T>(
  db: WorkflowLedgerDatabase,
  sql: string,
  id: string,
  decode: (payload: unknown) => T
): T | null {
  const stmt = db.prepare(sql)
  try {
    stmt.bind([id])
    return stmt.step() ? decode(stmt.getAsObject().payload) : null
  } finally {
    stmt.free()
  }
}

function selectMany<T>(
  db: WorkflowLedgerDatabase,
  sql: string,
  decode: (payload: unknown) => T,
  parameter?: string
): T[] {
  const stmt = db.prepare(sql)
  const records: T[] = []
  try {
    if (parameter !== undefined) stmt.bind([parameter])
    while (stmt.step()) records.push(decode(stmt.getAsObject().payload))
    return records
  } finally {
    stmt.free()
  }
}
