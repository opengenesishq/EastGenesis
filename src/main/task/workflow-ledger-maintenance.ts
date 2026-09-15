import { createRequire } from 'node:module'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import initSqlJs from 'sql.js'
import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactGraphVerification,
  WorkflowArtifactLocationRecord,
  WorkflowArtifactRecord,
  WorkflowEventRecord,
  WorkflowGoalRecord,
  WorkflowLedgerExportOptions,
  WorkflowLedgerExportResult,
  WorkflowLedgerExportRunRecord,
  WorkflowLedgerExportScope,
  WorkflowLedgerExportSelection,
  WorkflowLedgerExportTaskEvidenceRecord,
  WorkflowLedgerExportVerification,
  WorkflowLedgerRepairAction,
  WorkflowLedgerRepairDiagnostic,
  WorkflowLedgerRepairPlan,
  WorkflowLedgerScope,
  WorkflowLedgerSelection,
  WorkflowLedgerTaskEvidenceVerification,
  WorkflowLedgerVerification,
  WorkflowRunRecord,
  WorkflowWorkItemRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowEvidenceVerification
} from '../../shared/workflow-types'
import { flushTaskSnapshotMutations, taskSnapshotsDbFile } from './task-snapshot'
import {
  readArtifactEdges,
  readArtifactLocations,
  verifyWorkflowArtifactGraph,
  verifyWorkflowLedgerWithArtifactGraph
} from './workflow-ledger-artifact-graph-query'
import { verifyWorkflowLedger } from './workflow-ledger-store'
import { setupWorkflowArtifactGraphSchema } from './workflow-ledger-artifact-graph-types'
import { canonicalJson, digest } from './workflow-ledger-codec'
import {
  setupTaskEvidenceSchema,
  verifyTaskEvidence,
  type TaskEvidenceRecord,
  type TaskEvidenceVerification
} from './task-evidence-store'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { selectClosedWorkflowLedger } from './workflow-ledger-export-scope'
import {
  setupWorkflowEvidenceSchema,
  verifyWorkflowEvidence
} from './workflow-evidence-store'
import { redactSensitiveText } from '../security/secret-redaction'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
type SqlDatabase = InstanceType<SqlJsStatic['Database']>

const nodeRequire = createRequire(__filename)
const EXPORT_SCHEMA_VERSION = 1 as const
const EXPORT_FORMAT = 'caogen.workflow-ledger.export.v1' as const
const REPAIR_FORMAT = 'caogen.workflow-ledger.repair-plan.v1' as const
const GENESIS_DIGEST = '0'.repeat(64)

let sqlPromise: Promise<SqlJsStatic> | null = null

interface ReadOnlyDatabase {
  db: SqlDatabase
  path: string
  exists: boolean
}

/**
 * Read a snapshot of the database without going through the task snapshot
 * persistence path.  Schema setup happens only in the in-memory sql.js copy;
 * no export/repair operation writes the source file.
 */
async function openReadOnlyDatabase(rootDir?: string): Promise<ReadOnlyDatabase> {
  await flushTaskSnapshotMutations(rootDir)
  const path = taskSnapshotsDbFile(rootDir)
  let sourceBytes: Uint8Array | undefined
  let exists = true
  try {
    sourceBytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }
  const SQL = await loadSql()
  const db = sourceBytes ? new SQL.Database(sourceBytes) : new SQL.Database()
  try {
    // A brand-new user-data directory has no tables. These calls only alter
    // the in-memory database and make an empty ledger/evidence chain readable.
    setupTaskEvidenceSchema(db)
    setupWorkflowArtifactGraphSchema(db as unknown as WorkflowLedgerDatabase)
    setupWorkflowEvidenceSchema(db as unknown as WorkflowLedgerDatabase)
    return { db, path, exists }
  } catch (error) {
    db.close()
    throw error
  }
}

function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) =>
        file.endsWith('.wasm') ? nodeRequire.resolve('sql.js/dist/sql-wasm.wasm') : file
    })
  }
  return sqlPromise
}

