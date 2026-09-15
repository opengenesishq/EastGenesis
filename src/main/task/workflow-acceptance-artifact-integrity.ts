import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  constants,
  type BigIntStats
} from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowArtifactLocationRecord,
  WorkflowEventRecord,
  WorkflowEvidenceRecord
} from '../../shared/workflow-types'
import { canonicalJson } from './workflow-ledger-codec'
import {
  assertArtifactScopeCompatibility,
  assertLocationProjectCompatibility,
  assertScopeReferences
} from './workflow-ledger-artifact-graph-codec'
import { readArtifactLocations } from './workflow-ledger-artifact-graph-query'
import { setupWorkflowArtifactGraphSchema } from './workflow-ledger-artifact-graph-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { findWorkflowArtifact } from './workflow-ledger-query'

export type WorkflowArtifactByteIntegrityReason =
  | 'workflow_evidence_artifact_graph_invalid'
  | 'workflow_evidence_artifact_local_location_missing'
  | 'workflow_evidence_artifact_location_invalid'
  | 'workflow_evidence_artifact_location_size_missing'
  | 'workflow_evidence_artifact_location_checksum_missing'
  | 'workflow_evidence_artifact_file_unavailable'
  | 'workflow_evidence_artifact_file_not_regular'
  | 'workflow_evidence_artifact_file_changed'
  | 'workflow_evidence_artifact_size_mismatch'
  | 'workflow_evidence_content_digest_invalid'
  | 'workflow_evidence_content_digest_mismatch'
  | 'workflow_artifact_digest_invalid'
  | 'workflow_artifact_digest_mismatch'
  | 'workflow_artifact_location_checksum_invalid'
  | 'workflow_artifact_location_checksum_mismatch'

export class WorkflowArtifactByteIntegrityError extends Error {
  readonly reason: WorkflowArtifactByteIntegrityReason

  constructor(reason: WorkflowArtifactByteIntegrityReason) {
    super(reason)
    this.name = 'WorkflowArtifactByteIntegrityError'
    this.reason = reason
  }
}

/** Require Workflow Evidence with an Artifact to resolve to byte-verified local files. */
export function assertWorkflowEvidenceArtifactByteIntegrity(
  db: WorkflowLedgerDatabase,
  acceptance: WorkflowAcceptanceRecord,
  evidence: WorkflowEvidenceRecord,
  verifiedEvents: readonly WorkflowEventRecord[],
  deferFileReadsForArtifactIds?: ReadonlySet<string>
): void {
  if (acceptance.status !== 'passed' || !evidence.artifactId) return

  const neighborhood = loadArtifactNeighborhood(db, evidence.artifactId, verifiedEvents)
  const evidenceDigest = normalizeEvidenceDigest(evidence.contentDigest)
  const artifactDigest = normalizeDeclaredDigest(
    neighborhood.artifact.digest,
    'workflow_artifact_digest_invalid'
  )
  if (artifactDigest !== evidenceDigest) {
    fail('workflow_artifact_digest_mismatch')
  }

  let localCandidateCount = 0
  for (const location of neighborhood.locations) {
    if (location.availability !== 'available') continue
    const paths = localPaths(location)
    if (paths.length === 0) continue
    localCandidateCount += paths.length
    assertLocationDeclarations(location, evidenceDigest)
    // The file-change repair ingress already observed these exact Artifact
    // bytes. Keep all identity/digest/location declarations checked before
    // it invalidates verification; ordinary callers always read the files.
    if (deferFileReadsForArtifactIds?.has(evidence.artifactId)) continue
    for (const path of paths) {
      const observed = readStableRegularFile(path)
      if (observed.sizeBytes !== location.sizeBytes) {
        fail('workflow_evidence_artifact_size_mismatch')
      }
      if (observed.digest !== evidenceDigest) {
        fail('workflow_evidence_content_digest_mismatch')
      }
    }
  }
  if (localCandidateCount === 0) {
    fail('workflow_evidence_artifact_local_location_missing')
  }
}

