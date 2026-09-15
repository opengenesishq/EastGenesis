import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkflowGoalRecord, WorkflowRunRecord, WorkflowWorkItemRecord } from '../../shared/workflow-types'
import { isTaskRunRecord } from './task-run'
import { isTaskSnapshotRecord } from './task-snapshot-validation'
import { digest } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import {
  WorkflowLedgerMigrationError,
  type WorkflowLedgerMigrationAcceptanceChangeImpact,
  type WorkflowLedgerMigrationSource
} from './workflow-ledger-migration-types'
import {
  openWorkflowLedgerDatabase,
  validateLegacyJsonMigrationSource
} from './workflow-ledger-readiness'
import { readGoals, readRuns, readWorkItems, readAcceptances, readArtifacts, readEvidenceLinks, findEventById } from './workflow-ledger-query'
import { applyWorkflowAcceptanceRechecks, buildWorkflowChangeImpactPlan } from './workflow-change-impact'
import { readArtifactEdges } from './workflow-ledger-artifact-graph-query'
import { insertAcceptance } from './workflow-ledger-sql'

const PREFIX_APPEND_TABLES = new Set(['task_evidence', 'workflow_events'])
const ADDITIVE_PROJECTION_TABLES = new Set(['workflow_goals', 'workflow_runs', 'workflow_work_items'])

interface TableColumn {
  cid: number
  name: string
  type: string
  notNull: number
  defaultValue: string | number | null | { blobHex: string }
  primaryKey: number
}

interface SchemaObject {
  type: string
  name: string
  tableName: string
  sql: string | null
}

/** Fail closed unless candidate bytes retain every pre-migration state row. */
export async function assertWorkflowLedgerMigrationPreservesSource(
  source: WorkflowLedgerMigrationSource,
  candidateBytes: Uint8Array,
  acceptanceChangeImpact?: WorkflowLedgerMigrationAcceptanceChangeImpact
): Promise<void> {
  const candidate = await openDatabase(candidateBytes, 'CANDIDATE')
  try {
    if (source.sourceKind === 'empty') return
    if (source.sourceKind === 'legacy_json') {
      assertLegacySnapshotsPreserved(source.sourceBytes, candidate)
      return
    }
    if (source.sourceKind !== 'sqlite') {
      throw preservationError('SOURCE_KIND_INVALID', `Unsupported source kind: ${String(source.sourceKind)}`)
    }
    const sourceDb = await openDatabase(source.sourceBytes, 'SOURCE')
    try {
      assertSqliteStatePreserved(sourceDb, candidate, acceptanceChangeImpact)
    } finally {
      sourceDb.close()
    }
  } finally {
    candidate.close()
  }
}

function assertSqliteStatePreserved(
  source: WorkflowLedgerDatabase,
  candidate: WorkflowLedgerDatabase,
  acceptanceChangeImpact?: WorkflowLedgerMigrationAcceptanceChangeImpact
): void {
  assertSchemaObjectsPreserved(source, candidate)
  const sourceTables = readUserTableNames(source)
  const candidateTables = readUserTableNames(candidate)
  for (const table of sourceTables) {
    if (!candidateTables.has(table)) {
      throw preservationError('SOURCE_TABLE_MISSING', `Candidate dropped source state table ${table}`)
    }
    const sourceColumns = readTableColumns(source, table)
    const candidateColumns = readTableColumns(candidate, table)
    if (digest(sourceColumns) !== digest(candidateColumns)) {
      throw preservationError('SOURCE_TABLE_SCHEMA_CHANGED', `Candidate changed source table schema ${table}`)
    }
    if (ADDITIVE_PROJECTION_TABLES.has(table)) {
      assertAdditiveProjectionTable(table, source, candidate)
      continue
    }
    if (table === 'workflow_acceptances' && acceptanceChangeImpact) {
      assertPlannedAcceptanceInvalidation(source, candidate, acceptanceChangeImpact)
      continue
    }
    const ordered = PREFIX_APPEND_TABLES.has(table)
    const sourceRows = readCanonicalRowDigests(source, table, sourceColumns, ordered)
    const candidateRows = readCanonicalRowDigests(candidate, table, candidateColumns, ordered)
    if (ordered) {
      assertAppendOnlyPrefix(table, sourceRows, candidateRows)
    } else {
      assertExactRows(table, sourceRows, candidateRows)
    }
  }
}

