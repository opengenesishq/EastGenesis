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
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProjectAggregateObjectCounts } from '../../shared/project-aggregate-types'
import type { ProjectResource, ProjectResourceKind } from '../../shared/project-workspace-types'
import type {
  WorkflowLedgerAuthorizedPurgeCounts,
  WorkflowLedgerAuthorizedPurgeRecord
} from '../task/workflow-ledger-authorized-purge'
import { projectAggregateCanonicalJson, projectAggregateDigest } from '../project-aggregate/codec'
import { ProjectDeletionBackupStore } from './project-deletion-backup-store'

const PROOF_FORMAT = 'caogen.project-deletion-proof.v1' as const

export type ProjectDeletionExternalResourceState =
  | 'not_local'
  | 'missing'
  | 'file'
  | 'directory'
  | 'symlink'
  | 'other'

export interface ProjectDeletionExternalResourceBoundary {
  id: string
  kind: ProjectResourceKind
  locationDigest: string
  state: ProjectDeletionExternalResourceState
}

export interface ProjectDeletionProof {
  schemaVersion: 1
  format: typeof PROOF_FORMAT
  operationId: string
  projectId: string
  createdAt: number
  expectedWorkspaceRevision: number
  backup: {
    path: string
    backupDigest: string
    exportDigest: string
    aggregateRevision: number
    identityDigest: string
    aggregateDigest: string
    objectCounts: ProjectAggregateObjectCounts
    readbackVerified: true
  }
  scope: {
    sessionIds: string[]
    sdkSessionIds: string[]
    artifactBlobDigests: string[]
    effectArtifactRefs?: string[]
  }
  authorizedPurge: {
    seq: number
    recordDigest: string
    removed: WorkflowLedgerAuthorizedPurgeCounts
  }
  residuals: Record<string, number>
  externalResources: {
    before: ProjectDeletionExternalResourceBoundary[]
    after: ProjectDeletionExternalResourceBoundary[]
    preserved: true
    externalDeleteAttempted: false
  }
  proofDigest: string
}

export interface ProjectDeletionProofReceipt {
  path: string
  proofDigest: string
  createdAt: number
}

export class ProjectDeletionProofStore {
  readonly rootDir: string
  private readonly userDataRoot: string

  constructor(userDataRoot: string) {
    this.userDataRoot = requiredRoot(userDataRoot)
    this.rootDir = join(this.userDataRoot, 'private', 'project-deletion-proofs')
  }

  write(input: {
    operationId: string
    projectId: string
    expectedWorkspaceRevision: number
    backupPath: string
    backupDigest: string
    exportDigest: string
    sessionIds: readonly string[]
    sdkSessionIds: readonly string[]
    artifactBlobDigests: readonly string[]
    effectArtifactRefs: readonly string[]
    authorizedPurge: WorkflowLedgerAuthorizedPurgeRecord
    residuals: Readonly<Record<string, number>>
    externalResourcesBefore: readonly ProjectDeletionExternalResourceBoundary[]
  }): ProjectDeletionProofReceipt {
    const operationId = requiredId(input.operationId, 'operationId')
    const projectId = requiredId(input.projectId, 'projectId')
    const file = this.pathFor(operationId, projectId)
    if (existsSync(file)) return this.verify(file, operationId, projectId)
    const backup = new ProjectDeletionBackupStore(this.userDataRoot)
      .read(input.backupPath, operationId, projectId)
    if (backup.backupDigest !== input.backupDigest || backup.aggregateExport.exportDigest !== input.exportDigest) {
      throw new Error('project deletion proof backup receipt mismatch')
    }
    if (input.authorizedPurge.operationId !== operationId || input.authorizedPurge.projectId !== projectId) {
      throw new Error('project deletion proof authorized purge identity mismatch')
    }
    const residuals = normalizedResiduals(input.residuals)
    assertZeroResiduals(residuals)
    const before = normalizedExternalBoundaries(input.externalResourcesBefore)
    const after = captureProjectExternalResourceBoundaries(backup.aggregateExport.aggregate.resources)
    if (projectAggregateCanonicalJson(before) !== projectAggregateCanonicalJson(after)) {
      throw new Error('external Project resources changed during permanent deletion')
    }
    const aggregate = backup.aggregateExport.aggregate
    const body = {
      schemaVersion: 1 as const,
      format: PROOF_FORMAT,
      operationId,
      projectId,
      createdAt: Date.now(),
      expectedWorkspaceRevision: nonNegativeInteger(input.expectedWorkspaceRevision, 'expectedWorkspaceRevision'),
      backup: {
        path: resolve(input.backupPath),
        backupDigest: input.backupDigest,
        exportDigest: input.exportDigest,
        aggregateRevision: backup.aggregateExport.aggregateRevision,
        identityDigest: aggregate.identityDigest,
        aggregateDigest: aggregate.aggregateDigest,
        objectCounts: aggregate.objectCounts,
        readbackVerified: true as const
      },
      scope: {
        sessionIds: normalizedIds(input.sessionIds, 'sessionId'),
        sdkSessionIds: normalizedIds(input.sdkSessionIds, 'sdkSessionId'),
        artifactBlobDigests: normalizedDigests(input.artifactBlobDigests),
        effectArtifactRefs: normalizedEffectArtifactRefs(input.effectArtifactRefs)
      },
      authorizedPurge: {
        seq: input.authorizedPurge.seq,
        recordDigest: input.authorizedPurge.digest,
        removed: { ...input.authorizedPurge.removed }
      },
      residuals,
      externalResources: {
        before,
        after,
        preserved: true as const,
        externalDeleteAttempted: false as const
      }
    }
    const proof: ProjectDeletionProof = { ...body, proofDigest: projectAggregateDigest(body) }
    atomicPrivateWrite(file, `${projectAggregateCanonicalJson(proof)}\n`)
    return this.verify(file, operationId, projectId)
  }

