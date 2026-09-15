import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  readTaskSnapshotDatabase,
  taskSnapshotsDbFile,
  withTaskSnapshotDatabaseMutationBarrier
} from '../task/task-snapshot'
import {
  assessWorkflowLedgerCanonicalReadiness,
  persistPreparedWorkflowLedgerMigration,
  prepareWorkflowLedgerCanonicalMigration,
  readWorkflowLedgerCanonicalMigrationJournal,
  rollbackWorkflowLedgerCanonicalMigration,
  type PreparedWorkflowLedgerMigration,
  type WorkflowLedgerMigrationCheckpoint,
  type WorkflowLedgerMigrationSource
} from '../task/workflow-ledger-migration'
import {
  cacheWorkflowLedgerTaskStoreReadinessForDatabase
} from '../task/workflow-ledger-migration-readiness-flight'
import {
  openWorkflowLedgerDatabase,
  readWorkflowLedgerStoreVersionStrict
} from '../task/workflow-ledger-readiness'
import { canonicalJson } from '../task/workflow-ledger-codec'
import {
  listMigrationJournals,
  readFileIfExists,
  readRegularFile,
  sha256,
  writeDurableFile
} from '../task/workflow-ledger-migration-storage'
import {
  appendWorkflowEvent,
  projectWorkflowProjectionBatch,
  verifyWorkflowLedger,
  type WorkflowLedgerDatabase
} from '../task/workflow-ledger-store'
import { assertWorkflowAcceptanceGate } from '../task/workflow-acceptance-guard'
import { resolveProjectWorkspaceRoot } from './persistence'
import {
  PROJECT_WORKSPACE_MIGRATION_EVENT_KIND,
  PROJECT_WORKSPACE_MIGRATION_PAYLOAD_FORMAT,
  assertProjectWorkspaceSourceContinuity,
  latestProjectWorkspaceMigration,
  planProjectWorkspaceGoalWrites,
  planProjectWorkspaceWorkItemWrites,
  type ProjectWorkspaceMigrationPayload
} from './ledger-migration-continuity'
import {
  ProjectWorkspaceLedgerMigrationError,
  isDigest,
  isId,
  isRecord,
  migrationError,
  nonNegativeRevision,
  requiredId,
  safeError
} from './ledger-migration-errors'
import {
  assertProjectWorkspaceSourceUnchanged,
  buildProjectWorkspaceMigrationSourceFromState,
  buildProjectWorkspaceProjection,
  parentFirst,
  readProjectWorkspaceMigrationSource,
  validateProjectWorkspaceRunReferences,
  type ProjectionBundle,
  type ProjectWorkspaceSourceValidationMode,
  type SourceFile
} from './ledger-migration-source'
import type { ProjectWorkspaceState } from '../../shared/project-workspace-types'
import {
  validateProjectWorkspaceFileChangeImpact,
  commitProjectWorkspaceFileChangeImpactInDatabase,
  type ProjectWorkspaceFileChangeImpact
} from './file-change-impact'
import { verifyWorkflowArtifactGraph } from '../task/workflow-ledger-artifact-graph-query'

const TASK_STORE_VERSION = 9
const MIGRATION_METADATA_FORMAT = 'caogen.project-workspace-ledger-migration-metadata.v1'
const SOURCE_SIDECAR = 'project-workspace.source.json'
const METADATA_SIDECAR = 'project-workspace-migration.json'

export { ProjectWorkspaceLedgerMigrationError }
export type ProjectWorkspaceLedgerMigrationStatus = 'migrated' | 'already_current'

export interface ProjectWorkspaceLedgerMigrationOptions {
  faultAt?: WorkflowLedgerMigrationCheckpoint
  now?: () => number
}

export interface ProjectWorkspaceCanonicalWriteMigrationOptions extends ProjectWorkspaceLedgerMigrationOptions {
  assertCurrentJsonUnchanged: () => Promise<void>
  fileChangeImpact?: ProjectWorkspaceFileChangeImpact
}

export interface ProjectWorkspaceLedgerMigrationResult {
  status: ProjectWorkspaceLedgerMigrationStatus
  workspaceId: string
  workspaceRevision: number
  stateRevision: number
  sourceSha256: string
  projectionDigest: string
  goals: number
  workItems: number
  migrationId?: string
  journalPath?: string
}