function assertPlannedAcceptanceInvalidation(
  source: WorkflowLedgerDatabase,
  candidate: WorkflowLedgerDatabase,
  impact: WorkflowLedgerMigrationAcceptanceChangeImpact
): void {
  const { plan, now } = impact
  if (!plan?.projectId || !Number.isFinite(now)) {
    throw preservationError('ACCEPTANCE_CHANGE_INVALID', 'Acceptance invalidation must have a Project and timestamp')
  }
  const original = readAcceptances(source)
  const rebuilt = buildWorkflowChangeImpactPlan({
    projectId: plan.projectId, changedArtifactIds: plan.changedArtifactIds,
    manuallyModifiedArtifactIds: plan.changedArtifactIds,
    artifacts: readArtifacts(source).filter(item => item.projectId === plan.projectId),
    edges: readArtifactEdges(source).filter(item => item.projectId === plan.projectId),
    evidenceLinks: readEvidenceLinks(source).filter(item => item.projectId === plan.projectId),
    acceptances: original.filter(item => item.projectId === plan.projectId)
  })
  const event = findEventById(candidate, `workflow:change-impact:${plan.planDigest}`)
  if (digest(rebuilt) !== digest(plan) || !event || event.kind !== 'workflow.change-impact.plan.created' ||
      digest(event.payload) !== digest(plan)) {
    throw preservationError('ACCEPTANCE_CHANGE_INVALID', 'Acceptance invalidation differs from the source graph or canonical plan event')
  }
  const expected = applyWorkflowAcceptanceRechecks(original, plan, now).sort((left, right) => left.id.localeCompare(right.id))
  const actual = readAcceptances(candidate).sort((left, right) => left.id.localeCompare(right.id))
  if (digest(expected) !== digest(actual)) {
    throw preservationError('ACCEPTANCE_CHANGE_INVALID', 'Candidate changed an Acceptance outside the exact invalidation plan')
  }
  // The opened source DB is a disposable copy of the immutable backup. Apply
  // only the permitted row writes there, then retain the original SQL-level
  // comparison (including storage classes and every unchanged column).
  const recheckedIds = new Set(plan.acceptanceRechecks.map(item => item.acceptanceId))
  for (const acceptance of expected) if (recheckedIds.has(acceptance.id)) insertAcceptance(source, acceptance)
  const columns = readTableColumns(source, 'workflow_acceptances')
  assertExactRows('workflow_acceptances',
    readCanonicalRowDigests(source, 'workflow_acceptances', columns, false),
    readCanonicalRowDigests(candidate, 'workflow_acceptances', columns, false))
}

function readUserTableNames(db: WorkflowLedgerDatabase): Set<string> {
  const names = new Set<string>()
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  try {
    while (stmt.step()) {
      const name = stmt.getAsObject().name
      if (typeof name !== 'string' || name.startsWith('sqlite_')) continue
      names.add(name)
    }
  } finally {
    stmt.free()
  }
  return names
}

function assertSchemaObjectsPreserved(
  source: WorkflowLedgerDatabase,
  candidate: WorkflowLedgerDatabase
): void {
  const sourceObjects = readSchemaObjects(source)
  const candidateObjects = new Map(readSchemaObjects(candidate).map((item) => [schemaObjectKey(item), item]))
  for (const sourceObject of sourceObjects) {
    const candidateObject = candidateObjects.get(schemaObjectKey(sourceObject))
    if (!candidateObject) {
      throw preservationError(
        'SOURCE_SCHEMA_OBJECT_MISSING',
        `Candidate dropped source ${sourceObject.type} ${sourceObject.name}`
      )
    }
    if (digest(sourceObject) !== digest(candidateObject)) {
      throw preservationError(
        'SOURCE_SCHEMA_OBJECT_CHANGED',
        `Candidate changed source ${sourceObject.type} DDL ${sourceObject.name}`
      )
    }
  }
}

