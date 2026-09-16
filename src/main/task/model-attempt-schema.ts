import {
  assertModelAttemptTableContract,
  ModelAttemptLedgerError,
  modelAttemptCorruption,
  modelAttemptError,
  type ModelAttemptEventKind, type ModelAttemptEventRecord, type ModelAttemptOutcome,
  type ModelAttemptRecord, type ModelAttemptTerminalStatus, type ModelAttemptUsage
} from '../../shared/model-attempt-types'
import { canonicalJson, digest, GENESIS_DIGEST } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'

const ATTEMPTS_TABLE = 'model_attempts'
const EVENTS_TABLE = 'model_attempt_events'
const META_TABLE = 'model_attempt_meta'
const REQUIRED_ATTEMPT_COLUMNS = new Set([
  'id', 'start_command_id', 'run_id', 'request_id', 'step_id', 'project_id', 'goal_id',
  'work_item_id', 'ordinal', 'provider_id', 'model_id', 'protocol', 'adapter_version',
  'key_label', 'context_digest', 'route_reason', 'status', 'revision', 'started_at',
  'completed_at', 'latency_ms', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'cost_usd', 'outcome', 'error_class', 'failover_from_attempt_id',
  'start_payload_digest', 'completion_command_id', 'completion_payload_digest',
  'record_digest', 'payload'
])
const REQUIRED_EVENT_COLUMNS = new Set([
  'seq', 'event_id', 'command_id', 'attempt_id', 'run_id', 'kind', 'revision',
  'occurred_at', 'prev_digest', 'record_digest', 'payload'
])
const REQUIRED_META_COLUMNS = new Set(['id', 'initialized', 'attempt_count', 'event_count', 'last_seq', 'last_digest'])
const NOT_NULL_ATTEMPT_COLUMNS = new Set([
  'id', 'start_command_id', 'run_id', 'request_id', 'work_item_id', 'ordinal',
  'provider_id', 'model_id', 'protocol', 'adapter_version', 'context_digest',
  'route_reason', 'status', 'revision', 'started_at', 'start_payload_digest',
  'record_digest', 'payload'
])
const NOT_NULL_EVENT_COLUMNS = new Set([
  'seq', 'event_id', 'command_id', 'attempt_id', 'run_id', 'kind', 'revision',
  'occurred_at', 'prev_digest', 'record_digest', 'payload'
])
const NOT_NULL_META_COLUMNS = new Set(REQUIRED_META_COLUMNS)
const ATTEMPT_UNIQUE_CONTRACTS = [
  ['start_command_id'],
  ['failover_from_attempt_id'],
  ['completion_command_id'],
  ['run_id', 'request_id', 'ordinal']
] as const
const EVENT_UNIQUE_CONTRACTS = [['event_id'], ['command_id']] as const

export interface ModelAttemptCursorScope {
  runId?: string
  requestId?: string
  projectId?: string
  providerId?: string
  status?: string
}

export interface ModelAttemptCursor {
  v: 2
  runId: string
  requestId: string
  ordinal: number
  id: string
  scopeDigest: string
  headSeq: number
  headDigest: string
}

export interface ModelAttemptLedgerMeta {
  initialized: true
  attemptCount: number
  eventCount: number
  lastSeq: number
  lastDigest: string
}

export function encodeModelAttemptCursor(
  attempt: ModelAttemptRecord,
  scopeDigest: string,
  head: { lastSeq: number; lastDigest: string }
): string {
  const cursor: ModelAttemptCursor = {
    v: 2,
    runId: attempt.runId,
    requestId: attempt.requestId,
    ordinal: attempt.ordinal,
    id: attempt.id,
    scopeDigest: rawCursorDigest(scopeDigest, 'cursor scope digest'),
    headSeq: nonNegativeSafeIntegerColumn(head.lastSeq, 'cursor head seq'),
    headDigest: rawCursorDigest(head.lastDigest, 'cursor head digest')
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeModelAttemptCursor(
  value: unknown,
  expected: { scopeDigest: string; lastSeq: number; lastDigest: string }
): ModelAttemptCursor {
  if (typeof value !== 'string' || !value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'query cursor is invalid')
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cursor is not an object')
    const record = parsed as Record<string, unknown>
    if (record.v !== 2 ||
        Object.keys(record).sort().join(',') !== 'headDigest,headSeq,id,ordinal,requestId,runId,scopeDigest,v') {
      throw new Error('cursor schema is invalid')
    }
    const cursor: ModelAttemptCursor = {
      v: 2,
      runId: cursorId(record.runId, 'cursor run id'),
      requestId: cursorId(record.requestId, 'cursor request id'),
      ordinal: cursorOrdinal(record.ordinal),
      id: cursorId(record.id, 'cursor attempt id'),
      scopeDigest: rawCursorDigest(record.scopeDigest, 'cursor scope digest'),
      headSeq: cursorHeadSeq(record.headSeq),
      headDigest: rawCursorDigest(record.headDigest, 'cursor head digest')
    }
    assertCursorScopeAndHead(cursor, expected)
    return cursor
  } catch (error) {
    if (error instanceof ModelAttemptLedgerError) throw error
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'query cursor cannot be decoded')
  }
}

