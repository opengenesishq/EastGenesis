import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  AssignmentOwnerCoordinatorAuditEvent,
  AssignmentOwnerCoordinatorAuditKind,
  AssignmentOwnerJournalEntry,
  AssignmentOwnerJournalPhase,
  AssignmentOwnerOperation,
  JsonObject
} from '../../shared/digital-worker-types'
import { acquireFileLock, enqueueMutation, releaseFileLock } from '../digital-worker/persistence'
import { AssignmentOwnerCoordinatorError } from './errors'
import { clone } from './validation'

const JOURNAL_SCHEMA_VERSION = 1 as const
const JOURNAL_FILE_NAME = 'assignment-owner-coordinator.json'
const PHASES = new Set<AssignmentOwnerJournalPhase>([
  'prepared',
  'assignment_written',
  'owner_written',
  'owner_cleared',
  'assignment_released',
  'reassignment_written',
  'committed',
  'compensation_pending',
  'compensated',
  'failed'
])
const OPERATIONS = new Set<AssignmentOwnerOperation>(['assign', 'release', 'reassign'])

interface AssignmentOwnerJournalDocument {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  revision: number
  entries: AssignmentOwnerJournalEntry[]
  audit: AssignmentOwnerCoordinatorAuditEvent[]
}

export interface AssignmentOwnerJournalSession {
  readonly document: AssignmentOwnerJournalDocument
  persist(): void
  appendAudit(
    entry: AssignmentOwnerJournalEntry,
    kind: AssignmentOwnerCoordinatorAuditKind,
    details?: JsonObject
  ): void
}

export function assignmentOwnerJournalPath(rootDir: string): string {
  return join(resolve(rootDir), JOURNAL_FILE_NAME)
}

export class AssignmentOwnerJournal {
  readonly filePath: string
  private readonly lockPath: string

  constructor(rootDir: string) {
    this.filePath = assignmentOwnerJournalPath(rootDir)
    this.lockPath = `${this.filePath}.lock`
  }

  async withExclusive<T>(operation: (session: AssignmentOwnerJournalSession) => Promise<T>): Promise<T> {
    return enqueueMutation(this.filePath, async () => {
      const lock = acquireFileLock(this.lockPath)
      try {
        const document = readJournal(this.filePath)
        const session: AssignmentOwnerJournalSession = {
          document,
          persist: () => {
            document.revision += 1
            writeJournal(this.filePath, document)
          },
          appendAudit: (entry, kind, details = {}) => {
            document.audit.push(buildAudit(document, entry, kind, details))
          }
        }
        return await operation(session)
      } finally {
        releaseFileLock(this.lockPath, lock)
      }
    })
  }

  async getEntry(requestId: string): Promise<AssignmentOwnerJournalEntry | null> {
    return this.withExclusive(async ({ document }) => {
      const entry = document.entries.find((candidate) => candidate.requestId === requestId)
      return entry ? clone(entry) : null
    })
  }

  async listAudit(requestId?: string): Promise<AssignmentOwnerCoordinatorAuditEvent[]> {
    return this.withExclusive(async ({ document }) => document.audit
      .filter((event) => requestId === undefined || event.requestId === requestId)
      .map(clone))
  }

  async purgeProject(projectId: string): Promise<{ entries: number; audit: number }> {
    if (!requiredString(projectId)) {
      throw new AssignmentOwnerCoordinatorError('INVALID_INPUT', 'projectId is required')
    }
    return this.withExclusive(async ({ document, persist }) => {
      const entries = document.entries.length
      const audit = document.audit.length
      document.entries = document.entries.filter((entry) => entry.projectId !== projectId)
      document.audit = document.audit.filter((event) => event.projectId !== projectId)
      const removed = {
        entries: entries - document.entries.length,
        audit: audit - document.audit.length
      }
      if (removed.entries > 0 || removed.audit > 0) persist()
      return removed
    })
  }

  async countProject(projectId: string): Promise<{ entries: number; audit: number }> {
    if (!requiredString(projectId)) {
      throw new AssignmentOwnerCoordinatorError('INVALID_INPUT', 'projectId is required')
    }
    return this.withExclusive(async ({ document }) => ({
      entries: document.entries.filter((entry) => entry.projectId === projectId).length,
      audit: document.audit.filter((event) => event.projectId === projectId).length
    }))
  }
}

function emptyJournal(): AssignmentOwnerJournalDocument {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, revision: 0, entries: [], audit: [] }
}