  verify(file: string, operationId: string, projectId: string): ProjectDeletionProofReceipt {
    const proof = this.read(file, operationId, projectId)
    return { path: resolve(file), proofDigest: proof.proofDigest, createdAt: proof.createdAt }
  }

  read(file: string, operationId: string, projectId: string): ProjectDeletionProof {
    const expected = this.pathFor(operationId, projectId)
    if (resolve(file) !== expected) throw new Error('project deletion proof path does not match its operation')
    const stat = lstatSync(expected)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('project deletion proof is not a regular file')
    const parsed = JSON.parse(readFileSync(expected, 'utf8')) as unknown
    assertProof(parsed, operationId, projectId)
    const backup = new ProjectDeletionBackupStore(this.userDataRoot)
      .read(parsed.backup.path, operationId, projectId)
    if (backup.backupDigest !== parsed.backup.backupDigest ||
        backup.aggregateExport.exportDigest !== parsed.backup.exportDigest ||
        backup.aggregateExport.aggregateRevision !== parsed.backup.aggregateRevision ||
        backup.aggregateExport.aggregate.identityDigest !== parsed.backup.identityDigest ||
        backup.aggregateExport.aggregate.aggregateDigest !== parsed.backup.aggregateDigest ||
        projectAggregateCanonicalJson(backup.aggregateExport.aggregate.objectCounts) !==
          projectAggregateCanonicalJson(parsed.backup.objectCounts)) {
      throw new Error('project deletion proof no longer matches its backup readback')
    }
    return structuredClone(parsed)
  }

  private pathFor(operationId: string, projectId: string): string {
    const operation = requiredId(operationId, 'operationId')
    const project = requiredId(projectId, 'projectId')
    const directory = join(this.rootDir, projectAggregateDigest({ project }).slice(0, 24))
    return resolve(directory, `${projectAggregateDigest({ operation }).slice(0, 32)}.json`)
  }
}

export function captureProjectExternalResourceBoundaries(
  resources: readonly ProjectResource[]
): ProjectDeletionExternalResourceBoundary[] {
  return resources.map((resource) => {
    const location = resource.path ?? resource.uri ?? ''
    return {
      id: requiredId(resource.id, 'resource id'),
      kind: resource.kind,
      locationDigest: projectAggregateDigest({ location }),
      state: externalResourceState(resource.path)
    }
  }).sort((left, right) => left.id.localeCompare(right.id))
}