function assertCursorScopeAndHead(
  cursor: ModelAttemptCursor,
  expected: { scopeDigest: string; lastSeq: number; lastDigest: string }
): void {
  if (cursor.scopeDigest !== expected.scopeDigest) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'query cursor does not match normalized filter scope')
  }
  if (cursor.headSeq !== expected.lastSeq || cursor.headDigest !== expected.lastDigest) {
    throw modelAttemptError('MODEL_ATTEMPT_CURSOR_STALE', 'query cursor ledger head has changed; restart pagination')
  }
}

export function modelAttemptQueryScopeDigest(scope: ModelAttemptCursorScope): string {
  return digest({
    runId: scope.runId ?? null,
    requestId: scope.requestId ?? null,
    projectId: scope.projectId ?? null,
    providerId: scope.providerId ?? null,
    status: scope.status ?? null
  })
}

export function compareModelAttemptToCursor(
  attempt: ModelAttemptRecord,
  cursor: ModelAttemptCursor
): number {
  for (const [left, right] of [[attempt.runId, cursor.runId], [attempt.requestId, cursor.requestId]] as const) {
    if (left < right) return -1
    if (left > right) return 1
  }
  if (attempt.ordinal !== cursor.ordinal) return attempt.ordinal - cursor.ordinal
  if (attempt.id < cursor.id) return -1
  if (attempt.id > cursor.id) return 1
  return 0
}

export function setupModelAttemptSchema(db: WorkflowLedgerDatabase): void {
  const existed = assertModelAttemptSchemaState(db, true)
  enableAndVerifyForeignKeys(db)
  db.run(`
    CREATE TABLE IF NOT EXISTS ${ATTEMPTS_TABLE} (
      id TEXT PRIMARY KEY,
      start_command_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      step_id TEXT,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      key_label TEXT,
      context_digest TEXT NOT NULL,
      route_reason TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_usd REAL,
      outcome TEXT,
      error_class TEXT,
      failover_from_attempt_id TEXT UNIQUE,
      start_payload_digest TEXT NOT NULL,
      completion_command_id TEXT UNIQUE,
      completion_payload_digest TEXT,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(run_id, request_id, ordinal),
      FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE RESTRICT,
      FOREIGN KEY(failover_from_attempt_id) REFERENCES model_attempts(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
      seq INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      prev_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY(attempt_id) REFERENCES model_attempts(id) ON DELETE RESTRICT,
      FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      initialized INTEGER NOT NULL CHECK(initialized = 1),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      event_count INTEGER NOT NULL CHECK(event_count >= 0),
      last_seq INTEGER NOT NULL CHECK(last_seq >= 0),
      last_digest TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_attempts_run ON ${ATTEMPTS_TABLE}(run_id, request_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_model_attempts_project ON ${ATTEMPTS_TABLE}(project_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_model_attempt_events_attempt ON ${EVENTS_TABLE}(attempt_id, seq);
    CREATE INDEX IF NOT EXISTS idx_model_attempt_events_run ON ${EVENTS_TABLE}(run_id, seq);
  `)
  assertModelAttemptSchemaState(db, false)
  if (!existed) initializeModelAttemptLedgerMeta(db)
  readModelAttemptLedgerMeta(db)
  enableAndVerifyForeignKeys(db)
}

