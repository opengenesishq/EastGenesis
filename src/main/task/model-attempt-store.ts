import {
  attemptStatus,
  defaultOutcome,
  isRetryAuthorizedModelAttempt,
  modelAttemptCorruption,
  modelAttemptError,
  modelAttemptOutcome,
  normalizeModelAttemptUsage as normalizeUsage,
  nonNegativeInteger as nonNegativeSafeInteger,
  optionalId,
  optionalNonNegativeNumber,
  positiveInteger,
  rawDigest,
  requiredId,
  safeErrorClass,
  safeKeyLabel,
  safeReason,
  safeText,
  sha256Digest,
  terminalStatus,
  timestamp,
  type ModelAttemptCompleteInput, type ModelAttemptEventKind, type ModelAttemptEventRecord,
  type ModelAttemptLedgerVerification, type ModelAttemptOutcome, type ModelAttemptQuery,
  type ModelAttemptRecord, type ModelAttemptSelection, type ModelAttemptStartInput,
  type ModelAttemptTerminalStatus
} from '../../shared/model-attempt-types'
import type { TaskRunStatus } from '../../shared/types'
import { canonicalJson, digest, GENESIS_DIGEST } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { normalizeModelExecutorReceipt } from './model-attempt-executor'
import {
  appendModelAttemptEvent,
  compareModelAttemptToCursor,
  decodeModelAttemptCursor,
  deriveModelAttemptNext,
  encodeModelAttemptCursor,
  findModelAttemptEventByCommand,
  findRawModelAttempt,
  insertModelAttempt,
  modelAttemptEventPayload,
  modelAttemptQueryScopeDigest,
  modelAttemptStartRecordVersion,
  modelAttemptWithoutDerived,
  modelAttemptSchemaExists,
  readModelAttemptLedgerMeta,
  readModelAttemptEvents,
  readRawModelAttempts,
  setupModelAttemptSchema,
  updateModelAttemptLedgerMeta,
  updateModelAttempt,
  validateModelAttemptTerminalOutcome,
  type ModelAttemptCursor,
  type ModelAttemptLedgerMeta
} from './model-attempt-schema'