function externalResourceState(path: string | undefined): ProjectDeletionExternalResourceState {
  if (!path || !isAbsolute(path)) return 'not_local'
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isFile()) return 'file'
    if (stat.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function assertProof(value: unknown, operationId: string, projectId: string): asserts value is ProjectDeletionProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project deletion proof is invalid')
  const proof = value as Partial<ProjectDeletionProof>
  if (!proofHeaderValid(proof, operationId, projectId)) {
    throw new Error('project deletion proof schema or identity is invalid')
  }
  const { proofDigest, ...body } = proof as ProjectDeletionProof
  if (projectAggregateDigest(body) !== proofDigest) throw new Error('project deletion proof digest mismatch')
  assertZeroResiduals(normalizedResiduals(proof.residuals ?? {}))
  normalizedIds(proof.scope.sessionIds ?? [], 'sessionId')
  normalizedIds(proof.scope.sdkSessionIds ?? [], 'sdkSessionId')
  normalizedDigests(proof.scope.artifactBlobDigests ?? [])
  normalizedEffectArtifactRefs(proof.scope.effectArtifactRefs ?? [])
  const before = normalizedExternalBoundaries(proof.externalResources.before ?? [])
  const after = normalizedExternalBoundaries(proof.externalResources.after ?? [])
  if (projectAggregateCanonicalJson(before) !== projectAggregateCanonicalJson(after)) {
    throw new Error('project deletion proof external resource boundary mismatch')
  }
}

function proofHeaderValid(
  proof: Partial<ProjectDeletionProof>,
  operationId: string,
  projectId: string
): proof is ProjectDeletionProof {
  return [
    proof.schemaVersion === 1,
    proof.format === PROOF_FORMAT,
    proof.operationId === operationId,
    proof.projectId === projectId,
    Number.isSafeInteger(proof.createdAt),
    Boolean(proof.backup),
    Boolean(proof.scope),
    Boolean(proof.authorizedPurge),
    Boolean(proof.externalResources),
    isDigest(proof.proofDigest),
    proof.externalResources?.preserved === true,
    proof.externalResources?.externalDeleteAttempted === false
  ].every(Boolean)
}

function normalizedExternalBoundaries(
  values: readonly ProjectDeletionExternalResourceBoundary[]
): ProjectDeletionExternalResourceBoundary[] {
  if (!Array.isArray(values)) throw new Error('project deletion proof external resources are invalid')
  const ids = new Set<string>()
  const normalized = values.map((value) => {
    if (!value || typeof value !== 'object' || !requiredId(value.id, 'resource id') ||
        typeof value.kind !== 'string' || !isDigest(value.locationDigest) || !isExternalState(value.state)) {
      throw new Error('project deletion proof external resource boundary is invalid')
    }
    if (ids.has(value.id)) throw new Error('project deletion proof contains duplicate external resources')
    ids.add(value.id)
    return { ...value }
  })
  return normalized.sort((left, right) => left.id.localeCompare(right.id))
}

function normalizedResiduals(values: Readonly<Record<string, number>>): Record<string, number> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('project deletion residuals are invalid')
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0 || entries.some(([key, value]) => !key || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('project deletion residuals are invalid')
  }
  return Object.fromEntries(entries)
}

function assertZeroResiduals(residuals: Readonly<Record<string, number>>): void {
  const total = Object.values(residuals).reduce((sum, value) => sum + value, 0)
  if (total !== 0) throw new Error(`project deletion proof has ${total} residual records`)
}

function normalizedIds(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} list is invalid`)
  return [...new Set(values.map((value) => requiredId(value, label)))].sort()
}

function normalizedDigests(values: readonly string[]): string[] {
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value))) {
    throw new Error('artifact blob digest list is invalid')
  }
  return [...new Set(values)].sort()
}

function normalizedEffectArtifactRefs(values: readonly string[]): string[] {
  if (!Array.isArray(values) || !values.every((value) =>
    typeof value === 'string' && /^git-index\/[a-f0-9]{64}$/.test(value))) {
    throw new Error('effect artifact reference list is invalid')
  }
  return [...new Set(values)].sort()
}

function isExternalState(value: unknown): value is ProjectDeletionExternalResourceState {
  return value === 'not_local' || value === 'missing' || value === 'file' || value === 'directory' ||
    value === 'symlink' || value === 'other'
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
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
