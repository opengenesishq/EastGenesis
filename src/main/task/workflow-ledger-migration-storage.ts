import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { canonicalJson, digest } from './workflow-ledger-codec'
import {
  WORKFLOW_LEDGER_MIGRATION_JOURNAL_FORMAT,
  WORKFLOW_LEDGER_MIGRATION_KIND,
  WORKFLOW_LEDGER_MIGRATION_VERSION,
  WorkflowLedgerMigrationError,
  type WorkflowLedgerCanonicalMigrationJournal,
  type WorkflowLedgerCanonicalReadinessReport,
  type WorkflowLedgerMigrationFileDigest,
  type WorkflowLedgerMigrationSourceKind,
  type WorkflowLedgerMigrationState
} from './workflow-ledger-migration-types'

export async function readMigrationJournal(
  journalPath: string
): Promise<WorkflowLedgerCanonicalMigrationJournal> {
  const path = resolve(journalPath)
  let value: unknown
  try {
    value = JSON.parse((await readRegularFile(path, 'Workflow Ledger migration journal')).toString('utf8')) as unknown
  } catch (error) {
    throw new WorkflowLedgerMigrationError(
      'MIGRATION_JOURNAL_INVALID',
      `Invalid migration journal ${path}: ${safeErrorMessage(error)}`
    )
  }
  if (!isMigrationJournal(value)) {
    throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_INVALID', `Invalid migration journal: ${path}`)
  }
  assertJournalPathBindings(path, value)
  return value
}

export async function listMigrationJournals(
  root: string
): Promise<Array<{ path: string; journal: WorkflowLedgerCanonicalMigrationJournal }>> {
  if (!(await pathExists(root))) return []
  const entries = await readdir(root, { withFileTypes: true })
  const journals: Array<{ path: string; journal: WorkflowLedgerCanonicalMigrationJournal }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.creating-')) continue
    const path = resolve(root, entry.name, 'journal.json')
    journals.push({ path, journal: await readMigrationJournal(path) })
  }
  return journals
}

export async function publishDurableDirectory(sourcePath: string, targetPath: string): Promise<void> {
  const source = resolve(sourcePath)
  const target = resolve(targetPath)
  if (await pathExists(target)) {
    throw new WorkflowLedgerMigrationError('MIGRATION_FILE_EXISTS', `Refusing to replace migration directory ${target}`)
  }
  await renameWithRetry(source, target)
  await syncDirectory(dirname(target))
}

export async function writeMigrationJournal(
  path: string,
  journal: WorkflowLedgerCanonicalMigrationJournal
): Promise<void> {
  if (!isMigrationJournal(journal)) {
    throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_INVALID', 'Refusing to persist an invalid migration journal')
  }
  await writeDurableFile(path, Buffer.from(`${canonicalJson(journal)}\n`, 'utf8'), { replace: true })
}