interface ProjectWorkspaceMigrationMetadata {
  format: typeof MIGRATION_METADATA_FORMAT
  migrationId: string
  workspaceId: string
  projectionDigest: string
  sourcePath: string
  sourceSha256: string
  sourceSizeBytes: number
}

interface BridgeJournal {
  prepared: PreparedWorkflowLedgerMigration
  metadata: ProjectWorkspaceMigrationMetadata
}

interface BridgeJournalState {
  committed: BridgeJournal[]
  inProgress: BridgeJournal[]
}

/**
 * JSON remains the write source. The bridge projects one aggregate into the
 * Workflow Ledger without flipping read mode or making JSON read-only.
 */
export async function migrateProjectWorkspaceToWorkflowLedger(
  workspaceId: string,
  rootDir?: string,
  options: ProjectWorkspaceLedgerMigrationOptions = {}
): Promise<ProjectWorkspaceLedgerMigrationResult> {
  return migrateProjectWorkspaceToWorkflowLedgerWithValidation(workspaceId, rootDir, options, 'global')
}

export async function ensureProjectWorkspaceLedgerProjectionForScopedRead(
  workspaceId: string,
  rootDir?: string
): Promise<ProjectWorkspaceLedgerMigrationResult> {
  return migrateProjectWorkspaceToWorkflowLedgerWithValidation(workspaceId, rootDir, {}, 'workspace')
}

/** Recover only an already-verified bridge before a canonical read. */
export async function preflightProjectWorkspaceLedgerBridgeForCanonicalRead(
  workspaceId: string,
  rootDir?: string
): Promise<boolean> {
  const id = requiredId(workspaceId, 'workspace id')
  const root = resolve(resolveProjectWorkspaceRoot(rootDir))
  const databasePath = taskSnapshotsDbFile(root)
  return withTaskSnapshotDatabaseMutationBarrier(root, async () => {
    const journals = await readBridgeJournalState(databasePath, id)
    await assertCommittedBridgeTargetPresent(databasePath, journals.committed)
    const bridge = singleInProgressBridge(journals.inProgress, id)
    if (!bridge || bridge.prepared.journal.state !== 'migrated_verified') return false
    const targetBytes = await readRequiredTarget(databasePath)
    return resumeVerifiedBridgeCandidate(databasePath, bridge, targetBytes, {}, true)
  })
}

export async function commitProjectWorkspaceStateToWorkflowLedger(
  state: ProjectWorkspaceState,
  workspaceId: string,
  rootDir: string | undefined,
  options: ProjectWorkspaceCanonicalWriteMigrationOptions
): Promise<ProjectWorkspaceLedgerMigrationResult> {
  const id = requiredId(workspaceId, 'workspace id')
  const root = resolve(resolveProjectWorkspaceRoot(rootDir))
  const databasePath = taskSnapshotsDbFile(root)
  const journals = await readBridgeJournalState(databasePath, id)

  await assertCommittedBridgeTargetPresent(databasePath, journals.committed)
  if (journals.inProgress.length === 0 && !options.fileChangeImpact) {
    await readTaskSnapshotDatabase(root, () => undefined)
  }

  return withTaskSnapshotDatabaseMutationBarrier(root, async () => {
    await options.assertCurrentJsonUnchanged()
    const source = buildProjectWorkspaceMigrationSourceFromState(state, root, id, 'global')
    const targetBytes = await readRequiredTarget(databasePath)
    await resumeRenamedBridgeCandidate(databasePath, id, targetBytes, options)
    return migrateUnderBarrier(source, databasePath, options)
  })
}

async function migrateProjectWorkspaceToWorkflowLedgerWithValidation(
  workspaceId: string,
  rootDir: string | undefined,
  options: ProjectWorkspaceLedgerMigrationOptions,
  sourceValidation: ProjectWorkspaceSourceValidationMode
): Promise<ProjectWorkspaceLedgerMigrationResult> {
  const id = requiredId(workspaceId, 'workspace id')
  const root = resolve(resolveProjectWorkspaceRoot(rootDir))
  const databasePath = taskSnapshotsDbFile(root)
  const journals = await readBridgeJournalState(databasePath, id)

  await assertCommittedBridgeTargetPresent(databasePath, journals.committed)
  if (journals.inProgress.length === 0) {
    // Bootstrap outside the mutation queue; doing this inside would deadlock.
    await readTaskSnapshotDatabase(root, () => undefined)
  }

  return withTaskSnapshotDatabaseMutationBarrier(root, async () => {
    const source = await readProjectWorkspaceMigrationSource(root, id, sourceValidation)
    const targetBytes = await readRequiredTarget(databasePath)
    await resumeRenamedBridgeCandidate(databasePath, id, targetBytes, options)
    return migrateUnderBarrier(source, databasePath, options)
  })
}