const MAX_QUERY_LIMIT = 500
const RECONCILIATION_COMPLETION = Symbol('model-attempt-reconciliation-completion')
const TASK_RUN_STATUSES = new Set<TaskRunStatus>([
  'queued', 'planning', 'executing', 'waiting_approval', 'waiting_reconciliation',
  'verifying', 'recovering', 'completed', 'failed', 'cancelled'
])
const TERMINAL_RUN_STATUSES = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled'])
const MODEL_ATTEMPT_RECORD_FIELDS = new Set([
  'schemaVersion', 'id', 'runId', 'requestId', 'stepId', 'projectId', 'goalId',
  'workItemId', 'ordinal', 'providerId', 'model', 'protocol', 'adapterVersion', 'executorReceipt',
  'contextDigest', 'routeReason', 'keyLabel', 'status', 'revision', 'startedAt',
  'completedAt', 'latencyMs', 'usage', 'costUsd', 'outcome', 'errorClass',
  'failoverFromAttemptId', 'startCommandId', 'startPayloadDigest',
  'completionCommandId', 'completionPayloadDigest', 'recordDigest'
])
interface CanonicalRunOwner {
  id: string
  status: TaskRunStatus
  projectId?: string
  goalId?: string
  workItemId: string
}
interface NormalizedStart extends ModelAttemptStartInput {
  startedAt: number
  startPayloadDigest: string
}
interface NormalizedComplete extends ModelAttemptCompleteInput {
  completedAt: number
  outcome: ModelAttemptOutcome
  completionPayloadDigest: string
}
interface NormalizedQuery extends Omit<ModelAttemptQuery, 'limit' | 'cursor'> {
  limit: number
  scopeDigest: string
  cursor?: ModelAttemptCursor
}
export function startModelAttempt(db: WorkflowLedgerDatabase, input: ModelAttemptStartInput): ModelAttemptRecord {
  setupModelAttemptSchema(db)
  const ledger = verifyModelAttemptLedger(db)
  const normalized = normalizeStartInput(input)
  const commandEvent = findModelAttemptEventByCommand(db, normalized.commandId)
  if (commandEvent) return resolveIdempotentStart(db, normalized, commandEvent)
  const byId = findRawModelAttempt(db, normalized.id)
  if (byId) {
    throw modelAttemptError('MODEL_ATTEMPT_ID_CONFLICT', `Attempt id ${normalized.id} already exists with different command or payload`)
  }
  const owner = requireCanonicalRun(db, normalized.runId)
  if (TERMINAL_RUN_STATUSES.has(owner.status)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_TRANSITION', `Canonical Run ${owner.id} is terminal`)
  }
  assertOwnershipClaims(normalized, owner)
  const attempts = readRawModelAttempts(db).filter(
    (attempt) => attempt.runId === owner.id && attempt.requestId === normalized.requestId
  )
  if (owner.status === 'waiting_reconciliation') {
    const authorization = attempts.find((attempt) => attempt.id === normalized.failoverFromAttemptId)
    if (!authorization || authorization.stepId !== normalized.stepId || !isRetryAuthorizedModelAttempt(authorization) || attempts.some((attempt) => attempt.failoverFromAttemptId === authorization.id))
      throw modelAttemptError('MODEL_ATTEMPT_RECONCILIATION_REQUIRED', `Canonical Run ${owner.id} requires an explicit retry authorization`)
  }
  const ordinal = attempts.length + 1
  assertRequestOrdinals(owner.id, normalized.requestId, attempts)
  assertFailoverSource(db, normalized.failoverFromAttemptId, owner, ordinal, normalized.startedAt, attempts)

  const withoutDigest = {
    schemaVersion: 1 as const,
    id: normalized.id,
    runId: owner.id,
    requestId: normalized.requestId,
    stepId: normalized.stepId,
    projectId: owner.projectId,
    goalId: owner.goalId,
    workItemId: owner.workItemId,
    ordinal,
    providerId: normalized.providerId,
    model: normalized.model,
    protocol: normalized.protocol,
    adapterVersion: normalized.adapterVersion,
    ...(normalized.executorReceipt ? { executorReceipt: normalized.executorReceipt } : {}),
    contextDigest: normalized.contextDigest,
    routeReason: normalized.routeReason,
    keyLabel: normalized.keyLabel,
    status: 'started' as const,
    revision: 1,
    startedAt: normalized.startedAt,
    failoverFromAttemptId: normalized.failoverFromAttemptId,
    startCommandId: normalized.commandId,
    startPayloadDigest: normalized.startPayloadDigest
  }
  const record: ModelAttemptRecord = { ...withoutDigest, recordDigest: digest(withoutDigest) }
  withModelAttemptTransaction(db, () => {
    insertModelAttempt(db, record)
    const event = appendModelAttemptEvent(db, {
      commandId: normalized.commandId,
      attempt: record,
      kind: 'model_attempt.started',
      occurredAt: record.startedAt,
      inputDigest: normalized.startPayloadDigest
    })
    advanceModelAttemptMeta(db, ledgerMeta(ledger), event, 1)
  })
  return deriveModelAttemptNext(record, readRawModelAttempts(db))
}

export function completeModelAttempt(
  db: WorkflowLedgerDatabase, attemptId: string, input: ModelAttemptCompleteInput, capability?: unknown
): ModelAttemptRecord {
  setupModelAttemptSchema(db)
  const ledger = verifyModelAttemptLedger(db)
  const id = requiredId(attemptId, 'attempt id')
  const normalized = normalizeCompleteInput(input)
  assertTerminalSemantics(normalized, capability === RECONCILIATION_COMPLETION)
  const commandEvent = findModelAttemptEventByCommand(db, normalized.commandId)
  if (commandEvent) return resolveIdempotentCompletion(db, id, normalized, commandEvent)
  const current = findRawModelAttempt(db, id)
  if (!current) throw modelAttemptError('MODEL_ATTEMPT_NOT_FOUND', `Attempt ${id} does not exist`)
  if (current.revision !== normalized.expectedRevision) {
    throw modelAttemptError(
      'MODEL_ATTEMPT_REVISION_CONFLICT',
      `Attempt ${id} revision is ${current.revision}, expected ${normalized.expectedRevision}`
    )
  }
  if (current.status !== 'started' || current.revision !== 1) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_TRANSITION', `Attempt ${id} cannot transition from ${current.status}`)
  }
  if (normalized.completedAt < current.startedAt) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'completedAt cannot precede startedAt')
  }
  const withoutDigest = {
    ...modelAttemptWithoutDerived(current),
    status: normalized.status,
    revision: 2,
    completedAt: normalized.completedAt,
    latencyMs: normalized.completedAt - current.startedAt,
    usage: normalized.usage,
    costUsd: normalized.costUsd,
    outcome: normalized.outcome,
    errorClass: normalized.errorClass,
    completionCommandId: normalized.commandId,
    completionPayloadDigest: normalized.completionPayloadDigest
  }
  const next: ModelAttemptRecord = { ...withoutDigest, recordDigest: digest(withoutDigest) }
  withModelAttemptTransaction(db, () => {
    updateModelAttempt(db, next, normalized.expectedRevision)
    const event = appendModelAttemptEvent(db, {
      commandId: normalized.commandId,
      attempt: next,
      kind: eventKindForStatus(normalized.status),
      occurredAt: normalized.completedAt,
      inputDigest: normalized.completionPayloadDigest
    })
    advanceModelAttemptMeta(db, ledgerMeta(ledger), event, 0)
  })
  return deriveModelAttemptNext(next, readRawModelAttempts(db))
}