/**
 * Export a complete, deterministic snapshot for the requested scope.
 *
 * The underlying event and TaskRun evidence chains are verified before any
 * data is returned. A corrupt chain therefore fails closed instead of
 * producing an export that looks trustworthy.
 */
export async function exportPersistedWorkflowLedger(
  optionsOrRootDir: WorkflowLedgerExportOptions | WorkflowLedgerExportScope | string = {},
  rootDirOrOptions?: string | WorkflowLedgerExportOptions
): Promise<WorkflowLedgerExportResult> {
  const { options, resolvedRootDir } = normalizeExportArguments(optionsOrRootDir, rootDirOrOptions)
  const scope = normalizeExportScope(options.scope)
  const source = await openReadOnlyDatabase(resolvedRootDir)
  try {
    const ledgerVerification = verifyWorkflowLedgerWithArtifactGraph(
      source.db as unknown as WorkflowLedgerDatabase
    )
    const artifactGraphVerification = requireArtifactGraphVerification(ledgerVerification)
    const taskEvidenceVerification = verifyTaskEvidence(source.db)
    const workflowEvidenceVerification = verifyWorkflowEvidence(
      source.db as unknown as WorkflowLedgerDatabase
    )
    const selection = readCompleteSelection(source.db as unknown as WorkflowLedgerDatabase, scope)
    const ledger = sanitizeSelection(selection)
    const verificationWithoutDigest = {
      valid: true as const,
      ledger: ledgerVerification,
      artifactGraph: artifactGraphVerification,
      taskEvidence: toSharedTaskEvidenceVerification(taskEvidenceVerification),
      workflowEvidence: workflowEvidenceVerification,
      sanitized: true as const
    }
    const digestInput = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      format: EXPORT_FORMAT,
      scope,
      ledger,
      verification: verificationWithoutDigest
    }
    const exportDigest = digest(digestInput)
    const verification: WorkflowLedgerExportVerification = {
      ...verificationWithoutDigest,
      exportDigest
    }
    const bundle = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      format: EXPORT_FORMAT,
      scope,
      ledger,
      verification,
      exportDigest
    } as const
    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      format: EXPORT_FORMAT,
      json: canonicalJson(bundle),
      exportDigest,
      ledger,
      verification
    }
  } finally {
    source.db.close()
  }
}

/** Stable public alias used by callers that do not need the persisted prefix. */
export async function exportWorkflowLedger(
  options: WorkflowLedgerExportOptions = {},
  rootDir?: string
): Promise<WorkflowLedgerExportResult> {
  return exportPersistedWorkflowLedger(options, rootDir)
}

/**
 * Generate a read-only repair/diagnostic plan. This function intentionally
 * never calls mutateTaskSnapshotDatabase, never appends events, and never
 * recomputes a digest. Any repair action is represented as an explicit,
 * approval-gated recommendation for a future operation.
 */