function loadArtifactNeighborhood(
  db: WorkflowLedgerDatabase,
  artifactId: string,
  verifiedEvents: readonly WorkflowEventRecord[]
): { artifact: WorkflowArtifactRecord; locations: WorkflowArtifactLocationRecord[] } {
  try {
    setupWorkflowArtifactGraphSchema(db)
    const artifact = findWorkflowArtifact(db, artifactId)
    if (!artifact) fail('workflow_evidence_artifact_graph_invalid')
    const locations = readArtifactLocations(db).filter((location) => location.artifactId === artifactId)
    for (const location of locations) {
      assertLocationProjectCompatibility(location, artifact)
      assertArtifactScopeCompatibility(location, artifact)
      assertScopeReferences(db, location, location.projectId, `location ${location.id}`)
    }
    assertArtifactEventBinding(artifact, verifiedEvents)
    assertLocationEventBindings(artifact, locations, verifiedEvents)
    return { artifact, locations }
  } catch {
    fail('workflow_evidence_artifact_graph_invalid')
  }
}

function assertArtifactEventBinding(
  artifact: WorkflowArtifactRecord,
  events: readonly WorkflowEventRecord[]
): void {
  const matching = events.filter((event) =>
    event.entityType === 'artifact' && event.entityId === artifact.id && event.kind === 'artifact.created'
  )
  const event = matching[0]
  const expectedStreamId = artifact.workItemId ? `work-item:${artifact.workItemId}` : `artifact:${artifact.id}`
  const expectedCorrelationId = artifact.runId ?? artifact.workItemId ?? artifact.id
  if (matching.length !== 1 || !event ||
      event.eventId !== `workflow:artifact:${artifact.id}:version:${artifact.version}` ||
      event.streamId !== expectedStreamId || event.correlationId !== expectedCorrelationId ||
      event.projectId !== artifact.projectId || event.goalId !== artifact.goalId ||
      event.workItemId !== artifact.workItemId || event.runId !== artifact.runId ||
      event.occurredAt !== artifact.createdAt || canonicalJson(event.payload) !== canonicalJson(artifact)) {
    fail('workflow_evidence_artifact_graph_invalid')
  }
}

function assertLocationEventBindings(
  artifact: WorkflowArtifactRecord,
  locations: readonly WorkflowArtifactLocationRecord[],
  events: readonly WorkflowEventRecord[]
): void {
  const eventsById = new Map(events.map((event) => [event.eventId, event]))
  const locationIds = new Set(locations.map((location) => location.id))
  for (const location of locations) {
    assertLocationEventBinding(location, eventsById)
  }
  assertNoOrphanLocationEvents(artifact, locationIds, events)
}

function assertLocationEventBinding(
  location: WorkflowArtifactLocationRecord,
  eventsById: ReadonlyMap<string, WorkflowEventRecord>
): void {
  const event = eventsById.get(`workflow.artifact.location.created:${location.id}`)
  if (!event || event.kind !== 'workflow.artifact.location.created' ||
      event.entityType !== 'artifact' || event.entityId !== `artifact-location:${location.id}` ||
      event.correlationId !== location.artifactId || event.streamId !== `artifact:${location.artifactId}` ||
      event.projectId !== location.projectId || event.goalId !== location.goalId ||
      event.workItemId !== location.workItemId || event.runId !== location.runId ||
      canonicalJson(event.payload) !== canonicalJson(location)) {
    fail('workflow_evidence_artifact_graph_invalid')
  }
}

function assertNoOrphanLocationEvents(
  artifact: WorkflowArtifactRecord,
  locationIds: ReadonlySet<string>,
  events: readonly WorkflowEventRecord[]
): void {
  for (const event of events) {
    if (event.kind !== 'workflow.artifact.location.created') continue
    if (event.streamId !== `artifact:${artifact.id}` && event.correlationId !== artifact.id) continue
    if (!event.entityId.startsWith('artifact-location:') ||
        !locationIds.has(event.entityId.slice('artifact-location:'.length))) {
      fail('workflow_evidence_artifact_graph_invalid')
    }
  }
}