function readJournal(filePath: string): AssignmentOwnerJournalDocument {
  if (!existsSync(filePath)) return emptyJournal()
  let value: unknown
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch (error) {
    corrupt(`assignment-owner journal is not valid JSON: ${String(error)}`)
  }
  upgradeLegacyJournal(value)
  assertJournal(value)
  return clone(value)
}

function assertJournal(value: unknown): asserts value is AssignmentOwnerJournalDocument {
  if (!isRecord(value)) corrupt('assignment-owner journal must be an object')
  assertJournalHeader(value)
  assertJournalEntries(value.entries)
  assertJournalAudit(value.audit)
}

function assertJournalHeader(value: Record<string, unknown>): void {
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) corrupt('assignment-owner journal schema is unsupported')
  if (!isNonNegativeInteger(value.revision)) corrupt('assignment-owner journal revision is invalid')
  if (!Array.isArray(value.entries) || !Array.isArray(value.audit)) {
    corrupt('assignment-owner journal collections are invalid')
  }
}

function assertJournalEntries(value: unknown): void {
  if (!Array.isArray(value)) corrupt('assignment-owner journal entries are invalid')
  const requestIds = new Set<string>()
  const journalIds = new Set<string>()
  for (const candidate of value) {
    assertEntry(candidate)
    if (requestIds.has(candidate.requestId)) corrupt(`duplicate assignment-owner requestId: ${candidate.requestId}`)
    if (journalIds.has(candidate.id)) corrupt(`duplicate assignment-owner journal id: ${candidate.id}`)
    requestIds.add(candidate.requestId)
    journalIds.add(candidate.id)
  }
}

function assertJournalAudit(value: unknown): void {
  if (!Array.isArray(value)) corrupt('assignment-owner journal audit is invalid')
  const auditIds = new Set<string>()
  for (const candidate of value) {
    assertAuditEvent(candidate)
    if (auditIds.has(candidate.id)) corrupt(`duplicate assignment-owner audit id: ${candidate.id}`)
    auditIds.add(candidate.id)
  }
}

function assertEntry(value: unknown): asserts value is AssignmentOwnerJournalEntry {
  if (!isRecord(value) || value.schemaVersion !== JOURNAL_SCHEMA_VERSION) corrupt('assignment-owner journal entry is invalid')
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation as AssignmentOwnerOperation)) {
    corrupt('assignment-owner journal operation is invalid')
  }
  assertEntryIds(value)
  assertEntryPhase(value)
  assertEntryNumbers(value)
  assertEntryOwner(value)
  assertEntryReceipt(value)
}

function assertEntryIds(value: Record<string, unknown>): void {
  for (const field of [
    'id', 'requestId', 'requestDigest', 'projectId', 'workItemId', 'assigneeId',
    'assignmentId', 'assignedBy'
  ]) {
    if (!requiredString(value[field])) corrupt(`assignment-owner journal entry ${field} is invalid`)
  }
  if (value.previousAssignmentId !== undefined && !requiredString(value.previousAssignmentId)) {
    corrupt('assignment-owner journal entry previousAssignmentId is invalid')
  }
  if (value.assigneeKind !== 'digital_worker' && value.assigneeKind !== 'human') {
    corrupt('assignment-owner journal entry assigneeKind is invalid')
  }
}

function assertEntryPhase(value: Record<string, unknown>): void {
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase as AssignmentOwnerJournalPhase)) {
    corrupt('assignment-owner journal phase is invalid')
  }
}

function assertEntryNumbers(value: Record<string, unknown>): void {
  for (const field of [
    'expectedWorkItemRevision', 'expectedProjectStoreRevision',
    'expectedDigitalWorkerStoreRevision'
  ]) {
    if (!isNonNegativeInteger(value[field])) corrupt(`assignment-owner journal entry ${field} is invalid`)
  }
  for (const field of ['createdAt', 'updatedAt', 'assignedAt']) {
    if (!isNonNegativeNumber(value[field])) corrupt(`assignment-owner journal entry ${field} is invalid`)
  }
  if (value.releasedAt !== undefined && !isNonNegativeNumber(value.releasedAt)) {
    corrupt('assignment-owner journal entry releasedAt is invalid')
  }
}

function assertEntryOwner(value: Record<string, unknown>): void {
  if (!isRecord(value.owner) || value.owner.type !== value.assigneeKind || value.owner.id !== value.assigneeId) {
    corrupt('assignment-owner journal owner is invalid')
  }
  if (!isRecord(value.scope)) corrupt('assignment-owner journal scope is invalid')
}