function readSchemaObjects(db: WorkflowLedgerDatabase): SchemaObject[] {
  const objects: SchemaObject[] = []
  const stmt = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master " +
    "WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name"
  )
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const name = requiredText(row.name, 'sqlite_master.name')
      if (name.startsWith('sqlite_')) continue
      objects.push({
        type: requiredText(row.type, `${name}.type`),
        name,
        tableName: requiredText(row.tbl_name, `${name}.tbl_name`),
        sql: nullableText(row.sql, `${name}.sql`)
      })
    }
  } finally {
    stmt.free()
  }
  return objects
}

function schemaObjectKey(object: SchemaObject): string {
  return `${object.type}:${object.name}`
}

function readTableColumns(db: WorkflowLedgerDatabase, table: string): TableColumn[] {
  const columns: TableColumn[] = []
  const stmt = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      columns.push({
        cid: requiredInteger(row.cid, `${table}.cid`),
        name: requiredText(row.name, `${table}.name`),
        type: requiredText(row.type, `${table}.type`),
        notNull: requiredInteger(row.notnull, `${table}.notnull`),
        defaultValue: canonicalSqlValue(row.dflt_value, `${table}.dflt_value`),
        primaryKey: requiredInteger(row.pk, `${table}.pk`)
      })
    }
  } finally {
    stmt.free()
  }
  if (columns.length === 0) {
    throw preservationError('SOURCE_TABLE_SCHEMA_INVALID', `State table ${table} has no columns`)
  }
  return columns
}

function readCanonicalRowDigests(
  db: WorkflowLedgerDatabase,
  table: string,
  columns: readonly TableColumn[],
  evidenceOrder: boolean
): string[] {
  if (evidenceOrder && !columns.some((column) => column.name === 'seq')) {
    throw preservationError('APPEND_ONLY_SCHEMA_INVALID', `${table} source table has no seq column`)
  }
  const selections = columns.flatMap((column) => {
    const name = quoteIdentifier(column.name)
    return [`typeof(${name})`, name]
  })
  const order = evidenceOrder ? ` ORDER BY ${quoteIdentifier('seq')} ASC` : ''
  const stmt = db.prepare(`SELECT ${selections.join(', ')} FROM ${quoteIdentifier(table)}${order}`)
  const rows: string[] = []
  try {
    while (stmt.step()) {
      const values = stmt.get() as unknown[]
      const canonicalColumns = columns.map((column, index) => ({
        name: column.name,
        storage: requiredText(values[index * 2], `${table}.${column.name} storage class`),
        value: canonicalSqlValue(values[index * 2 + 1], `${table}.${column.name}`)
      }))
      rows.push(digest({ table, columns: canonicalColumns }))
    }
  } finally {
    stmt.free()
  }
  return evidenceOrder ? rows : rows.sort()
}

function assertExactRows(table: string, sourceRows: readonly string[], candidateRows: readonly string[]): void {
  if (sourceRows.length !== candidateRows.length) {
    throw preservationError(
      'SOURCE_ROW_COUNT_CHANGED',
      `Candidate changed ${table} row count from ${sourceRows.length} to ${candidateRows.length}`
    )
  }
  const changedAt = sourceRows.findIndex((row, index) => row !== candidateRows[index])
  if (changedAt >= 0) {
    throw preservationError('SOURCE_ROW_CHANGED', `Candidate changed ${table} source row digest at ${changedAt}`)
  }
}

