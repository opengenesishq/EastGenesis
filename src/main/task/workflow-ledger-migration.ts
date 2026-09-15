import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  assertFileDigest,
  fileDigest,
  listMigrationJournals,
  pathExists,
  publishDurableDirectory,
  readFileIfExists,
  readMigrationJournal,
  readRegularFile,
  sha256,
  syncDirectory,
  writeDurableFile,
  writeMigrationJournal
} from './workflow-ledger-migration-storage'
import {
  assessWorkflowLedgerCanonicalReadiness,
  assessWorkflowLedgerCanonicalReadinessFile,
  openWorkflowLedgerDatabase,
  readWorkflowLedgerStoreVersionStrict,
  validateLegacyJsonMigrationSource
} from './workflow-ledger-readiness'
import { assertWorkflowLedgerMigrationPreservesSource } from './workflow-ledger-migration-preservation'
import { digest } from './workflow-ledger-codec'
import {
  assertCommittedWorkflowLedgerTargetContinuity,
  findCommittedWorkflowLedgerMigration
} from './workflow-ledger-migration-continuity'
import type { WorkflowLedgerReadMode } from './workflow-ledger-recovery'
import { workflowLedgerReadinessSupportsMode } from './workflow-ledger-migration-read-mode'
import {
  clearWorkflowLedgerMigrationSingleFlightForDatabase,
  clearWorkflowLedgerMigrationSingleFlightForTests,
  ensureWorkflowLedgerTaskStoreReadySingleFlight
} from './workflow-ledger-migration-readiness-flight'
import {
  assertMigrationCandidateReadiness,
  selectMigrationMode
} from './workflow-ledger-migration-policy'
import {
  WORKFLOW_LEDGER_MIGRATION_JOURNAL_FORMAT,
  WORKFLOW_LEDGER_MIGRATION_KIND,
  WORKFLOW_LEDGER_MIGRATION_VERSION,
  WorkflowLedgerMigrationError,
  WorkflowLedgerMigrationFault,
  type EnsureWorkflowLedgerTaskStoreReadyOptions,
  type PreparedWorkflowLedgerMigration,
  type WorkflowLedgerCanonicalMigrationJournal,
  type WorkflowLedgerCanonicalReadinessReport,
  type WorkflowLedgerMigrationCheckpoint,
  type WorkflowLedgerMigrationFaultOptions,
  type WorkflowLedgerMigrationFileDigest,
  type WorkflowLedgerMigrationMode,
  type WorkflowLedgerMigrationPath,
  type WorkflowLedgerRollbackOptions,
  type WorkflowLedgerMigrationSource,
  type WorkflowLedgerMigrationState,
  type WorkflowLedgerTaskStoreReadiness
} from './workflow-ledger-migration-types'

export * from './workflow-ledger-migration-types'
export { assessWorkflowLedgerCanonicalReadiness, assessWorkflowLedgerCanonicalReadinessFile }
export { workflowLedgerReadinessSupportsMode } from './workflow-ledger-migration-read-mode'

const BACKUP_DIR = join('backups', 'workflow-ledger')

/** Discover the actual pre-migration source, including legacy JSON when SQLite is absent. */
export async function discoverWorkflowLedgerMigrationSource(input: {
  databasePath: string
  legacyJsonPath: string
}): Promise<WorkflowLedgerMigrationSource> {
  const targetPath = resolve(input.databasePath)
  if (await pathExists(targetPath)) {
    return {
      sourceKind: 'sqlite',
      sourcePath: targetPath,
      targetPath,
      sourceBytes: await readRegularFile(targetPath, 'task snapshot database'),
      targetExisted: true
    }
  }
  const legacyPath = resolve(input.legacyJsonPath)
  if (await pathExists(legacyPath)) {
    return {
      sourceKind: 'legacy_json',
      sourcePath: legacyPath,
      targetPath,
      sourceBytes: await readRegularFile(legacyPath, 'legacy task snapshot JSON'),
      targetExisted: false
    }
  }
  return {
    sourceKind: 'empty',
    sourcePath: targetPath,
    targetPath,
    sourceBytes: new Uint8Array(),
    targetExisted: false
  }
}

/**
 * Single-flight gate intended to wrap the first task-store open in a process.
 * It finishes strict preflight or a reversible shadow migration before any
 * caller receives permission to continue with ordinary reads/writes.
 */
export function ensureWorkflowLedgerTaskStoreReady(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions
): Promise<WorkflowLedgerTaskStoreReadiness> {
  return ensureWorkflowLedgerTaskStoreReadySingleFlight(options, ensureTaskStoreReady)
}

