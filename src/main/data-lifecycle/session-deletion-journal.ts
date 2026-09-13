import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DataPurgeTarget, DataRetentionSubject } from '../../shared/data-lifecycle-types'
import { acquireFileLock, enqueueMutation, releaseFileLock } from '../digital-worker/persistence'
import { normalizeDataPurgeTargets } from './retention-authority'
import {
  DataRetentionAuthorityStore,
  normalizeDataRetentionSubjects
} from './retention-authority-store'
import { withDataLifecycleMutation } from './data-lifecycle-mutation-lock'

export const SESSION_DELETION_COMPLETED_RECEIPT_LIMIT = 255
export const SESSION_DELETION_COMPLETED_RECEIPT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export const SESSION_DELETION_PHASES = [
  'prepared',
  'snapshot_purged',
  'stores_purged',
  'files_purged',
  'verified',
  'completed'
] as const

export type SessionDeletionPhase = typeof SESSION_DELETION_PHASES[number]

export interface SessionDeletionJournalEntry {
  schemaVersion: 1
  operationId: string
  sessionId: string
  sdkSessionId: string
  retentionTargets?: DataPurgeTarget[]
  legalHoldSubjects?: DataRetentionSubject[]
  phase: SessionDeletionPhase
  removedRecords?: Record<string, number>
  removedPathCount?: number
  residuals?: Record<string, number>
  createdAt: number
  updatedAt: number
  completedAt?: number
}

interface SessionDeletionJournalDocument {
  schemaVersion: 1
  revision: number
  entries: SessionDeletionJournalEntry[]
}

export interface SessionDeletionJournalBeginInput {
  sessionId: string
  sdkSessionId: string
  retentionTargets: DataPurgeTarget[]
  legalHoldSubjects?: DataRetentionSubject[]
}

export interface SessionDeletionJournalCompactionResult {
  removed: number
  retainedCompleted: number
  protectedCompleted: number
  pending: number
}

type JournalPatch = Partial<Pick<SessionDeletionJournalEntry,
  'removedRecords' | 'removedPathCount' | 'residuals'>>

export class SessionDeletionJournal {
  readonly filePath: string
  private readonly lockPath: string
  private readonly userDataRoot: string

  constructor(userDataRoot: string) {
    this.userDataRoot = requiredRoot(userDataRoot)
    this.filePath = join(this.userDataRoot, 'private', 'session-deletion-journal.json')
    this.lockPath = `${this.filePath}.lock`
  }

  listPending(): SessionDeletionJournalEntry[] {
    return readDocument(this.filePath).entries
      .filter((entry) => entry.phase !== 'completed')
      .map(clone)
  }

  getPendingSession(sessionIdInput: string): SessionDeletionJournalEntry | undefined {
    const sessionId = requiredId(sessionIdInput, 'sessionId')
    const entry = readDocument(this.filePath).entries.find((candidate) =>
      candidate.sessionId === sessionId && candidate.phase !== 'completed')
    return entry ? clone(entry) : undefined
  }

  async begin(input: SessionDeletionJournalBeginInput): Promise<SessionDeletionJournalEntry>
  async begin(sessionId: string, sdkSessionId: string): Promise<SessionDeletionJournalEntry>
  async begin(
    inputOrSessionId: SessionDeletionJournalBeginInput | string,
    sdkSessionIdInput?: string
  ): Promise<SessionDeletionJournalEntry> {
    const input: SessionDeletionJournalBeginInput = typeof inputOrSessionId === 'string'
      ? {
          sessionId: inputOrSessionId,
          sdkSessionId: requiredId(sdkSessionIdInput, 'sdkSessionId'),
          retentionTargets: [{
            subject: { kind: 'session', id: inputOrSessionId },
            retentionAnchorAt: Date.now()
          }],
          legalHoldSubjects: [{ kind: 'session', id: inputOrSessionId }]
        }
      : inputOrSessionId
    const sessionId = requiredId(input.sessionId, 'sessionId')
    const sdkSessionId = requiredId(input.sdkSessionId, 'sdkSessionId')
    const retentionTargets = normalizeDataPurgeTargets(input.retentionTargets)
    const legalHoldSubjects = normalizeDataRetentionSubjects(input.legalHoldSubjects ?? [])
    return this.mutate((document) => {
      compactCompletedEntries(document, this.activeLegalHoldKeys(), Date.now())
      const pending = document.entries.find((candidate) =>
        candidate.sessionId === sessionId && candidate.phase !== 'completed')
      if (pending) {
        if (pending.sdkSessionId !== sdkSessionId) {
          throw new Error('session deletion journal identity conflicts with visible history')
        }
        return pending
      }
      const now = Date.now()
      const entry: SessionDeletionJournalEntry = {
        schemaVersion: 1,
        operationId: randomUUID(),
        sessionId,
        sdkSessionId,
        retentionTargets,
        legalHoldSubjects,
        phase: 'prepared',
        createdAt: now,
        updatedAt: now
      }
      document.entries.push(entry)
      return entry
    })
  }