export function readModelAttemptLedgerMeta(db: WorkflowLedgerDatabase): ModelAttemptLedgerMeta {
  const rows: Array<Record<string, unknown>> = []
  const stmt = db.prepare(`SELECT * FROM ${META_TABLE} ORDER BY id ASC`)
  try {
    while (stmt.step()) rows.push(stmt.getAsObject())
  } finally {
    stmt.free()
  }
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].initialized !== 1) {
    modelAttemptCorruption('ModelAttempt ledger meta marker is missing or invalid')
  }
  const attemptCount = nonNegativeSafeIntegerColumn(rows[0].attempt_count, 'meta attempt count')
  const eventCount = nonNegativeSafeIntegerColumn(rows[0].event_count, 'meta event count')
  const lastSeq = nonNegativeSafeIntegerColumn(rows[0].last_seq, 'meta last seq')
  const lastDigest = rawStoredDigest(rows[0].last_digest, 'meta last digest')
  if (lastSeq !== eventCount || (lastSeq === 0 && lastDigest !== GENESIS_DIGEST)) {
    modelAttemptCorruption('ModelAttempt ledger meta count/head relationship is invalid')
  }
  return { initialized: true, attemptCount, eventCount, lastSeq, lastDigest }
}

export function updateModelAttemptLedgerMeta(
  db: WorkflowLedgerDatabase,
  expected: ModelAttemptLedgerMeta,
  next: Omit<ModelAttemptLedgerMeta, 'initialized'>
): void {
  assertModelAttemptMetaTransition(expected, next)
  db.run(
    `UPDATE ${META_TABLE} SET
       attempt_count = ?, event_count = ?, last_seq = ?, last_digest = ?
     WHERE id = 1 AND initialized = 1 AND attempt_count = ? AND event_count = ?
       AND last_seq = ? AND last_digest = ?`,
    [
      next.attemptCount, next.eventCount, next.lastSeq, next.lastDigest,
      expected.attemptCount, expected.eventCount, expected.lastSeq, expected.lastDigest
    ]
  )
  if (db.getRowsModified() !== 1) {
    modelAttemptCorruption('ModelAttempt ledger meta CAS update failed')
  }
}

function initializeModelAttemptLedgerMeta(db: WorkflowLedgerDatabase): void {
  db.run(
    `INSERT INTO ${META_TABLE}(
       id, initialized, attempt_count, event_count, last_seq, last_digest
     ) VALUES (1, 1, 0, 0, 0, ?)`,
    [GENESIS_DIGEST]
  )
}

function assertModelAttemptMetaTransition(
  expected: ModelAttemptLedgerMeta,
  next: Omit<ModelAttemptLedgerMeta, 'initialized'>
): void {
  const attemptDelta = next.attemptCount - expected.attemptCount
  if ((attemptDelta !== 0 && attemptDelta !== 1) || next.eventCount !== expected.eventCount + 1 ||
      next.lastSeq !== expected.lastSeq + 1 || next.lastSeq !== next.eventCount ||
      !/^[0-9a-f]{64}$/.test(next.lastDigest)) {
    modelAttemptCorruption('ModelAttempt ledger meta transition is invalid')
  }
}

