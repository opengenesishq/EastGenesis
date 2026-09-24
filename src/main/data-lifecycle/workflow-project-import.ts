import type {
  ProjectAggregateAuditRecord,
  ProjectAggregateSnapshot
} from '../../shared/project-aggregate-types'
import type {
  WorkflowEventRecord,
  WorkflowGoalRecord,
  WorkflowEvidenceInput,
  WorkflowEvidenceRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import { buildProjectWorkspaceProjection, parentFirst } from '../project-workspace/ledger-migration-source'
import {
  buildProjectWorkspaceImportAuthorityEvent,
  isLocalProjectWorkspaceAuthorityEvent
} from '../project-workspace/ledger-import-authority'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase, type TaskSnapshotDatabase } from '../task/task-snapshot'
import { setupTaskSnapshotSchema } from '../task/task-snapshot-schema'
import {
  backfillTaskEvidence,
  selectTaskEvidence,
  verifyTaskEvidence,
  type TaskEvidenceRecord
} from '../task/task-evidence-store'
import { canonicalJson } from '../task/workflow-ledger-codec'
import {
  findWorkflowAcceptance,
  findWorkflowArtifact,
  findWorkflowEvidenceLink,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem
} from '../task/workflow-ledger-query'
import {
  appendWorkflowEvent,
  setupWorkflowLedgerSchema,
  verifyWorkflowLedger
} from '../task/workflow-ledger-store'
import {
  insertAcceptance,
  insertArtifact,
  insertEvidenceLink,
  insertGoal,
  insertRun,
  insertWorkItem
} from '../task/workflow-ledger-sql'
import {
  appendWorkflowEvidence,
  readAllWorkflowEvidenceForIntegrity,
  setupWorkflowEvidenceSchema,
  verifyWorkflowEvidence
} from '../task/workflow-evidence-store'
import {
  findWorkflowArtifactEdge,
  findWorkflowArtifactLocation
} from '../task/workflow-ledger-artifact-graph'
import { setupWorkflowArtifactGraphSchema } from '../task/workflow-ledger-artifact-graph-types'
import { verifyWorkflowArtifactGraph } from '../task/workflow-ledger-artifact-graph-query'
import { exportPersistedWorkflowLedger } from '../task/workflow-ledger-maintenance'
import { digest as workflowDigest } from '../task/workflow-ledger-codec'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'

const CURRENT_TASK_STORE_VERSION = 9

export interface WorkflowProjectImportResult {
  projectId: string
  runs: number
  artifacts: number
  acceptances: number
  evidence: number
  events: number
}

export async function importWorkflowProjectAggregate(
  aggregate: ProjectAggregateSnapshot,
  rootDir: string
): Promise<WorkflowProjectImportResult> {
  if (await workflowProjectImportAlreadyApplied(aggregate, rootDir)) return importResult(aggregate)
  return mutateTaskSnapshotDatabase(rootDir, (db) => importIntoDatabase(db, aggregate))
}

/** Execute the complete import in a disposable database copy. */
export async function verifyWorkflowProjectAggregateImportable(
  aggregate: ProjectAggregateSnapshot,
  rootDir: string
): Promise<WorkflowProjectImportResult> {
  return readTaskSnapshotDatabase(rootDir, (db) => importIntoDatabase(db, aggregate))
}

