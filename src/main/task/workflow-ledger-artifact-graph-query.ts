import type {
  WorkflowArtifactRecord,
  WorkflowEventRecord,
  WorkflowLedgerPage,
  WorkflowLedgerVerification
} from '../../shared/workflow-types'
import {
  canonicalJson,
  cursorOffset,
  normalizeOptionalId,
  pageSize
} from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import {
  readAndVerifyEvents,
  readArtifacts
} from './workflow-ledger-query'
import { verifyWorkflowLedger } from './workflow-ledger-store'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  assertArtifactScopeCompatibility,
  assertEndpointProjectCompatibility,
  assertEndpointScopeCompatibility,
  assertLocationProjectCompatibility,
  assertScopeReferences,
  decodeEdgeRow,
  decodeLocationRow,
  requireArtifact
} from './workflow-ledger-artifact-graph-codec'
import {
  setupWorkflowArtifactGraphSchema,
  EDGE_RELATIONS,
  LOCATION_AVAILABILITIES,
  LOCATION_KINDS,
  type WorkflowArtifactEdgeRecord,
  type WorkflowArtifactGraphScope,
  type WorkflowArtifactGraphVerification,
  type WorkflowArtifactLocationRecord,
  type WorkflowArtifactNeighborhood
} from './workflow-ledger-artifact-graph-types'