export { clearWorkflowLedgerMigrationSingleFlightForTests }

export async function prepareWorkflowLedgerCanonicalMigration(input: {
  source: WorkflowLedgerMigrationSource
  migrationPath: WorkflowLedgerMigrationPath
  mode?: WorkflowLedgerMigrationMode
  fromVersion: number
  toVersion: number
  backupsRoot?: string
} & WorkflowLedgerMigrationFaultOptions): Promise<PreparedWorkflowLedgerMigration> {
  validateVersionBoundary(input.fromVersion, input.toVersion)
  const source = normalizedSource(input.source)
  const root = resolve(input.backupsRoot ?? join(dirname(source.targetPath), BACKUP_DIR))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const reusable = await findReusableJournal(root, source, input.migrationPath, input.toVersion)
  if (reusable) return resumePreparedJournal(reusable, input)

  const now = input.now?.() ?? Date.now()
  const migrationId = `${WORKFLOW_LEDGER_MIGRATION_KIND}-v${WORKFLOW_LEDGER_MIGRATION_VERSION}-${sha256(
    Buffer.from(`${source.targetPath}\0${source.sourcePath}\0${source.sourceKind}\0${sha256(source.sourceBytes)}`)
  ).slice(0, 20)}-${randomUUID().slice(0, 8)}`
  const directory = join(root, migrationId)
  const creatingDirectory = join(root, `.creating-${migrationId}-${randomUUID().slice(0, 8)}`)
  await mkdir(creatingDirectory, { recursive: false, mode: 0o700 })
  const backupPath = join(directory, backupName(source))
  const journalPath = join(directory, 'journal.json')
  const creatingJournalPath = join(creatingDirectory, 'journal.json')
  let journal: WorkflowLedgerCanonicalMigrationJournal = {
    schemaVersion: 1,
    format: WORKFLOW_LEDGER_MIGRATION_JOURNAL_FORMAT,
    migrationKind: WORKFLOW_LEDGER_MIGRATION_KIND,
    migrationVersion: WORKFLOW_LEDGER_MIGRATION_VERSION,
    migrationId,
    migrationPath: input.migrationPath,
    mode: input.mode ?? 'shadow',
    state: 'prepared',
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    sourceKind: source.sourceKind,
    sourcePath: source.sourcePath,
    targetPath: source.targetPath,
    targetExisted: source.targetExisted,
    source: fileDigest(source.sourcePath, source.sourceBytes),
    backup: fileDigest(backupPath, source.sourceBytes),
    createdAt: now,
    updatedAt: now,
    transitions: [{ state: 'prepared', at: now }]
  }
  try {
    await writeMigrationJournal(creatingJournalPath, journal)
    await publishDurableDirectory(creatingDirectory, directory)
  } catch (error) {
    await rm(creatingDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  hitFault(input.faultAt, 'after_prepared_journal')
  await writeDurableFile(backupPath, source.sourceBytes, { replace: false })
  hitFault(input.faultAt, 'after_backup_write')
  await assertFileDigest(journal.backup, 'migration backup')
  journal = transitionJournal(journal, 'backup_verified', input.now)
  await writeMigrationJournal(journalPath, journal)
  hitFault(input.faultAt, 'after_backup_verified')
  return { migrationId, journalPath, backupPath, journal, alreadyCommitted: false }
}

export async function persistPreparedWorkflowLedgerMigration(
  prepared: PreparedWorkflowLedgerMigration,
  candidateBytes: Uint8Array,
  report: WorkflowLedgerCanonicalReadinessReport,
  options: WorkflowLedgerMigrationFaultOptions & {
    readMode?: WorkflowLedgerReadMode
    acceptanceChangeImpact?: import('./workflow-ledger-migration-types').WorkflowLedgerMigrationAcceptanceChangeImpact
  } = {}
): Promise<PreparedWorkflowLedgerMigration> {
  let journal = await readWorkflowLedgerCanonicalMigrationJournal(prepared.journalPath)
  assertJournalIdentity(journal, prepared)
  if (options.acceptanceChangeImpact) {
    const sameImpact = journal.acceptanceChangeImpact && digest(journal.acceptanceChangeImpact) === digest(options.acceptanceChangeImpact)
    if (journal.acceptanceChangeImpact && !sameImpact) {
      throw new WorkflowLedgerMigrationError('MIGRATION_CANDIDATE_DRIFT', 'Acceptance change impact differs from its durable migration journal')
    }
    if (!journal.acceptanceChangeImpact) {
      if (journal.state !== 'prepared' && journal.state !== 'backup_verified') {
        throw new WorkflowLedgerMigrationError('MIGRATION_CANDIDATE_DRIFT', 'Cannot add Acceptance invalidation to an existing candidate')
      }
      journal = { ...journal, acceptanceChangeImpact: structuredClone(options.acceptanceChangeImpact) }
      await writeMigrationJournal(prepared.journalPath, journal)
    }
  }
  if (journal.state === 'committed') {
    if (!journal.readiness) {
      throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_INVALID', 'Committed migration has no readiness evidence')
    }
    assertMigrationCandidateReadiness(journal.readiness, journal.mode)
    return { ...prepared, journal, alreadyCommitted: true }
  }
  if (journal.state === 'rollback_pending') {
    throw new WorkflowLedgerMigrationError('MIGRATION_ROLLBACK_PENDING', 'A migration rollback is pending')
  }
  if (journal.state === 'rolled_back') {
    throw new WorkflowLedgerMigrationError('MIGRATION_ROLLED_BACK', 'A rolled-back migration cannot be committed')
  }
  const candidate = Buffer.from(candidateBytes)
  const verifiedReport = await verifyCandidateReport(journal, candidate, report)
  const migrated = fileDigest(journal.targetPath, candidate)
  if (journal.migrated && journal.migrated.sha256 !== migrated.sha256) {
    throw new WorkflowLedgerMigrationError('MIGRATION_CANDIDATE_DRIFT', 'Resumed candidate digest differs from journal')
  }
  const candidateFile = fileDigest(
    journal.candidate?.path ?? join(dirname(prepared.journalPath), 'candidate.sqlite'),
    candidate
  )
  if (journal.candidate && journal.candidate.sha256 !== candidateFile.sha256) {
    throw new WorkflowLedgerMigrationError('MIGRATION_CANDIDATE_DRIFT', 'Resumed candidate bytes differ from journal')
  }
  await assertFileDigest(journal.backup, 'migration backup')
  const backupBytes = await readRegularFile(journal.backup.path, 'migration backup')
  await assertWorkflowLedgerMigrationPreservesSource({
    sourceKind: journal.sourceKind,
    sourcePath: journal.sourcePath,
    targetPath: journal.targetPath,
    sourceBytes: backupBytes,
    targetExisted: journal.targetExisted
  }, candidate, journal.acceptanceChangeImpact)
  await assertOriginalSourceUnchangedOrCandidatePresent(journal, migrated)

  if (journal.state === 'prepared') {
    journal = transitionJournal(journal, 'backup_verified', options.now)
    await writeMigrationJournal(prepared.journalPath, journal)
  }
  if (journal.state === 'backup_verified') {
    await writeDurableFile(candidateFile.path, candidate, { replace: true })
    await assertFileDigest(candidateFile, 'verified migration candidate')
    journal = transitionJournal(
      { ...journal, candidate: candidateFile, migrated, readiness: verifiedReport },
      'migrated_verified',
      options.now
    )
    await writeMigrationJournal(prepared.journalPath, journal)
    hitFault(options.faultAt, 'after_migrated_verified')
  }
  if (!journal.candidate) {
    throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_INVALID', 'Verified migration has no durable candidate')
  }
  await assertFileDigest(journal.candidate, 'verified migration candidate')

  const currentTarget = await readFileIfExists(journal.targetPath)
  const alreadyRenamed = currentTarget !== null && sha256(currentTarget) === migrated.sha256
  if (!alreadyRenamed) {
    hitFault(options.faultAt, 'before_source_rename')
    await writeDurableFile(journal.targetPath, candidate, { replace: true })
    hitFault(options.faultAt, 'after_source_rename')
  }
  await assertFileDigest(migrated, 'migrated task database')
  hitFault(options.faultAt, 'before_journal_commit')
  journal = transitionJournal({ ...journal, migrated, readiness: verifiedReport }, 'committed', options.now)
  journal = { ...journal, committedAt: journal.updatedAt }
  await writeMigrationJournal(prepared.journalPath, journal)
  hitFault(options.faultAt, 'after_journal_commit')
  return { ...prepared, journal, alreadyCommitted: false }
}

export async function rollbackWorkflowLedgerCanonicalMigration(
  journalPath: string,
  options: WorkflowLedgerRollbackOptions
): Promise<WorkflowLedgerCanonicalMigrationJournal> {
  let journal = await readWorkflowLedgerCanonicalMigrationJournal(journalPath)
  if (resolve(options.expectedTargetPath) !== journal.targetPath) {
    throw new WorkflowLedgerMigrationError(
      'MIGRATION_TARGET_MISMATCH',
      'Rollback target does not match the caller-authorized task database path'
    )
  }
  clearWorkflowLedgerMigrationSingleFlightForDatabase(journal.targetPath)
  if (journal.state === 'rolled_back') {
    clearWorkflowLedgerMigrationSingleFlightForDatabase(journal.targetPath)
    return journal
  }
  if (journal.state === 'prepared') {
    const resumed = await resumePreparedJournal({ path: resolve(journalPath), journal }, options)
    journal = resumed.journal
  }
  await assertFileDigest(journal.backup, 'migration rollback backup')
  await assertRollbackDigestGate(journal)
  if (journal.state !== 'rollback_pending') {
    journal = transitionJournal(journal, 'rollback_pending', options.now)
    journal = { ...journal, rollbackPreparedAt: journal.updatedAt }
    await writeMigrationJournal(resolve(journalPath), journal)
    clearWorkflowLedgerMigrationSingleFlightForDatabase(journal.targetPath)
  }
  hitFault(options.faultAt, 'before_rollback_source_change')

  const backupBytes = await readFile(journal.backup.path)
  if (journal.sourceKind === 'sqlite') {
    await writeDurableFile(journal.targetPath, backupBytes, { replace: true })
  } else {
    await restoreNonSqliteSource(journal, backupBytes)
  }
  hitFault(options.faultAt, 'after_rollback_source_change')
  await assertRestoredSource(journal)
  hitFault(options.faultAt, 'before_rollback_journal_commit')
  journal = transitionJournal(journal, 'rolled_back', options.now)
  journal = { ...journal, rolledBackAt: journal.updatedAt }
  await writeMigrationJournal(resolve(journalPath), journal)
  hitFault(options.faultAt, 'after_rollback_journal_commit')
  clearWorkflowLedgerMigrationSingleFlightForDatabase(journal.targetPath)
  return journal
}

export async function readWorkflowLedgerCanonicalMigrationJournal(
  journalPath: string
): Promise<WorkflowLedgerCanonicalMigrationJournal> {
  const path = resolve(journalPath)
  return readMigrationJournal(path)
}

async function ensureTaskStoreReady(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions
): Promise<WorkflowLedgerTaskStoreReadiness> {
  const source = await discoverWorkflowLedgerMigrationSource(options)
  if (source.sourceKind === 'sqlite') {
    const db = await openWorkflowLedgerDatabase(source.sourceBytes)
    let version: number
    let report: WorkflowLedgerCanonicalReadinessReport
    try {
      version = readWorkflowLedgerStoreVersionStrict(db)
      if (version > options.supportedStoreVersion) {
        throw new WorkflowLedgerMigrationError(
          'FUTURE_SCHEMA',
          `任务快照数据库版本过新:${version} > ${options.supportedStoreVersion}`
        )
      }
      report = assessWorkflowLedgerCanonicalReadiness(db, {
        ...source,
        assessedAt: options.now?.()
      })
    } finally {
      db.close()
    }
    const committed = await findCommittedWorkflowLedgerMigration(options, source.targetPath)
    assertCommittedWorkflowLedgerTargetContinuity({
      currentVersion: version,
      current: report,
      committed
    })
    const resumed = await findInProgressForTarget(options, source)
    if (resumed) return resumeTaskStoreMigration(options, source, resumed)
    if (version === options.targetStoreVersion) {
      if (report.safeForShadowUse || report.readyForCanonicalRead) {
        return { disposition: 'ready_existing_current', report }
      }
    }
    const mode = selectMigrationMode(report)
    const prepared = await prepareWorkflowLedgerCanonicalMigration({
      source,
      migrationPath: mode === 'canonical'
        ? 'canonical_upgrade'
        : version === options.targetStoreVersion ? 'existing_current' : 'legacy_upgrade',
      mode,
      fromVersion: version,
      toVersion: options.targetStoreVersion,
      backupsRoot: options.backupsRoot,
      faultAt: options.faultAt,
      now: options.now
    })
    return migratePreparedSource(options, source, prepared)
  }

  if (source.sourceKind === 'legacy_json') validateLegacyJsonMigrationSource(source.sourceBytes)
  const resumed = await findInProgressForTarget(options, source)
  if (resumed) return resumeTaskStoreMigration(options, source, resumed)
  const prepared = await prepareWorkflowLedgerCanonicalMigration({
    source,
    migrationPath: 'legacy_upgrade',
    mode: 'shadow',
    fromVersion: 0,
    toVersion: options.targetStoreVersion,
    backupsRoot: options.backupsRoot,
    faultAt: options.faultAt,
    now: options.now
  })
  return migratePreparedSource(options, source, prepared)
}

async function migratePreparedSource(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions,
  source: WorkflowLedgerMigrationSource,
  prepared: PreparedWorkflowLedgerMigration
): Promise<WorkflowLedgerTaskStoreReadiness> {
  const candidateBytes = await options.buildCandidate(source)
  const candidateDb = await openWorkflowLedgerDatabase(candidateBytes)
  let report: WorkflowLedgerCanonicalReadinessReport
  try {
    const version = readWorkflowLedgerStoreVersionStrict(candidateDb)
    if (version !== options.targetStoreVersion) {
      throw new WorkflowLedgerMigrationError(
        'MIGRATION_VERSION_MISMATCH',
        `Candidate store version ${version} does not match target ${options.targetStoreVersion}`
      )
    }
    report = assessWorkflowLedgerCanonicalReadiness(candidateDb, {
      sourceKind: 'sqlite',
      sourcePath: source.targetPath,
      sourceBytes: candidateBytes,
      assessedAt: options.now?.()
    })
  } finally {
    candidateDb.close()
  }
  assertMigrationCandidateReadiness(report, prepared.journal.mode)
  const migration = await persistPreparedWorkflowLedgerMigration(prepared, candidateBytes, report, options)
  return { disposition: 'migrated', report, migration }
}

async function resumeTaskStoreMigration(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions,
  discovered: WorkflowLedgerMigrationSource,
  prepared: PreparedWorkflowLedgerMigration
): Promise<WorkflowLedgerTaskStoreReadiness> {
  if (prepared.journal.state === 'prepared') {
    prepared = await resumePreparedJournal(
      { path: prepared.journalPath, journal: prepared.journal },
      options
    )
  }
  const journal = prepared.journal
  if (journal.state === 'rollback_pending') {
    await rollbackWorkflowLedgerCanonicalMigration(prepared.journalPath, {
      ...options,
      expectedTargetPath: options.databasePath
    })
    throw new WorkflowLedgerMigrationError(
      'MIGRATION_ROLLBACK_COMPLETED',
      'Interrupted Workflow Ledger rollback was completed; task-store open remains blocked for this attempt'
    )
  }
  if (journal.state === 'committed') {
    if (discovered.sourceKind !== 'sqlite') {
      throw new WorkflowLedgerMigrationError('COMMITTED_TARGET_MISSING', 'Committed migration target is missing')
    }
    const report = await assessWorkflowLedgerCanonicalReadinessFile(journal.targetPath, {
      assessedAt: options.now?.()
    })
    assertMigrationCandidateReadiness(report, journal.mode)
    return { disposition: 'migrated', report, migration: { ...prepared, alreadyCommitted: true } }
  }
  if (journal.state === 'migrated_verified' && journal.migrated) {
    const target = await readFileIfExists(journal.targetPath)
    if (target && sha256(target) === journal.migrated.sha256) {
      const report = await assessWorkflowLedgerCanonicalReadinessFile(journal.targetPath, {
        assessedAt: options.now?.()
      })
      assertMigrationCandidateReadiness(report, journal.mode)
      const committed = await persistPreparedWorkflowLedgerMigration(prepared, target, report, options)
      return { disposition: 'migrated', report, migration: committed }
    }
    await assertFileDigest(journal.backup, 'migration backup')
    await assertResumeSourceIdentity(discovered, journal)
    if (!journal.candidate || !journal.readiness) {
      throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_INVALID', 'Verified migration is missing candidate evidence')
    }
    await assertFileDigest(journal.candidate, 'verified migration candidate')
    const candidateBytes = await readRegularFile(journal.candidate.path, 'verified migration candidate')
    const committed = await persistPreparedWorkflowLedgerMigration(
      prepared,
      candidateBytes,
      journal.readiness,
      options
    )
    return { disposition: 'migrated', report: committed.journal.readiness!, migration: committed }
  }
  await assertFileDigest(journal.backup, 'migration backup')
  await assertResumeSourceIdentity(discovered, journal)
  const backupBytes = await readFile(journal.backup.path)
  const source: WorkflowLedgerMigrationSource = {
    sourceKind: journal.sourceKind,
    sourcePath: journal.sourcePath,
    targetPath: journal.targetPath,
    sourceBytes: backupBytes,
    targetExisted: journal.targetExisted
  }
  return migratePreparedSource(options, source, prepared)
}

async function findInProgressForTarget(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions,
  source: WorkflowLedgerMigrationSource
): Promise<PreparedWorkflowLedgerMigration | null> {
  const root = resolve(options.backupsRoot ?? join(dirname(source.targetPath), BACKUP_DIR))
  const journals = await listMigrationJournals(root)
  const matching = journals
    .filter(({ journal }) => journal.migrationKind === WORKFLOW_LEDGER_MIGRATION_KIND &&
      journal.migrationVersion === WORKFLOW_LEDGER_MIGRATION_VERSION &&
      journal.targetPath === source.targetPath &&
      journal.toVersion === options.targetStoreVersion &&
      journal.state !== 'rolled_back' &&
      (journal.state !== 'committed' || source.sourceKind !== 'sqlite'))
    .sort((left, right) => right.journal.updatedAt - left.journal.updatedAt)
  const found = matching[0]
  if (!found) return null
  return {
    migrationId: found.journal.migrationId,
    journalPath: found.path,
    backupPath: found.journal.backup.path,
    journal: found.journal,
    alreadyCommitted: found.journal.state === 'committed'
  }
}

async function verifyCandidateReport(
  journal: WorkflowLedgerCanonicalMigrationJournal,
  candidate: Uint8Array,
  supplied: WorkflowLedgerCanonicalReadinessReport
): Promise<WorkflowLedgerCanonicalReadinessReport> {
  if (supplied.sourceKind !== 'sqlite' || resolve(supplied.sourcePath) !== journal.targetPath ||
      supplied.sourceSha256 !== sha256(candidate) || supplied.sourceSizeBytes !== candidate.byteLength ||
      !Number.isFinite(supplied.assessedAt)) {
    throw new WorkflowLedgerMigrationError(
      'MIGRATION_REPORT_MISMATCH',
      'Candidate readiness report is not bound to the migration target bytes'
    )
  }
  const db = await openWorkflowLedgerDatabase(candidate)
  let verified: WorkflowLedgerCanonicalReadinessReport
  try {
    const version = readWorkflowLedgerStoreVersionStrict(db)
    if (version !== journal.toVersion) {
      throw new WorkflowLedgerMigrationError(
        'MIGRATION_VERSION_MISMATCH',
        `Candidate store version ${version} does not match target ${journal.toVersion}`
      )
    }
    verified = assessWorkflowLedgerCanonicalReadiness(db, {
      sourceKind: 'sqlite',
      sourcePath: journal.targetPath,
      sourceBytes: candidate,
      assessedAt: supplied.assessedAt
    })
  } finally {
    db.close()
  }
  if (verified.reportDigest !== supplied.reportDigest) {
    throw new WorkflowLedgerMigrationError('MIGRATION_REPORT_MISMATCH', 'Candidate readiness report failed strict revalidation')
  }
  assertMigrationCandidateReadiness(verified, journal.mode, 'MIGRATION_CANDIDATE_BLOCKED')
  return verified
}

async function assertResumeSourceIdentity(
  discovered: WorkflowLedgerMigrationSource,
  journal: WorkflowLedgerCanonicalMigrationJournal
): Promise<void> {
  const target = await readFileIfExists(journal.targetPath)
  if (journal.targetExisted) {
    if (discovered.sourceKind !== 'sqlite' || !target || sha256(target) !== journal.source.sha256) {
      throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_DRIFT', 'Task database changed after migration backup')
    }
    return
  }
  if (target) {
    throw new WorkflowLedgerMigrationError('MIGRATION_TARGET_APPEARED', 'Migration target changed before resume')
  }
  if (journal.sourceKind === 'legacy_json') {
    if (discovered.sourceKind !== 'legacy_json' || discovered.sourcePath !== journal.sourcePath ||
        sha256(discovered.sourceBytes) !== journal.source.sha256) {
      throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_DRIFT', 'Legacy JSON changed after migration backup')
    }
  } else if (discovered.sourceKind !== 'empty') {
    throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_DRIFT', 'An empty migration source appeared before resume')
  }
}

async function resumePreparedJournal(
  reusable: { path: string; journal: WorkflowLedgerCanonicalMigrationJournal },
  options: WorkflowLedgerMigrationFaultOptions
): Promise<PreparedWorkflowLedgerMigration> {
  let journal = reusable.journal
  if (journal.state === 'rolled_back') {
    throw new WorkflowLedgerMigrationError('MIGRATION_ROLLED_BACK', 'Rolled-back journal is terminal')
  }
  if (journal.state === 'prepared') {
    const backup = await readFileIfExists(journal.backup.path)
    if (!backup) {
      const source = await readFileIfExists(journal.sourcePath)
      const bytes = source ?? (journal.sourceKind === 'empty' ? Buffer.alloc(0) : null)
      if (!bytes || sha256(bytes) !== journal.source.sha256) {
        throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_DRIFT', 'Cannot resume backup from changed source')
      }
      await writeDurableFile(journal.backup.path, bytes, { replace: false })
      hitFault(options.faultAt, 'after_backup_write')
    }
    await assertFileDigest(journal.backup, 'migration backup')
    journal = transitionJournal(journal, 'backup_verified', options.now)
    await writeMigrationJournal(reusable.path, journal)
    hitFault(options.faultAt, 'after_backup_verified')
  }
  return {
    migrationId: journal.migrationId,
    journalPath: reusable.path,
    backupPath: journal.backup.path,
    journal,
    alreadyCommitted: journal.state === 'committed'
  }
}

async function findReusableJournal(
  root: string,
  source: WorkflowLedgerMigrationSource,
  migrationPath: WorkflowLedgerMigrationPath,
  toVersion: number
): Promise<{ path: string; journal: WorkflowLedgerCanonicalMigrationJournal } | null> {
  const sourceDigest = sha256(source.sourceBytes)
  const journals = await listMigrationJournals(root)
  return journals
    .filter(({ journal }) => journal.migrationPath === migrationPath && journal.toVersion === toVersion &&
      journal.targetPath === source.targetPath && journal.sourceKind === source.sourceKind &&
      journal.sourcePath === source.sourcePath && journal.source.sha256 === sourceDigest &&
      journal.state !== 'rolled_back' && journal.state !== 'committed')
    .sort((left, right) => right.journal.updatedAt - left.journal.updatedAt)[0] ?? null
}

function transitionJournal(
  journal: WorkflowLedgerCanonicalMigrationJournal,
  state: WorkflowLedgerMigrationState,
  nowProvider?: () => number
): WorkflowLedgerCanonicalMigrationJournal {
  assertStateTransition(journal.state, state)
  const now = Math.max(nowProvider?.() ?? Date.now(), journal.updatedAt)
  return {
    ...journal,
    state,
    updatedAt: now,
    transitions: [...journal.transitions, { state, at: now }]
  }
}

function assertStateTransition(current: WorkflowLedgerMigrationState, next: WorkflowLedgerMigrationState): void {
  if (current === next) return
  const allowed: Record<WorkflowLedgerMigrationState, ReadonlySet<WorkflowLedgerMigrationState>> = {
    prepared: new Set(['backup_verified', 'rollback_pending']),
    backup_verified: new Set(['migrated_verified', 'rollback_pending']),
    migrated_verified: new Set(['committed', 'rollback_pending']),
    committed: new Set(['rollback_pending']),
    rollback_pending: new Set(['rolled_back']),
    rolled_back: new Set()
  }
  if (!allowed[current].has(next)) {
    throw new WorkflowLedgerMigrationError('MIGRATION_STATE_INVALID', `Invalid migration transition ${current} -> ${next}`)
  }
}

async function assertOriginalSourceUnchangedOrCandidatePresent(
  journal: WorkflowLedgerCanonicalMigrationJournal,
  migrated: WorkflowLedgerMigrationFileDigest
): Promise<void> {
  if (journal.sourceKind === 'legacy_json') {
    const source = await readFileIfExists(journal.sourcePath)
    if (!source || sha256(source) !== journal.source.sha256) {
      throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_DRIFT', 'Legacy JSON changed after backup')
    }
  }
  const target = await readFileIfExists(journal.targetPath)
  if (target && sha256(target) === migrated.sha256) return
  if (journal.targetExisted) {
    if (!target || sha256(target) !== journal.source.sha256) {
      throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_DRIFT', 'Task database changed after backup')
    }
  } else if (target) {
    throw new WorkflowLedgerMigrationError('MIGRATION_TARGET_APPEARED', 'Migration target appeared after backup')
  }
}

async function assertRollbackDigestGate(journal: WorkflowLedgerCanonicalMigrationJournal): Promise<void> {
  if (journal.sourceKind === 'legacy_json') {
    const source = await readFileIfExists(journal.sourcePath)
    if (source && sha256(source) !== journal.source.sha256) {
      throw new WorkflowLedgerMigrationError(
        'ROLLBACK_SOURCE_DIGEST_MISMATCH',
        'Legacy JSON changed after migration and cannot be overwritten by rollback'
      )
    }
  }
  const target = await readFileIfExists(journal.targetPath)
  if (!target) {
    if (!journal.targetExisted) return
    throw new WorkflowLedgerMigrationError('ROLLBACK_TARGET_MISSING', 'Rollback target is missing')
  }
  const actual = sha256(target)
  const allowed = new Set([journal.source.sha256, journal.migrated?.sha256].filter(Boolean))
  if (!allowed.has(actual)) {
    throw new WorkflowLedgerMigrationError('ROLLBACK_DIGEST_MISMATCH', 'Current target digest is not owned by this migration')
  }
}

async function restoreNonSqliteSource(
  journal: WorkflowLedgerCanonicalMigrationJournal,
  backupBytes: Uint8Array
): Promise<void> {
  if (journal.sourceKind === 'legacy_json') {
    await writeDurableFile(journal.sourcePath, backupBytes, { replace: true })
  }
  const target = await readFileIfExists(journal.targetPath)
  if (target) {
    if (journal.migrated && sha256(target) !== journal.migrated.sha256) {
      throw new WorkflowLedgerMigrationError('ROLLBACK_DIGEST_MISMATCH', 'Refusing to remove an unowned target')
    }
    await rm(journal.targetPath)
    await syncDirectory(dirname(journal.targetPath))
  }
}

async function assertRestoredSource(journal: WorkflowLedgerCanonicalMigrationJournal): Promise<void> {
  if (journal.sourceKind === 'sqlite') {
    await assertFileDigest(journal.source, 'restored task database')
    return
  }
  if (journal.sourceKind === 'legacy_json') await assertFileDigest(journal.source, 'restored legacy JSON')
  if (await pathExists(journal.targetPath)) {
    throw new WorkflowLedgerMigrationError('ROLLBACK_TARGET_REMAINS', 'Rollback left a migration-created target')
  }
}

function assertJournalIdentity(
  journal: WorkflowLedgerCanonicalMigrationJournal,
  prepared: PreparedWorkflowLedgerMigration
): void {
  const expected = prepared.journal
  const matches = [
    journal.migrationId === prepared.migrationId,
    journal.backup.path === prepared.backupPath,
    journal.migrationKind === expected.migrationKind,
    journal.migrationVersion === expected.migrationVersion,
    journal.migrationPath === expected.migrationPath,
    journal.mode === expected.mode,
    journal.fromVersion === expected.fromVersion,
    journal.toVersion === expected.toVersion,
    journal.sourceKind === expected.sourceKind,
    journal.sourcePath === expected.sourcePath,
    journal.targetPath === expected.targetPath,
    journal.targetExisted === expected.targetExisted,
    sameFileDigest(journal.source, expected.source),
    sameFileDigest(journal.backup, expected.backup),
    journal.createdAt === expected.createdAt
  ].every(Boolean)
  if (!matches) {
    throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_MISMATCH', 'Prepared migration does not match journal')
  }
}

function sameFileDigest(
  left: WorkflowLedgerMigrationFileDigest,
  right: WorkflowLedgerMigrationFileDigest
): boolean {
  return left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes
}

function normalizedSource(source: WorkflowLedgerMigrationSource): WorkflowLedgerMigrationSource {
  const normalized = {
    ...source,
    sourcePath: resolve(source.sourcePath),
    targetPath: resolve(source.targetPath),
    sourceBytes: new Uint8Array(source.sourceBytes)
  }
  if (normalized.sourceKind === 'sqlite' && normalized.sourcePath !== normalized.targetPath) {
    throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_INVALID', 'SQLite source must be the migration target')
  }
  if (normalized.sourceKind !== 'sqlite' && normalized.targetExisted) {
    throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_INVALID', 'Non-SQLite source cannot claim an existing target')
  }
  return normalized
}

function validateVersionBoundary(fromVersion: number, toVersion: number): void {
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0 ||
      !Number.isSafeInteger(toVersion) || toVersion < fromVersion) {
    throw new WorkflowLedgerMigrationError('MIGRATION_VERSION_INVALID', 'Invalid migration version boundary')
  }
}

function backupName(source: WorkflowLedgerMigrationSource): string {
  if (source.sourceKind === 'empty') return 'source-empty.bin'
  return `source-${basename(source.sourcePath)}`
}

function hitFault(
  configured: WorkflowLedgerMigrationCheckpoint | undefined,
  checkpoint: WorkflowLedgerMigrationCheckpoint
): void {
  if (configured === checkpoint) throw new WorkflowLedgerMigrationFault(checkpoint)
}
