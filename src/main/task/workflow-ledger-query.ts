import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEventRecord,
  WorkflowGoalRecord,
  WorkflowLedgerPage,
  WorkflowLedgerScope,
  WorkflowLedgerSelection,
  WorkflowRunRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import type {
  WorkflowEventAppendState,
  WorkflowEventReferenceIndex
} from './workflow-ledger-query-types'
import {
  canonicalJson,
  cursorOffset,
  decodeEventRow,
  decodePayload,
  GENESIS_DIGEST,
  isWorkflowAcceptance,
  isWorkflowArtifact,
  isWorkflowEvidenceLink,
  isWorkflowGoal,
  isWorkflowRun,
  isWorkflowWorkItem,
  pageSize
} from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { readRows } from './workflow-ledger-sql'
import { selectTaskEvidence, type TaskEvidenceRecord } from './task-evidence-store'
import {
  assertTaskEvidenceEvent,
  assertTaskEvidenceEventCoverage,
  resolveArtifactGraphEntity
} from './workflow-ledger-integrity'
import {
  buildProjectionEventIndex,
  latestEntityEvent,
  type ProjectionEventIndex
} from './workflow-ledger-projection-index'

export type { WorkflowEventAppendState, WorkflowEventReferenceIndex } from './workflow-ledger-query-types'

const GOAL_COLUMNS = { id: 'id', project_id: 'projectId', status: 'status', revision: 'revision', updated_at: 'updatedAt' }
const WORK_ITEM_COLUMNS = { id: 'id', project_id: 'projectId', goal_id: 'goalId', status: 'status', revision: 'revision', current_run_id: 'currentRunId', updated_at: 'updatedAt' }
const RUN_COLUMNS = { id: 'id', project_id: 'projectId', goal_id: 'goalId', work_item_id: 'workItemId', session_id: 'sessionId', task_id: 'taskId', status: 'status', revision: 'revision', attempt: 'attempt', updated_at: 'updatedAt' }
const ARTIFACT_COLUMNS = { id: 'id', project_id: 'projectId', goal_id: 'goalId', work_item_id: 'workItemId', run_id: 'runId', kind: 'kind', digest: 'digest', version: 'version', updated_at: 'updatedAt' }
const ACCEPTANCE_COLUMNS = { id: 'id', project_id: 'projectId', goal_id: 'goalId', work_item_id: 'workItemId', status: 'status', revision: 'revision', updated_at: 'updatedAt' }
const EVIDENCE_LINK_COLUMNS = { id: 'id', evidence_id: 'evidenceId', project_id: 'projectId', run_id: 'runId', artifact_id: 'artifactId', acceptance_id: 'acceptanceId', relation: 'relation', created_at: 'createdAt' }

export function readGoals(db: WorkflowLedgerDatabase): WorkflowGoalRecord[] {
  return readPayloadRows(
    db,
    'SELECT id, project_id, status, revision, updated_at, payload FROM workflow_goals ORDER BY updated_at ASC, id ASC',
    isWorkflowGoal,
    'goal',
    { id: 'id', project_id: 'projectId', status: 'status', revision: 'revision', updated_at: 'updatedAt' }
  )
}

export function readWorkItems(db: WorkflowLedgerDatabase): WorkflowWorkItemRecord[] {
  return readPayloadRows(
    db,
    'SELECT id, project_id, goal_id, status, revision, current_run_id, updated_at, payload FROM workflow_work_items ORDER BY updated_at ASC, id ASC',
    isWorkflowWorkItem,
    'work item',
    { id: 'id', project_id: 'projectId', goal_id: 'goalId', status: 'status', revision: 'revision', current_run_id: 'currentRunId', updated_at: 'updatedAt' }
  )
}

export function readRuns(db: WorkflowLedgerDatabase): WorkflowRunRecord[] {
  return readPayloadRows(
    db,
    'SELECT id, project_id, goal_id, work_item_id, session_id, task_id, status, revision, attempt, updated_at, payload FROM workflow_runs ORDER BY updated_at ASC, id ASC',
    isWorkflowRun,
    'run',
    { id: 'id', project_id: 'projectId', goal_id: 'goalId', work_item_id: 'workItemId', session_id: 'sessionId', task_id: 'taskId', status: 'status', revision: 'revision', attempt: 'attempt', updated_at: 'updatedAt' }
  )
}