export function readArtifactEdges(db: WorkflowLedgerDatabase): WorkflowArtifactEdgeRecord[] {
  const rows: WorkflowArtifactEdgeRecord[] = []
  const stmt = db.prepare(
    `SELECT id, from_artifact_id, to_artifact_id, relation, project_id, goal_id,
            work_item_id, run_id, created_at, updated_at, payload
       FROM workflow_artifact_edges ORDER BY created_at ASC, id ASC`
  )
  try {
    while (stmt.step()) rows.push(decodeEdgeRow(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  return rows
}

export function readArtifactLocations(db: WorkflowLedgerDatabase): WorkflowArtifactLocationRecord[] {
  const rows: WorkflowArtifactLocationRecord[] = []
  const stmt = db.prepare(
    `SELECT id, artifact_id, project_id, goal_id, work_item_id, run_id, kind,
            uri, path, availability, checksum, size_bytes, media_type,
            created_at, updated_at, payload
       FROM workflow_artifact_locations ORDER BY updated_at ASC, id ASC`
  )
  try {
    while (stmt.step()) rows.push(decodeLocationRow(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  return rows
}

export function selectWorkflowArtifactEdges(db: WorkflowLedgerDatabase, scope: WorkflowArtifactGraphScope = {}): WorkflowLedgerPage<WorkflowArtifactEdgeRecord> {
  setupWorkflowArtifactGraphSchema(db)
  verifyWorkflowArtifactGraph(db)
  const normalized = normalizeGraphScope(scope)
  return page(readArtifactEdges(db).filter((edge) => matchesEdgeScope(edge, normalized)), normalized)
}

export function selectWorkflowArtifactLocations(db: WorkflowLedgerDatabase, scope: WorkflowArtifactGraphScope = {}): WorkflowLedgerPage<WorkflowArtifactLocationRecord> {
  setupWorkflowArtifactGraphSchema(db)
  verifyWorkflowArtifactGraph(db)
  const normalized = normalizeGraphScope(scope)
  return page(readArtifactLocations(db).filter((location) => matchesLocationScope(location, normalized)), normalized)
}

export function queryWorkflowArtifactGraph(db: WorkflowLedgerDatabase, artifactId: string): WorkflowArtifactNeighborhood {
  setupWorkflowArtifactGraphSchema(db)
  verifyWorkflowArtifactGraph(db)
  const artifact = requireArtifact(db, artifactId, 'graph query artifact')
  const edges = readArtifactEdges(db)
  return {
    artifact,
    inbound: edges.filter((edge) => edge.toArtifactId === artifact.id),
    outbound: edges.filter((edge) => edge.fromArtifactId === artifact.id),
    locations: readArtifactLocations(db).filter((location) => location.artifactId === artifact.id)
  }
}

export const getWorkflowArtifactNeighborhood = queryWorkflowArtifactGraph

export function verifyWorkflowArtifactGraph(
  db: WorkflowLedgerDatabase,
  options: { ledgerVerification?: WorkflowLedgerVerification } = {}
): WorkflowArtifactGraphVerification {
  const { edges, locations, events } = verifyWorkflowArtifactGraphStructure(db)
  const ledger = options.ledgerVerification ?? verifyWorkflowLedger(db)
  const last = events.at(-1)
  return {
    valid: true,
    artifacts: ledger.artifacts,
    edges: edges.length,
    locations: locations.length,
    events: events.length,
    lastSeq: last?.seq ?? 0,
    lastDigest: last?.digest ?? '0'.repeat(64)
  }
}

/** Validate ownership and immutable graph events before repairing stale file verification. */
export function verifyWorkflowArtifactGraphStructure(db: WorkflowLedgerDatabase) {
  setupWorkflowArtifactGraphSchema(db)
  const artifacts = readArtifacts(db)
  const edges = readArtifactEdges(db)
  const locations = readArtifactLocations(db)
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  for (const edge of edges) {
    const from = requireIndexedArtifact(artifacts, edge.fromArtifactId, `edge ${edge.id} source`)
    const to = requireIndexedArtifact(artifacts, edge.toArtifactId, `edge ${edge.id} target`)
    if (!artifactIds.has(edge.fromArtifactId) || !artifactIds.has(edge.toArtifactId)) {
      throw new WorkflowLedgerCorruptionError(`artifact edge ${edge.id} references missing endpoint`)
    }
    assertEndpointProjectCompatibility(edge, from, to)
    assertScopeReferences(db, edge, edge.projectId, `edge ${edge.id}`)
    assertEndpointScopeCompatibility(edge, from, to)
  }
  for (const location of locations) {
    const artifact = requireIndexedArtifact(artifacts, location.artifactId, `location ${location.id}`)
    assertLocationProjectCompatibility(location, artifact)
    assertArtifactScopeCompatibility(location, artifact)
    assertScopeReferences(db, location, location.projectId, `location ${location.id}`)
  }
  const events = readAndVerifyEvents(db)
  verifyGraphEvents(edges, locations, events)
  return { artifacts, edges, locations, events }
}

/** Verify the base projection and additive Artifact Graph as one contract. */
export function verifyWorkflowLedgerWithArtifactGraph(
  db: WorkflowLedgerDatabase
): WorkflowLedgerVerification {
  const ledger = verifyWorkflowLedger(db)
  const artifactGraph = verifyWorkflowArtifactGraph(db, { ledgerVerification: ledger })
  return { ...ledger, artifactGraph }
}

function requireIndexedArtifact(artifacts: readonly WorkflowArtifactRecord[], id: string, label: string): WorkflowArtifactRecord {
  const artifact = artifacts.find((candidate) => candidate.id === id)
  if (!artifact) throw new WorkflowLedgerCorruptionError(`${label} references missing artifact ${id}`)
  return artifact
}

function normalizeGraphScope(scope: WorkflowArtifactGraphScope): WorkflowArtifactGraphScope {
  validateGraphScope(scope)
  return {
    ...normalizedScopeIds(scope),
    ...optionalScopeFilters(scope),
    ...(scope.cursor === undefined ? {} : { cursor: scope.cursor }),
    ...(scope.limit === undefined ? {} : { limit: scope.limit })
  }
}

function validateGraphScope(scope: WorkflowArtifactGraphScope): void {
  if (scope.relation !== undefined && !EDGE_RELATIONS.includes(scope.relation)) {
    throw new WorkflowLedgerCorruptionError('artifact edge relation scope is invalid')
  }
  if (scope.kind !== undefined && !LOCATION_KINDS.includes(scope.kind)) {
    throw new WorkflowLedgerCorruptionError('artifact location kind scope is invalid')
  }
  if (scope.availability !== undefined && !LOCATION_AVAILABILITIES.includes(scope.availability)) {
    throw new WorkflowLedgerCorruptionError('artifact location availability scope is invalid')
  }
  if (scope.cursor !== undefined) cursorOffset(scope.cursor)
  pageSize(scope.limit)
}

function normalizedScopeIds(scope: WorkflowArtifactGraphScope): WorkflowArtifactGraphScope {
  const projectId = normalizeOptionalId(scope.projectId)
  const artifactId = normalizeOptionalId(scope.artifactId)
  const fromArtifactId = normalizeOptionalId(scope.fromArtifactId)
  const toArtifactId = normalizeOptionalId(scope.toArtifactId)
  return {
    ...(projectId ? { projectId } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(fromArtifactId ? { fromArtifactId } : {}),
    ...(toArtifactId ? { toArtifactId } : {})
  }
}

function optionalScopeFilters(scope: WorkflowArtifactGraphScope): WorkflowArtifactGraphScope {
  return {
    ...(scope.relation ? { relation: scope.relation } : {}),
    ...(scope.kind ? { kind: scope.kind } : {}),
    ...(scope.availability ? { availability: scope.availability } : {})
  }
}

function matchesEdgeScope(edge: WorkflowArtifactEdgeRecord, scope: WorkflowArtifactGraphScope): boolean {
  return (!scope.projectId || edge.projectId === scope.projectId) &&
    (!scope.artifactId || edge.fromArtifactId === scope.artifactId || edge.toArtifactId === scope.artifactId) &&
    (!scope.fromArtifactId || edge.fromArtifactId === scope.fromArtifactId) &&
    (!scope.toArtifactId || edge.toArtifactId === scope.toArtifactId) &&
    (!scope.relation || edge.relation === scope.relation)
}

function matchesLocationScope(location: WorkflowArtifactLocationRecord, scope: WorkflowArtifactGraphScope): boolean {
  return (!scope.projectId || location.projectId === scope.projectId) &&
    (!scope.artifactId || location.artifactId === scope.artifactId) &&
    (!scope.kind || location.kind === scope.kind) &&
    (!scope.availability || location.availability === scope.availability)
}

function page<T>(records: T[], scope: WorkflowArtifactGraphScope): WorkflowLedgerPage<T> {
  const limit = pageSize(scope.limit)
  const offset = cursorOffset(scope.cursor)
  const items = records.slice(offset, offset + limit)
  const hasMore = offset + items.length < records.length
  return { items, total: records.length, hasMore, ...(hasMore ? { nextCursor: String(offset + items.length) } : {}) }
}

function verifyGraphEvents(edges: readonly WorkflowArtifactEdgeRecord[], locations: readonly WorkflowArtifactLocationRecord[], events: readonly WorkflowEventRecord[]): void {
  const byId = new Map(events.map((event) => [event.eventId, event]))
  for (const edge of edges) {
    assertGraphEvent(byId.get(`workflow.artifact.edge.created:${edge.id}`), edge, 'workflow.artifact.edge.created')
  }
  for (const location of locations) {
    assertGraphEvent(byId.get(`workflow.artifact.location.created:${location.id}`), location, 'workflow.artifact.location.created')
  }
  for (const event of events) {
    if (event.kind === 'workflow.artifact.edge.created' && !edges.some((edge) => event.eventId === `workflow.artifact.edge.created:${edge.id}`)) {
      throw new WorkflowLedgerCorruptionError(`artifact edge event ${event.eventId} has no record`)
    }
    if (event.kind === 'workflow.artifact.location.created' && !locations.some((location) => event.eventId === `workflow.artifact.location.created:${location.id}`)) {
      throw new WorkflowLedgerCorruptionError(`artifact location event ${event.eventId} has no record`)
    }
  }
}

function assertGraphEvent(event: WorkflowEventRecord | undefined, record: WorkflowArtifactEdgeRecord | WorkflowArtifactLocationRecord, kind: string): void {
  const artifactId = 'fromArtifactId' in record ? record.fromArtifactId : record.artifactId
  if (!event) throw new WorkflowLedgerCorruptionError(`${kind} event missing for ${record.id}`)
  if (event.kind !== kind || event.entityType !== 'artifact' || event.entityId !== `${kind.includes('.edge.') ? 'artifact-edge' : 'artifact-location'}:${record.id}` || event.correlationId !== artifactId) {
    throw new WorkflowLedgerCorruptionError(`${kind} event identity mismatch for ${record.id}`)
  }
  if (event.streamId !== `artifact:${artifactId}` || event.projectId !== record.projectId || event.goalId !== record.goalId || event.workItemId !== record.workItemId || event.runId !== record.runId) {
    throw new WorkflowLedgerCorruptionError(`${kind} event scope mismatch for ${record.id}`)
  }
  if (canonicalJson(event.payload) !== canonicalJson(record)) {
    throw new WorkflowLedgerCorruptionError(`${kind} event payload mismatch for ${record.id}`)
  }
}