function importIntoDatabase(
  db: TaskSnapshotDatabase,
  aggregate: ProjectAggregateSnapshot
): WorkflowProjectImportResult {
  setupTaskSnapshotSchema(db, CURRENT_TASK_STORE_VERSION)
  setupWorkflowLedgerSchema(db)
  setupWorkflowEvidenceSchema(db)
  setupWorkflowArtifactGraphSchema(db)
  verifyWorkflowLedger(db)
  verifyTaskEvidence(db)
  verifyWorkflowEvidence(db)
  verifyWorkflowArtifactGraph(db)

  const projection = buildProjectWorkspaceProjection({
    workspace: aggregate.workspace,
    goals: aggregate.goals,
    workItems: aggregate.workItems
  })
  // A TaskRun projection may advance the Workflow Goal/WorkItem revision after
  // the last ProjectWorkspace JSON write. The exported audit chain is the
  // verified source for that projection; seed the Workflow tables from its
  // latest entity event while preserving the Workspace aggregate unchanged.
  const sourceEvents = workflowEventsFromAudit(aggregate.audit)
  assertNoWorkflowConflicts(db, aggregate, projection)

  for (const goal of projection.goals) insertGoal(db, workflowGoalRecordForImport(goal.record, sourceEvents))
  for (const item of parentFirst(projection.workItems)) {
    insertWorkItem(db, workflowWorkItemRecordForImport(item.record, sourceEvents))
  }
  for (const run of aggregate.workflow.runs) {
    insertRun(db, run)
    db.run(
      'INSERT INTO task_runs(id, session_id, updated_at, payload) VALUES (?, ?, ?, ?)',
      [run.id, run.sessionId, run.updatedAt, canonicalJson(run.taskRun)]
    )
  }
  for (const artifact of aggregate.workflow.artifacts) insertArtifact(db, artifact)
  for (const acceptance of aggregate.workflow.acceptances) insertAcceptance(db, acceptance)
  for (const link of aggregate.workflow.evidenceLinks) insertEvidenceLink(db, link)
  for (const edge of aggregate.workflow.artifactEdges) insertArtifactEdge(db, edge)
  for (const location of aggregate.workflow.artifactLocations) insertArtifactLocation(db, location)

  backfillTaskEvidence(
    db,
    aggregate.workflow.runs.map((run) => run.taskRun),
    aggregate.workflow.runs.map((run) => ({ sessionId: run.sessionId, projectId: aggregate.projectId }))
  )
  const taskEvidence = selectTaskEvidence(db, { projectId: aggregate.projectId })
  assertEvidenceIdentitySet(
    aggregate.workflow.taskEvidence.map((record) => record.evidenceId),
    taskEvidence.map((record) => record.evidenceId),
    'Task evidence'
  )

  const workflowEvidence = aggregate.workflow.workflowEvidence
    .slice()
    .sort((left, right) => left.seq - right.seq)
    .map((record) => appendWorkflowEvidence(db, workflowEvidenceInput(record), {
      source: record.source,
      verifier: record.verifier,
      observedAt: record.observedAt,
      createdAt: record.createdAt
    }))

  const taskEvidenceById = new Map(taskEvidence.map((record) => [record.evidenceId, record]))
  const workflowEvidenceById = new Map(workflowEvidence.map((record) => [record.evidenceId, record]))
  for (const event of sourceEvents) {
    const payload = reboundEvidencePayload(event, taskEvidenceById, workflowEvidenceById)
    appendWorkflowEvent(db, {
      eventId: event.eventId,
      streamId: event.streamId,
      entityType: event.entityType,
      entityId: event.entityId,
      kind: event.kind,
      payload,
      occurredAt: event.occurredAt,
      causationId: event.causationId,
      correlationId: event.correlationId
    }, {
      projectId: event.projectId,
      goalId: event.goalId,
      workItemId: event.workItemId,
      runId: event.runId,
      sessionId: event.sessionId
    })
  }
  const importAuthority = buildProjectWorkspaceImportAuthorityEvent({
    projectId: aggregate.projectId,
    aggregateDigest: aggregate.aggregateDigest,
    workspaceRevision: aggregate.workspace.revision,
    occurredAt: aggregate.workspace.updatedAt,
    workItems: projection.workItems.map((item) => ({
      id: item.record.id,
      revision: item.record.revision,
      digest: item.descriptor.ledgerDigest
    }))
  })
  appendWorkflowEvent(db, importAuthority.event, importAuthority.scope)

  verifyWorkflowLedger(db)
  verifyTaskEvidence(db)
  verifyWorkflowEvidence(db)
  verifyWorkflowArtifactGraph(db)
  return {
    projectId: aggregate.projectId,
    runs: aggregate.workflow.runs.length,
    artifacts: aggregate.workflow.artifacts.length,
    acceptances: aggregate.workflow.acceptances.length,
    evidence: taskEvidence.length + workflowEvidence.length,
    events: sourceEvents.length
  }
}

function workflowGoalRecordForImport(
  fallback: WorkflowGoalRecord,
  events: readonly WorkflowEventRecord[]
): WorkflowGoalRecord {
  const event = latestProjectionEvent(events, 'goal', fallback.id)
  return event ? structuredClone(event.payload) as unknown as WorkflowGoalRecord : fallback
}

function workflowWorkItemRecordForImport(
  fallback: WorkflowWorkItemRecord,
  events: readonly WorkflowEventRecord[]
): WorkflowWorkItemRecord {
  const event = latestProjectionEvent(events, 'work_item', fallback.id)
  return event ? structuredClone(event.payload) as unknown as WorkflowWorkItemRecord : fallback
}