  async advance(
    operationIdInput: string,
    phase: SessionDeletionPhase,
    patch: JournalPatch = {}
  ): Promise<SessionDeletionJournalEntry> {
    const operationId = requiredId(operationIdInput, 'operationId')
    const targetIndex = SESSION_DELETION_PHASES.indexOf(phase)
    if (targetIndex < 0) throw new Error('session deletion phase is invalid')
    return this.mutate((document) => {
      const entry = document.entries.find((candidate) => candidate.operationId === operationId)
      if (!entry) throw new Error('session deletion operation is missing')
      const currentIndex = SESSION_DELETION_PHASES.indexOf(entry.phase)
      if (targetIndex < currentIndex) return entry
      if (targetIndex > currentIndex + 1) {
        throw new Error(`session deletion phase cannot skip ${entry.phase} -> ${phase}`)
      }
      entry.phase = phase
      entry.updatedAt = Date.now()
      Object.assign(entry, normalizePatch(patch))
      if (phase === 'completed') entry.completedAt = entry.updatedAt
      return entry
    })
  }

  async compactCompleted(nowInput = Date.now()): Promise<SessionDeletionJournalCompactionResult> {
    const now = requiredTimestamp(nowInput, 'compaction time')
    return withDataLifecycleMutation(this.userDataRoot, () => enqueueMutation(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const lock = acquireFileLock(this.lockPath)
      try {
        const document = readDocument(this.filePath)
        const result = compactCompletedEntries(document, this.activeLegalHoldKeys(), now)
        if (result.removed > 0) {
          document.revision += 1
          writeDocument(this.filePath, document)
        }
        return result
      } finally {
        releaseFileLock(this.lockPath, lock)
      }
    }))
  }

  private activeLegalHoldKeys(): { application: boolean; subjects: Set<string> } {
    const authority = new DataRetentionAuthorityStore(this.userDataRoot).read()
    const active = authority.legalHolds.filter((hold) => hold.status === 'active')
    return {
      application: active.some((hold) => hold.subject.kind === 'application'),
      subjects: new Set(active
        .filter((hold) => hold.subject.kind !== 'application')
        .map((hold) => subjectKey(hold.subject)))
    }
  }

  private async mutate<T>(operation: (document: SessionDeletionJournalDocument) => T): Promise<T> {
    return withDataLifecycleMutation(this.userDataRoot, () => enqueueMutation(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const lock = acquireFileLock(this.lockPath)
      try {
        const document = readDocument(this.filePath)
        const result = operation(document)
        document.revision += 1
        writeDocument(this.filePath, document)
        return clone(result)
      } finally {
        releaseFileLock(this.lockPath, lock)
      }
    }))
  }
}

function compactCompletedEntries(
  document: SessionDeletionJournalDocument,
  holds: { application: boolean; subjects: ReadonlySet<string> },
  now: number
): SessionDeletionJournalCompactionResult {
  const pending = document.entries.filter((entry) => entry.phase !== 'completed')
  const completed = document.entries.filter((entry) => entry.phase === 'completed')
    .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0) ||
      right.operationId.localeCompare(left.operationId))
  const protectedEntries = completed.filter((entry) => receiptProtectedByHold(entry, holds))
  const unprotected = completed.filter((entry) => !receiptProtectedByHold(entry, holds))
  const cutoff = Math.max(0, now - SESSION_DELETION_COMPLETED_RECEIPT_MAX_AGE_MS)
  const retainedUnprotected = unprotected
    .filter((entry) => (entry.completedAt ?? 0) >= cutoff)
    .slice(0, SESSION_DELETION_COMPLETED_RECEIPT_LIMIT)
  const retainedOperationIds = new Set([
    ...protectedEntries.map((entry) => entry.operationId),
    ...retainedUnprotected.map((entry) => entry.operationId)
  ])
  const previousLength = document.entries.length
  document.entries = document.entries.filter((entry) =>
    entry.phase !== 'completed' || retainedOperationIds.has(entry.operationId))
  return {
    removed: previousLength - document.entries.length,
    retainedCompleted: retainedOperationIds.size,
    protectedCompleted: protectedEntries.length,
    pending: pending.length
  }
}