function assertLocationDeclarations(
  location: WorkflowArtifactLocationRecord,
  evidenceDigest: string
): void {
  if (location.sizeBytes === undefined) {
    fail('workflow_evidence_artifact_location_size_missing')
  }
  if (location.checksum === undefined) {
    fail('workflow_evidence_artifact_location_checksum_missing')
  }
  const checksum = normalizeDeclaredDigest(
    location.checksum,
    'workflow_artifact_location_checksum_invalid'
  )
  if (checksum !== evidenceDigest) {
    fail('workflow_artifact_location_checksum_mismatch')
  }
}

function localPaths(location: WorkflowArtifactLocationRecord): string[] {
  const paths = new Set<string>()
  if (location.path) {
    if (!isAbsolute(location.path)) fail('workflow_evidence_artifact_location_invalid')
    paths.add(resolve(location.path))
  }
  if (location.uri?.toLowerCase().startsWith('file:')) {
    try {
      paths.add(resolve(fileURLToPath(new URL(location.uri))))
    } catch {
      fail('workflow_evidence_artifact_location_invalid')
    }
  }
  return [...paths]
}

function normalizeEvidenceDigest(value: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    fail('workflow_evidence_content_digest_invalid')
  }
  return value.toLowerCase()
}

function normalizeDeclaredDigest(
  value: string,
  reason: Extract<
    WorkflowArtifactByteIntegrityReason,
    'workflow_artifact_digest_invalid' | 'workflow_artifact_location_checksum_invalid'
  >
): string {
  const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(value.trim())
  if (!match) fail(reason)
  return match[1].toLowerCase()
}

function readStableRegularFile(path: string): { digest: string; sizeBytes: number } {
  let descriptor: number | undefined
  try {
    const pathBefore = lstatSync(path, { bigint: true })
    assertRegularPath(pathBefore)
    descriptor = openSync(path, constants.O_RDONLY)
    return readOpenedRegularFile(path, descriptor, pathBefore)
  } catch (error) {
    if (error instanceof WorkflowArtifactByteIntegrityError) throw error
    return fail('workflow_evidence_artifact_file_unavailable')
  } finally {
    closeDescriptor(descriptor)
  }
}

function readOpenedRegularFile(
  path: string,
  descriptor: number,
  pathBefore: BigIntStats
): { digest: string; sizeBytes: number } {
  const openedBefore = fstatSync(descriptor, { bigint: true })
  if (!openedBefore.isFile() || !sameFile(pathBefore, openedBefore)) {
    fail('workflow_evidence_artifact_file_changed')
  }
  const observed = hashOpenedFile(descriptor)
  const openedAfter = fstatSync(descriptor, { bigint: true })
  const pathAfter = lstatSync(path, { bigint: true })
  if (!pathAfter.isFile() || pathAfter.isSymbolicLink() ||
      !sameSnapshot(openedBefore, openedAfter) || !sameFile(openedAfter, pathAfter) ||
      openedAfter.size !== BigInt(observed.sizeBytes)) {
    fail('workflow_evidence_artifact_file_changed')
  }
  return observed
}

function hashOpenedFile(descriptor: number): { digest: string; sizeBytes: number } {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let sizeBytes = 0
  while (true) {
    const count = readSync(descriptor, buffer, 0, buffer.byteLength, null)
    if (count === 0) break
    hash.update(buffer.subarray(0, count))
    sizeBytes += count
    if (!Number.isSafeInteger(sizeBytes)) fail('workflow_evidence_artifact_file_unavailable')
  }
  return { digest: hash.digest('hex'), sizeBytes }
}

function assertRegularPath(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail('workflow_evidence_artifact_file_not_regular')
  }
}

function closeDescriptor(descriptor: number | undefined): void {
  if (descriptor === undefined) return
  try {
    closeSync(descriptor)
  } catch {
    // The stable public failure is determined by the read/verification path.
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function fail(reason: WorkflowArtifactByteIntegrityReason): never {
  throw new WorkflowArtifactByteIntegrityError(reason)
}