export function readArtifacts(db: WorkflowLedgerDatabase): WorkflowArtifactRecord[] {
  return readPayloadRows(
    db,
    'SELECT id, project_id, goal_id, work_item_id, run_id, kind, digest, version, updated_at, payload FROM workflow_artifacts ORDER BY updated_at ASC, id ASC',
    isWorkflowArtifact,
    'artifact',
    { id: 'id', project_id: 'projectId', goal_id: 'goalId', work_item_id: 'workItemId', run_id: 'runId', kind: 'kind', digest: 'digest', version: 'version', updated_at: 'updatedAt' }
  )
}

export function readAcceptances(db: WorkflowLedgerDatabase): WorkflowAcceptanceRecord[] {
  return readPayloadRows(
    db,
    'SELECT id, project_id, goal_id, work_item_id, status, revision, updated_at, payload FROM workflow_acceptances ORDER BY updated_at ASC, id ASC',
    isWorkflowAcceptance,
    'acceptance',
    { id: 'id', project_id: 'projectId', goal_id: 'goalId', work_item_id: 'workItemId', status: 'status', revision: 'revision', updated_at: 'updatedAt' }
  )
}

export function readEvidenceLinks(db: WorkflowLedgerDatabase): WorkflowEvidenceLinkRecord[] {
  return readPayloadRows(
    db,
    'SELECT id, evidence_id, project_id, run_id, artifact_id, acceptance_id, relation, created_at, payload FROM workflow_evidence_links ORDER BY created_at ASC, id ASC',
    isWorkflowEvidenceLink,
    'evidence link',
    { id: 'id', evidence_id: 'evidenceId', project_id: 'projectId', run_id: 'runId', artifact_id: 'artifactId', acceptance_id: 'acceptanceId', relation: 'relation', created_at: 'createdAt' }
  )
}

export function readAndVerifyEventAppendState(
  db: WorkflowLedgerDatabase,
  options: {
    requireTaskEvidenceCoverage?: boolean
    requireProjectionBinding?: boolean
  } = {}
): WorkflowEventAppendState {
  const events = readWorkflowEventChain(db)
  const references = verifyEventReferences(db, events)
  if (options.requireTaskEvidenceCoverage !== false) {
    assertTaskEvidenceEventCoverage(events, references)
  }
  if (options.requireProjectionBinding !== false) {
    assertProjectionEventBindings(events, references)
  }
  return { events, references }
}

export function readAndVerifyEvents(
  db: WorkflowLedgerDatabase,
  options: {
    requireTaskEvidenceCoverage?: boolean
    requireProjectionBinding?: boolean
  } = {}
): WorkflowEventRecord[] {
  return readAndVerifyEventAppendState(db, options).events
}