function assertAppendOnlyPrefix(
  table: string,
  sourceRows: readonly string[],
  candidateRows: readonly string[]
): void {
  if (candidateRows.length < sourceRows.length) {
    throw preservationError(
      'APPEND_ONLY_TABLE_TRUNCATED',
      `Candidate retained ${candidateRows.length} of ${sourceRows.length} ${table} rows`
    )
  }
  const changedAt = sourceRows.findIndex((row, index) => row !== candidateRows[index])
  if (changedAt >= 0) {
    throw preservationError(
      'APPEND_ONLY_PREFIX_CHANGED',
      `Candidate changed ${table} source sequence ${changedAt + 1}`
    )
  }
}

function assertAdditiveProjectionTable(
  table: string,
  source: WorkflowLedgerDatabase,
  candidate: WorkflowLedgerDatabase
): void {
  if (table === 'workflow_runs') {
    assertWorkflowRunsAdditive(readRuns(source), readRuns(candidate))
    return
  }
  if (table === 'workflow_goals') {
    assertWorkflowGoalsAdditive(readGoals(source), readGoals(candidate))
    return
  }
  assertWorkflowWorkItemsAdditive(readWorkItems(source), readWorkItems(candidate))
}

function assertWorkflowGoalsAdditive(
  sourceGoals: readonly WorkflowGoalRecord[],
  candidateGoals: readonly WorkflowGoalRecord[]
): void {
  const candidates = new Map(candidateGoals.map((goal) => [goal.id, goal]))
  for (const source of sourceGoals) {
    const candidate = candidates.get(source.id)
    if (!candidate) {
      throw preservationError('WORKFLOW_GOAL_MISSING', `Candidate dropped Workflow Goal ${source.id}`)
    }
    if (digest(workflowGoalOwnership(source)) !== digest(workflowGoalOwnership(candidate))) {
      throw preservationError('WORKFLOW_GOAL_OWNERSHIP_CHANGED', `Candidate changed Workflow Goal ${source.id} ownership`)
    }
    if (candidate.revision < source.revision || candidate.updatedAt < source.updatedAt) {
      throw preservationError('WORKFLOW_GOAL_REGRESSED', `Candidate regressed Workflow Goal ${source.id}`)
    }
    if (candidate.revision === source.revision && digest(candidate) !== digest(source)) {
      throw preservationError(
        'WORKFLOW_GOAL_CHANGED_WITHOUT_REVISION',
        `Candidate changed Workflow Goal ${source.id} without a revision increment`
      )
    }
  }
}

function workflowGoalOwnership(goal: WorkflowGoalRecord): Record<string, unknown> {
  return {
    id: goal.id,
    projectId: goal.projectId,
    source: goal.source,
    createdAt: goal.createdAt
  }
}

function assertWorkflowRunsAdditive(
  sourceRuns: readonly WorkflowRunRecord[],
  candidateRuns: readonly WorkflowRunRecord[]
): void {
  const candidates = new Map(candidateRuns.map((run) => [run.id, run]))
  for (const source of sourceRuns) {
    const candidate = candidates.get(source.id)
    if (!candidate) {
      throw preservationError('WORKFLOW_RUN_MISSING', `Candidate dropped Workflow Run ${source.id}`)
    }
    if (digest(workflowRunOwnership(source)) !== digest(workflowRunOwnership(candidate))) {
      throw preservationError('WORKFLOW_RUN_OWNERSHIP_CHANGED', `Candidate changed Workflow Run ${source.id} ownership`)
    }
    if (
      candidate.revision < source.revision ||
      candidate.attempt < source.attempt ||
      candidate.updatedAt < source.updatedAt
    ) {
      throw preservationError('WORKFLOW_RUN_REGRESSED', `Candidate regressed Workflow Run ${source.id}`)
    }
  }
}