function latestProjectionEvent(
  events: readonly WorkflowEventRecord[],
  entityType: 'goal' | 'work_item',
  entityId: string
): WorkflowEventRecord | undefined {
  return events
    .filter((event) => event.entityType === entityType && event.entityId === entityId &&
      (event.kind === `${entityType}.created` || event.kind === `${entityType}.updated`))
    .sort((left, right) => left.seq - right.seq)
    .at(-1)
}

async function workflowProjectImportAlreadyApplied(
  aggregate: ProjectAggregateSnapshot,
  rootDir: string
): Promise<boolean> {
  const target = await exportPersistedWorkflowLedger({ scope: { projectId: aggregate.projectId } }, rootDir)
  const targetEvents = target.ledger.events.items.filter((event) =>
    !isLocalProjectWorkspaceAuthorityEvent(event)
  )
  const targetCount = target.ledger.goals.total + target.ledger.workItems.total + target.ledger.runs.total +
    target.ledger.artifacts.total + target.ledger.acceptances.total + target.ledger.evidenceLinks.total +
    targetEvents.length + target.ledger.artifactEdges.total + target.ledger.artifactLocations.total +
    target.ledger.taskEvidence.total + target.ledger.workflowEvidence.total
  if (targetCount === 0) return false
  const projection = buildProjectWorkspaceProjection({
    workspace: aggregate.workspace,
    goals: aggregate.goals,
    workItems: aggregate.workItems
  })
  const sourceEvents = workflowEventsFromAudit(aggregate.audit)
  const expected = {
    goals: projection.goals.map((item) => workflowGoalRecordForImport(item.record, sourceEvents)).sort(byId),
    workItems: projection.workItems.map((item) => workflowWorkItemRecordForImport(item.record, sourceEvents)).sort(byId),
    runs: aggregate.workflow.runs.map(({ taskRun, ...record }) => ({
      ...record,
      taskRunDigest: workflowDigest(taskRun)
    })).sort(byId),
    artifacts: aggregate.workflow.artifacts.slice().sort(byId),
    acceptances: aggregate.workflow.acceptances.slice().sort(byId),
    evidenceLinks: aggregate.workflow.evidenceLinks.slice().sort(byId),
    artifactEdges: aggregate.workflow.artifactEdges.slice().sort(byId),
    artifactLocations: aggregate.workflow.artifactLocations.slice().sort(byId),
    taskEvidence: aggregate.workflow.taskEvidence.map(stripChain).sort(byEvidenceId),
    workflowEvidence: aggregate.workflow.workflowEvidence.map(stripChain).sort(byEvidenceId),
    events: sourceEvents.map(normalizeEventChain).sort(byEventId)
  }
  const actual = {
    goals: target.ledger.goals.items.slice().sort(byId),
    workItems: target.ledger.workItems.items.slice().sort(byId),
    runs: target.ledger.runs.items.slice().sort(byId),
    artifacts: target.ledger.artifacts.items.slice().sort(byId),
    acceptances: target.ledger.acceptances.items.slice().sort(byId),
    evidenceLinks: target.ledger.evidenceLinks.items.slice().sort(byId),
    artifactEdges: target.ledger.artifactEdges.items.slice().sort(byId),
    artifactLocations: target.ledger.artifactLocations.items.slice().sort(byId),
    taskEvidence: target.ledger.taskEvidence.items.map(stripChain).sort(byEvidenceId),
    workflowEvidence: target.ledger.workflowEvidence.items.map(stripChain).sort(byEvidenceId),
    events: targetEvents.map(normalizeEventChain).sort(byEventId)
  }
  if (projectAggregateCanonicalJson(expected) === projectAggregateCanonicalJson(actual)) return true
  throw new Error(`Project import Workflow identity conflict: ${aggregate.projectId}`)
}

function importResult(aggregate: ProjectAggregateSnapshot): WorkflowProjectImportResult {
  return {
    projectId: aggregate.projectId,
    runs: aggregate.workflow.runs.length,
    artifacts: aggregate.workflow.artifacts.length,
    acceptances: aggregate.workflow.acceptances.length,
    evidence: aggregate.workflow.taskEvidence.length + aggregate.workflow.workflowEvidence.length,
    events: workflowEventsFromAudit(aggregate.audit).length
  }
}

function stripChain<T>(value: T): T {
  if (!isRecord(value)) return value
  const { seq: _seq, prevDigest: _prevDigest, digest: _digest, ...semantic } = value
  return semantic as T
}