export function insertModelAttempt(db: WorkflowLedgerDatabase, attempt: ModelAttemptRecord): void {
  db.run(
    `INSERT INTO ${ATTEMPTS_TABLE}(
       id, start_command_id, run_id, request_id, step_id, project_id, goal_id, work_item_id, ordinal,
       provider_id, model_id, protocol, adapter_version, key_label, context_digest,
       route_reason, status, revision, started_at, completed_at, latency_ms,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
       outcome, error_class, failover_from_attempt_id, start_payload_digest,
       completion_command_id, completion_payload_digest, record_digest, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    attemptSqlValues(attempt)
  )
}

export function updateModelAttempt(
  db: WorkflowLedgerDatabase,
  attempt: ModelAttemptRecord,
  expectedRevision: number
): void {
  const values = attemptSqlValues(attempt)
  db.run(
    `UPDATE ${ATTEMPTS_TABLE} SET
       start_command_id = ?, run_id = ?, request_id = ?, step_id = ?, project_id = ?, goal_id = ?, work_item_id = ?, ordinal = ?,
       provider_id = ?, model_id = ?, protocol = ?, adapter_version = ?, key_label = ?, context_digest = ?,
       route_reason = ?, status = ?, revision = ?, started_at = ?, completed_at = ?, latency_ms = ?,
       input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?,
       outcome = ?, error_class = ?, failover_from_attempt_id = ?, start_payload_digest = ?,
       completion_command_id = ?, completion_payload_digest = ?, record_digest = ?, payload = ?
     WHERE id = ? AND revision = ?`,
    [...values.slice(1), attempt.id, expectedRevision]
  )
  if (db.getRowsModified() !== 1) {
    throw modelAttemptError('MODEL_ATTEMPT_REVISION_CONFLICT', `Attempt ${attempt.id} CAS update failed`)
  }
}

export function appendModelAttemptEvent(
  db: WorkflowLedgerDatabase,
  input: {
    commandId: string
    attempt: ModelAttemptRecord
    kind: ModelAttemptEventKind
    occurredAt: number
    inputDigest: string
  }
): ModelAttemptEventRecord {
  const events = readModelAttemptEvents(db)
  const previous = events.at(-1)
  const seq = (previous?.seq ?? 0) + 1
  const eventId = `model-attempt:${input.attempt.id}:revision:${input.attempt.revision}`
  const payload = modelAttemptEventPayload(input.attempt, input.inputDigest)
  const withoutDigest = {
    schemaVersion: 1 as const,
    seq,
    eventId,
    commandId: input.commandId,
    attemptId: input.attempt.id,
    runId: input.attempt.runId,
    kind: input.kind,
    revision: input.attempt.revision,
    occurredAt: input.occurredAt,
    prevDigest: previous?.digest ?? GENESIS_DIGEST,
    payload
  }
  const event: ModelAttemptEventRecord = { ...withoutDigest, digest: digest(withoutDigest) }
  db.run(
    `INSERT INTO ${EVENTS_TABLE}(
       seq, event_id, command_id, attempt_id, run_id, kind, revision,
       occurred_at, prev_digest, record_digest, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.seq, event.eventId, event.commandId, event.attemptId, event.runId,
      event.kind, event.revision, event.occurredAt, event.prevDigest, event.digest,
      canonicalJson(event.payload)
    ]
  )
  return event
}

export function modelAttemptEventPayload(
  attempt: ModelAttemptRecord,
  inputDigest: string
): Record<string, unknown> {
  return {
    attemptRecordDigest: attempt.recordDigest,
    inputDigest,
    ordinal: attempt.ordinal,
    requestId: attempt.requestId,
    stepId: attempt.stepId,
    status: attempt.status,
    providerId: attempt.providerId,
    model: attempt.model,
    protocol: attempt.protocol,
    adapterVersion: attempt.adapterVersion,
    ...(attempt.executorReceipt ? { executorReceipt: attempt.executorReceipt } : {}),
    contextDigest: attempt.contextDigest,
    routeReason: attempt.routeReason,
    projectId: attempt.projectId,
    goalId: attempt.goalId,
    workItemId: attempt.workItemId,
    failoverFromAttemptId: attempt.failoverFromAttemptId,
    completedAt: attempt.completedAt,
    latencyMs: attempt.latencyMs,
    usage: attempt.usage,
    costUsd: attempt.costUsd,
    outcome: attempt.outcome,
    errorClass: attempt.errorClass
  }
}

export function deriveModelAttemptNext(
  record: ModelAttemptRecord,
  attempts: readonly ModelAttemptRecord[]
): ModelAttemptRecord {
  const next = attempts.find((attempt) => attempt.failoverFromAttemptId === record.id)
  return next ? { ...record, nextAttemptId: next.id } : record
}

export function modelAttemptWithoutDerived(
  attempt: ModelAttemptRecord
): Omit<ModelAttemptRecord, 'nextAttemptId' | 'recordDigest'> {
  const { nextAttemptId: _next, recordDigest: _digest, ...record } = attempt
  return record
}

export function modelAttemptStartRecordVersion(attempt: ModelAttemptRecord): ModelAttemptRecord {
  const start = {
    ...modelAttemptWithoutDerived(attempt),
    status: 'started' as const,
    revision: 1
  } as Record<string, unknown>
  for (const field of [
    'completedAt', 'latencyMs', 'usage', 'costUsd', 'outcome', 'errorClass',
    'completionCommandId', 'completionPayloadDigest'
  ]) delete start[field]
  return { ...start, recordDigest: digest(start) } as unknown as ModelAttemptRecord
}