export async function diagnosePersistedWorkflowLedger(rootDir?: string): Promise<WorkflowLedgerRepairPlan> {
  let source: ReadOnlyDatabase
  try {
    source = await openReadOnlyDatabase(rootDir)
  } catch (error) {
    const path = taskSnapshotsDbFile(rootDir)
    const diagnostic: WorkflowLedgerRepairDiagnostic = {
      code: 'database_open_failed',
      severity: 'error',
      message: safeErrorMessage(error)
    }
    return buildRepairPlan({
      path,
      exists: await pathExists(path),
      status: 'unavailable',
      diagnostics: [diagnostic],
      verificationError: errorDescriptor(error)
    })
  }

  try {
    const diagnostics: WorkflowLedgerRepairDiagnostic[] = []
    let ledgerVerification: WorkflowLedgerVerification | undefined
    let artifactGraphVerification: WorkflowArtifactGraphVerification | undefined
    let taskEvidenceVerification: WorkflowLedgerTaskEvidenceVerification | undefined
    let workflowEvidenceVerification: WorkflowEvidenceVerification | undefined
    let verificationError: WorkflowLedgerRepairPlan['verificationError']
    let taskEvidenceVerificationError: WorkflowLedgerRepairPlan['taskEvidenceVerificationError']
    let workflowEvidenceVerificationError: WorkflowLedgerRepairPlan['workflowEvidenceVerificationError']
    let artifactGraphVerificationError: WorkflowLedgerRepairPlan['artifactGraphVerificationError']

    try {
      ledgerVerification = verifyWorkflowLedger(source.db as unknown as WorkflowLedgerDatabase)
    } catch (error) {
      verificationError = errorDescriptor(error)
      diagnostics.push(diagnosticFromError('workflow_ledger_verification_failed', error))
    }

    if (ledgerVerification) {
      try {
        artifactGraphVerification = verifyWorkflowArtifactGraph(
          source.db as unknown as WorkflowLedgerDatabase,
          { ledgerVerification }
        )
        ledgerVerification = { ...ledgerVerification, artifactGraph: artifactGraphVerification }
      } catch (error) {
        artifactGraphVerificationError = errorDescriptor(error)
        diagnostics.push(diagnosticFromError('artifact_graph_verification_failed', error))
      }
    }

    try {
      taskEvidenceVerification = toSharedTaskEvidenceVerification(verifyTaskEvidence(source.db))
    } catch (error) {
      taskEvidenceVerificationError = errorDescriptor(error)
      diagnostics.push(diagnosticFromError('task_evidence_verification_failed', error))
    }

    try {
      workflowEvidenceVerification = verifyWorkflowEvidence(
        source.db as unknown as WorkflowLedgerDatabase
      )
    } catch (error) {
      workflowEvidenceVerificationError = errorDescriptor(error)
      diagnostics.push(diagnosticFromError('workflow_evidence_verification_failed', error))
    }

    const healthy = Boolean(
      ledgerVerification && artifactGraphVerification && taskEvidenceVerification &&
      workflowEvidenceVerification
    )
    return buildRepairPlan({
      path: source.path,
      exists: source.exists,
      status: healthy ? 'healthy' : 'repair_required',
      diagnostics,
      verification: healthy
        ? {
          ledger: ledgerVerification!,
          artifactGraph: artifactGraphVerification!,
          taskEvidence: taskEvidenceVerification!,
          workflowEvidence: workflowEvidenceVerification!
        }
        : undefined,
      verificationError,
      taskEvidenceVerificationError,
      workflowEvidenceVerificationError,
      artifactGraphVerificationError
    })
  } finally {
    source.db.close()
  }
}

/** Publicly named plan alias; it remains diagnostics-only by contract. */
export async function planPersistedWorkflowLedgerRepair(rootDir?: string): Promise<WorkflowLedgerRepairPlan> {
  return diagnosePersistedWorkflowLedger(rootDir)
}

/** Compatibility alias for callers that use the verb "repair". */
export async function repairPersistedWorkflowLedger(rootDir?: string): Promise<WorkflowLedgerRepairPlan> {
  return diagnosePersistedWorkflowLedger(rootDir)
}

export async function diagnoseWorkflowLedger(rootDir?: string): Promise<WorkflowLedgerRepairPlan> {
  return diagnosePersistedWorkflowLedger(rootDir)
}

export async function planWorkflowLedgerRepair(rootDir?: string): Promise<WorkflowLedgerRepairPlan> {
  return diagnosePersistedWorkflowLedger(rootDir)
}

function normalizeExportArguments(
  optionsOrRootDir: WorkflowLedgerExportOptions | WorkflowLedgerExportScope | string,
  rootDirOrOptions?: string | WorkflowLedgerExportOptions
): { options: WorkflowLedgerExportOptions; resolvedRootDir?: string } {
  if (typeof optionsOrRootDir === 'string') {
    return {
      options: isRecord(rootDirOrOptions) ? rootDirOrOptions : {},
      resolvedRootDir: optionsOrRootDir
    }
  }
  const options = 'scope' in optionsOrRootDir
    ? optionsOrRootDir as WorkflowLedgerExportOptions
    : { scope: optionsOrRootDir as WorkflowLedgerExportScope }
  return {
    options,
    resolvedRootDir: typeof rootDirOrOptions === 'string' ? rootDirOrOptions : undefined
  }
}