export function completeReconciledModelAttempt(
  db: WorkflowLedgerDatabase, attemptId: string, input: ModelAttemptCompleteInput
): ModelAttemptRecord { return completeModelAttempt(db, attemptId, input, RECONCILIATION_COMPLETION) }

export function getModelAttempt(db: WorkflowLedgerDatabase, attemptId: string): ModelAttemptRecord | null {
  if (!modelAttemptSchemaExists(db)) return null
  verifyModelAttemptLedger(db)
  const attempts = readRawModelAttempts(db)
  const record = attempts.find((attempt) => attempt.id === requiredId(attemptId, 'attempt id'))
  return record ? deriveModelAttemptNext(record, attempts) : null
}
export function selectModelAttempts(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptQuery = {}
): ModelAttemptSelection {
  if (!modelAttemptSchemaExists(db)) {
    return { attempts: [], events: [], total: 0, hasMore: false }
  }
  const ledger = verifyModelAttemptLedger(db)
  const normalized = normalizeQuery(query, ledger)
  const allAttempts = readRawModelAttempts(db)
  const filtered = allAttempts.filter((attempt) =>
    (!normalized.runId || attempt.runId === normalized.runId) &&
    (!normalized.requestId || attempt.requestId === normalized.requestId) &&
    (!normalized.projectId || attempt.projectId === normalized.projectId) &&
    (!normalized.providerId || attempt.providerId === normalized.providerId) &&
    (!normalized.status || attempt.status === normalized.status)
  )
  if (normalized.cursor && !filtered.some((attempt) => compareModelAttemptToCursor(attempt, normalized.cursor as ModelAttemptCursor) === 0)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'query cursor anchor does not exist in the normalized filter scope')
  }
  const remaining = normalized.cursor
    ? filtered.filter((attempt) => compareModelAttemptToCursor(attempt, normalized.cursor as ModelAttemptCursor) > 0)
    : filtered
  const selectedRaw = remaining.slice(0, normalized.limit)
  const selected = selectedRaw.map((attempt) => deriveModelAttemptNext(attempt, allAttempts))
  const ids = new Set(selected.map((attempt) => attempt.id))
  const hasMore = remaining.length > selected.length
  return {
    attempts: selected,
    events: readModelAttemptEvents(db).filter((event) => ids.has(event.attemptId)),
    total: filtered.length,
    hasMore,
    ...(hasMore && selectedRaw.length > 0
      ? {
          nextCursor: encodeModelAttemptCursor(
            selectedRaw[selectedRaw.length - 1],
            normalized.scopeDigest,
            { lastSeq: ledger.lastSeq, lastDigest: ledger.lastDigest }
          )
        }
      : {})
  }
}

export function verifyModelAttemptLedger(
  db: WorkflowLedgerDatabase
): ModelAttemptLedgerVerification {
  if (!modelAttemptSchemaExists(db)) {
    return { valid: true, attempts: 0, events: 0, runs: 0, lastSeq: 0, lastDigest: GENESIS_DIGEST }
  }
  const attempts = readRawModelAttempts(db)
  const events = readModelAttemptEvents(db)
  const meta = readModelAttemptLedgerMeta(db)
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]))
  const runIds = new Set<string>()
  const byRequest = new Map<string, ModelAttemptRecord[]>()
  const failoverSources = new Set<string>()

  for (const attempt of attempts) {
    assertStoredAttemptSemantics(attempt)
    const owner = requireCanonicalRun(db, attempt.runId, true)
    assertStoredOwnership(attempt, owner)
    runIds.add(attempt.runId)
    const chainKey = requestChainKey(attempt.runId, attempt.requestId)
    const requestAttempts = byRequest.get(chainKey) ?? []
    requestAttempts.push(attempt)
    byRequest.set(chainKey, requestAttempts)
    if (attempt.recordDigest !== digest(modelAttemptWithoutDerived(attempt))) {
      modelAttemptCorruption(`Attempt ${attempt.id} record digest mismatch`)
    }
    verifyStoredFailover(attempt, attemptsById, failoverSources)
  }
  for (const requestAttempts of byRequest.values()) {
    const first = requestAttempts[0]
    assertRequestOrdinals(first.runId, first.requestId, requestAttempts)
  }
  assertEventCoverage(attempts, events)
  const last = events.at(-1)
  assertModelAttemptMetaMatches(meta, attempts.length, events.length, last)
  return {
    valid: true,
    attempts: attempts.length,
    events: events.length,
    runs: runIds.size,
    lastSeq: last?.seq ?? 0,
    lastDigest: last?.digest ?? GENESIS_DIGEST
  }
}

