import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ProjectAggregateExportBundle, ProjectAggregateExportResult } from '../../shared/project-aggregate-types'
import {
  assertNoCredentialMaterial,
  projectAggregateCanonicalJson,
  projectAggregateDigest
} from '../project-aggregate/codec'

const BACKUP_FORMAT = 'caogen.project-deletion-backup.v1' as const

export interface ProjectDeletionBackup {
  schemaVersion: 1
  format: typeof BACKUP_FORMAT
  operationId: string
  projectId: string
  createdAt: number
  aggregateExport: ProjectAggregateExportBundle
  backupDigest: string
}

export interface ProjectDeletionBackupReceipt {
  path: string
  backupDigest: string
  exportDigest: string
}

export class ProjectDeletionBackupStore {
  readonly rootDir: string

  constructor(userDataRoot: string) {
    this.rootDir = join(requiredRoot(userDataRoot), 'private', 'project-deletion-backups')
  }

  write(operationId: string, projectId: string, aggregate: ProjectAggregateExportResult): ProjectDeletionBackupReceipt {
    const file = this.pathFor(operationId, projectId)
    if (existsSync(file)) return this.verify(file, operationId, projectId)
    assertAggregateExport(aggregate, projectId)
    const body = {
      schemaVersion: 1 as const,
      format: BACKUP_FORMAT,
      operationId: requiredId(operationId, 'operationId'),
      projectId: requiredId(projectId, 'projectId'),
      createdAt: Date.now(),
      aggregateExport: aggregate.bundle
    }
    assertNoCredentialMaterial(body)
    const backup: ProjectDeletionBackup = { ...body, backupDigest: projectAggregateDigest(body) }
    atomicPrivateWrite(file, `${projectAggregateCanonicalJson(backup)}\n`)
    return this.verify(file, operationId, projectId)
  }

  verify(file: string, operationId: string, projectId: string): ProjectDeletionBackupReceipt {
    const parsed = this.read(file, operationId, projectId)
    return {
      path: resolve(file),
      backupDigest: parsed.backupDigest,
      exportDigest: parsed.aggregateExport.exportDigest
    }
  }

  read(file: string, operationId: string, projectId: string): ProjectDeletionBackup {
    const expected = this.pathFor(operationId, projectId)
    if (resolve(file) !== expected) throw new Error('project deletion backup path does not match its operation')
    const stat = lstatSync(expected)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('project deletion backup is not a regular file')
    const parsed = JSON.parse(readFileSync(expected, 'utf8')) as unknown
    assertBackup(parsed, operationId, projectId)
    return structuredClone(parsed)
  }

  private pathFor(operationId: string, projectId: string): string {
    const operation = requiredId(operationId, 'operationId')
    const project = requiredId(projectId, 'projectId')
    const directory = join(this.rootDir, projectAggregateDigest({ project }).slice(0, 24))
    return resolve(directory, `${projectAggregateDigest({ operation }).slice(0, 32)}.json`)
  }
}

function assertAggregateExport(value: ProjectAggregateExportResult, projectId: string): void {
  if (value.bundle.projectId !== projectId || value.bundle.verification.projectId !== projectId ||
      value.bundle.verification.valid !== true || value.bundle.verification.sanitized !== true ||
      value.bundle.verification.sealed !== true || value.bundle.exportDigest !== value.exportDigest) {
    throw new Error('Project aggregate export is not a verified, sanitized, sealed backup')
  }
  const { exportDigest: _digest, ...body } = value.bundle
  if (projectAggregateDigest(body) !== value.exportDigest) {
    throw new Error('Project aggregate export digest mismatch')
  }
  assertNoCredentialMaterial(value.bundle)
}

function assertBackup(value: unknown, operationId: string, projectId: string): asserts value is ProjectDeletionBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project deletion backup is invalid')
  const record = value as Partial<ProjectDeletionBackup>
  if (record.schemaVersion !== 1 || record.format !== BACKUP_FORMAT || record.operationId !== operationId ||
      record.projectId !== projectId || typeof record.createdAt !== 'number' || !record.aggregateExport ||
      typeof record.backupDigest !== 'string') {
    throw new Error('project deletion backup identity is invalid')
  }
  const { backupDigest, ...body } = record as ProjectDeletionBackup
  if (projectAggregateDigest(body) !== backupDigest) throw new Error('project deletion backup digest mismatch')
  assertAggregateExport({
    schemaVersion: record.aggregateExport.schemaVersion,
    format: record.aggregateExport.format,
    json: projectAggregateCanonicalJson(record.aggregateExport),
    exportDigest: record.aggregateExport.exportDigest,
    bundle: record.aggregateExport
  }, projectId)
  assertNoCredentialMaterial(record)
}

function atomicPrivateWrite(file: string, content: string): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    if (process.platform !== 'win32') chmodSync(file, 0o600)
    syncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}