function receiptProtectedByHold(
  entry: SessionDeletionJournalEntry,
  holds: { application: boolean; subjects: ReadonlySet<string> }
): boolean {
  if (holds.application) return true
  const subjects = entry.legalHoldSubjects ?? [{ kind: 'session' as const, id: entry.sessionId }]
  return subjects.some((subject) => holds.subjects.has(subjectKey(subject)))
}

function subjectKey(subject: DataRetentionSubject): string {
  return subject.kind === 'application' ? 'application' : `${subject.kind}:${subject.id}`
}

function readDocument(filePath: string): SessionDeletionJournalDocument {
  if (!existsSync(filePath)) return { schemaVersion: 1, revision: 0, entries: [] }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  assertDocument(parsed)
  return clone(parsed)
}

function writeDocument(filePath: string, document: SessionDeletionJournalDocument): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, filePath)
    if (process.platform !== 'win32') {
      const directoryDescriptor = openSync(directory, 'r')
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function assertDocument(value: unknown): asserts value is SessionDeletionJournalDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('session deletion journal is invalid')
  const document = value as Partial<SessionDeletionJournalDocument>
  if (document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || (document.revision ?? -1) < 0 ||
      !Array.isArray(document.entries)) {
    throw new Error('session deletion journal is invalid')
  }
  const operations = new Set<string>()
  const pendingSessions = new Set<string>()
  for (const entry of document.entries) {
    assertEntry(entry)
    if (operations.has(entry.operationId)) throw new Error('session deletion journal has duplicate operations')
    if (entry.phase !== 'completed' && pendingSessions.has(entry.sessionId)) {
      throw new Error('session deletion journal has duplicate pending sessions')
    }
    operations.add(entry.operationId)
    if (entry.phase !== 'completed') pendingSessions.add(entry.sessionId)
  }
}

function assertEntry(value: unknown): asserts value is SessionDeletionJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('session deletion journal entry is invalid')
  const entry = value as Partial<SessionDeletionJournalEntry>
  if (entry.schemaVersion !== 1 || !requiredId(entry.operationId, 'operationId') ||
      !requiredId(entry.sessionId, 'sessionId') || !requiredId(entry.sdkSessionId, 'sdkSessionId') ||
      !SESSION_DELETION_PHASES.includes(entry.phase as SessionDeletionPhase) ||
      !validTimestamp(entry.createdAt) || !validTimestamp(entry.updatedAt) ||
      (entry.completedAt !== undefined && !validTimestamp(entry.completedAt)) ||
      !optionalRetentionTargets(entry.retentionTargets) || !optionalLegalHoldSubjects(entry.legalHoldSubjects) ||
      !optionalCounts(entry.removedRecords) || !optionalCounts(entry.residuals) ||
      (entry.removedPathCount !== undefined && (!Number.isSafeInteger(entry.removedPathCount) || entry.removedPathCount < 0))) {
    throw new Error('session deletion journal entry is invalid')
  }
  if (entry.phase === 'completed' && entry.completedAt === undefined) {
    throw new Error('completed session deletion journal entry is missing completion timestamp')
  }
}

function optionalRetentionTargets(value: unknown): boolean {
  if (value === undefined) return true
  try {
    normalizeDataPurgeTargets(value as DataPurgeTarget[])
    return true
  } catch {
    return false
  }
}

function optionalLegalHoldSubjects(value: unknown): boolean {
  if (value === undefined) return true
  try {
    normalizeDataRetentionSubjects(value as DataRetentionSubject[])
    return true
  } catch {
    return false
  }
}

function normalizePatch(patch: JournalPatch): JournalPatch {
  const next: JournalPatch = {}
  if (patch.removedRecords !== undefined) next.removedRecords = normalizedCounts(patch.removedRecords)
  if (patch.removedPathCount !== undefined) {
    if (!Number.isSafeInteger(patch.removedPathCount) || patch.removedPathCount < 0) {
      throw new Error('session deletion removed path count is invalid')
    }
    next.removedPathCount = patch.removedPathCount
  }
  if (patch.residuals !== undefined) next.residuals = normalizedCounts(patch.residuals)
  return next
}

function optionalCounts(value: unknown): boolean {
  return value === undefined || isCounts(value)
}

function normalizedCounts(value: Record<string, number>): Record<string, number> {
  if (!isCounts(value)) throw new Error('session deletion counts are invalid')
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function isCounts(value: unknown): value is Record<string, number> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(([key, count]) =>
      key.length > 0 && Number.isSafeInteger(count) && Number(count) >= 0)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function requiredTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid`)
  return Number(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