function normalizeExportScope(scope: WorkflowLedgerExportOptions['scope']): WorkflowLedgerExportScope {
  if (scope === undefined) return {}
  if (!isRecord(scope)) throw new Error('workflow ledger export scope must be an object')
  const raw = scope as Record<string, unknown>
  if (raw.limit !== undefined || raw.cursor !== undefined) {
    throw new Error('workflow ledger export scope must not include pagination')
  }
  assertKnownExportScopeKeys(raw)
  const result: WorkflowLedgerExportScope = {}
  for (const key of [
    'projectId', 'goalId', 'workItemId', 'runId', 'sessionId',
    'entityId', 'eventKind', 'artifactId', 'acceptanceId'
  ] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`workflow ledger export scope ${key} must be a non-empty string`)
    }
    result[key] = value.trim()
  }
  if (raw.entityType !== undefined) {
    if (!isEntityType(raw.entityType)) throw new Error('workflow ledger export scope entityType is invalid')
    result.entityType = raw.entityType
  }
  return result
}

function assertKnownExportScopeKeys(raw: Record<string, unknown>): void {
  const allowedKeys = new Set([
    'projectId', 'goalId', 'workItemId', 'runId', 'sessionId',
    'entityType', 'entityId', 'eventKind', 'artifactId', 'acceptanceId'
  ])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error('workflow ledger export scope contains unknown field')
  }
}

function readCompleteSelection(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerExportScope
): WorkflowLedgerSelection & {
  artifactEdges: { items: WorkflowArtifactEdgeRecord[]; total: number; hasMore: false }
  artifactLocations: { items: WorkflowArtifactLocationRecord[]; total: number; hasMore: false }
  taskEvidence: { items: TaskEvidenceRecord[]; total: number; hasMore: false }
  workflowEvidence: { items: WorkflowEvidenceRecord[]; total: number; hasMore: false }
} {
  const selection = selectClosedWorkflowLedger(db, scope)
  const graph = selectGraphRows(db, scope, selection.artifacts, selection.events)
  return {
    goals: closedPage(selection.goals),
    workItems: closedPage(selection.workItems),
    runs: closedPage(selection.runs),
    artifacts: closedPage(selection.artifacts),
    acceptances: closedPage(selection.acceptances),
    evidenceLinks: closedPage(selection.evidenceLinks),
    events: closedPage(selection.events),
    artifactEdges: closedPage(graph.edges),
    artifactLocations: closedPage(graph.locations),
    taskEvidence: closedPage(selection.taskEvidence),
    workflowEvidence: closedPage(selection.workflowEvidence)
  }
}

function selectGraphRows(
  db: WorkflowLedgerDatabase,
  scope: WorkflowLedgerExportScope,
  artifacts: readonly WorkflowArtifactRecord[],
  events: readonly WorkflowEventRecord[]
): { edges: WorkflowArtifactEdgeRecord[]; locations: WorkflowArtifactLocationRecord[] } {
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const selectedEdgeIds = new Set(
    events
      .filter((event) => event.kind === 'workflow.artifact.edge.created' && event.entityType === 'artifact')
      .map((event) => event.entityId.startsWith('artifact-edge:') ? event.entityId.slice('artifact-edge:'.length) : '')
      .filter(Boolean)
  )
  const selectedLocationIds = new Set(
    events
      .filter((event) => event.kind === 'workflow.artifact.location.created' && event.entityType === 'artifact')
      .map((event) => event.entityId.startsWith('artifact-location:') ? event.entityId.slice('artifact-location:'.length) : '')
      .filter(Boolean)
  )
  const edges = readArtifactEdges(db).filter((edge) =>
    artifactIds.has(edge.fromArtifactId) && artifactIds.has(edge.toArtifactId) &&
    selectedEdgeIds.has(edge.id) && graphScopeMatches(edge, scope)
  )
  const locations = readArtifactLocations(db).filter((location) =>
    artifactIds.has(location.artifactId) &&
    selectedLocationIds.has(location.id) &&
    graphScopeMatches(location, scope)
  )
  return { edges, locations }
}