export async function writeDurableFile(
  targetPath: string,
  bytes: Uint8Array,
  options: { replace: boolean }
): Promise<void> {
  const path = resolve(targetPath)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (!options.replace && await pathExists(path)) {
    throw new WorkflowLedgerMigrationError('MIGRATION_FILE_EXISTS', `Refusing to replace existing migration file ${path}`)
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!options.replace && await pathExists(path)) {
      throw new WorkflowLedgerMigrationError('MIGRATION_FILE_EXISTS', `Refusing to replace existing migration file ${path}`)
    }
    await renameWithRetry(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function assertFileDigest(
  expected: WorkflowLedgerMigrationFileDigest,
  label: string
): Promise<void> {
  const bytes = await readRegularFile(expected.path, label)
  if (bytes.byteLength !== expected.sizeBytes || sha256(bytes) !== expected.sha256) {
    throw new WorkflowLedgerMigrationError('MIGRATION_DIGEST_MISMATCH', `${label} digest does not match journal`)
  }
}

export function fileDigest(path: string, bytes: Uint8Array): WorkflowLedgerMigrationFileDigest {
  return { path: resolve(path), sha256: sha256(bytes), sizeBytes: bytes.byteLength }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readRegularFile(path: string, label: string): Promise<Buffer> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WorkflowLedgerMigrationError('MIGRATION_SOURCE_INVALID', `${label} is not a regular file`)
  }
  return readFile(path)
}

export async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readRegularFile(path, 'migration file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isMigrationJournal(value: unknown): value is WorkflowLedgerCanonicalMigrationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<WorkflowLedgerCanonicalMigrationJournal>
  return hasJournalEnvelope(item) && hasJournalVersions(item) && hasJournalFiles(item) &&
    hasJournalTimestamps(item) && isValidTransitionHistory(item) && hasStatePayload(item) &&
    hasConsistentSourceIdentity(item) && hasValidAcceptanceChangeImpact(item)
}

function hasValidAcceptanceChangeImpact(item: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  if (item.acceptanceChangeImpact === undefined) return true
  const impact = item.acceptanceChangeImpact
  if (!impact || typeof impact !== 'object' || !isTimestamp(impact.now) ||
      !impact.plan || typeof impact.plan !== 'object' || impact.plan.schemaVersion !== 1 ||
      impact.plan.contract !== 'workflow-change-impact-v1' || !isNonEmptyString(impact.plan.projectId)) return false
  const { planDigest, ...unsignedPlan } = impact.plan
  return typeof planDigest === 'string' && digest(unsignedPlan) === planDigest
}

function hasJournalEnvelope(item: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  return item.schemaVersion === 1 && item.format === WORKFLOW_LEDGER_MIGRATION_JOURNAL_FORMAT &&
    item.migrationKind === WORKFLOW_LEDGER_MIGRATION_KIND && item.migrationVersion === WORKFLOW_LEDGER_MIGRATION_VERSION &&
    isNonEmptyString(item.migrationId) &&
    (item.migrationPath === 'existing_v7' || item.migrationPath === 'existing_v8' ||
      item.migrationPath === 'existing_current' ||
      item.migrationPath === 'legacy_upgrade' || item.migrationPath === 'canonical_upgrade') &&
    (item.mode === 'shadow' || item.mode === 'canonical') &&
    isMigrationState(item.state)
}

function hasJournalVersions(item: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  return isVersion(item.fromVersion) && isVersion(item.toVersion) &&
    (item.toVersion ?? -1) >= (item.fromVersion ?? 0)
}

function hasJournalFiles(item: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  return isSourceKind(item.sourceKind) && isNonEmptyString(item.sourcePath) && isNonEmptyString(item.targetPath) &&
    typeof item.targetExisted === 'boolean' && isFileDigest(item.source) && isFileDigest(item.backup) &&
    (item.candidate === undefined || isFileDigest(item.candidate)) &&
    (item.migrated === undefined || isFileDigest(item.migrated)) &&
    (item.readiness === undefined || isReadinessReport(item.readiness))
}

function hasJournalTimestamps(item: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  return isTimestamp(item.createdAt) && isTimestamp(item.updatedAt) &&
    (item.committedAt === undefined || isTimestamp(item.committedAt)) &&
    (item.rollbackPreparedAt === undefined || isTimestamp(item.rollbackPreparedAt)) &&
    (item.rolledBackAt === undefined || isTimestamp(item.rolledBackAt))
}

function isMigrationState(value: unknown): value is WorkflowLedgerMigrationState {
  return value === 'prepared' || value === 'backup_verified' || value === 'migrated_verified' ||
    value === 'committed' || value === 'rollback_pending' || value === 'rolled_back'
}

function isSourceKind(value: unknown): value is WorkflowLedgerMigrationSourceKind {
  return value === 'sqlite' || value === 'legacy_json' || value === 'empty'
}

function isFileDigest(value: unknown): value is WorkflowLedgerMigrationFileDigest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<WorkflowLedgerMigrationFileDigest>
  return isNonEmptyString(item.path) && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) &&
    Number.isSafeInteger(item.sizeBytes) && (item.sizeBytes ?? -1) >= 0
}

function isReadinessReport(value: unknown): value is WorkflowLedgerCanonicalReadinessReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<WorkflowLedgerCanonicalReadinessReport>
  if (item.schemaVersion !== 1 || item.format !== 'caogen.workflow-ledger.canonical-readiness.v1' ||
      item.mode !== 'shadow' || (item.storeId !== undefined && !isUuid(item.storeId)) ||
      !isNonEmptyString(item.reportDigest)) return false
  const { reportDigest, ...withoutDigest } = item
  return digest(withoutDigest) === reportDigest
}

function isValidTransitionHistory(journal: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  const transitions = journal.transitions
  if (!Array.isArray(transitions) || transitions.length === 0 || transitions[0]?.state !== 'prepared') return false
  let prior: WorkflowLedgerMigrationState | undefined
  let priorAt = Number.NEGATIVE_INFINITY
  for (const transition of transitions) {
    if (!transition || !isMigrationState(transition.state) || !isTimestamp(transition.at) || transition.at < priorAt) {
      return false
    }
    if (prior && !isAllowedTransition(prior, transition.state)) return false
    prior = transition.state
    priorAt = transition.at
  }
  return prior === journal.state && journal.updatedAt === priorAt &&
    typeof journal.createdAt === 'number' && journal.createdAt === transitions[0]?.at
}