export function validateModelAttemptTerminalOutcome(
  record: Pick<ModelAttemptRecord, 'errorClass'>, status: ModelAttemptTerminalStatus, outcome: ModelAttemptOutcome
): void {
  const runtimeUnknown = record.errorClass === 'runtime_result_unknown'
  if ((outcome === 'unknown') !== runtimeUnknown || (runtimeUnknown && status !== 'failed'))
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'unknown outcome requires runtime-result reconciliation')
  if (status === 'succeeded' && (outcome !== 'success' || record.errorClass !== undefined)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'succeeded state has invalid outcome/error')
  }
  if (status === 'failed' && (outcome === 'success' || outcome === 'cancelled' || !record.errorClass)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'failed state has invalid outcome/error')
  }
  if (status === 'cancelled' && outcome !== 'cancelled') {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'cancelled state has invalid outcome')
  }
}
export function readRawModelAttempts(db: WorkflowLedgerDatabase): ModelAttemptRecord[] {
  if (!modelAttemptSchemaExists(db)) return []
  const attempts: ModelAttemptRecord[] = []
  const stmt = db.prepare(`SELECT * FROM ${ATTEMPTS_TABLE} ORDER BY run_id ASC, request_id ASC, ordinal ASC, id ASC`)
  try {
    while (stmt.step()) attempts.push(decodeAttemptRow(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  return attempts
}

export function readModelAttemptEvents(db: WorkflowLedgerDatabase): ModelAttemptEventRecord[] {
  if (!modelAttemptSchemaExists(db)) return []
  const events: ModelAttemptEventRecord[] = []
  const stmt = db.prepare(`SELECT * FROM ${EVENTS_TABLE} ORDER BY seq ASC`)
  let expectedSeq = 1
  let previousDigest = GENESIS_DIGEST
  try {
    while (stmt.step()) {
      const event = decodeEventRow(stmt.getAsObject())
      if (event.seq !== expectedSeq || event.prevDigest !== previousDigest) {
        modelAttemptCorruption(`Attempt event chain breaks at seq ${event.seq}`)
      }
      events.push(event)
      expectedSeq += 1
      previousDigest = event.digest
    }
  } finally {
    stmt.free()
  }
  return events
}

export function findRawModelAttempt(
  db: WorkflowLedgerDatabase,
  id: string
): ModelAttemptRecord | null {
  return readRawModelAttempts(db).find((attempt) => attempt.id === id) ?? null
}

export function findModelAttemptEventByCommand(
  db: WorkflowLedgerDatabase,
  commandId: string
): ModelAttemptEventRecord | null {
  return readModelAttemptEvents(db).find((event) => event.commandId === commandId) ?? null
}

export function modelAttemptSchemaExists(db: WorkflowLedgerDatabase): boolean {
  const exists = assertModelAttemptSchemaState(db, true)
  if (exists) enableAndVerifyForeignKeys(db)
  return exists
}

function attemptSqlValues(attempt: ModelAttemptRecord): Array<string | number | null> {
  const usage: Partial<ModelAttemptUsage> = attempt.usage ?? {}
  return [
    attempt.id,
    attempt.startCommandId,
    attempt.runId,
    attempt.requestId,
    nullableSql(attempt.stepId),
    nullableSql(attempt.projectId),
    nullableSql(attempt.goalId),
    attempt.workItemId,
    attempt.ordinal,
    attempt.providerId,
    attempt.model,
    attempt.protocol,
    attempt.adapterVersion,
    nullableSql(attempt.keyLabel),
    attempt.contextDigest,
    attempt.routeReason,
    attempt.status,
    attempt.revision,
    attempt.startedAt,
    nullableSql(attempt.completedAt),
    nullableSql(attempt.latencyMs),
    nullableSql(usage.inputTokens),
    nullableSql(usage.outputTokens),
    nullableSql(usage.cacheReadTokens),
    nullableSql(usage.cacheWriteTokens),
    nullableSql(attempt.costUsd),
    nullableSql(attempt.outcome),
    nullableSql(attempt.errorClass),
    nullableSql(attempt.failoverFromAttemptId),
    attempt.startPayloadDigest,
    nullableSql(attempt.completionCommandId),
    nullableSql(attempt.completionPayloadDigest),
    attempt.recordDigest,
    canonicalJson(attempt)
  ]
}

function nullableSql(value: string | number | undefined): string | number | null {
  return value === undefined ? null : value
}

function decodeAttemptRow(row: Record<string, unknown>): ModelAttemptRecord {
  const parsed = parseObject(row.payload, 'Attempt payload')
  if (row.payload !== canonicalJson(parsed)) modelAttemptCorruption('Attempt payload JSON is not canonical')
  if (parsed.schemaVersion !== 1 || typeof parsed.id !== 'string') {
    modelAttemptCorruption('Attempt payload shape is invalid')
  }
  const record = parsed as unknown as ModelAttemptRecord
  const columns: Array<[unknown, unknown, string]> = [
    [row.id, record.id, 'id'],
    [row.start_command_id, record.startCommandId, 'start command'],
    [row.run_id, record.runId, 'run'],
    [row.request_id, record.requestId, 'request'],
    [nullableText(row.step_id), record.stepId, 'step'],
    [nullableText(row.project_id), record.projectId, 'project'],
    [nullableText(row.goal_id), record.goalId, 'goal'],
    [row.work_item_id, record.workItemId, 'work item'],
    [row.ordinal, record.ordinal, 'ordinal'],
    [row.provider_id, record.providerId, 'provider'],
    [row.model_id, record.model, 'model'],
    [row.protocol, record.protocol, 'protocol'],
    [row.adapter_version, record.adapterVersion, 'adapter version'],
    [nullableText(row.key_label), record.keyLabel, 'key label'],
    [row.context_digest, record.contextDigest, 'context digest'],
    [row.route_reason, record.routeReason, 'route reason'],
    [row.status, record.status, 'status'],
    [row.revision, record.revision, 'revision'],
    [row.started_at, record.startedAt, 'startedAt'],
    [nullableNumber(row.completed_at), record.completedAt, 'completedAt'],
    [nullableNumber(row.latency_ms), record.latencyMs, 'latency'],
    [nullableNumber(row.cost_usd), record.costUsd, 'cost'],
    [nullableText(row.outcome), record.outcome, 'outcome'],
    [nullableText(row.error_class), record.errorClass, 'error class'],
    [nullableText(row.failover_from_attempt_id), record.failoverFromAttemptId, 'failover source'],
    [row.start_payload_digest, record.startPayloadDigest, 'start payload digest'],
    [nullableText(row.completion_command_id), record.completionCommandId, 'completion command'],
    [nullableText(row.completion_payload_digest), record.completionPayloadDigest, 'completion payload digest'],
    [row.record_digest, record.recordDigest, 'record digest']
  ]
  for (const [column, payload, label] of columns) {
    if (column !== payload) modelAttemptCorruption(`Attempt ${record.id} ${label} column differs from payload`)
  }
  const usage = usageFromRow(row)
  if (canonicalJson(usage) !== canonicalJson(record.usage)) {
    modelAttemptCorruption(`Attempt ${record.id} usage columns differ from payload`)
  }
  return record
}

function decodeEventRow(row: Record<string, unknown>): ModelAttemptEventRecord {
  const payload = parseObject(row.payload, 'Attempt event payload')
  if (row.payload !== canonicalJson(payload)) modelAttemptCorruption('Attempt event payload JSON is not canonical')
  const withoutDigest = {
    schemaVersion: 1 as const,
    seq: positiveIntegerColumn(row.seq, 'event seq'),
    eventId: rowText(row.event_id, 'event id'),
    commandId: rowText(row.command_id, 'event command id'),
    attemptId: rowText(row.attempt_id, 'event attempt id'),
    runId: rowText(row.run_id, 'event run id'),
    kind: eventKind(row.kind),
    revision: positiveIntegerColumn(row.revision, 'event revision'),
    occurredAt: timestampColumn(row.occurred_at, 'event occurredAt'),
    prevDigest: rowText(row.prev_digest, 'event prev digest'),
    payload
  }
  const record: ModelAttemptEventRecord = {
    ...withoutDigest,
    digest: rowText(row.record_digest, 'event record digest')
  }
  if (record.digest !== digest(withoutDigest)) {
    modelAttemptCorruption(`Attempt event ${record.eventId} digest mismatch`)
  }
  return record
}

function usageFromRow(row: Record<string, unknown>): ModelAttemptUsage | undefined {
  const inputTokens = nullableNumber(row.input_tokens)
  const outputTokens = nullableNumber(row.output_tokens)
  const cacheReadTokens = nullableNumber(row.cache_read_tokens)
  const cacheWriteTokens = nullableNumber(row.cache_write_tokens)
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every((value) => value === undefined)) return undefined
  if (inputTokens === undefined || outputTokens === undefined) {
    modelAttemptCorruption('Attempt usage columns are incomplete')
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function eventKind(value: unknown): ModelAttemptEventKind {
  if (value === 'model_attempt.started' || value === 'model_attempt.succeeded' ||
      value === 'model_attempt.failed' || value === 'model_attempt.cancelled') return value
  modelAttemptCorruption('Attempt event kind is invalid')
}

function assertModelAttemptSchemaState(
  db: WorkflowLedgerDatabase,
  allowAbsent: boolean
): boolean {
  const attemptsExist = tableExists(db, ATTEMPTS_TABLE)
  const eventsExist = tableExists(db, EVENTS_TABLE)
  const metaExists = tableExists(db, META_TABLE)
  if (!attemptsExist && !eventsExist && !metaExists) {
    if (allowAbsent) return false
    modelAttemptCorruption('ModelAttempt schema creation did not create all three tables')
  }
  if (!attemptsExist || !eventsExist || !metaExists) {
    modelAttemptCorruption('ModelAttempt schema is partial; Attempt, event, and meta tables are required')
  }
  assertModelAttemptTableContract(db, {
    table: ATTEMPTS_TABLE,
    columns: REQUIRED_ATTEMPT_COLUMNS,
    notNull: NOT_NULL_ATTEMPT_COLUMNS,
    primaryKey: ['id'],
    unique: ATTEMPT_UNIQUE_CONTRACTS,
    foreignKeys: [
      foreignKey('run_id', 'workflow_runs', 'id'),
      foreignKey('failover_from_attempt_id', ATTEMPTS_TABLE, 'id')
    ]
  })
  assertModelAttemptTableContract(db, {
    table: EVENTS_TABLE,
    columns: REQUIRED_EVENT_COLUMNS,
    notNull: NOT_NULL_EVENT_COLUMNS,
    primaryKey: ['seq'],
    unique: EVENT_UNIQUE_CONTRACTS,
    foreignKeys: [
      foreignKey('attempt_id', ATTEMPTS_TABLE, 'id'),
      foreignKey('run_id', 'workflow_runs', 'id')
    ]
  })
  assertModelAttemptTableContract(db, {
    table: META_TABLE,
    columns: REQUIRED_META_COLUMNS,
    notNull: NOT_NULL_META_COLUMNS,
    primaryKey: ['id'],
    unique: [],
    foreignKeys: []
  })
  return true
}

function tableExists(db: WorkflowLedgerDatabase, table: string): boolean {
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
  try {
    stmt.bind([table])
    return stmt.step()
  } finally {
    stmt.free()
  }
}

function foreignKey(from: string, table: string, to: string): string {
  return `${from}->${table}.${to}|NO ACTION|RESTRICT`
}

function enableAndVerifyForeignKeys(db: WorkflowLedgerDatabase): void {
  db.run('PRAGMA foreign_keys = ON')
  const enabled = db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]
  if (enabled !== 1) modelAttemptCorruption('ModelAttempt database connection did not enable foreign keys')
  const violations = db.exec('PRAGMA foreign_key_check')
  if (violations.some((result) => result.values.length > 0)) {
    modelAttemptCorruption('ModelAttempt database contains foreign-key violations')
  }
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') modelAttemptCorruption(`${label} is not text`)
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    return parsed as Record<string, unknown>
  } catch {
    modelAttemptCorruption(`${label} is not valid JSON`)
  }
}

function rowText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) modelAttemptCorruption(`${label} column is invalid`)
  return value
}

function nullableText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') modelAttemptCorruption('nullable text column is invalid')
  return value
}

function nullableNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    modelAttemptCorruption('nullable number column is invalid')
  }
  return value
}

function positiveIntegerColumn(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    modelAttemptCorruption(`${label} column is invalid`)
  }
  return value
}

function nonNegativeSafeIntegerColumn(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    modelAttemptCorruption(`${label} column is invalid`)
  }
  return value
}

function timestampColumn(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    modelAttemptCorruption(`${label} column is invalid`)
  }
  return value
}

function cursorId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /\s|[\u0000-\u001f\u007f]/.test(value)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} is invalid`)
  }
  return value
}

function cursorOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'cursor ordinal is invalid')
  }
  return value
}

function cursorHeadSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'cursor head seq is invalid')
  }
  return value
}

function rawCursorDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} is invalid`)
  }
  return value
}

function rawStoredDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    modelAttemptCorruption(`${label} is invalid`)
  }
  return value
}