function workflowRunOwnership(run: WorkflowRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    projectId: run.projectId,
    goalId: run.goalId,
    workItemId: run.workItemId,
    sessionId: run.sessionId,
    taskId: run.taskId,
    createdAt: run.createdAt
  }
}

function assertWorkflowWorkItemsAdditive(
  sourceItems: readonly WorkflowWorkItemRecord[],
  candidateItems: readonly WorkflowWorkItemRecord[]
): void {
  const candidates = new Map(candidateItems.map((item) => [item.id, item]))
  for (const source of sourceItems) {
    const candidate = candidates.get(source.id)
    if (!candidate) {
      throw preservationError('WORKFLOW_WORK_ITEM_MISSING', `Candidate dropped Workflow WorkItem ${source.id}`)
    }
    if (digest(workflowWorkItemOwnership(source)) !== digest(workflowWorkItemOwnership(candidate))) {
      throw preservationError(
        'WORKFLOW_WORK_ITEM_OWNERSHIP_CHANGED',
        `Candidate changed Workflow WorkItem ${source.id} ownership`
      )
    }
    if (candidate.revision < source.revision || candidate.updatedAt < source.updatedAt) {
      throw preservationError('WORKFLOW_WORK_ITEM_REGRESSED', `Candidate regressed Workflow WorkItem ${source.id}`)
    }
    if (candidate.revision === source.revision && digest(candidate) !== digest(source)) {
      throw preservationError(
        'WORKFLOW_WORK_ITEM_CHANGED_WITHOUT_REVISION',
        `Candidate changed Workflow WorkItem ${source.id} without a revision increment`
      )
    }
    const candidateRunIds = new Set(candidate.runIds)
    if (source.runIds.some((runId) => !candidateRunIds.has(runId))) {
      throw preservationError(
        'WORKFLOW_WORK_ITEM_RUNS_TRUNCATED',
        `Candidate removed Run ownership from Workflow WorkItem ${source.id}`
      )
    }
  }
}

function workflowWorkItemOwnership(item: WorkflowWorkItemRecord): Record<string, unknown> {
  return {
    id: item.id,
    projectId: item.projectId,
    goalId: item.goalId,
    parentId: item.parentId,
    businessLineId: item.businessLineId,
    type: item.type,
    source: item.source,
    createdAt: item.createdAt,
    dueAt: item.dueAt
  }
}

function assertLegacySnapshotsPreserved(
  sourceBytes: Uint8Array,
  candidate: WorkflowLedgerDatabase
): void {
  const sourceSnapshots = parseLegacySnapshots(sourceBytes)
  const expected = legacySnapshotDigests(sourceSnapshots, 'LEGACY_JSON_INVALID')
  const actual = readCandidateSnapshotDigests(candidate)
  if (expected.size !== actual.size) {
    throw preservationError(
      'LEGACY_SNAPSHOT_COUNT_CHANGED',
      `Candidate contains ${actual.size} task snapshots; expected ${expected.size}`
    )
  }
  for (const [identity, expectedDigest] of expected) {
    const actualDigest = actual.get(identity)
    if (!actualDigest) {
      throw preservationError('LEGACY_SNAPSHOT_MISSING', `Candidate omitted legacy Snapshot ${identity}`)
    }
    if (actualDigest !== expectedDigest) {
      throw preservationError('LEGACY_SNAPSHOT_CHANGED', `Candidate changed legacy Snapshot ${identity}`)
    }
  }
  assertLegacyRunsPreserved(sourceSnapshots, candidate)
}

