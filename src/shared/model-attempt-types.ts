export type ModelAttemptStatus = 'started' | 'succeeded' | 'failed' | 'cancelled'

export type ModelAttemptTerminalStatus = Exclude<ModelAttemptStatus, 'started'>

export type ModelAttemptOutcome =
  | 'success'
  | 'error'
  | 'unknown'
  | 'timeout'
  | 'rate_limited'
  | 'auth_failed'
  | 'unavailable'
  | 'cancelled'

export interface ModelAttemptUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ModelAttemptOwnership {
  projectId?: string
  goalId?: string
  workItemId: string
}

export type NativeModelExecutorComponent = 'openai_engine' | 'anthropic_engine' | 'google_genai_runtime' | 'model_dag_decomposer'

/** Main-process execution provenance, not a claim that the remote model passed a capability probe. */
export interface ModelExecutorReceipt {
  readonly schemaVersion: 1
  readonly source: 'native_runtime'
  readonly executorId: string
  /** Version embedded in this CaoGen build, never a Session/provider setting. */
  readonly executorVersion: string
  readonly component: NativeModelExecutorComponent
  readonly engineKind: 'openai' | 'anthropic' | 'gemini'
  readonly executionDomain: 'native_text'
  /** Binds this executor to the Attempt's provider, model, protocol and adapter. */
  readonly bindingDigest: string
}

export interface ModelAttemptStartInput {
  id: string
  commandId: string
  requestId: string
  stepId?: string
  runId: string
  providerId: string
  model: string
  protocol: string
  adapterVersion: string
  executorReceipt?: ModelExecutorReceipt
  contextDigest: string
  routeReason: string
  keyLabel?: string
  failoverFromAttemptId?: string
  startedAt?: number
  /** Optional ownership claims are checked against, never written over, the canonical Run. */
  projectId?: string
  goalId?: string
  workItemId?: string
}

export interface ModelAttemptCompleteInput {
  commandId: string
  expectedRevision: number
  status: ModelAttemptTerminalStatus
  completedAt?: number
  usage?: ModelAttemptUsage
  costUsd?: number
  outcome?: ModelAttemptOutcome
  errorClass?: string
}

export interface ModelAttemptRecord extends ModelAttemptOwnership {
  schemaVersion: 1
  id: string
  runId: string
  requestId: string
  stepId?: string
  ordinal: number
  providerId: string
  model: string
  protocol: string
  adapterVersion: string
  /** Absent on old records: historical executor identity is unknown. */
  executorReceipt?: ModelExecutorReceipt
  contextDigest: string
  routeReason: string
  keyLabel?: string
  status: ModelAttemptStatus
  revision: number
  startedAt: number
  completedAt?: number
  latencyMs?: number
  usage?: ModelAttemptUsage
  costUsd?: number
  outcome?: ModelAttemptOutcome
  errorClass?: string
  failoverFromAttemptId?: string
  /** Derived from another Attempt's failoverFromAttemptId; never mutates this Attempt row. */
  nextAttemptId?: string
  startCommandId: string
  startPayloadDigest: string
  completionCommandId?: string
  completionPayloadDigest?: string
  recordDigest: string
}

export type ModelAttemptEventKind =
  | 'model_attempt.started'
  | 'model_attempt.succeeded'
  | 'model_attempt.failed'
  | 'model_attempt.cancelled'

export interface ModelAttemptEventRecord {
  schemaVersion: 1
  seq: number
  eventId: string
  commandId: string
  attemptId: string
  runId: string
  kind: ModelAttemptEventKind
  revision: number
  occurredAt: number
  prevDigest: string
  digest: string
  payload: Record<string, unknown>
}

export interface ModelAttemptQuery {
  runId?: string
  requestId?: string
  projectId?: string
  providerId?: string
  status?: ModelAttemptStatus
  limit?: number
  cursor?: string
}