function assertEntryReceipt(value: Record<string, unknown>): void {
  if (value.receipt === undefined) return
  if (!isRecord(value.receipt)) corrupt('assignment-owner journal receipt is invalid')
  const expected = {
    operation: value.operation,
    requestId: value.requestId,
    journalId: value.id,
    assignmentId: value.assignmentId,
    workItemId: value.workItemId
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value.receipt[field] !== expectedValue) corrupt('assignment-owner journal receipt is invalid')
  }
}

function assertAuditEvent(value: unknown): asserts value is AssignmentOwnerCoordinatorAuditEvent {
  if (!isRecord(value)) corrupt('assignment-owner audit event is invalid')
  for (const field of ['id', 'requestId', 'journalId', 'assignmentId', 'workItemId', 'projectId', 'kind']) {
    if (!requiredString(value[field])) corrupt(`assignment-owner audit ${field} is invalid`)
  }
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation as AssignmentOwnerOperation)) {
    corrupt('assignment-owner audit operation is invalid')
  }
  if (!isNonNegativeInteger(value.revision)) corrupt('assignment-owner audit revision is invalid')
  if (typeof value.occurredAt !== 'number' || !Number.isFinite(value.occurredAt)) {
    corrupt('assignment-owner audit occurredAt is invalid')
  }
  if (!isRecord(value.details)) {
    corrupt('assignment-owner journal receipt is invalid')
  }
}

function buildAudit(
  document: AssignmentOwnerJournalDocument,
  entry: AssignmentOwnerJournalEntry,
  kind: AssignmentOwnerCoordinatorAuditKind,
  details: JsonObject
): AssignmentOwnerCoordinatorAuditEvent {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: randomUUID(),
    kind,
    operation: entry.operation,
    requestId: entry.requestId,
    journalId: entry.id,
    projectId: entry.projectId,
    workItemId: entry.workItemId,
    assignmentId: entry.assignmentId,
    ...(entry.previousAssignmentId === undefined ? {} : { previousAssignmentId: entry.previousAssignmentId }),
    occurredAt: Date.now(),
    revision: document.revision + 1,
    details: clone(details)
  }
}

function upgradeLegacyJournal(value: unknown): void {
  if (!isRecord(value)) return
  const entries = upgradeLegacyEntries(value.entries)
  upgradeLegacyAudit(value.audit, entries)
}

function upgradeLegacyEntries(value: unknown): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>()
  if (!Array.isArray(value)) return entries
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    upgradeLegacyEntry(candidate)
    if (requiredString(candidate.requestId)) entries.set(candidate.requestId, candidate)
  }
  return entries
}

function upgradeLegacyEntry(entry: Record<string, unknown>): void {
  if (entry.operation === undefined) entry.operation = 'assign'
  if (entry.assigneeKind === undefined) entry.assigneeKind = 'digital_worker'
  if (entry.assigneeId === undefined && requiredString(entry.workerId)) entry.assigneeId = entry.workerId
  if (isRecord(entry.receipt) && entry.receipt.operation === undefined) {
    entry.receipt.operation = entry.operation
  }
}

function upgradeLegacyAudit(
  value: unknown,
  entries: ReadonlyMap<string, Record<string, unknown>>
): void {
  if (!Array.isArray(value)) return
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    upgradeLegacyAuditEvent(candidate, entries)
  }
}

function upgradeLegacyAuditEvent(
  event: Record<string, unknown>,
  entries: ReadonlyMap<string, Record<string, unknown>>
): void {
  const entry = requiredString(event.requestId) ? entries.get(event.requestId) : undefined
  if (event.operation === undefined) event.operation = entry?.operation ?? 'assign'
  if (event.previousAssignmentId === undefined && entry?.previousAssignmentId !== undefined) {
    event.previousAssignmentId = entry.previousAssignmentId
  }
}

function writeJournal(filePath: string, document: AssignmentOwnerJournalDocument): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, undefined, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, filePath)
    syncDirectory(dirname(filePath))
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporaryPath) } catch { /* committed file remains authoritative */ }
    throw new AssignmentOwnerCoordinatorError(
      'RECOVERY_PENDING',
      `unable to persist assignment-owner journal: ${String(error)}`
    )
  }
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // Some filesystems do not permit directory fsync.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function corrupt(message: string): never {
  throw new AssignmentOwnerCoordinatorError('JOURNAL_CORRUPT', message)
}