function normalizeEventChain<T>(value: T): T {
  if (!isRecord(value)) return value
  const { seq: _seq, prevDigest: _prevDigest, digest: _digest, payload, ...event } = value
  if (event.kind === 'workflow.effect.evidence' && isRecord(payload)) {
    const {
      evidenceSeq: _evidenceSeq,
      taskEvidenceRecordDigest: _recordDigest,
      taskEvidencePrevDigest: _recordPrevDigest,
      ...semanticPayload
    } = payload
    return { ...event, payload: semanticPayload } as T
  }
  if (event.kind === 'workflow.evidence.recorded') return { ...event, payload: stripChain(payload) } as T
  return { ...event, payload } as T
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id)
}

function byEvidenceId(left: { evidenceId?: string }, right: { evidenceId?: string }): number {
  return String(left.evidenceId).localeCompare(String(right.evidenceId))
}

function byEventId(left: { eventId?: string }, right: { eventId?: string }): number {
  return String(left.eventId).localeCompare(String(right.eventId))
}

function assertNoWorkflowConflicts(
  db: TaskSnapshotDatabase,
  aggregate: ProjectAggregateSnapshot,
  projection: ReturnType<typeof buildProjectWorkspaceProjection>
): void {
  const conflicts = [
    ...conflictingIds(projection.goals.map((item) => item.record), (id) => Boolean(findWorkflowGoal(db, id)), 'goal'),
    ...conflictingIds(projection.workItems.map((item) => item.record), (id) => Boolean(findWorkflowWorkItem(db, id)), 'work_item'),
    ...conflictingIds(aggregate.workflow.runs, (id) => Boolean(findWorkflowRun(db, id)), 'run'),
    ...conflictingIds(aggregate.workflow.runs, (id) => rowExists(db, 'task_runs', id), 'task_run'),
    ...conflictingIds(aggregate.workflow.artifacts, (id) => Boolean(findWorkflowArtifact(db, id)), 'artifact'),
    ...conflictingIds(aggregate.workflow.acceptances, (id) => Boolean(findWorkflowAcceptance(db, id)), 'acceptance'),
    ...conflictingIds(aggregate.workflow.evidenceLinks, (id) => Boolean(findWorkflowEvidenceLink(db, id)), 'evidence_link'),
    ...conflictingIds(aggregate.workflow.artifactEdges, (id) => Boolean(findWorkflowArtifactEdge(db, id)), 'artifact_edge'),
    ...conflictingIds(aggregate.workflow.artifactLocations, (id) => Boolean(findWorkflowArtifactLocation(db, id)), 'artifact_location')
  ]
  const taskEvidenceIds = new Set(selectTaskEvidence(db).map((item) => item.evidenceId))
  const workflowEvidenceIds = new Set(readAllWorkflowEvidenceForIntegrity(db).map((item) => item.evidenceId))
  conflicts.push(
    ...conflictingEvidenceIds(aggregate.workflow.taskEvidence, taskEvidenceIds, 'task_evidence'),
    ...conflictingEvidenceIds(aggregate.workflow.workflowEvidence, workflowEvidenceIds, 'workflow_evidence'),
    ...conflictingEventIds(db, workflowEventsFromAudit(aggregate.audit))
  )
  if (conflicts.length > 0) throw new Error(`Project import Workflow identity conflict: ${conflicts.sort().join(', ')}`)
}

function conflictingIds(
  items: readonly { id: string }[],
  exists: (id: string) => boolean,
  prefix: string
): string[] {
  return items.filter((item) => exists(item.id)).map((item) => `${prefix}:${item.id}`)
}

function conflictingEvidenceIds(
  items: readonly { evidenceId: string }[],
  existing: ReadonlySet<string>,
  prefix: string
): string[] {
  return items.filter((item) => existing.has(item.evidenceId)).map((item) => `${prefix}:${item.evidenceId}`)
}

function conflictingEventIds(db: TaskSnapshotDatabase, events: readonly WorkflowEventRecord[]): string[] {
  return events
    .filter((event) => rowExists(db, 'workflow_events', event.eventId, 'event_id'))
    .map((event) => `event:${event.eventId}`)
}

function workflowEventsFromAudit(audit: readonly ProjectAggregateAuditRecord[]): WorkflowEventRecord[] {
  return audit
    .filter((entry) => entry.source === 'workflow_ledger')
    .map((entry) => requireWorkflowEvent(entry.value))
    .filter((event) => !isLocalProjectWorkspaceAuthorityEvent(event))
    .sort((left, right) => left.seq - right.seq)
}