function verifyStoredFailover(
  attempt: ModelAttemptRecord,
  attemptsById: ReadonlyMap<string, ModelAttemptRecord>,
  sources: Set<string>
): void {
  const sourceId = attempt.failoverFromAttemptId
  if (!sourceId) return
  if (sources.has(sourceId)) modelAttemptCorruption(`Attempt ${sourceId} has multiple failover successors`)
  sources.add(sourceId)
  const source = attemptsById.get(sourceId)
  if (!source || source.runId !== attempt.runId || source.requestId !== attempt.requestId ||
      source.ordinal + 1 !== attempt.ordinal || source.status !== 'failed' ||
      source.completedAt === undefined || attempt.startedAt < source.completedAt) {
    modelAttemptCorruption(`Attempt ${attempt.id} has invalid failover source ${sourceId}`)
  }
}

function ledgerMeta(verification: ModelAttemptLedgerVerification): ModelAttemptLedgerMeta {
  return {
    initialized: true,
    attemptCount: verification.attempts,
    eventCount: verification.events,
    lastSeq: verification.lastSeq,
    lastDigest: verification.lastDigest
  }
}

function advanceModelAttemptMeta(
  db: WorkflowLedgerDatabase,
  expected: ModelAttemptLedgerMeta,
  event: ModelAttemptEventRecord,
  attemptDelta: 0 | 1
): void {
  updateModelAttemptLedgerMeta(db, expected, {
    attemptCount: expected.attemptCount + attemptDelta,
    eventCount: expected.eventCount + 1,
    lastSeq: event.seq,
    lastDigest: event.digest
  })
}

function assertModelAttemptMetaMatches(
  meta: ModelAttemptLedgerMeta,
  attempts: number,
  events: number,
  last: ModelAttemptEventRecord | undefined
): void {
  const actual = {
    attemptCount: attempts,
    eventCount: events,
    lastSeq: last?.seq ?? 0,
    lastDigest: last?.digest ?? GENESIS_DIGEST
  }
  const expected = {
    attemptCount: meta.attemptCount,
    eventCount: meta.eventCount,
    lastSeq: meta.lastSeq,
    lastDigest: meta.lastDigest
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    modelAttemptCorruption('ModelAttempt ledger meta marker differs from persisted ledger head/counts')
  }
}

function withModelAttemptTransaction<T>(db: WorkflowLedgerDatabase, operation: () => T): T {
  db.run('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.run('COMMIT')
    return result
  } catch (error) {
    try { db.run('ROLLBACK') } catch { /* preserve the original ledger error */ }
    throw error
  }
}

function assertEventCoverage(
  attempts: readonly ModelAttemptRecord[],
  events: readonly ModelAttemptEventRecord[]
): void {
  const eventsByAttempt = indexAttemptEvents(attempts, events)
  for (const attempt of attempts) assertAttemptEventCoverage(attempt, eventsByAttempt.get(attempt.id) ?? [])
}

function indexAttemptEvents(
  attempts: readonly ModelAttemptRecord[],
  events: readonly ModelAttemptEventRecord[]
): Map<string, ModelAttemptEventRecord[]> {
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]))
  const eventsByAttempt = new Map<string, ModelAttemptEventRecord[]>()
  const commands = new Set<string>()
  for (const event of events) {
    if (commands.has(event.commandId)) modelAttemptCorruption(`Attempt command ${event.commandId} is duplicated`)
    commands.add(event.commandId)
    const attempt = attemptsById.get(event.attemptId)
    if (!attempt || attempt.runId !== event.runId) modelAttemptCorruption(`Attempt event ${event.eventId} references missing Attempt`)
    const grouped = eventsByAttempt.get(event.attemptId) ?? []
    grouped.push(event)
    eventsByAttempt.set(event.attemptId, grouped)
  }
  return eventsByAttempt
}