export interface ModelAttemptSelection {
  attempts: ModelAttemptRecord[]
  events: ModelAttemptEventRecord[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export type ModelAttemptReconciliationResolution = 'retry_authorized' | 'cancelled_by_user'

export interface ModelAttemptReconciliationQuery {
  runId?: string
  sessionId?: string
  requestId?: string
  stepId?: string
  limit?: number
}

export interface ModelAttemptReconciliationView {
  attempt: ModelAttemptRecord
  runId: string
  sessionId: string
  requestId: string
}

export interface ModelAttemptRecoveryApi {
  listModelAttemptReconciliations(): Promise<ModelAttemptReconciliationView[]>
  resolveModelAttemptReconciliation(
    attemptId: string,
    expectedRevision: number,
    resolution: ModelAttemptReconciliationResolution
  ): Promise<ModelAttemptReconciliationView>
}

export interface ModelAttemptLedgerVerification {
  valid: true
  attempts: number
  events: number
  runs: number
  lastSeq: number
  lastDigest: string
}

export type ModelAttemptLedgerErrorCode =
  | 'MODEL_ATTEMPT_INVALID_INPUT'
  | 'MODEL_ATTEMPT_SECRET_REJECTED'
  | 'MODEL_ATTEMPT_RUN_NOT_FOUND'
  | 'MODEL_ATTEMPT_NOT_FOUND'
  | 'MODEL_ATTEMPT_OWNERSHIP_MISMATCH'
  | 'MODEL_ATTEMPT_COMMAND_CONFLICT'
  | 'MODEL_ATTEMPT_ID_CONFLICT'
  | 'MODEL_ATTEMPT_REVISION_CONFLICT'
  | 'MODEL_ATTEMPT_INVALID_TRANSITION'
  | 'MODEL_ATTEMPT_FAILOVER_INVALID'
  | 'MODEL_ATTEMPT_RECONCILIATION_REQUIRED'
  | 'MODEL_ATTEMPT_RECONCILIATION_AMBIGUOUS'
  | 'MODEL_ATTEMPT_CURSOR_STALE'
  | 'MODEL_ATTEMPT_LEDGER_CORRUPTION'

export class ModelAttemptLedgerError extends Error {
  constructor(readonly code: ModelAttemptLedgerErrorCode, message: string) {
    super(message)
    this.name = 'ModelAttemptLedgerError'
  }
}

export function modelAttemptError(
  code: ModelAttemptLedgerErrorCode,
  message: string
): ModelAttemptLedgerError {
  return new ModelAttemptLedgerError(code, message)
}

export function modelAttemptCorruption(message: string): never {
  throw modelAttemptError('MODEL_ATTEMPT_LEDGER_CORRUPTION', message)
}

export function attemptStatus(value: unknown): ModelAttemptStatus {
  if (value === 'started' || value === 'succeeded' || value === 'failed' || value === 'cancelled') return value
  throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'Attempt status is invalid')
}

export function terminalStatus(value: unknown): ModelAttemptTerminalStatus {
  const status = attemptStatus(value)
  if (status === 'started') throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'completion status must be terminal')
  return status
}

export function defaultOutcome(status: ModelAttemptTerminalStatus): ModelAttemptOutcome {
  if (status === 'succeeded') return 'success'
  if (status === 'cancelled') return 'cancelled'
  return 'error'
}

export function modelAttemptOutcome(value: unknown): ModelAttemptOutcome {
  if (value === 'success' || value === 'error' || value === 'unknown' || value === 'timeout' || value === 'rate_limited' ||
      value === 'auth_failed' || value === 'unavailable' || value === 'cancelled') return value
  throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'Attempt outcome is invalid')
}

export function isRetryAuthorizedModelAttempt(
  attempt: Pick<ModelAttemptRecord, 'status' | 'outcome' | 'errorClass'>
): boolean {
  return attempt.status === 'failed' && attempt.outcome === 'unknown' &&
    attempt.errorClass === 'runtime_result_unknown'
}

export function normalizeModelAttemptUsage(usage: ModelAttemptUsage | undefined): ModelAttemptUsage | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    if (!usage) return undefined
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'usage must be an object')
  }
  return {
    inputTokens: nonNegativeInteger(usage.inputTokens, 'inputTokens'),
    outputTokens: nonNegativeInteger(usage.outputTokens, 'outputTokens'),
    cacheReadTokens: optionalNonNegativeInteger(usage.cacheReadTokens, 'cacheReadTokens'),
    cacheWriteTokens: optionalNonNegativeInteger(usage.cacheWriteTokens, 'cacheWriteTokens')
  }
}