function requireWorkflowEvent(value: unknown): WorkflowEventRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !positiveInteger(value.seq) ||
      !text(value.eventId) || !text(value.streamId) || !text(value.entityType) || !text(value.entityId) ||
      !text(value.kind) || !Number.isFinite(value.occurredAt) || !isRecord(value.payload) ||
      !text(value.prevDigest) || !text(value.digest)) {
    throw new Error('Project import contains an invalid Workflow event')
  }
  return structuredClone(value) as unknown as WorkflowEventRecord
}

export function workflowEvidenceInput(record: WorkflowEvidenceRecord): WorkflowEvidenceInput {
  return {
    evidenceId: record.evidenceId,
    projectId: record.projectId,
    goalId: record.goalId,
    workItemId: record.workItemId,
    runId: record.runId,
    artifactId: record.artifactId,
    kind: record.kind,
    source: record.source,
    title: record.title,
    summary: record.summary,
    uri: record.uri,
    mediaType: record.mediaType,
    verifier: record.verifier,
    observedAt: record.observedAt,
    contentDigest: record.contentDigest,
    metadata: record.metadata
  }
}

export function reboundEvidencePayload(
  event: WorkflowEventRecord,
  taskEvidence: ReadonlyMap<string, TaskEvidenceRecord>,
  workflowEvidence: ReadonlyMap<string, WorkflowEvidenceRecord>
): Record<string, unknown> {
  if (event.kind === 'workflow.effect.evidence') {
    const evidenceId = typeof event.payload.evidenceId === 'string' ? event.payload.evidenceId : ''
    const record = taskEvidence.get(evidenceId)
    if (!record) throw new Error(`Project import event ${event.eventId} references missing Task evidence`)
    return taskEvidencePayload(record)
  }
  if (event.kind === 'workflow.evidence.recorded') {
    const prefix = 'workflow:evidence-record:'
    const record = event.eventId.startsWith(prefix) ? workflowEvidence.get(event.eventId.slice(prefix.length)) : undefined
    if (!record) throw new Error(`Project import event ${event.eventId} references missing Workflow evidence`)
    return { ...record }
  }
  return structuredClone(event.payload)
}

function taskEvidencePayload(record: TaskEvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: record.evidenceId,
    evidenceSeq: record.seq,
    effectId: record.effectId,
    kind: record.kind,
    generation: record.generation,
    observedAt: record.observedAt,
    verifier: record.verifier,
    evidenceDigest: record.evidenceDigest,
    effectKey: record.effectKey,
    targetDigest: record.targetDigest,
    taskEvidenceRecordDigest: record.digest,
    taskEvidencePrevDigest: record.prevDigest,
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {})
  }
}

export function insertArtifactEdge(db: TaskSnapshotDatabase, edge: ProjectAggregateSnapshot['workflow']['artifactEdges'][number]): void {
  db.run(
    `INSERT INTO workflow_artifact_edges(
       id, from_artifact_id, to_artifact_id, relation, project_id, goal_id,
       work_item_id, run_id, created_at, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [edge.id, edge.fromArtifactId, edge.toArtifactId, edge.relation, edge.projectId ?? null,
      edge.goalId ?? null, edge.workItemId ?? null, edge.runId ?? null, edge.createdAt,
      edge.updatedAt, canonicalJson(edge)]
  )
}

export function insertArtifactLocation(
  db: TaskSnapshotDatabase,
  location: ProjectAggregateSnapshot['workflow']['artifactLocations'][number]
): void {
  db.run(
    `INSERT INTO workflow_artifact_locations(
       id, artifact_id, project_id, goal_id, work_item_id, run_id, kind,
       uri, path, availability, checksum, size_bytes, media_type,
       created_at, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [location.id, location.artifactId, location.projectId ?? null, location.goalId ?? null,
      location.workItemId ?? null, location.runId ?? null, location.kind, location.uri ?? null,
      location.path ?? null, location.availability, location.checksum ?? null,
      location.sizeBytes ?? null, location.mediaType ?? null, location.createdAt,
      location.updatedAt, canonicalJson(location)]
  )
}

function rowExists(db: TaskSnapshotDatabase, table: string, value: string, column = 'id'): boolean {
  const stmt = db.prepare(`SELECT 1 AS found FROM ${table} WHERE ${column} = ? LIMIT 1`)
  try {
    stmt.bind([value])
    return stmt.step()
  } finally {
    stmt.free()
  }
}

function assertEvidenceIdentitySet(expected: string[], actual: string[], label: string): void {
  const left = [...new Set(expected)].sort()
  const right = [...new Set(actual)].sort()
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} cannot be reconstructed from imported Run evidence`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