function assertAttemptEventCoverage(
  attempt: ModelAttemptRecord,
  owned: readonly ModelAttemptEventRecord[]
): void {
  const start = owned.find((event) => event.revision === 1)
  if (!start) modelAttemptCorruption(`Attempt ${attempt.id} has no start event`)
  assertEventSource(
    start, attempt, modelAttemptStartRecordVersion(attempt), 'model_attempt.started', attempt.startCommandId
  )
  if (attempt.revision === 1) {
    const state = { count: owned.length, status: attempt.status, completion: attempt.completionCommandId }
    if (canonicalJson(state) !== canonicalJson({ count: 1, status: 'started', completion: undefined })) {
      modelAttemptCorruption(`Attempt ${attempt.id} started state has invalid event coverage`)
    }
    return
  }
  const terminal = owned.find((event) => event.revision === 2)
  if (!terminal) modelAttemptCorruption(`Attempt ${attempt.id} has no terminal event`)
  assertEventSource(
    terminal,
    attempt,
    attempt,
    eventKindForStatus(attempt.status as ModelAttemptTerminalStatus),
    attempt.completionCommandId ?? ''
  )
  if (owned.length !== 2 || terminal.seq <= start.seq) {
    modelAttemptCorruption(`Attempt ${attempt.id} terminal event coverage is invalid`)
  }
}

function assertEventSource(
  event: ModelAttemptEventRecord,
  attempt: ModelAttemptRecord,
  revisionRecord: ModelAttemptRecord,
  kind: ModelAttemptEventKind,
  commandId: string
): void {
  const expected = {
    kind,
    commandId,
    eventId: `model-attempt:${attempt.id}:revision:${revisionRecord.revision}`,
    runId: attempt.runId,
    occurredAt: revisionRecord.revision === 1 ? attempt.startedAt : attempt.completedAt
  }
  const actual = {
    kind: event.kind,
    commandId: event.commandId,
    eventId: event.eventId,
    runId: event.runId,
    occurredAt: event.occurredAt
  }
  const inputDigest = revisionRecord.revision === 1
    ? attempt.startPayloadDigest
    : attempt.completionPayloadDigest ?? ''
  if (canonicalJson(actual) !== canonicalJson(expected) ||
      canonicalJson(event.payload) !== canonicalJson(modelAttemptEventPayload(revisionRecord, inputDigest))) {
    modelAttemptCorruption(`Attempt ${attempt.id} revision ${revisionRecord.revision} event differs from source`)
  }
}

function resolveIdempotentStart(
  db: WorkflowLedgerDatabase,
  input: NormalizedStart,
  event: ModelAttemptEventRecord
): ModelAttemptRecord {
  if (event.kind !== 'model_attempt.started' || event.attemptId !== input.id ||
      event.payload.inputDigest !== input.startPayloadDigest) {
    throw modelAttemptError('MODEL_ATTEMPT_COMMAND_CONFLICT', `Command ${input.commandId} maps to different Attempt content`)
  }
  const attempts = readRawModelAttempts(db)
  const record = attempts.find((attempt) => attempt.id === input.id)
  if (!record) modelAttemptCorruption(`Command ${input.commandId} references missing Attempt ${input.id}`)
  return deriveModelAttemptNext(record, attempts)
}

function resolveIdempotentCompletion(
  db: WorkflowLedgerDatabase,
  attemptId: string,
  input: NormalizedComplete,
  event: ModelAttemptEventRecord
): ModelAttemptRecord {
  if (event.attemptId !== attemptId || event.kind !== eventKindForStatus(input.status) ||
      event.payload.inputDigest !== input.completionPayloadDigest) {
    throw modelAttemptError('MODEL_ATTEMPT_COMMAND_CONFLICT', `Command ${input.commandId} maps to different completion content`)
  }
  const attempts = readRawModelAttempts(db)
  const record = attempts.find((attempt) => attempt.id === attemptId)
  if (!record || record.completionCommandId !== input.commandId) {
    modelAttemptCorruption(`Command ${input.commandId} references incomplete Attempt ${attemptId}`)
  }
  return deriveModelAttemptNext(record, attempts)
}