export const ensureProjectWorkspaceLedgerProjection = migrateProjectWorkspaceToWorkflowLedger

async function migrateUnderBarrier(
  source: SourceFile,
  databasePath: string,
  options: ProjectWorkspaceLedgerMigrationOptions
): Promise<ProjectWorkspaceLedgerMigrationResult> {
  const targetBytes = await readRequiredTarget(databasePath)
  const db = await openWorkflowLedgerDatabase(targetBytes)
  let prepared: PreparedWorkflowLedgerMigration | undefined
  try {
    const version = readWorkflowLedgerStoreVersionStrict(db)
    assertSupportedVersion(version)
    const projection = buildProjectWorkspaceProjection(source.aggregate)
    const fileChangeImpact = (options as Partial<ProjectWorkspaceCanonicalWriteMigrationOptions>).fileChangeImpact
    if (fileChangeImpact) {
      if (fileChangeImpact.projectId !== source.aggregate.workspace.id) throw new Error('STUDIO_FILE_CHECK_SCOPE: change impact Project differs')
      validateProjectWorkspaceFileChangeImpact(db, fileChangeImpact, source.state)
    }
    validateProjectWorkspaceRunReferences(db, projection.workItems)
    assertTerminalProjectionAcceptance(db, projection)
    const previous = latestProjectWorkspaceMigration(db, source.aggregate.workspace.id)
    assertProjectWorkspaceSourceContinuity(source, projection, previous)
    const goalWrites = planProjectWorkspaceGoalWrites(db, projection.goals, previous)
    const workItemWrites = planProjectWorkspaceWorkItemWrites(db, projection.workItems, previous)

    if (previous?.projectionDigest === projection.projectionDigest) {
      if (goalWrites.size > 0 || workItemWrites.size > 0) {
        throw migrationError('TARGET_STATE_REGRESSION', 'Workflow Ledger projection regressed after a committed migration')
      }
      await assertMigrationSourceUnchanged(source, options)
      if (fileChangeImpact) verifyWorkflowArtifactGraph(db)
      return migrationResult('already_current', source, projection)
    }

    prepared = await prepareBridgeMigration(databasePath, targetBytes, version, options)
    await ensureBridgeSidecars(prepared, source, projection)
    applyProjection(db, projection, goalWrites, workItemWrites)
    if (fileChangeImpact) commitProjectWorkspaceFileChangeImpactInDatabase(db, fileChangeImpact)
    appendMigrationEvent(db, source, projection, prepared)
    verifyWorkflowLedger(db)
    if (fileChangeImpact) verifyWorkflowArtifactGraph(db)
    const candidateBytes = db.export()
    const report = assessWorkflowLedgerCanonicalReadiness(db, {
      sourceKind: 'sqlite',
      sourcePath: databasePath,
      sourceBytes: candidateBytes,
      assessedAt: prepared.journal.createdAt
    })
    assertCandidateReady(report)
    await assertMigrationSourceUnchanged(source, options)
    const committed = await persistPreparedWorkflowLedgerMigration(prepared, candidateBytes, report, {
      faultAt: options.faultAt,
      now: options.now,
      ...(fileChangeImpact ? { acceptanceChangeImpact: { plan: fileChangeImpact.plan, now: fileChangeImpact.now } } : {}),
      readMode: 'legacy'
    })
    cacheWorkflowLedgerTaskStoreReadinessForDatabase(databasePath, {
      disposition: 'migrated',
      report: committed.journal.readiness ?? report,
      migration: committed
    })
    return {
      ...migrationResult('migrated', source, projection),
      migrationId: committed.migrationId,
      journalPath: committed.journalPath
    }
  } catch (error) {
    if (prepared && isBridgeSidecarWriteFailure(error)) {
      await rollbackWorkflowLedgerCanonicalMigration(prepared.journalPath, {
        expectedTargetPath: databasePath,
        now: options.now
      }).catch(() => undefined)
    }
    throw error
  } finally {
    db.close()
  }
}

