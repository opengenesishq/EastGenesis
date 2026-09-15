import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { acquireFileLock, enqueueMutation, releaseFileLock } from '../digital-worker/persistence'

export const PROJECT_IMPORT_PHASES = [
  'source_saved',
  'workspace_imported',
  'workforce_imported',
  'workflow_imported',
  'runtime_imported',
  'automation_imported',
  'learning_imported',
  'sealed',
  'completed'
] as const

export type ProjectImportPhase = typeof PROJECT_IMPORT_PHASES[number]

export interface ProjectImportJournalEntry {
  schemaVersion: 1
  operationId: string
  projectId: string
  phase: ProjectImportPhase
  sourcePath: string
  sourceDigest: string
  exportDigest: string
  sourceAggregateDigest: string
  sourceSemanticDigest: string
  importedAggregateDigest?: string
  importedSemanticDigest?: string
  aggregateRevision?: number
  createdAt: number
  updatedAt: number
  completedAt?: number
}

interface JournalDocument {
  schemaVersion: 1
  revision: number
  entries: ProjectImportJournalEntry[]
}

export class ProjectImportJournal {
  readonly filePath: string
  private readonly lockPath: string

  constructor(userDataRoot: string) {
    this.filePath = join(requiredRoot(userDataRoot), 'private', 'project-import-journal.json')
    this.lockPath = `${this.filePath}.lock`
  }

  listPending(): ProjectImportJournalEntry[] {
    return readDocument(this.filePath).entries.filter((entry) => entry.phase !== 'completed').map(clone)
  }

  listCompleted(projectId: string): ProjectImportJournalEntry[] {
    const id = requiredId(projectId, 'projectId')
    return readDocument(this.filePath).entries.filter((entry) => entry.projectId === id && entry.phase === 'completed')
      .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0)).map(clone)
  }

  getOperation(operationId: string): ProjectImportJournalEntry | undefined {
    const id = requiredId(operationId, 'operationId')
    return clone(readDocument(this.filePath).entries.find((entry) => entry.operationId === id))
  }

  async begin(input: Omit<ProjectImportJournalEntry, 'schemaVersion' | 'phase' | 'createdAt' | 'updatedAt'>): Promise<ProjectImportJournalEntry> {
    return this.mutate((document) => {
      const existing = document.entries.find((entry) => entry.operationId === input.operationId)
      if (existing) return existing
      const pendingProject = document.entries.find((entry) => entry.projectId === input.projectId && entry.phase !== 'completed')
      if (pendingProject) throw new Error(`Project import is already pending: ${input.projectId}`)
      const now = Date.now()
      const entry: ProjectImportJournalEntry = {
        schemaVersion: 1,
        ...input,
        phase: 'source_saved',
        createdAt: now,
        updatedAt: now
      }
      document.entries.push(entry)
      return entry
    })
  }

  async advance(
    operationId: string,
    phase: ProjectImportPhase,
    patch: Partial<Pick<ProjectImportJournalEntry,
      'importedAggregateDigest' | 'importedSemanticDigest' | 'aggregateRevision'>> = {}
  ): Promise<ProjectImportJournalEntry> {
    const targetIndex = PROJECT_IMPORT_PHASES.indexOf(phase)
    if (targetIndex < 0) throw new Error('Project import phase is invalid')
    return this.mutate((document) => {
      const entry = document.entries.find((candidate) => candidate.operationId === operationId)
      if (!entry) throw new Error(`Project import operation not found: ${operationId}`)
      const currentIndex = PROJECT_IMPORT_PHASES.indexOf(entry.phase)
      if (targetIndex < currentIndex) return entry
      if (targetIndex > currentIndex + 1) throw new Error(`Project import phase cannot skip ${entry.phase} -> ${phase}`)
      entry.phase = phase
      entry.updatedAt = Date.now()
      Object.assign(entry, patch)
      if (phase === 'completed') entry.completedAt = entry.updatedAt
      return entry
    })
  }

  private async mutate<T>(operation: (document: JournalDocument) => T): Promise<T> {
    return enqueueMutation(this.filePath, async () => {
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
    })
  }
}

function readDocument(file: string): JournalDocument {
  if (!existsSync(file)) return { schemaVersion: 1, revision: 0, entries: [] }
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project import journal is invalid')
  const document = value as Partial<JournalDocument>
  if (document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || !Array.isArray(document.entries)) {
    throw new Error('Project import journal is invalid')
  }
  const operations = new Set<string>()
  for (const entry of document.entries) {
    assertJournalEntry(entry)
    if (operations.has(entry.operationId)) throw new Error('Project import journal contains duplicate operations')
    operations.add(entry.operationId)
  }
  return clone(document as JournalDocument)
}

function assertJournalEntry(entry: ProjectImportJournalEntry): void {
  const fieldsValid = [
    entry.schemaVersion === 1,
    Boolean(requiredId(entry.operationId, 'operationId')),
    Boolean(requiredId(entry.projectId, 'projectId')),
    PROJECT_IMPORT_PHASES.includes(entry.phase),
    pathValue(entry.sourcePath),
    digestValue(entry.sourceDigest),
    digestValue(entry.exportDigest),
    digestValue(entry.sourceAggregateDigest),
    digestValue(entry.sourceSemanticDigest),
    typeof entry.createdAt === 'number',
    typeof entry.updatedAt === 'number',
    optionalDigest(entry.importedAggregateDigest),
    optionalDigest(entry.importedSemanticDigest),
    optionalPositiveInteger(entry.aggregateRevision)
  ].every(Boolean)
  if (!fieldsValid) throw new Error('Project import journal entry is invalid')
}

function optionalDigest(value: unknown): boolean {
  return value === undefined ? true : digestValue(value)
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined ? true : Number.isSafeInteger(value) && Number(value) >= 1
}

function writeDocument(file: string, document: JournalDocument): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    if (process.platform !== 'win32') {
      const directoryHandle = openSync(directory, 'r')
      try { fsyncSync(directoryHandle) } finally { closeSync(directoryHandle) }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function pathValue(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0')
}

function digestValue(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