function assertLegacyRunsPreserved(
  snapshots: readonly TaskSnapshotRecord[],
  candidate: WorkflowLedgerDatabase
): void {
  const expected = new Map<string, string>()
  for (const snapshot of snapshots) {
    const run = snapshot.run
    if (!run) continue
    if (expected.has(run.id)) {
      throw preservationError('LEGACY_JSON_INVALID', `Legacy TaskRun identity ${run.id} is duplicated`)
    }
    expected.set(run.id, taskRunRowDigest(run.id, run.sessionId, run.updatedAt, run))
  }
  const actual = readCandidateTaskRunDigests(candidate)
  if (expected.size !== actual.size) {
    throw preservationError(
      'LEGACY_TASK_RUN_COUNT_CHANGED',
      `Candidate contains ${actual.size} task runs; expected ${expected.size}`
    )
  }
  for (const [id, expectedDigest] of expected) {
    const actualDigest = actual.get(id)
    if (!actualDigest) {
      throw preservationError('LEGACY_TASK_RUN_MISSING', `Candidate omitted legacy TaskRun ${id}`)
    }
    if (actualDigest !== expectedDigest) {
      throw preservationError('LEGACY_TASK_RUN_CHANGED', `Candidate changed legacy TaskRun ${id}`)
    }
  }
}

function readCandidateTaskRunDigests(db: WorkflowLedgerDatabase): Map<string, string> {
  if (!readUserTableNames(db).has('task_runs')) {
    throw preservationError('LEGACY_TASK_RUN_TABLE_MISSING', 'Candidate has no task_runs table')
  }
  const records = new Map<string, string>()
  const stmt = db.prepare('SELECT id, session_id, updated_at, payload FROM task_runs ORDER BY id')
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const id = requiredText(row.id, 'task_runs.id')
      const sessionId = requiredText(row.session_id, 'task_runs.session_id')
      const updatedAt = requiredNumber(row.updated_at, 'task_runs.updated_at')
      const run = parseCandidateTaskRun(row.payload, id)
      if (run.id !== id || run.sessionId !== sessionId || run.updatedAt !== updatedAt) {
        throw preservationError('LEGACY_TASK_RUN_SQL_MISMATCH', `TaskRun ${id} payload differs from SQL metadata`)
      }
      if (records.has(id)) {
        throw preservationError('LEGACY_TASK_RUN_DUPLICATED', `Candidate TaskRun identity ${id} is duplicated`)
      }
      records.set(id, taskRunRowDigest(id, sessionId, updatedAt, run))
    }
  } finally {
    stmt.free()
  }
  return records
}

function parseCandidateTaskRun(payload: unknown, id: string): TaskRunRecord {
  if (typeof payload !== 'string') {
    throw preservationError('LEGACY_TASK_RUN_PAYLOAD_INVALID', `Candidate TaskRun ${id} payload is not text`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch {
    throw preservationError('LEGACY_TASK_RUN_PAYLOAD_INVALID', `Candidate TaskRun ${id} payload is invalid JSON`)
  }
  if (!isTaskRunRecord(parsed)) {
    throw preservationError('LEGACY_TASK_RUN_PAYLOAD_INVALID', `Candidate TaskRun ${id} failed schema validation`)
  }
  return parsed
}

function taskRunRowDigest(
  id: string,
  sessionId: string,
  updatedAt: number,
  payload: TaskRunRecord
): string {
  return digest({ id, sessionId, updatedAt, payload })
}

function parseLegacySnapshots(sourceBytes: Uint8Array): TaskSnapshotRecord[] {
  validateLegacyJsonMigrationSource(sourceBytes)
  const parsed = JSON.parse(Buffer.from(sourceBytes).toString('utf8')) as unknown
  return (Array.isArray(parsed)
    ? parsed
    : (parsed as { snapshots: unknown[] }).snapshots) as TaskSnapshotRecord[]
}

function legacySnapshotDigests(
  snapshots: readonly TaskSnapshotRecord[],
  duplicateCode: string
): Map<string, string> {
  const records = new Map<string, string>()
  const sessions = new Set<string>()
  for (const snapshot of snapshots) {
    const identity = snapshotIdentity(snapshot.id, snapshot.sessionId)
    if (records.has(identity) || sessions.has(snapshot.sessionId)) {
      throw preservationError(duplicateCode, `Snapshot identity ${identity} is duplicated`)
    }
    sessions.add(snapshot.sessionId)
    records.set(identity, snapshotRowDigest(snapshot.id, snapshot.sessionId, snapshot.updatedAt, snapshot))
  }
  return records
}

function readCandidateSnapshotDigests(db: WorkflowLedgerDatabase): Map<string, string> {
  if (!readUserTableNames(db).has('task_snapshots')) {
    throw preservationError('LEGACY_SNAPSHOT_TABLE_MISSING', 'Candidate has no task_snapshots table')
  }
  const records = new Map<string, string>()
  const sessions = new Set<string>()
  const stmt = db.prepare('SELECT id, session_id, updated_at, payload FROM task_snapshots ORDER BY id')
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const id = requiredText(row.id, 'task_snapshots.id')
      const sessionId = requiredText(row.session_id, 'task_snapshots.session_id')
      const updatedAt = requiredNumber(row.updated_at, 'task_snapshots.updated_at')
      const snapshot = parseCandidateSnapshot(row.payload, id)
      if (snapshot.id !== id || snapshot.sessionId !== sessionId || snapshot.updatedAt !== updatedAt) {
        throw preservationError('LEGACY_SNAPSHOT_SQL_MISMATCH', `Snapshot ${id} payload differs from SQL metadata`)
      }
      const identity = snapshotIdentity(id, sessionId)
      if (records.has(identity) || sessions.has(sessionId)) {
        throw preservationError('LEGACY_SNAPSHOT_DUPLICATED', `Candidate Snapshot identity ${identity} is duplicated`)
      }
      sessions.add(sessionId)
      records.set(identity, snapshotRowDigest(id, sessionId, updatedAt, snapshot))
    }
  } finally {
    stmt.free()
  }
  return records
}