function assertMigrationSourceUnchanged(
  source: SourceFile,
  options: ProjectWorkspaceLedgerMigrationOptions
): Promise<void> {
  const canonicalWrite = options as Partial<ProjectWorkspaceCanonicalWriteMigrationOptions>
  return canonicalWrite.assertCurrentJsonUnchanged
    ? canonicalWrite.assertCurrentJsonUnchanged()
    : assertProjectWorkspaceSourceUnchanged(source)
}

async function prepareBridgeMigration(
  databasePath: string,
  targetBytes: Uint8Array,
  version: number,
  options: ProjectWorkspaceLedgerMigrationOptions
): Promise<PreparedWorkflowLedgerMigration> {
  const source: WorkflowLedgerMigrationSource = {
    sourceKind: 'sqlite',
    sourcePath: resolve(databasePath),
    targetPath: resolve(databasePath),
    sourceBytes: targetBytes,
    targetExisted: true
  }
  // Faults are injected only after bridge sidecars identify the journal.
  return prepareWorkflowLedgerCanonicalMigration({
    source,
    migrationPath: 'existing_current',
    mode: 'shadow',
    fromVersion: version,
    toVersion: version,
    now: options.now
  })
}

function applyProjection(
  db: WorkflowLedgerDatabase,
  projection: ProjectionBundle,
  goalWrites: ReadonlySet<string>,
  workItemWrites: ReadonlySet<string>
): void {
  const goals = []
  for (const goal of projection.goals) {
    if (!goalWrites.has(goal.source.id)) continue
    if (goal.source.status === 'archived' && goal.source.archivedFromStatus === 'completed') {
      assertWorkflowAcceptanceGate(db, { kind: 'goal', record: goal.record })
    }
    goals.push(goal.input)
  }
  const workItems = parentFirst(projection.workItems)
    .filter((item) => workItemWrites.has(item.source.id))
    .map((item) => item.input)
  projectWorkflowProjectionBatch(db, { goals, workItems }, { enforceTransition: false })
}

function assertTerminalProjectionAcceptance(db: WorkflowLedgerDatabase, projection: ProjectionBundle): void {
  for (const goal of projection.goals) {
    if (goal.source.status === 'completed' ||
        (goal.source.status === 'archived' && goal.source.archivedFromStatus === 'completed')) {
      assertWorkflowAcceptanceGate(db, { kind: 'goal', record: goal.record })
    }
  }
  for (const item of projection.workItems) {
    if (item.source.status === 'done') {
      assertWorkflowAcceptanceGate(db, { kind: 'work_item', record: item.record })
    }
  }
}

function appendMigrationEvent(
  db: WorkflowLedgerDatabase,
  source: SourceFile,
  projection: ProjectionBundle,
  prepared: PreparedWorkflowLedgerMigration
): void {
  const workspace = source.aggregate.workspace
  const payload: ProjectWorkspaceMigrationPayload = {
    format: PROJECT_WORKSPACE_MIGRATION_PAYLOAD_FORMAT,
    migrationId: prepared.migrationId,
    journalPath: prepared.journalPath,
    sqliteBackupPath: prepared.backupPath,
    workspaceId: workspace.id,
    workspaceRevision: workspace.revision,
    stateRevision: source.state.revision,
    workspaceDigest: projection.workspaceDigest,
    projectionDigest: projection.projectionDigest,
    source: {
      path: source.path,
      sha256: source.sha256,
      sizeBytes: source.bytes.byteLength,
      backupPath: join(dirname(prepared.journalPath), SOURCE_SIDECAR)
    },
    workspace,
    goals: projection.goals.map((item) => item.descriptor),
    workItems: projection.workItems.map((item) => item.descriptor)
  }
  appendWorkflowEvent(db, {
    eventId: `workflow:project-workspace:${workspace.id}:revision:${workspace.revision}:projection:${projection.projectionDigest}`,
    streamId: `project-workspace:${workspace.id}`,
    entityType: 'system',
    entityId: workspace.id,
    kind: PROJECT_WORKSPACE_MIGRATION_EVENT_KIND,
    payload: { ...payload },
    occurredAt: prepared.journal.createdAt,
    correlationId: prepared.migrationId
  }, { projectId: workspace.id })
}