function graphScopeMatches(
  record: WorkflowArtifactEdgeRecord | WorkflowArtifactLocationRecord,
  scope: WorkflowLedgerExportScope
): boolean {
  // Ownership/artifact selectors have already been resolved into the closed
  // Artifact set. Re-applying them here drops graph rows reached through a
  // second hop or rows that intentionally omit duplicated owner columns.
  return !scope.projectId || record.projectId === scope.projectId
}

function closedPage<T>(items: T[]): { items: T[]; total: number; hasMore: false } {
  return { items, total: items.length, hasMore: false }
}

function sanitizeSelection(
  selection: ReturnType<typeof readCompleteSelection>
): WorkflowLedgerExportSelection {
  return {
    goals: sanitizePage(selection.goals),
    workItems: sanitizePage(selection.workItems),
    runs: {
      items: selection.runs.items.map((run) => {
        const { taskRun, ...metadata } = run
        return sanitizeValue({ ...metadata, taskRunDigest: digest(taskRun) }) as WorkflowLedgerExportRunRecord
      }),
      total: selection.runs.total,
      hasMore: false
    },
    artifacts: sanitizePage(selection.artifacts),
    artifactEdges: sanitizePage(selection.artifactEdges),
    artifactLocations: sanitizePage(selection.artifactLocations),
    acceptances: sanitizePage(selection.acceptances),
    evidenceLinks: sanitizePage(selection.evidenceLinks),
    events: closedPage(selection.events.items.map((event) => sanitizeValue({
      ...event,
      eventId: portableEventId(event.eventId),
      ...(event.causationId ? { causationId: portableEventId(event.causationId) } : {})
    }) as WorkflowEventRecord)),
    taskEvidence: sanitizePage(selection.taskEvidence) as {
      items: WorkflowLedgerExportTaskEvidenceRecord[]
      total: number
      hasMore: false
    },
    workflowEvidence: sanitizePage(selection.workflowEvidence)
  }
}

/**
 * Credential redaction is lossy, so it cannot define event identity. For
 * example, successive `...session:revision:...` IDs redact to the same text.
 * Fingerprint only IDs that need redaction, and use the same mapping for
 * causation references. The opaque identity survives re-export and does not
 * depend on the ledger sequence, which changes when a Project is imported.
 */
function portableEventId(value: string): string {
  return sanitizeString(value) === value
    ? value
    : `workflow-event-redacted:${digest({ eventId: value })}`
}

function sanitizePage<T>(page: { items: T[]; total: number; hasMore: boolean }): {
  items: T[]
  total: number
  hasMore: false
} {
  return {
    items: page.items.map((item) => sanitizeValue(item) as T),
    total: page.total,
    hasMore: false
  }
}

/** Redact credential-bearing fields while retaining audit metadata and digests. */
function sanitizeValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]'
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[REDACTED_CYCLIC_VALUE]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, undefined, seen))
  }
  const output: Record<string, unknown> = {}
  for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
    const childValue = (value as Record<string, unknown>)[childKey]
    if (childValue === undefined) continue
    output[childKey] = sanitizeValue(childValue, childKey, seen)
  }
  return output
}

function isSensitiveKey(key: string | undefined): boolean {
  if (!key) return false
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return /(?:apikey|accesskey|accesstoken|authtoken|authorization|clientsecret|credential|cookie|password|privatekey|refreshtoken|secretaccesskey|securitytoken|sessioncookie|signature|webhooksecret)/i.test(normalized) ||
    /(?:token|secret|password|credential|cookie)$/i.test(normalized)
}

function sanitizeString(value: string): string {
  return redactSensitiveText(value)
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
}