function parseCandidateSnapshot(payload: unknown, id: string): TaskSnapshotRecord {
  if (typeof payload !== 'string') {
    throw preservationError('LEGACY_SNAPSHOT_PAYLOAD_INVALID', `Candidate Snapshot ${id} payload is not text`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch {
    throw preservationError('LEGACY_SNAPSHOT_PAYLOAD_INVALID', `Candidate Snapshot ${id} payload is invalid JSON`)
  }
  if (!isTaskSnapshotRecord(parsed)) {
    throw preservationError('LEGACY_SNAPSHOT_PAYLOAD_INVALID', `Candidate Snapshot ${id} failed schema validation`)
  }
  return parsed
}

function snapshotRowDigest(
  id: string,
  sessionId: string,
  updatedAt: number,
  payload: TaskSnapshotRecord
): string {
  return digest({ id, sessionId, updatedAt, payload })
}

function snapshotIdentity(id: string, sessionId: string): string {
  return `${id}:${sessionId}`
}

async function openDatabase(
  bytes: Uint8Array,
  owner: 'SOURCE' | 'CANDIDATE'
): Promise<WorkflowLedgerDatabase> {
  try {
    return await openWorkflowLedgerDatabase(bytes)
  } catch (error) {
    throw preservationError(`${owner}_DATABASE_INVALID`, safeErrorMessage(error))
  }
}

function canonicalSqlValue(
  value: unknown,
  label: string
): string | number | null | { blobHex: string } {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value instanceof Uint8Array) return { blobHex: Buffer.from(value).toString('hex') }
  throw preservationError('SQL_VALUE_INVALID', `${label} has unsupported SQLite value type`)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  throw preservationError('SQL_METADATA_INVALID', `${label} is not text`)
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  throw preservationError('SQL_METADATA_INVALID', `${label} is neither text nor null`)
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw preservationError('SQL_METADATA_INVALID', `${label} is not an integer`)
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw preservationError('SQL_METADATA_INVALID', `${label} is not numeric`)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function preservationError(code: string, message: string): WorkflowLedgerMigrationError {
  return new WorkflowLedgerMigrationError(`MIGRATION_PRESERVATION_${code}`, message)
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