async function ensureBridgeSidecars(
  prepared: PreparedWorkflowLedgerMigration,
  source: SourceFile,
  projection: ProjectionBundle
): Promise<void> {
  const directory = dirname(prepared.journalPath)
  const metadata: ProjectWorkspaceMigrationMetadata = {
    format: MIGRATION_METADATA_FORMAT,
    migrationId: prepared.migrationId,
    workspaceId: source.aggregate.workspace.id,
    projectionDigest: projection.projectionDigest,
    sourcePath: source.path,
    sourceSha256: source.sha256,
    sourceSizeBytes: source.bytes.byteLength
  }
  await ensureDurableBytes(join(directory, SOURCE_SIDECAR), source.bytes, 'ProjectWorkspace source sidecar')
  await ensureDurableBytes(
    join(directory, METADATA_SIDECAR),
    Buffer.from(`${canonicalJson(metadata)}\n`, 'utf8'),
    'ProjectWorkspace migration metadata'
  )
}

async function ensureDurableBytes(path: string, bytes: Uint8Array, label: string): Promise<void> {
  const existing = await readFileIfExists(path)
  if (existing) {
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes)) {
      throw migrationError('SOURCE_DRIFT_DURING_MIGRATION', `${label} differs from the durable migration source`)
    }
    return
  }
  try {
    await writeDurableFile(path, bytes, { replace: false })
  } catch (error) {
    const wrapped = migrationError('SIDECAR_WRITE_FAILED', `${label} could not be persisted: ${safeError(error)}`)
    Object.defineProperty(wrapped, 'bridgeSidecarWriteFailure', { value: true })
    throw wrapped
  }
}

function isBridgeSidecarWriteFailure(error: unknown): boolean {
  return Boolean(isRecord(error) && error.bridgeSidecarWriteFailure === true)
}

async function readRequiredTarget(databasePath: string): Promise<Buffer> {
  const bytes = await readFileIfExists(databasePath)
  if (!bytes) throw migrationError('TARGET_MISSING', `Workflow Ledger target is missing: ${databasePath}`)
  return bytes
}

async function readBridgeJournalState(
  databasePath: string,
  workspaceId: string
): Promise<BridgeJournalState> {
  const root = join(dirname(resolve(databasePath)), 'backups', 'workflow-ledger')
  const journals = await listMigrationJournals(root)
  const result: BridgeJournalState = { committed: [], inProgress: [] }
  for (const entry of journals) {
    if (entry.journal.targetPath !== resolve(databasePath) || entry.journal.state === 'rolled_back') continue
    const metadataBytes = await readFileIfExists(join(dirname(entry.path), METADATA_SIDECAR))
    if (!metadataBytes) continue
    const metadata = parseMigrationMetadata(metadataBytes)
    if (metadata.workspaceId !== workspaceId) continue
    const bridge = { prepared: toPrepared(entry.path, entry.journal), metadata }
    result[entry.journal.state === 'committed' ? 'committed' : 'inProgress'].push(bridge)
  }
  for (const matches of [result.committed, result.inProgress]) {
    matches.sort((left, right) => right.prepared.journal.updatedAt - left.prepared.journal.updatedAt)
  }
  return result
}

function toPrepared(
  journalPath: string,
  journal: PreparedWorkflowLedgerMigration['journal']
): PreparedWorkflowLedgerMigration {
  return {
    migrationId: journal.migrationId,
    journalPath,
    backupPath: journal.backup.path,
    journal,
    alreadyCommitted: journal.state === 'committed'
  }
}

function parseMigrationMetadata(bytes: Uint8Array): ProjectWorkspaceMigrationMetadata {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    throw migrationError('MIGRATION_METADATA_INVALID', `ProjectWorkspace migration metadata is invalid: ${safeError(error)}`)
  }
  if (!isRecord(value) || value.format !== MIGRATION_METADATA_FORMAT || !isId(value.migrationId) ||
      !isId(value.workspaceId) || !isDigest(value.projectionDigest) || !isId(value.sourcePath) ||
      !isDigest(value.sourceSha256) || !nonNegativeRevision(value.sourceSizeBytes)) {
    throw migrationError('MIGRATION_METADATA_INVALID', 'ProjectWorkspace migration metadata is invalid')
  }
  return value as unknown as ProjectWorkspaceMigrationMetadata
}