export function safeKeyLabel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'keyLabel must be text')
  const label = value.trim()
  if (looksSecretLike(label)) {
    throw modelAttemptError('MODEL_ATTEMPT_SECRET_REJECTED', 'keyLabel contains secret-like material')
  }
  const safeLabel = /^label:([a-z0-9][a-z0-9._/@-]{0,79})$/i.exec(label)
  if (safeLabel) {
    if (looksHighEntropyCredential(safeLabel[1])) {
      throw modelAttemptError('MODEL_ATTEMPT_SECRET_REJECTED', 'keyLabel contains high-entropy credential-like material')
    }
    return label
  }
  if (/^sha256:[0-9a-f]{64}$/i.test(label)) return label.toLowerCase()
  throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'keyLabel must be label:<safe-id> or sha256:<digest>')
}

export function safeReason(value: unknown): string {
  const reason = safeText(value, 'route reason', 2000)
  if (looksSecretLike(reason) || reasonHasHighEntropyToken(reason)) {
    throw modelAttemptError('MODEL_ATTEMPT_SECRET_REJECTED', 'route reason contains credential-like material')
  }
  return reason
}

export function safeErrorClass(value: unknown): string {
  const errorClass = safeText(value, 'error class', 96)
  if (looksHighEntropyCredential(errorClass)) {
    throw modelAttemptError('MODEL_ATTEMPT_SECRET_REJECTED', 'error class contains credential-like material')
  }
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(errorClass)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'error class must be a low-entropy identifier')
  }
  return errorClass
}

export function sha256Digest(value: unknown, label: string): string {
  const text = safeText(value, label, 80).toLowerCase()
  const normalized = text.startsWith('sha256:') ? text : `sha256:${text}`
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} must be a SHA-256 digest`)
  }
  return normalized
}

export function safeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} must be text`)
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} is invalid`)
  }
  if (looksSecretLike(text)) throw modelAttemptError('MODEL_ATTEMPT_SECRET_REJECTED', `${label} contains secret-like material`)
  return text
}

export function requiredId(value: unknown, label: string): string {
  const id = safeText(value, label, 256)
  if (/\s/.test(id)) throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} cannot contain whitespace`)
  return id
}

export function optionalId(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : requiredId(value, label)
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} must be a positive safe integer`)
  }
  return value
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} must be a non-negative safe integer`)
  }
  return value
}

export function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} must be a non-negative finite number`)
  }
  return value
}

export function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} must be a non-negative safe-integer timestamp`)
  }
  return value
}

export function rawDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', `${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label)
}

function looksSecretLike(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) ||
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization)\s*[:=]\s*\S+/i.test(value) ||
    /\b(?:sk|rk|pk|xox[baprs])[-_][a-z0-9_-]{12,}\b/i.test(value)
}

function looksHighEntropyCredential(value: string): boolean {
  if (value.length < 24) return false
  if (/^[0-9a-f]{32,}$/i.test(value)) return true
  if (!/^[a-z0-9_+/=@.-]+$/i.test(value)) return false
  const categories = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[_+/=@.-]/.test(value)]
    .filter(Boolean).length
  return categories >= 3 && new Set(value).size / value.length >= 0.45
}

function reasonHasHighEntropyToken(value: string): boolean {
  const tokens = value.match(/[A-Za-z0-9_+/=@.-]{24,}/g) ?? []
  return tokens.some((token) => looksHighEntropyCredential(token) && !looksLikeStructuredRouteIdentity(token))
}

function looksLikeStructuredRouteIdentity(value: string): boolean {
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) return true
  const segments = value.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (segments.length < 2) return false
  const readableWords = segments.filter((segment) =>
    /^[a-z]{3,}$/.test(segment) || /^[A-Z][a-z]{2,}$/.test(segment)
  )
  return readableWords.length >= 2
}

export interface ModelAttemptSqlStatement {
  step(): boolean
  getAsObject(): Record<string, unknown>
  free(): void
}

export interface ModelAttemptSqlInspector {
  prepare(sql: string): ModelAttemptSqlStatement
}