/** Read and verify only the event hash chain, without dereferencing mutable projections. */
export function readWorkflowEventChain(db: WorkflowLedgerDatabase): WorkflowEventRecord[] {
  const rows: WorkflowEventRecord[] = []
  const stmt = db.prepare(
    `SELECT seq, event_id, stream_id, entity_type, entity_id, kind,
            project_id, goal_id, work_item_id, run_id, session_id, occurred_at,
            causation_id, correlation_id, prev_digest, record_digest, payload
       FROM workflow_events ORDER BY seq ASC`
  )
  try {
    while (stmt.step()) rows.push(decodeEventRow(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  verifyEventChain(rows)
  return rows
}

/** Validate one candidate event against the current projections before insert. */
export function assertWorkflowEventReferences(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventRecord
): void {
  verifyEventReference(db, event, buildEventReferenceIndex(db))
}

export function assertWorkflowEventReferencesWithIndex(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex
): void {
  verifyEventReference(db, event, index)
}

export function findWorkflowGoal(db: WorkflowLedgerDatabase, id: string): WorkflowGoalRecord | null {
  return findPayload(db, 'workflow_goals', id, isWorkflowGoal, 'goal', GOAL_COLUMNS)
}

export function findWorkflowWorkItem(db: WorkflowLedgerDatabase, id: string): WorkflowWorkItemRecord | null {
  return findPayload(db, 'workflow_work_items', id, isWorkflowWorkItem, 'work item', WORK_ITEM_COLUMNS)
}

export function findWorkflowRun(db: WorkflowLedgerDatabase, id: string): WorkflowRunRecord | null {
  return findPayload(db, 'workflow_runs', id, isWorkflowRun, 'run', RUN_COLUMNS)
}

export function findWorkflowArtifact(db: WorkflowLedgerDatabase, id: string): WorkflowArtifactRecord | null {
  return findPayload(db, 'workflow_artifacts', id, isWorkflowArtifact, 'artifact', ARTIFACT_COLUMNS)
}

export function findWorkflowAcceptance(db: WorkflowLedgerDatabase, id: string): WorkflowAcceptanceRecord | null {
  return findPayload(db, 'workflow_acceptances', id, isWorkflowAcceptance, 'acceptance', ACCEPTANCE_COLUMNS)
}

export function findWorkflowEvidenceLink(db: WorkflowLedgerDatabase, id: string): WorkflowEvidenceLinkRecord | null {
  return findPayload(db, 'workflow_evidence_links', id, isWorkflowEvidenceLink, 'evidence link', EVIDENCE_LINK_COLUMNS)
}

export function findEventById(db: WorkflowLedgerDatabase, eventId: string): WorkflowEventRecord | null {
  const stmt = db.prepare('SELECT * FROM workflow_events WHERE event_id = ? LIMIT 1')
  try {
    stmt.bind([eventId])
    return stmt.step() ? decodeEventRow(stmt.getAsObject()) : null
  } finally {
    stmt.free()
  }
}

export function selectWorkflowGoals(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerPage<WorkflowGoalRecord> {
  return page(readGoals(db).filter((record) => matchesGoalScope(record, scope)), scope)
}

export function selectWorkflowWorkItems(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerPage<WorkflowWorkItemRecord> {
  return page(readWorkItems(db).filter((record) => matchesWorkItemScope(record, scope)), scope)
}

export function selectWorkflowRuns(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerPage<WorkflowRunRecord> {
  return page(readRuns(db).filter((record) => matchesRunScope(record, scope)), scope)
}

export function selectWorkflowArtifacts(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerPage<WorkflowArtifactRecord> {
  return page(readArtifacts(db).filter((record) => matchesArtifactScope(record, scope)), scope)
}

export function selectWorkflowAcceptances(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerPage<WorkflowAcceptanceRecord> {
  return page(readAcceptances(db).filter((record) => matchesAcceptanceScope(record, scope)), scope)
}

export function selectWorkflowEvidenceLinks(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerPage<WorkflowEvidenceLinkRecord> {
  return page(readEvidenceLinks(db).filter((record) => matchesEvidenceLinkScope(record, scope)), scope)
}

export function selectWorkflowEvents(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerPage<WorkflowEventRecord> {
  return page(readAndVerifyEvents(db).filter((record) => matchesEventScope(record, scope)), scope)
}

export function selectWorkflowLedger(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerScope = {}
): WorkflowLedgerSelection {
  return {
    goals: selectWorkflowGoals(db, scope),
    workItems: selectWorkflowWorkItems(db, scope),
    runs: selectWorkflowRuns(db, scope),
    artifacts: selectWorkflowArtifacts(db, scope),
    acceptances: selectWorkflowAcceptances(db, scope),
    evidenceLinks: selectWorkflowEvidenceLinks(db, scope),
    events: selectWorkflowEvents(db, scope)
  }
}

function readPayloadRows<T>(
  db: WorkflowLedgerDatabase,
  sql: string,
  predicate: (value: unknown) => value is T,
  label: string,
  columns: Record<string, string>
): T[] {
  return readRows(db, sql).map((row) => decodePayloadRow(row, predicate, label, columns))
}

function decodePayloadRow<T>(
  row: Record<string, unknown>,
  predicate: (value: unknown) => value is T,
  label: string,
  columns: Record<string, string>
): T {
  const record = decodePayload(row.payload, predicate, label)
  for (const [column, field] of Object.entries(columns)) {
    if (!sameColumnValue(row[column], (record as Record<string, unknown>)[field])) {
      throw new WorkflowLedgerCorruptionError(`${label} payload does not match ${column} column`)
    }
  }
  return record
}

function sameColumnValue(columnValue: unknown, payloadValue: unknown): boolean {
  if (columnValue === null || columnValue === undefined) return payloadValue === undefined
  return columnValue === payloadValue
}

function findPayload<T>(
  db: WorkflowLedgerDatabase,
  table: string,
  id: string,
  predicate: (value: unknown) => value is T,
  label: string,
  columns: Record<string, string>
): T | null {
  const stmt = db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
  try {
    stmt.bind([id])
    if (!stmt.step()) return null
    return decodePayloadRow(stmt.getAsObject(), predicate, label, columns)
  } finally {
    stmt.free()
  }
}

function verifyEventChain(events: readonly WorkflowEventRecord[]): void {
  let previousDigest = GENESIS_DIGEST
  const seen = new Set<string>()
  events.forEach((event, index) => {
    if (seen.has(event.eventId)) throw new WorkflowLedgerCorruptionError(`duplicate event id ${event.eventId}`, event.seq)
    seen.add(event.eventId)
    if (event.seq !== index + 1) throw new WorkflowLedgerCorruptionError('event sequence is not contiguous', event.seq)
    if (event.prevDigest !== previousDigest) throw new WorkflowLedgerCorruptionError('event previous digest mismatch', event.seq)
    previousDigest = event.digest
  })
}

/**
 * Event hashes prove ordering and tamper evidence, but do not prove that an
 * event still points at a live projection. Rebuild the small reference index
 * and reject historical events whose entity or scope has become dangling.
 */
function verifyEventReferences(
  db: WorkflowLedgerDatabase,
  events: readonly WorkflowEventRecord[]
): WorkflowEventReferenceIndex {
  const index = buildEventReferenceIndex(db)
  for (const event of events) verifyEventReference(db, event, index)
  return index
}

function buildEventReferenceIndex(db: WorkflowLedgerDatabase): WorkflowEventReferenceIndex {
  return {
    goals: new Map(readGoals(db).map((record) => [record.id, record])),
    workItems: new Map(readWorkItems(db).map((record) => [record.id, record])),
    runs: new Map(readRuns(db).map((record) => [record.id, record])),
    artifacts: new Map(readArtifacts(db).map((record) => [record.id, record])),
    acceptances: new Map(readAcceptances(db).map((record) => [record.id, record])),
    evidenceLinks: new Map(readEvidenceLinks(db).map((record) => [record.id, record])),
    taskEvidence: readTaskEvidenceIndex(db)
  }
}

function readTaskEvidenceIndex(db: WorkflowLedgerDatabase): Map<string, TaskEvidenceRecord> | null {
  if (!hasTaskEvidenceTable(db)) return null
  try {
    return new Map(selectTaskEvidence(db).map((record) => [record.evidenceId, record]))
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown validation error'
    throw new WorkflowLedgerCorruptionError(`Task evidence ledger validation failed: ${reason}`)
  }
}

function hasTaskEvidenceTable(db: WorkflowLedgerDatabase): boolean {
  const stmt = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_evidence' LIMIT 1"
  )
  try {
    return stmt.step()
  } finally {
    stmt.free()
  }
}

function verifyEventReference(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex
): void {
  const entity = resolveEventEntity(db, event, index)
  const scope = resolveEventScope(event, index)
  assertEventScopeHierarchy(event, scope, entity)
  if (entity) assertEventEntityScope(event, entity)
  assertEventPayloadScope(event, entity)
  assertTaskEvidenceEvent(event, index)
}

type EventEntity =
  | WorkflowGoalRecord
  | WorkflowWorkItemRecord
  | WorkflowRunRecord
  | WorkflowArtifactRecord
  | WorkflowAcceptanceRecord

function resolveEventEntity(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex
): EventEntity | null {
  if (event.entityType === 'system') return null
  // Graph events use synthetic entity IDs. Resolve that namespace before the
  // ordinary Artifact map so an attacker cannot shadow a graph row with an
  // Artifact whose ID happens to share the synthetic prefix.
  if (event.entityType === 'artifact') {
    const graphEntity = resolveArtifactGraphEntity(db, event, index)
    if (graphEntity) return graphEntity
  }
  const maps: Record<Exclude<WorkflowEventRecord['entityType'], 'system'>, Map<string, EventEntity>> = {
    goal: index.goals,
    work_item: index.workItems,
    run: index.runs,
    artifact: index.artifacts,
    acceptance: index.acceptances
  }
  const entity = maps[event.entityType].get(event.entityId)
  if (entity) return entity
  if (!entity) {
    throw new WorkflowLedgerCorruptionError(
      `event ${event.eventId} references missing ${event.entityType} ${event.entityId}`,
      event.seq
    )
  }
  return entity
}

interface EventScopeReferences {
  goal: WorkflowGoalRecord | null
  workItem: WorkflowWorkItemRecord | null
  run: WorkflowRunRecord | null
}

function resolveEventScope(
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex
): EventScopeReferences {
  const goal = event.goalId ? index.goals.get(event.goalId) ?? null : null
  const workItem = event.workItemId ? index.workItems.get(event.workItemId) ?? null : null
  const run = event.runId ? index.runs.get(event.runId) ?? null : null
  if (event.goalId && !goal) missingEventScope(event, 'goal', event.goalId)
  if (event.workItemId && !workItem) missingEventScope(event, 'work item', event.workItemId)
  if (event.runId && !run) missingEventScope(event, 'run', event.runId)
  return { goal, workItem, run }
}

function missingEventScope(event: WorkflowEventRecord, label: string, id: string): never {
  throw new WorkflowLedgerCorruptionError(
    `event ${event.eventId} references missing ${label} ${id} in scope`,
    event.seq
  )
}

function assertEventScopeHierarchy(
  event: WorkflowEventRecord,
  scope: EventScopeReferences,
  entity: EventEntity | null
): void {
  const owners = [entity, scope.goal, scope.workItem, scope.run].filter(Boolean) as EventOwner[]
  assertEventProjectScope(event, owners)
  assertEventRelationScope(event, scope)
}

type EventOwner = { projectId?: string }

function assertEventProjectScope(event: WorkflowEventRecord, owners: EventOwner[]): void {
  const projectIds = new Set(owners.map((owner) => owner.projectId))
  if (projectIds.size > 1) eventConflict(event, 'event scope contains multiple project owners')
  if (owners.length > 0 && owners[0].projectId !== event.projectId) {
    eventConflict(event, 'event project scope differs from entity ownership')
  }
}

function assertEventRelationScope(
  event: WorkflowEventRecord,
  scope: EventScopeReferences
): void {
  if (scope.goal && scope.workItem && scope.workItem.goalId !== scope.goal.id) {
    eventConflict(event, 'event goal/work item scope differs')
  }
  if (scope.run && scope.workItem && scope.run.workItemId !== scope.workItem.id) {
    eventConflict(event, 'event run/work item scope differs')
  }
  if (scope.run && event.goalId && scope.run.goalId !== event.goalId) {
    eventConflict(event, 'event run/goal scope differs')
  }
  if (scope.run && event.sessionId && scope.run.sessionId !== event.sessionId) {
    eventConflict(event, 'event session scope differs')
  }
}

function assertEventEntityScope(
  event: WorkflowEventRecord,
  entity: EventEntity
): void {
  if (event.projectId !== undefined && entity.projectId !== event.projectId) {
    eventConflict(event, 'event project scope differs from entity')
  }
  if (event.entityType === 'goal') {
    if (event.goalId !== undefined && event.goalId !== entity.id) {
      eventConflict(event, 'goal entity and scope differ')
    }
    return
  }
  if (event.entityType === 'work_item') {
    if (event.workItemId !== undefined && event.workItemId !== entity.id) {
      eventConflict(event, 'work item entity and scope differ')
    }
    assertOptionalEntityScope(event, entity as WorkflowWorkItemRecord)
    return
  }
  if (event.entityType === 'run') {
    if (event.runId !== undefined && event.runId !== entity.id) {
      eventConflict(event, 'run entity and scope differ')
    }
    assertOptionalEntityScope(event, entity as WorkflowRunRecord)
    return
  }
  assertOptionalEntityScope(event, entity as WorkflowArtifactRecord | WorkflowAcceptanceRecord)
}

function assertOptionalEntityScope(
  event: WorkflowEventRecord,
  entity: WorkflowWorkItemRecord | WorkflowRunRecord | WorkflowArtifactRecord | WorkflowAcceptanceRecord
): void {
  const comparable = entity as unknown as Record<string, unknown>
  for (const field of ['goalId', 'workItemId', 'runId'] as const) {
    const eventValue = event[field]
    const entityValue = comparable[field]
    if (eventValue !== undefined && entityValue !== undefined && eventValue !== entityValue) {
      eventConflict(event, `event ${field} scope differs from entity`)
    }
  }
  if ('sessionId' in comparable && event.sessionId !== undefined && comparable.sessionId !== event.sessionId) {
    eventConflict(event, 'event session scope differs from entity')
  }
}

function assertEventPayloadScope(
  event: WorkflowEventRecord,
  entity: EventEntity | null
): void {
  const payload = event.payload
  for (const field of ['projectId', 'goalId', 'workItemId', 'runId'] as const) {
    const payloadValue = payload[field]
    if (payloadValue === undefined) continue
    if (typeof payloadValue !== 'string' || payloadValue.length === 0) {
      eventConflict(event, `event payload ${field} is invalid`)
    }
    const scopeValue = event[field]
    if (scopeValue !== undefined && payloadValue !== scopeValue) {
      eventConflict(event, `event payload ${field} differs from scope`)
    }
  }
  if (!entity) return
  const payloadIds: Record<string, string> = {
    goal: 'goalId',
    work_item: 'workItemId',
    run: 'runId',
    artifact: 'artifactId',
    acceptance: 'acceptanceId'
  }
  const field = payloadIds[event.entityType]
  if (field && payload[field] !== undefined && payload[field] !== entity.id) {
    eventConflict(event, `event payload ${field} differs from entity`)
  }
  if (event.entityType === 'run' && payload.taskId !== undefined &&
      (typeof payload.taskId !== 'string' || payload.taskId !== (entity as WorkflowRunRecord).taskId)) {
    eventConflict(event, 'event payload taskId differs from entity')
  }
}

function assertProjectionEventBindings(
  events: readonly WorkflowEventRecord[],
  index: WorkflowEventReferenceIndex
): void {
  const projectionEvents = buildProjectionEventIndex(events)
  for (const goal of index.goals.values()) {
    assertProjectionEvent(
      goal,
      latestEntityEvent(projectionEvents, 'goal', goal.id, ['goal.created', 'goal.updated']),
      `workflow:goal:${goal.id}:revision:${goal.revision}`,
      'Goal'
    )
  }
  for (const item of index.workItems.values()) {
    assertProjectionEvent(
      item,
      latestEntityEvent(projectionEvents, 'work_item', item.id, ['work_item.created', 'work_item.updated']),
      `workflow:work-item:${item.id}:revision:${item.revision}`,
      'WorkItem'
    )
  }
  for (const artifact of index.artifacts.values()) {
    assertProjectionEvent(
      artifact,
      latestEntityEvent(projectionEvents, 'artifact', artifact.id, ['artifact.created']),
      `workflow:artifact:${artifact.id}:version:${artifact.version}`,
      'Artifact'
    )
  }
  assertAcceptanceEventBindings(projectionEvents, index.acceptances)
  assertRunEventBindings(projectionEvents, index.runs)
  assertEvidenceLinkEventBindings(projectionEvents, index.evidenceLinks)
}

function assertAcceptanceEventBindings(
  projectionEvents: ProjectionEventIndex,
  acceptances: Map<string, WorkflowAcceptanceRecord>
): void {
  for (const acceptance of acceptances.values()) {
    assertProjectionEvent(
      acceptance,
      latestEntityEvent(projectionEvents, 'acceptance', acceptance.id, ['acceptance.created', 'acceptance.updated']),
      `workflow:acceptance:${acceptance.id}:revision:${acceptance.revision}`,
      'Acceptance'
    )
  }
}

function assertRunEventBindings(
  projectionEvents: ProjectionEventIndex,
  runs: Map<string, WorkflowRunRecord>
): void {
  for (const run of runs.values()) {
    const event = projectionEvents.runProjections.get(run.id)
    if (!event) throw new WorkflowLedgerCorruptionError(`Run ${run.id} has no projection event`)
    const expected = runProjectionEventPayload(run)
    for (const [field, value] of Object.entries(expected)) {
      if (event.payload[field] !== value) {
        eventConflict(event, `Run ${run.id} projection payload differs at ${field}`)
      }
    }
    if (event.occurredAt !== run.updatedAt) {
      eventConflict(event, `Run ${run.id} projection timestamp differs`)
    }
  }
}

function assertEvidenceLinkEventBindings(
  projectionEvents: ProjectionEventIndex,
  links: Map<string, WorkflowEvidenceLinkRecord>
): void {
  for (const link of links.values()) {
    const event = projectionEvents.evidenceLinks.get(link.id)
    assertProjectionEvent(link, event, `workflow:evidence-link:${link.id}`, 'Evidence Link')
  }
}

function assertProjectionEvent(
  record: object & { id: string },
  event: WorkflowEventRecord | undefined,
  expectedEventId: string,
  label: string
): void {
  if (!event) throw new WorkflowLedgerCorruptionError(`${label} ${record.id} has no projection event`)
  if (event.eventId !== expectedEventId) {
    eventConflict(event, `${label} ${record.id} projection event identity differs`)
  }
  if (canonicalJson(event.payload) !== canonicalJson(record)) {
    eventConflict(event, `${label} ${record.id} projection payload differs from current state`)
  }
}

function runProjectionEventPayload(run: WorkflowRunRecord): Record<string, unknown> {
  return {
    runId: run.id,
    workItemId: run.workItemId,
    taskId: run.taskId,
    status: run.status,
    revision: run.revision,
    attempt: run.attempt
  }
}

function eventConflict(event: WorkflowEventRecord, reason: string): never {
  throw new WorkflowLedgerCorruptionError(`event ${event.eventId} ${reason}`, event.seq)
}

function matchesGoalScope(record: WorkflowGoalRecord, scope: WorkflowLedgerScope): boolean {
  return !scope.projectId || record.projectId === scope.projectId
}

function matchesWorkItemScope(record: WorkflowWorkItemRecord, scope: WorkflowLedgerScope): boolean {
  return (!scope.projectId || record.projectId === scope.projectId) &&
    (!scope.goalId || record.goalId === scope.goalId) &&
    (!scope.workItemId || record.id === scope.workItemId)
}

function matchesRunScope(record: WorkflowRunRecord, scope: WorkflowLedgerScope): boolean {
  return (!scope.projectId || record.projectId === scope.projectId) &&
    (!scope.goalId || record.goalId === scope.goalId) &&
    (!scope.workItemId || record.workItemId === scope.workItemId) &&
    (!scope.runId || record.id === scope.runId) &&
    (!scope.sessionId || record.sessionId === scope.sessionId)
}

function matchesArtifactScope(record: WorkflowArtifactRecord, scope: WorkflowLedgerScope): boolean {
  return (!scope.projectId || record.projectId === scope.projectId) &&
    (!scope.goalId || record.goalId === scope.goalId) &&
    (!scope.workItemId || record.workItemId === scope.workItemId) &&
    (!scope.runId || record.runId === scope.runId) &&
    (!scope.artifactId || record.id === scope.artifactId)
}

function matchesAcceptanceScope(record: WorkflowAcceptanceRecord, scope: WorkflowLedgerScope): boolean {
  return (!scope.projectId || record.projectId === scope.projectId) &&
    (!scope.goalId || record.goalId === scope.goalId) &&
    (!scope.workItemId || record.workItemId === scope.workItemId) &&
    (!scope.acceptanceId || record.id === scope.acceptanceId)
}

function matchesEvidenceLinkScope(record: WorkflowEvidenceLinkRecord, scope: WorkflowLedgerScope): boolean {
  return (!scope.projectId || record.projectId === scope.projectId) &&
    (!scope.runId || record.runId === scope.runId) &&
    (!scope.artifactId || record.artifactId === scope.artifactId) &&
    (!scope.acceptanceId || record.acceptanceId === scope.acceptanceId)
}

function matchesEventScope(record: WorkflowEventRecord, scope: WorkflowLedgerScope): boolean {
  return matchesEventOwnership(record, scope) && matchesEventIdentity(record, scope)
}

function matchesEventOwnership(record: WorkflowEventRecord, scope: WorkflowLedgerScope): boolean {
  return (!scope.projectId || record.projectId === scope.projectId) &&
    (!scope.goalId || record.goalId === scope.goalId) &&
    (!scope.workItemId || record.workItemId === scope.workItemId) &&
    (!scope.runId || record.runId === scope.runId) &&
    (!scope.sessionId || record.sessionId === scope.sessionId)
}

function matchesEventIdentity(record: WorkflowEventRecord, scope: WorkflowLedgerScope): boolean {
  return (!scope.entityType || record.entityType === scope.entityType) &&
    (!scope.entityId || record.entityId === scope.entityId) &&
    (!scope.eventKind || record.kind === scope.eventKind)
}

function page<T>(records: T[], scope: WorkflowLedgerScope): WorkflowLedgerPage<T> {
  const limit = pageSize(scope.limit)
  const offset = cursorOffset(scope.cursor)
  const items = records.slice(offset, offset + limit)
  const hasMore = offset + items.length < records.length
  return {
    items,
    total: records.length,
    hasMore,
    ...(hasMore ? { nextCursor: String(offset + items.length) } : {})
  }
}