function assertFailoverSource(
  db: WorkflowLedgerDatabase,
  sourceId: string | undefined,
  owner: CanonicalRunOwner,
  ordinal: number,
  startedAt: number,
  attempts: readonly ModelAttemptRecord[]
): void {
  const retryAuthorizations = attempts.filter((attempt) =>
    isRetryAuthorizedModelAttempt(attempt) && !attempts.some((candidate) => candidate.failoverFromAttemptId === attempt.id)
  )
  if (retryAuthorizations.length > 1) {
    throw modelAttemptError('MODEL_ATTEMPT_RECONCILIATION_AMBIGUOUS', 'Request has multiple unconsumed retry authorizations')
  }
  if (retryAuthorizations[0] && sourceId !== retryAuthorizations[0].id) {
    throw modelAttemptError('MODEL_ATTEMPT_FAILOVER_INVALID', `Retry must consume authorization ${retryAuthorizations[0].id}`)
  }
  if (!sourceId) return
  const source = findRawModelAttempt(db, sourceId)
  const requestId = attempts[0]?.requestId
  if (!source || source.runId !== owner.id || source.requestId !== requestId ||
      source.ordinal + 1 !== ordinal || source.status !== 'failed' ||
      source.completedAt === undefined || startedAt < source.completedAt) {
    throw modelAttemptError(
      'MODEL_ATTEMPT_FAILOVER_INVALID',
      `Failover source ${sourceId} is not the latest failed Attempt for Run ${owner.id} request ${requestId ?? ''}`
    )
  }
  if (attempts.some((attempt) => attempt.failoverFromAttemptId === sourceId)) {
    throw modelAttemptError('MODEL_ATTEMPT_FAILOVER_INVALID', `Failover source ${sourceId} already has a successor`)
  }
}

function requireCanonicalRun(
  db: WorkflowLedgerDatabase,
  runId: string,
  integrity = false
): CanonicalRunOwner {
  const stmt = db.prepare(
    'SELECT id, project_id, goal_id, work_item_id, status FROM workflow_runs WHERE id = ? LIMIT 1'
  )
  try {
    stmt.bind([runId])
    if (!stmt.step()) {
      if (integrity) modelAttemptCorruption(`Attempt references missing canonical Run ${runId}`)
      throw modelAttemptError('MODEL_ATTEMPT_RUN_NOT_FOUND', `Canonical Run ${runId} does not exist`)
    }
    const row = stmt.getAsObject()
    return {
      id: rowText(row.id, 'Run id'),
      status: canonicalRunStatus(row.status),
      projectId: nullableText(row.project_id),
      goalId: nullableText(row.goal_id),
      workItemId: rowText(row.work_item_id, 'Run work item id')
    }
  } finally {
    stmt.free()
  }
}

function canonicalRunStatus(value: unknown): TaskRunStatus {
  if (typeof value !== 'string' || !TASK_RUN_STATUSES.has(value as TaskRunStatus)) {
    modelAttemptCorruption('Canonical Run status is invalid')
  }
  return value as TaskRunStatus
}

function assertOwnershipClaims(input: NormalizedStart, owner: CanonicalRunOwner): void {
  for (const [label, claim, actual] of [
    ['project', input.projectId, owner.projectId],
    ['goal', input.goalId, owner.goalId],
    ['work item', input.workItemId, owner.workItemId]
  ] as const) {
    if (claim !== undefined && claim !== actual) {
      throw modelAttemptError('MODEL_ATTEMPT_OWNERSHIP_MISMATCH', `Attempt ${label} claim differs from canonical Run`)
    }
  }
}

function assertStoredOwnership(attempt: ModelAttemptRecord, owner: CanonicalRunOwner): void {
  if (attempt.projectId !== owner.projectId || attempt.goalId !== owner.goalId || attempt.workItemId !== owner.workItemId) {
    modelAttemptCorruption(`Attempt ${attempt.id} ownership differs from canonical Run ${owner.id}`)
  }
}

function assertRequestOrdinals(
  runId: string,
  requestId: string,
  attempts: readonly ModelAttemptRecord[]
): void {
  const sorted = [...attempts].sort((left, right) => left.ordinal - right.ordinal)
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].ordinal !== index + 1) {
      modelAttemptCorruption(`Run ${runId} request ${requestId} Attempt ordinal sequence has a gap`)
    }
  }
}

function requestChainKey(runId: string, requestId: string): string {
  return `${runId}\u0000${requestId}`
}