export interface ModelAttemptTableContract {
  table: string
  columns: ReadonlySet<string>
  notNull: ReadonlySet<string>
  primaryKey: readonly string[]
  unique: readonly (readonly string[])[]
  foreignKeys: readonly string[]
}

export function assertModelAttemptTableContract(
  db: ModelAttemptSqlInspector,
  contract: ModelAttemptTableContract
): void {
  const columns = readTableColumns(db, contract.table)
  const names = new Set(columns.map((column) => column.name))
  if (names.size !== contract.columns.size || [...names].some((name) => !contract.columns.has(name))) {
    modelAttemptCorruption(`${contract.table} columns differ from the required schema contract`)
  }
  for (const column of columns) {
    if ((column.notNull || column.primaryKeyOrdinal > 0) !== contract.notNull.has(column.name)) {
      modelAttemptCorruption(`${contract.table}.${column.name} NOT NULL contract differs`)
    }
  }
  const primaryKey = columns.filter((column) => column.primaryKeyOrdinal > 0)
    .sort((left, right) => left.primaryKeyOrdinal - right.primaryKeyOrdinal).map((column) => column.name)
  assertStringListsEqual(primaryKey, contract.primaryKey, `${contract.table} primary key`)
  assertStringListsEqual(
    readUniqueContracts(db, contract.table), contract.unique.map((columns) => columns.join(',')),
    `${contract.table} UNIQUE constraints`
  )
  assertStringListsEqual(readForeignKeyContracts(db, contract.table), contract.foreignKeys, `${contract.table} foreign keys`)
}

interface ModelAttemptTableColumn {
  name: string
  notNull: boolean
  primaryKeyOrdinal: number
}

function readTableColumns(db: ModelAttemptSqlInspector, table: string): ModelAttemptTableColumn[] {
  const columns: ModelAttemptTableColumn[] = []
  const stmt = db.prepare(`PRAGMA table_info(${table})`)
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      if (typeof row.name !== 'string' || typeof row.notnull !== 'number' || typeof row.pk !== 'number') {
        modelAttemptCorruption(`${table} table_info row is invalid`)
      }
      columns.push({ name: row.name, notNull: row.notnull === 1, primaryKeyOrdinal: row.pk })
    }
  } finally { stmt.free() }
  return columns
}

function readUniqueContracts(db: ModelAttemptSqlInspector, table: string): string[] {
  const contracts: string[] = []
  const stmt = db.prepare(`PRAGMA index_list(${table})`)
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      if (row.unique !== 1 || row.origin === 'pk') continue
      if (typeof row.name !== 'string') modelAttemptCorruption(`${table} unique index name is invalid`)
      contracts.push(readIndexColumns(db, row.name).join(','))
    }
  } finally { stmt.free() }
  return contracts
}

function readIndexColumns(db: ModelAttemptSqlInspector, index: string): string[] {
  const columns: Array<{ sequence: number; name: string }> = []
  const stmt = db.prepare(`PRAGMA index_info('${index.replace(/'/g, "''")}')`)
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      if (typeof row.seqno !== 'number' || typeof row.name !== 'string') {
        modelAttemptCorruption(`ModelAttempt index ${index} definition is invalid`)
      }
      columns.push({ sequence: row.seqno, name: row.name })
    }
  } finally { stmt.free() }
  return columns.sort((left, right) => left.sequence - right.sequence).map((column) => column.name)
}

function readForeignKeyContracts(db: ModelAttemptSqlInspector, table: string): string[] {
  const contracts: string[] = []
  const stmt = db.prepare(`PRAGMA foreign_key_list(${table})`)
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      if (typeof row.from !== 'string' || typeof row.table !== 'string' || typeof row.to !== 'string' ||
          typeof row.on_update !== 'string' || typeof row.on_delete !== 'string') {
        modelAttemptCorruption(`${table} foreign key definition is invalid`)
      }
      contracts.push(`${row.from}->${row.table}.${row.to}|${row.on_update}|${row.on_delete}`)
    }
  } finally { stmt.free() }
  return contracts
}

function assertStringListsEqual(actual: readonly string[], expected: readonly string[], label: string): void {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    modelAttemptCorruption(`${label} differ from required contract`)
  }
}