function isAllowedTransition(current: WorkflowLedgerMigrationState, next: WorkflowLedgerMigrationState): boolean {
  if (current === 'prepared') return next === 'backup_verified' || next === 'rollback_pending'
  if (current === 'backup_verified') return next === 'migrated_verified' || next === 'rollback_pending'
  if (current === 'migrated_verified') return next === 'committed' || next === 'rollback_pending'
  if (current === 'committed') return next === 'rollback_pending'
  if (current === 'rollback_pending') return next === 'rolled_back'
  return false
}

function hasStatePayload(journal: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  const migrated = journal.state === 'migrated_verified' || journal.state === 'committed'
  if (migrated && (!journal.candidate || !journal.migrated || !journal.readiness)) return false
  if (journal.state === 'committed' && journal.committedAt !== journal.updatedAt) return false
  if (journal.state === 'rollback_pending' && journal.rollbackPreparedAt !== journal.updatedAt) return false
  if (journal.state === 'rolled_back' && journal.rolledBackAt !== journal.updatedAt) return false
  return true
}

function hasConsistentSourceIdentity(journal: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  if (!journal.source || !journal.backup || !journal.sourceKind || !journal.sourcePath || !journal.targetPath) return false
  if (!hasSourceDigestIdentity(journal) || !hasMigrationDigestIdentity(journal)) return false
  if (journal.sourceKind === 'sqlite') {
    return journal.targetExisted === true && resolve(journal.sourcePath) === resolve(journal.targetPath)
  }
  return journal.targetExisted === false
}

function hasSourceDigestIdentity(journal: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  return Boolean(journal.source && journal.backup && resolve(journal.source.path) === resolve(journal.sourcePath ?? '') &&
    journal.backup.sha256 === journal.source.sha256 && journal.backup.sizeBytes === journal.source.sizeBytes)
}

function hasMigrationDigestIdentity(journal: Partial<WorkflowLedgerCanonicalMigrationJournal>): boolean {
  const migrated = journal.migrated
  if (migrated && resolve(migrated.path) !== resolve(journal.targetPath ?? '')) return false
  if (journal.candidate && migrated && !sameDigest(journal.candidate, migrated)) return false
  if (journal.readiness && migrated && !readinessMatches(journal.readiness, migrated, journal.targetPath ?? '')) return false
  return true
}

function sameDigest(left: WorkflowLedgerMigrationFileDigest, right: WorkflowLedgerMigrationFileDigest): boolean {
  return left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes
}

function readinessMatches(
  readiness: WorkflowLedgerCanonicalReadinessReport,
  migrated: WorkflowLedgerMigrationFileDigest,
  targetPath: string
): boolean {
  return resolve(readiness.sourcePath) === resolve(targetPath) && readiness.sourceSha256 === migrated.sha256 &&
    readiness.sourceSizeBytes === migrated.sizeBytes
}

function assertJournalPathBindings(
  journalPath: string,
  journal: WorkflowLedgerCanonicalMigrationJournal
): void {
  const directory = dirname(journalPath)
  const expectedBackupName = journal.sourceKind === 'empty'
    ? 'source-empty.bin'
    : `source-${basename(journal.sourcePath)}`
  const valid = basename(journalPath) === 'journal.json' && basename(directory) === journal.migrationId &&
    isMigrationIdBound(journal) &&
    resolve(journal.backup.path) === resolve(directory, expectedBackupName) &&
    (journal.candidate === undefined ||
      resolve(journal.candidate.path) === resolve(join(directory, 'candidate.sqlite')))
  if (!valid) {
    throw new WorkflowLedgerMigrationError(
      'MIGRATION_JOURNAL_PATH_MISMATCH',
      `Migration journal paths are not bound to ${resolve(journalPath)}`
    )
  }
}

function isMigrationIdBound(journal: WorkflowLedgerCanonicalMigrationJournal): boolean {
  const prefix = `${WORKFLOW_LEDGER_MIGRATION_KIND}-v${WORKFLOW_LEDGER_MIGRATION_VERSION}-${sha256(
    Buffer.from(`${journal.targetPath}\0${journal.sourcePath}\0${journal.sourceKind}\0${journal.source.sha256}`)
  ).slice(0, 20)}-`
  return journal.migrationId.startsWith(prefix) && /^[a-f0-9]{8}$/.test(journal.migrationId.slice(prefix.length))
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= maxAttempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * attempt))
    }
  }
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