function normalizeStartInput(input: ModelAttemptStartInput): NormalizedStart {
  const startedAt = timestamp(input.startedAt ?? Date.now(), 'startedAt')
  const normalized = {
    id: requiredId(input.id, 'attempt id'),
    commandId: requiredId(input.commandId, 'start command id'),
    requestId: requiredId(input.requestId, 'request id'),
    stepId: optionalId(input.stepId, 'step id'),
    runId: requiredId(input.runId, 'run id'),
    providerId: safeText(input.providerId, 'provider id', 160),
    model: safeText(input.model, 'model', 240),
    protocol: safeText(input.protocol, 'protocol', 120),
    adapterVersion: safeText(input.adapterVersion, 'adapter version', 120),
    ...(input.executorReceipt === undefined ? {} : { executorReceipt: normalizeModelExecutorReceipt(input.executorReceipt, input) }),
    contextDigest: sha256Digest(input.contextDigest, 'context digest'),
    routeReason: safeReason(input.routeReason),
    keyLabel: safeKeyLabel(input.keyLabel),
    failoverFromAttemptId: optionalId(input.failoverFromAttemptId, 'failover source id'),
    startedAt,
    projectId: optionalId(input.projectId, 'project id'),
    goalId: optionalId(input.goalId, 'goal id'),
    workItemId: optionalId(input.workItemId, 'work item id')
  }
  const payload = { ...normalized, startedAt: input.startedAt === undefined ? undefined : startedAt }
  return { ...normalized, startPayloadDigest: digest(payload) }
}

function normalizeCompleteInput(input: ModelAttemptCompleteInput): NormalizedComplete {
  const status = terminalStatus(input.status)
  const outcome = modelAttemptOutcome(input.outcome ?? defaultOutcome(status))
  const completedAt = timestamp(input.completedAt ?? Date.now(), 'completedAt')
  const normalized = {
    commandId: requiredId(input.commandId, 'completion command id'),
    expectedRevision: positiveInteger(input.expectedRevision, 'expected revision'),
    status,
    completedAt,
    usage: normalizeUsage(input.usage),
    costUsd: optionalNonNegativeNumber(input.costUsd, 'costUsd'),
    outcome,
    errorClass: input.errorClass === undefined ? undefined : safeErrorClass(input.errorClass)
  }
  const payload = { ...normalized, completedAt: input.completedAt === undefined ? undefined : completedAt }
  return { ...normalized, completionPayloadDigest: digest(payload) }
}

function assertTerminalSemantics(input: NormalizedComplete, allowUnknown: boolean): void {
  if (input.outcome === 'unknown' && !allowUnknown)
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'unknown outcome is reserved for ModelAttempt reconciliation')
  validateModelAttemptTerminalOutcome(input, input.status, input.outcome)
}

function normalizeQuery(
  query: ModelAttemptQuery,
  ledger: ModelAttemptLedgerVerification
): NormalizedQuery {
  const limit = query.limit === undefined ? 100 : positiveInteger(query.limit, 'query limit')
  if (limit > MAX_QUERY_LIMIT) throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `query limit exceeds ${MAX_QUERY_LIMIT}`)
  const runId = optionalId(query.runId, 'query run id')
  const requestId = optionalId(query.requestId, 'query request id')
  const scope = {
    runId,
    requestId,
    projectId: optionalId(query.projectId, 'query project id'),
    providerId: query.providerId === undefined ? undefined : safeText(query.providerId, 'query provider id', 160),
    status: query.status === undefined ? undefined : attemptStatus(query.status)
  }
  const scopeDigest = modelAttemptQueryScopeDigest(scope)
  return {
    ...scope,
    limit,
    scopeDigest,
    cursor: query.cursor === undefined
      ? undefined
      : decodeModelAttemptCursor(query.cursor, {
          scopeDigest,
          lastSeq: ledger.lastSeq,
          lastDigest: ledger.lastDigest
        })
  }
}

function assertStoredAttemptSemantics(record: ModelAttemptRecord): void {
  try {
    validateStoredAttemptSemantics(record)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'MODEL_ATTEMPT_LEDGER_CORRUPTION') throw error
    const detail = error instanceof Error ? error.message : String(error)
    modelAttemptCorruption(`Attempt ${record?.id ?? '<unknown>'} semantic validation failed: ${detail}`)
  }
}

function validateStoredAttemptSemantics(record: ModelAttemptRecord): void {
  if (!record || record.schemaVersion !== 1) throw new Error('schemaVersion is invalid')
  for (const field of Object.keys(record)) {
    if (!MODEL_ATTEMPT_RECORD_FIELDS.has(field)) throw new Error(`unknown stored field ${field}`)
  }
  validateStoredAttemptIdentity(record)
  const status = attemptStatus(record.status)
  if (status === 'started') validateStoredStartedAttempt(record)
  else validateStoredTerminalAttempt(record, status)
}