function buildRepairPlan(input: {
  path: string
  exists: boolean
  status: WorkflowLedgerRepairPlan['status']
  diagnostics: WorkflowLedgerRepairDiagnostic[]
  verification?: WorkflowLedgerRepairPlan['verification']
  verificationError?: WorkflowLedgerRepairPlan['verificationError']
  taskEvidenceVerificationError?: WorkflowLedgerRepairPlan['taskEvidenceVerificationError']
  workflowEvidenceVerificationError?: WorkflowLedgerRepairPlan['workflowEvidenceVerificationError']
  artifactGraphVerificationError?: WorkflowLedgerRepairPlan['artifactGraphVerificationError']
}): WorkflowLedgerRepairPlan {
  const hasFailure = input.status !== 'healthy'
  const actions: WorkflowLedgerRepairAction[] = hasFailure
    ? [
      {
        kind: 'backup_database',
        mode: 'recommendation',
        requiresExplicitApproval: true,
        mutatesLedger: false,
        reason: 'Preserve the original bytes before any manual investigation.'
      },
      {
        kind: 'manual_review',
        mode: 'recommendation',
        requiresExplicitApproval: true,
        mutatesLedger: false,
        reason: 'Review the failed verification and restore only from a separately verified backup.'
      }
    ]
    : []
  return {
    schemaVersion: 1,
    format: REPAIR_FORMAT,
    status: input.status,
    readOnly: true,
    canAutoRepair: false,
    writesPerformed: false,
    chainPreserved: true,
    digestRecomputed: false,
    eventsAppended: false,
    databaseExists: input.exists,
    databasePath: input.path,
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.verificationError ? { verificationError: input.verificationError } : {}),
    ...(input.taskEvidenceVerificationError
      ? { taskEvidenceVerificationError: input.taskEvidenceVerificationError }
      : {}),
    ...(input.workflowEvidenceVerificationError
      ? { workflowEvidenceVerificationError: input.workflowEvidenceVerificationError }
      : {}),
    ...(input.artifactGraphVerificationError
      ? { artifactGraphVerificationError: input.artifactGraphVerificationError }
      : {}),
    diagnostics: input.diagnostics,
    backupRecommendation: {
      recommended: true,
      sourcePath: input.path,
      suggestedPath: `${input.path}.backup`,
      reason: hasFailure
        ? 'Create an immutable byte-for-byte backup before any approved repair work.'
        : 'Keep a byte-for-byte backup before future maintenance or migration.'
    },
    proposedActions: actions,
    mutations: []
  }
}

function diagnosticFromError(code: string, error: unknown): WorkflowLedgerRepairDiagnostic {
  const descriptor = errorDescriptor(error)
  return {
    code,
    severity: 'error',
    message: descriptor.message,
    ...(descriptor.seq === undefined ? {} : { seq: descriptor.seq })
  }
}

function errorDescriptor(error: unknown): { code: string; message: string; seq?: number } {
  const value = error as { code?: unknown; message?: unknown; seq?: unknown } | null
  const code = typeof value?.code === 'string' && value.code ? value.code : 'WORKFLOW_LEDGER_MAINTENANCE_ERROR'
  const message = safeErrorMessage(error)
  const seq = typeof value?.seq === 'number' && Number.isInteger(value.seq) ? value.seq : undefined
  return { code, message, ...(seq === undefined ? {} : { seq }) }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return sanitizeString(raw).slice(0, 1000)
}

function toSharedTaskEvidenceVerification(value: TaskEvidenceVerification): WorkflowLedgerTaskEvidenceVerification {
  return {
    valid: true,
    count: value.count,
    lastSeq: value.lastSeq,
    lastDigest: value.lastDigest
  }
}

function requireArtifactGraphVerification(
  verification: WorkflowLedgerVerification
): WorkflowArtifactGraphVerification {
  if (!verification.artifactGraph) {
    throw new Error('Artifact Graph verification result is missing')
  }
  return verification.artifactGraph
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    // A permission or I/O failure means the path may still exist. Only ENOENT
    // is reliable evidence that there is no database to preserve.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function isEntityType(value: unknown): value is WorkflowLedgerScope['entityType'] {
  return value === 'goal' || value === 'work_item' || value === 'run' ||
    value === 'artifact' || value === 'acceptance' || value === 'system'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Keep these imports visible to TypeScript's isolated module checker while
// documenting the projection record shapes used by the sanitised output.
type _ExportRecordShapeCheck =
  | WorkflowGoalRecord
  | WorkflowWorkItemRecord
  | WorkflowRunRecord
  | WorkflowArtifactRecord
  | WorkflowAcceptanceRecord
  | WorkflowEvidenceLinkRecord
  | WorkflowEventRecord

void (undefined as unknown as _ExportRecordShapeCheck)