async function assertCommittedBridgeTargetPresent(
  databasePath: string,
  committed: readonly BridgeJournal[]
): Promise<void> {
  if (committed.length === 0) return
  try {
    const info = await lstat(databasePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw migrationError('COMMITTED_TARGET_INVALID', 'Committed ProjectWorkspace Ledger target is not a regular file')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw migrationError('COMMITTED_TARGET_MISSING', 'Committed ProjectWorkspace Ledger target is missing')
    }
    throw error
  }
}

async function resumeRenamedBridgeCandidate(
  databasePath: string,
  workspaceId: string,
  targetBytes: Uint8Array,
  options: ProjectWorkspaceLedgerMigrationOptions
): Promise<boolean> {
  const { inProgress } = await readBridgeJournalState(databasePath, workspaceId)
  const bridge = singleInProgressBridge(inProgress, workspaceId)
  if (!bridge || bridge.prepared.journal.state !== 'migrated_verified') return false
  return resumeVerifiedBridgeCandidate(databasePath, bridge, targetBytes, options, false)
}

function singleInProgressBridge(
  inProgress: readonly BridgeJournal[],
  workspaceId: string
): BridgeJournal | undefined {
  if (inProgress.length > 1) {
    throw migrationError('MIGRATION_JOURNAL_CONFLICT', `Workspace ${workspaceId} has multiple in-progress Ledger migrations`)
  }
  return inProgress[0]
}

async function resumeVerifiedBridgeCandidate(
  databasePath: string,
  bridge: BridgeJournal,
  targetBytes: Uint8Array,
  options: ProjectWorkspaceLedgerMigrationOptions,
  installCandidate: boolean
): Promise<boolean> {
  const journal = await readWorkflowLedgerCanonicalMigrationJournal(bridge.prepared.journalPath)
  if (journal.state !== 'migrated_verified') return false
  if (!journal.candidate || !journal.migrated || !journal.readiness) {
    throw migrationError('MIGRATION_JOURNAL_INVALID', 'Verified ProjectWorkspace migration is missing candidate evidence')
  }
  const targetIsCandidate = sha256(targetBytes) === journal.migrated.sha256
  if (!targetIsCandidate && !installCandidate) return false
  const candidateBytes = targetIsCandidate
    ? targetBytes
    : await readRegularFile(journal.candidate.path, 'verified ProjectWorkspace migration candidate')
  const committed = await persistPreparedWorkflowLedgerMigration(
    { ...bridge.prepared, journal },
    candidateBytes,
    journal.readiness,
    { now: options.now, readMode: 'legacy' }
  )
  cacheWorkflowLedgerTaskStoreReadinessForDatabase(databasePath, {
    disposition: 'migrated',
    report: committed.journal.readiness ?? journal.readiness,
    migration: committed
  })
  return true
}

function migrationResult(
  status: ProjectWorkspaceLedgerMigrationStatus,
  source: SourceFile,
  projection: ProjectionBundle
): ProjectWorkspaceLedgerMigrationResult {
  return {
    status,
    workspaceId: source.aggregate.workspace.id,
    workspaceRevision: source.aggregate.workspace.revision,
    stateRevision: source.state.revision,
    sourceSha256: source.sha256,
    projectionDigest: projection.projectionDigest,
    goals: projection.goals.length,
    workItems: projection.workItems.length
  }
}

function assertSupportedVersion(version: number): void {
  if (version !== TASK_STORE_VERSION) {
    throw migrationError(
      'TARGET_VERSION_UNSUPPORTED',
      `ProjectWorkspace migration requires task store v${TASK_STORE_VERSION}; found v${version}`
    )
  }
}

function assertCandidateReady(report: ReturnType<typeof assessWorkflowLedgerCanonicalReadiness>): void {
  if (report.safeForShadowUse) return
  throw migrationError(
    'CANDIDATE_NOT_READY',
    `ProjectWorkspace candidate is not safe for Workflow Ledger shadow use: ${report.diagnostics
      .map((item) => item.code)
      .join(', ')}`
  )
}