function validateStoredAttemptIdentity(record: ModelAttemptRecord): void {
  assertCanonicalStored(record.id, requiredId(record.id, 'attempt id'), 'attempt id')
  assertCanonicalStored(record.runId, requiredId(record.runId, 'run id'), 'run id')
  assertCanonicalStored(record.requestId, requiredId(record.requestId, 'request id'), 'request id')
  assertCanonicalStored(record.stepId, optionalId(record.stepId, 'step id'), 'step id')
  assertCanonicalStored(record.projectId, optionalId(record.projectId, 'project id'), 'project id')
  assertCanonicalStored(record.goalId, optionalId(record.goalId, 'goal id'), 'goal id')
  assertCanonicalStored(record.workItemId, requiredId(record.workItemId, 'work item id'), 'work item id')
  assertCanonicalStored(record.startCommandId, requiredId(record.startCommandId, 'start command id'), 'start command id')
  assertCanonicalStored(
    record.failoverFromAttemptId,
    optionalId(record.failoverFromAttemptId, 'failover source id'),
    'failover source id'
  )
  assertCanonicalStored(record.providerId, safeText(record.providerId, 'provider id', 160), 'provider id')
  assertCanonicalStored(record.model, safeText(record.model, 'model', 240), 'model')
  assertCanonicalStored(record.protocol, safeText(record.protocol, 'protocol', 120), 'protocol')
  assertCanonicalStored(
    record.adapterVersion,
    safeText(record.adapterVersion, 'adapter version', 120),
    'adapter version'
  )
  normalizeModelExecutorReceipt(record.executorReceipt, record)
  assertCanonicalStored(
    record.contextDigest,
    sha256Digest(record.contextDigest, 'context digest'),
    'context digest'
  )
  assertCanonicalStored(record.routeReason, safeReason(record.routeReason), 'route reason')
  assertCanonicalStored(record.keyLabel, safeKeyLabel(record.keyLabel), 'key label')
  positiveInteger(record.ordinal, 'ordinal')
  nonNegativeSafeInteger(record.startedAt, 'startedAt')
  rawDigest(record.startPayloadDigest, 'start payload digest')
  rawDigest(record.recordDigest, 'record digest')
  if (record.nextAttemptId !== undefined) throw new Error('derived nextAttemptId was persisted')
}

function validateStoredStartedAttempt(record: ModelAttemptRecord): void {
  const terminalFields = [
    record.completedAt, record.latencyMs, record.usage, record.costUsd, record.outcome,
    record.errorClass, record.completionCommandId, record.completionPayloadDigest
  ]
  if (record.revision !== 1 || terminalFields.some((value) => value !== undefined)) {
    throw new Error('started state contains terminal fields')
  }
}

function validateStoredTerminalAttempt(
  record: ModelAttemptRecord,
  status: ModelAttemptTerminalStatus
): void {
  if (record.revision !== 2) throw new Error('terminal state revision is not 2')
  const completedAt = nonNegativeSafeInteger(record.completedAt, 'completedAt')
  const latencyMs = nonNegativeSafeInteger(record.latencyMs, 'latencyMs')
  if (completedAt < record.startedAt || latencyMs !== completedAt - record.startedAt) {
    throw new Error('terminal timing is inconsistent')
  }
  if (record.usage && canonicalJson(normalizeUsage(record.usage)) !== canonicalJson(record.usage)) {
    throw new Error('usage is not canonical')
  }
  optionalNonNegativeNumber(record.costUsd, 'costUsd')
  assertCanonicalStored(
    record.completionCommandId,
    requiredId(record.completionCommandId, 'completion command id'),
    'completion command id'
  )
  rawDigest(record.completionPayloadDigest, 'completion payload digest')
  const outcome = modelAttemptOutcome(record.outcome)
  validateModelAttemptTerminalOutcome(record, status, outcome)
  if (record.errorClass !== undefined) {
    assertCanonicalStored(record.errorClass, safeErrorClass(record.errorClass), 'error class')
  }
}

function assertCanonicalStored(actual: unknown, normalized: unknown, label: string): void {
  if (actual !== normalized) throw new Error(`${label} is not canonical`)
}

function eventKindForStatus(status: ModelAttemptTerminalStatus): ModelAttemptEventKind {
  if (status === 'succeeded') return 'model_attempt.succeeded'
  if (status === 'failed') return 'model_attempt.failed'
  return 'model_attempt.cancelled'
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
