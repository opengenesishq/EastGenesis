import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  ProjectAggregateArtifactSourceFile,
  ProjectAggregateExportBundle,
  ProjectAggregatePortableRuntime,
  ProjectAggregateSnapshot
} from '../../shared/project-aggregate-types'
import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { TaskSnapshotRecord } from '../../shared/types'
import { projectAggregateCanonicalJson, projectAggregateDigest, sanitizeProjectAggregateValue } from '../project-aggregate/codec'
import {
  artifactBlobPath,
  artifactSourceExtension,
  artifactSourceFilePath,
  assertArtifactContentCredentialFree,
  assertRegularContent,
  contentDigest,
  materializeArtifactBlob,
  materializeArtifactSourceFile
} from '../task/artifact-lifecycle-content'
import {
  findArtifactLifecycle,
  findArtifactPurge,
  importArtifactLifecycleSlice,
  readArtifactLifecycles,
  readArtifactPurges,
  readArtifactRetentionRevisions
} from '../task/artifact-lifecycle-store'
import type {
  ArtifactLifecycleRecord,
  ArtifactPurgeRecord,
  ArtifactRetentionRevisionRecord
} from '../task/artifact-lifecycle-types'
import { getModelAttempt, selectModelAttempts } from '../task/model-attempt-store'
import {
  listTaskSnapshots,
  mutateTaskSnapshotDatabase,
  readTaskSnapshotDatabase,
  saveTaskSnapshot
} from '../task/task-snapshot'
import {
  assertProjectSessionPortableSliceImportable,
  collectProjectSessionPortableSlice,
  importProjectSessionPortableSlice,
  validateProjectSessionPortableSlice,
  verifyProjectSessionPortableSlice
} from './project-session-portability'
import { importModelAttemptRecords } from './model-attempt-import'
import { reconcileAllTaskPlans } from '../task/task-plan-ledger'
import {
  assertProjectEffectArtifactsImportable,
  collectProjectEffectArtifacts,
  importProjectEffectArtifacts,
  validateProjectEffectArtifacts,
  verifyProjectEffectArtifacts
} from './project-effect-artifact-portability'
import {
  collectProjectExternalFileManifests,
  validateProjectExternalFileManifests
} from './project-external-file-manifest'
import { validateSubmissionReceiptBindings } from './submission-receipt-portability'
import { assertProjectLayeredMemoryImportable, collectProjectLayeredMemory, importProjectLayeredMemory,
  validateProjectLayeredMemory, verifyProjectLayeredMemory } from './layered-memory-portability'

const QUERY_LIMIT = 500
const PORTABLE_RUNTIME_ARRAY_FIELDS = [
  'sessionIds',
  'sdkSessionIds',
  'sessionHistory',
  'activeSessions',
  'sessionCreationJournal',
  'taskPlans',
  'sessionFiles',
  'taskSnapshots',
  'modelAttempts',
  'artifactLifecycles',
  'artifactPurges',
  'artifactBlobs'
] as const

export interface ProjectPortableRuntimeResult {
  sessionIds: number
  taskSnapshots: number
  modelAttempts: number
  artifactLifecycles: number
  artifactPurges: number
  artifactRetentionRevisions: number
  artifactBlobs: number
  artifactSourceFiles: number
  effectArtifacts: number
  externalFiles: number
  layeredMemory: number
}

export async function collectProjectPortableRuntime(
  projectId: string,
  rootDir: string,
  aggregate: ProjectAggregateSnapshot
): Promise<ProjectAggregatePortableRuntime> {
  const runIds = new Set(aggregate.workflow.runs.map((run) => run.id))
  const [allSnapshots, attempts, artifactSlice] = await Promise.all([
    listTaskSnapshots(rootDir),
    readAllProjectAttempts(projectId, rootDir),
    readTaskSnapshotDatabase(rootDir, (db) => ({
      lifecycles: readArtifactLifecycles(db).filter((record) => record.projectId === projectId),
      purges: readArtifactPurges(db).filter((record) => record.projectId === projectId),
      retentionRevisions: readArtifactRetentionRevisions(db).filter((record) => record.projectId === projectId)
    }))
  ])
  const taskSnapshots = allSnapshots.filter((snapshot) =>
    snapshot.meta.workspaceId === projectId || snapshot.meta.projectId === projectId ||
    Boolean(snapshot.run && runIds.has(snapshot.run.id)))
  const sessionIds = [...new Set([
    ...aggregate.workflow.runs.map((run) => run.sessionId),
    ...taskSnapshots.map((snapshot) => snapshot.sessionId)
  ])].sort()
  const sessions = collectProjectSessionPortableSlice(rootDir, projectId, sessionIds, taskSnapshots)
  validateSubmissionReceiptBindings(sessions.submissionReceipts, aggregate)
  const [artifactBlobs, artifactSourceFiles] = await Promise.all([
    collectArtifactBlobs(rootDir, artifactSlice.lifecycles, artifactSlice.purges),
    collectArtifactSourceFiles(artifactSlice.lifecycles, artifactSlice.purges)
  ])
  const effectArtifacts = collectProjectEffectArtifacts(rootDir, aggregate, taskSnapshots)
  const externalFiles = await collectProjectExternalFileManifests(aggregate, artifactSlice.lifecycles)
  const layeredMemory = await collectProjectLayeredMemory(rootDir, aggregate, { ...sessions, taskSnapshots })
  const body = sanitizeProjectAggregateValue({
    schemaVersion: 1 as const,
    ...sessions,
    taskSnapshots: taskSnapshots.sort(bySnapshot),
    modelAttempts: attempts.sort(byAttempt),
    artifactLifecycles: artifactSlice.lifecycles.sort(byLifecycle),
    artifactPurges: artifactSlice.purges.sort(byPurge),
    artifactRetentionRevisions: artifactSlice.retentionRevisions.sort(byRetentionRevision),
    artifactBlobs,
    artifactSourceFiles,
    effectArtifacts,
    externalFiles,
    layeredMemory
  }) as Omit<ProjectAggregatePortableRuntime, 'runtimeDigest'>
  return { ...body, runtimeDigest: projectAggregateDigest(body) }
}

export function validateProjectPortableRuntime(
  bundle: Pick<ProjectAggregateExportBundle, 'projectId' | 'aggregate' | 'runtime'>
): ProjectAggregatePortableRuntime | undefined {
  if (bundle.runtime === undefined) return undefined
  const runtime = requirePortableRuntime(bundle.runtime)
  const { runtimeDigest, ...body } = runtime
  if (projectAggregateDigest(body) !== runtimeDigest) throw new Error('Project import runtime digest mismatch')
  validateProjectSessionPortableSlice(bundle.projectId, runtime)
  validateSubmissionReceiptBindings(runtime.submissionReceipts, bundle.aggregate)
  const runIds = new Set(bundle.aggregate.workflow.runs.map((run) => run.id))
  const sessionIds = uniqueIds(runtime.sessionIds, 'runtime sessionId')
  validateTaskSnapshots(runtime.taskSnapshots, bundle.projectId, runIds, sessionIds)
  validateModelAttempts(runtime.modelAttempts, bundle.projectId, runIds)
  validateArtifactRuntime(bundle, runtime, runIds)
  validateProjectEffectArtifacts(bundle, runtime)
  validateProjectExternalFileManifests(bundle, runtime)
  validateProjectLayeredMemory(runtime.layeredMemory, bundle.aggregate, runtime)
  return structuredClone(runtime)
}

function requirePortableRuntime(value: unknown): ProjectAggregatePortableRuntime {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runtimeDigest !== 'string') {
    throw new Error('Project import portable runtime is invalid')
  }
  for (const field of PORTABLE_RUNTIME_ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) throw new Error('Project import portable runtime is invalid')
  }
  if (value.artifactSourceFiles !== undefined && !Array.isArray(value.artifactSourceFiles)) {
    throw new Error('Project import portable runtime is invalid')
  }
  if (value.artifactRetentionRevisions !== undefined && !Array.isArray(value.artifactRetentionRevisions)) {
    throw new Error('Project import portable runtime is invalid')
  }
  if (value.effectArtifacts !== undefined && !Array.isArray(value.effectArtifacts)) {
    throw new Error('Project import portable runtime is invalid')
  }
  if (value.externalFiles !== undefined && !Array.isArray(value.externalFiles)) {
    throw new Error('Project import portable runtime is invalid')
  }
  return value as unknown as ProjectAggregatePortableRuntime
}

function validateTaskSnapshots(
  snapshots: readonly TaskSnapshotRecord[],
  projectId: string,
  runIds: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>
): void {
  assertUnique(snapshots, recordId, 'TaskSnapshot')
  for (const snapshot of snapshots) {
    if (!isOwnedTaskSnapshot(snapshot, projectId, runIds)) {
      throw new Error('Project import TaskSnapshot crosses Project ownership')
    }
    if (!sessionIds.has(snapshot.sessionId)) throw new Error('Project import TaskSnapshot session is not declared')
  }
}

function isOwnedTaskSnapshot(value: unknown, projectId: string, runIds: ReadonlySet<string>): value is TaskSnapshotRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sessionId !== 'string' || !isRecord(value.meta)) {
    return false
  }
  if (value.meta.workspaceId === projectId || value.meta.projectId === projectId) return true
  return isRecord(value.run) && runIds.has(String(value.run.id))
}

function validateModelAttempts(
  attempts: readonly ModelAttemptRecord[],
  projectId: string,
  runIds: ReadonlySet<string>
): void {
  assertUnique(attempts, recordId, 'ModelAttempt')
  for (const attempt of attempts) {
    if (!isRecord(attempt) || attempt.projectId !== projectId || !runIds.has(String(attempt.runId))) {
      throw new Error('Project import ModelAttempt crosses Project ownership')
    }
  }
}

function validateArtifactRuntime(
  bundle: Pick<ProjectAggregateExportBundle, 'projectId' | 'aggregate'>,
  runtime: ProjectAggregatePortableRuntime,
  runIds: ReadonlySet<string>
): void {
  const artifactIds = new Set(bundle.aggregate.workflow.artifacts.map((artifact) => artifact.id))
  const lifecycles = runtime.artifactLifecycles.map(requireLifecycle)
  const purges = runtime.artifactPurges.map(requirePurge)
  const retentionRevisions = (runtime.artifactRetentionRevisions ?? []).map(requireRetentionRevision)
  assertUnique(lifecycles, (record) => record.artifactId, 'Artifact lifecycle')
  assertUnique(purges, (record) => record.artifactId, 'Artifact purge')
  for (const record of lifecycles) {
    if (record.projectId !== bundle.projectId || !runIds.has(record.runId) || !artifactIds.has(record.artifactId)) {
      throw new Error('Project import Artifact lifecycle crosses Project ownership')
    }
  }
  const lifecycleIds = new Set(lifecycles.map((record) => record.artifactId))
  validateArtifactRetentionRevisions(retentionRevisions, lifecycleIds, bundle.projectId)
  for (const record of purges) {
    if (record.projectId !== bundle.projectId || !lifecycleIds.has(record.artifactId)) {
      throw new Error('Project import Artifact purge has no owned lifecycle')
    }
  }
  const purgedIds = new Set(purges.map((record) => record.artifactId))
  const liveBlobDigests = new Set(lifecycles
    .filter((record) => record.storageKind === 'blob' && !purgedIds.has(record.artifactId))
    .map((record) => record.digest))
  validateArtifactBlobs(runtime.artifactBlobs, liveBlobDigests)
  const liveSourceLifecycles = lifecycles
    .filter((record) => record.storageKind === 'source_ref' && !purgedIds.has(record.artifactId))
  validateArtifactSourceFiles(runtime.artifactSourceFiles ?? [], liveSourceLifecycles)
}

function validateArtifactBlobs(
  artifactBlobs: ProjectAggregatePortableRuntime['artifactBlobs'],
  liveBlobDigests: ReadonlySet<string>
): void {
  const blobs = new Map<string, Uint8Array>()
  for (const blob of artifactBlobs) {
    if (!isRecord(blob) || typeof blob.digest !== 'string' || blob.encoding !== 'base64' ||
        typeof blob.data !== 'string' || !Number.isSafeInteger(blob.sizeBytes) || Number(blob.sizeBytes) < 0) {
      throw new Error('Project import Artifact blob is invalid')
    }
    if (blobs.has(blob.digest)) throw new Error(`Project import contains duplicate Artifact blob: ${blob.digest}`)
    const bytes = decodeBase64(blob.data)
    assertArtifactContentCredentialFree(bytes)
    if (bytes.byteLength !== blob.sizeBytes || contentDigest(bytes) !== blob.digest) {
      throw new Error(`Project import Artifact blob digest mismatch: ${blob.digest}`)
    }
    blobs.set(blob.digest, bytes)
  }
  if (projectAggregateCanonicalJson([...blobs.keys()].sort()) !==
      projectAggregateCanonicalJson([...liveBlobDigests].sort())) {
    throw new Error('Project import Artifact blob closure is incomplete')
  }
}

function validateArtifactSourceFiles(
  values: readonly ProjectAggregateArtifactSourceFile[],
  liveLifecycles: readonly ArtifactLifecycleRecord[]
): void {
  const sources = new Map<string, ProjectAggregateArtifactSourceFile>()
  for (const value of values) {
    const source = requireArtifactSourceFile(value)
    if (sources.has(source.artifactId)) throw new Error(
      `Project import contains duplicate Artifact source file: ${source.artifactId}`)
    const lifecycle = liveLifecycles.find((record) => record.artifactId === source.artifactId)
    assertArtifactSourceBinding(source, lifecycle)
    sources.set(source.artifactId, source)
  }
  if (projectAggregateCanonicalJson([...sources.keys()].sort()) !==
      projectAggregateCanonicalJson(liveLifecycles.map((record) => record.artifactId).sort())) {
    throw new Error('Project import Artifact source file closure is incomplete')
  }
}

function requireArtifactSourceFile(value: unknown): ProjectAggregateArtifactSourceFile {
  if (!isRecord(value) || typeof value.artifactId !== 'string' || !value.artifactId.trim() ||
      typeof value.digest !== 'string' || value.encoding !== 'base64' || typeof value.data !== 'string' ||
      typeof value.extension !== 'string' || !/^$|^\.[a-z0-9]{1,16}$/.test(value.extension) ||
      !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0) {
    throw new Error('Project import Artifact source file is invalid')
  }
  return value as unknown as ProjectAggregateArtifactSourceFile
}

function assertArtifactSourceBinding(
  source: ProjectAggregateArtifactSourceFile,
  lifecycle: ArtifactLifecycleRecord | undefined
): void {
  const bytes = decodeBase64(source.data)
  assertArtifactContentCredentialFree(bytes)
  if (!lifecycle || lifecycle.digest !== source.digest || lifecycle.sizeBytes !== source.sizeBytes ||
      bytes.byteLength !== source.sizeBytes || contentDigest(bytes) !== source.digest) {
    throw new Error(`Project import Artifact source file digest mismatch: ${source.artifactId}`)
  }
}

export async function importProjectPortableRuntime(
  bundle: Pick<ProjectAggregateExportBundle, 'projectId' | 'aggregate' | 'runtime'>,
  rootDir: string
): Promise<ProjectPortableRuntimeResult> {
  const runtime = validateProjectPortableRuntime(bundle)
  if (!runtime) return emptyResult()
  await assertProjectLayeredMemoryImportable(rootDir, runtime.layeredMemory)
  importProjectSessionPortableSlice(rootDir, bundle.projectId, runtime)
  await reconcileAllTaskPlans(rootDir)
  importProjectEffectArtifacts(bundle, runtime, rootDir)
  for (const snapshot of runtime.taskSnapshots) {
    await saveTaskSnapshot(snapshot, rootDir, { projectWorkflow: false })
  }
  for (const blob of runtime.artifactBlobs) {
    const bytes = decodeBase64(blob.data)
    await materializeArtifactBlob({
      storageKind: 'blob',
      digest: blob.digest,
      sizeBytes: blob.sizeBytes,
      bytes,
      blobRef: `sha256/${blob.digest.slice('sha256:'.length)}`,
      locationPath: artifactBlobPath(rootDir, blob.digest)
    })
  }
  for (const source of runtime.artifactSourceFiles ?? []) {
    const bytes = decodeBase64(source.data)
    await materializeArtifactSourceFile({
      locationPath: artifactSourceFilePath(rootDir, bundle.projectId, source.artifactId, source.extension),
      bytes,
      digest: source.digest,
      sizeBytes: source.sizeBytes
    })
  }
  const reboundLifecycles = rebindArtifactLifecycles(bundle, runtime, rootDir)
  await mutateTaskSnapshotDatabase(rootDir, (db) => {
    importArtifactLifecycleSlice(db, reboundLifecycles, runtime.artifactPurges, runtime.artifactRetentionRevisions)
    importModelAttemptRecords(db, runtime.modelAttempts)
  })
  await importProjectLayeredMemory(rootDir, runtime.layeredMemory)
  await verifyProjectPortableRuntime(bundle, rootDir)
  return runtimeResult(runtime)
}

export async function assertProjectPortableRuntimeImportable(
  bundle: Pick<ProjectAggregateExportBundle, 'projectId' | 'aggregate' | 'runtime'>,
  rootDir: string
): Promise<void> {
  const runtime = validateProjectPortableRuntime(bundle)
  if (!runtime) return
  await assertProjectLayeredMemoryImportable(rootDir, runtime.layeredMemory)
  assertProjectSessionPortableSliceImportable(rootDir, bundle.projectId, runtime)
  assertProjectEffectArtifactsImportable(bundle, runtime, rootDir)
  const snapshotIds = new Set((await listTaskSnapshots(rootDir)).map((snapshot) => snapshot.id))
  const snapshotConflicts = runtime.taskSnapshots.filter((snapshot) => snapshotIds.has(snapshot.id)).map((snapshot) => snapshot.id)
  const databaseConflicts = await readTaskSnapshotDatabase(rootDir, (db) => ({
    attempts: runtime.modelAttempts.filter((attempt) => getModelAttempt(db, attempt.id)).map((attempt) => attempt.id),
    lifecycles: runtime.artifactLifecycles.map(requireLifecycle)
      .filter((record) => findArtifactLifecycle(db, record.artifactId)).map((record) => record.artifactId),
    purges: runtime.artifactPurges.map(requirePurge)
      .filter((record) => findArtifactPurge(db, record.artifactId)).map((record) => record.artifactId),
    retentionRevisions: (runtime.artifactRetentionRevisions ?? []).map(requireRetentionRevision)
      .filter((record) => readArtifactRetentionRevisions(db, record.artifactId)
        .some((candidate) => candidate.revision === record.revision))
      .map((record) => `${record.artifactId}:${record.revision}`)
  }))
  const conflicts = [
    ...snapshotConflicts.map((id) => `snapshot:${id}`),
    ...databaseConflicts.attempts.map((id) => `attempt:${id}`),
    ...databaseConflicts.lifecycles.map((id) => `artifact_lifecycle:${id}`),
    ...databaseConflicts.purges.map((id) => `artifact_purge:${id}`),
    ...databaseConflicts.retentionRevisions.map((id) => `artifact_retention:${id}`)
  ].sort()
  if (conflicts.length > 0) throw new Error(`Project import runtime identity conflict: ${conflicts.join(', ')}`)
  for (const blob of runtime.artifactBlobs) {
    try {
      await assertRegularContent(artifactBlobPath(rootDir, blob.digest), blob.digest, blob.sizeBytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  for (const source of runtime.artifactSourceFiles ?? []) {
    const file = artifactSourceFilePath(rootDir, bundle.projectId, source.artifactId, source.extension)
    try {
      await assertRegularContent(file, source.digest, source.sizeBytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
}

export async function verifyProjectPortableRuntime(
  bundle: Pick<ProjectAggregateExportBundle, 'projectId' | 'aggregate' | 'runtime'>,
  rootDir: string
): Promise<ProjectPortableRuntimeResult> {
  const runtime = validateProjectPortableRuntime(bundle)
  if (!runtime) return emptyResult()
  await verifyProjectLayeredMemory(rootDir, runtime.layeredMemory)
  verifyProjectSessionPortableSlice(rootDir, bundle.projectId, runtime)
  verifyProjectEffectArtifacts(bundle, runtime, rootDir)
  const sourceSnapshots = runtime.taskSnapshots.slice().sort(bySnapshot)
  const snapshotIds = new Set(sourceSnapshots.map((snapshot) => snapshot.id))
  const targetSnapshots = (await listTaskSnapshots(rootDir)).filter((snapshot) => snapshotIds.has(snapshot.id)).sort(bySnapshot)
  assertSemanticEqual(targetSnapshots, sourceSnapshots, 'TaskSnapshot')
  const targetAttempts = await readAllProjectAttempts(bundle.projectId, rootDir)
  assertSemanticEqual(targetAttempts.map(stripAttemptNext).sort(byAttempt),
    runtime.modelAttempts.map(stripAttemptNext).sort(byAttempt), 'ModelAttempt')
  const targetArtifacts = await readTaskSnapshotDatabase(rootDir, (db) => ({
    lifecycles: readArtifactLifecycles(db).filter((record) => record.projectId === bundle.projectId).sort(byLifecycle),
    purges: readArtifactPurges(db).filter((record) => record.projectId === bundle.projectId).sort(byPurge),
    retentionRevisions: readArtifactRetentionRevisions(db)
      .filter((record) => record.projectId === bundle.projectId).sort(byRetentionRevision)
  }))
  assertSemanticEqual(
    targetArtifacts.lifecycles,
    rebindArtifactLifecycles(bundle, runtime, rootDir).sort(byLifecycle),
    'Artifact lifecycle'
  )
  assertSemanticEqual(targetArtifacts.purges, runtime.artifactPurges, 'Artifact purge')
  assertSemanticEqual(
    targetArtifacts.retentionRevisions,
    (runtime.artifactRetentionRevisions ?? []).map(requireRetentionRevision).sort(byRetentionRevision),
    'Artifact retention revision'
  )
  for (const blob of runtime.artifactBlobs) {
    await assertRegularContent(artifactBlobPath(rootDir, blob.digest), blob.digest, blob.sizeBytes)
  }
  for (const source of runtime.artifactSourceFiles ?? []) {
    await assertRegularContent(
      artifactSourceFilePath(rootDir, bundle.projectId, source.artifactId, source.extension),
      source.digest,
      source.sizeBytes
    )
  }
  return runtimeResult(runtime)
}

async function readAllProjectAttempts(projectId: string, rootDir: string): Promise<ModelAttemptRecord[]> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    const selection = selectModelAttempts(db, { projectId, limit: QUERY_LIMIT })
    if (selection.hasMore) throw new Error(`Project ${projectId} exceeds the portable ModelAttempt limit`)
    return selection.attempts
  })
}

async function collectArtifactBlobs(
  rootDir: string,
  lifecycles: readonly ArtifactLifecycleRecord[],
  purges: readonly ArtifactPurgeRecord[]
): Promise<ProjectAggregatePortableRuntime['artifactBlobs']> {
  const purgedIds = new Set(purges.map((record) => record.artifactId))
  const digests = [...new Set(lifecycles
    .filter((record) => record.storageKind === 'blob' && !purgedIds.has(record.artifactId))
    .map((record) => record.digest))].sort()
  const blobs: ProjectAggregatePortableRuntime['artifactBlobs'] = []
  for (const digest of digests) {
    const lifecycle = lifecycles.find((record) => record.digest === digest && record.storageKind === 'blob')
    if (!lifecycle) throw new Error(`Project Artifact blob lifecycle is missing: ${digest}`)
    const file = artifactBlobPath(rootDir, digest)
    await assertRegularContent(file, digest, lifecycle.sizeBytes)
    const bytes = await readFile(file)
    assertArtifactContentCredentialFree(bytes)
    blobs.push({ digest, sizeBytes: bytes.byteLength, encoding: 'base64', data: bytes.toString('base64') })
  }
  return blobs
}

async function collectArtifactSourceFiles(
  lifecycles: readonly ArtifactLifecycleRecord[],
  purges: readonly ArtifactPurgeRecord[]
): Promise<ProjectAggregateArtifactSourceFile[]> {
  const purgedIds = new Set(purges.map((record) => record.artifactId))
  const sources: ProjectAggregateArtifactSourceFile[] = []
  for (const lifecycle of lifecycles
    .filter((record) => record.storageKind === 'source_ref' && !purgedIds.has(record.artifactId))
    .sort(byLifecycle)) {
    if (!lifecycle.sourceRef) throw new Error(`Project Artifact source_ref is missing: ${lifecycle.artifactId}`)
    await assertRegularContent(lifecycle.sourceRef, lifecycle.digest, lifecycle.sizeBytes)
    const bytes = await readFile(lifecycle.sourceRef)
    assertArtifactContentCredentialFree(bytes)
    sources.push({
      artifactId: lifecycle.artifactId,
      digest: lifecycle.digest,
      sizeBytes: bytes.byteLength,
      extension: artifactSourceExtension(lifecycle.sourceRef),
      encoding: 'base64',
      data: bytes.toString('base64')
    })
  }
  return sources
}

function rebindArtifactLifecycles(
  bundle: Pick<ProjectAggregateExportBundle, 'projectId'>,
  runtime: ProjectAggregatePortableRuntime,
  rootDir: string
): ArtifactLifecycleRecord[] {
  const sourceByArtifact = new Map((runtime.artifactSourceFiles ?? [])
    .map((source) => [source.artifactId, source] as const))
  return runtime.artifactLifecycles.map(requireLifecycle).map((record) => {
    if (record.storageKind !== 'source_ref') return record
    const source = sourceByArtifact.get(record.artifactId)
    const extension = source?.extension ?? artifactSourceExtension(record.sourceRef ?? '')
    return {
      ...record,
      sourceRef: artifactSourceFilePath(rootDir, bundle.projectId, record.artifactId, extension)
    }
  })
}

/** Rebind immutable source_ref projections before they enter the destination Workflow database. */
export function rebindProjectPortableArtifactSources(
  bundle: Pick<ProjectAggregateExportBundle, 'projectId' | 'aggregate' | 'runtime'>,
  rootDir: string
): ProjectAggregateSnapshot {
  const runtime = validateProjectPortableRuntime(bundle)
  if (!runtime) return structuredClone(bundle.aggregate)
  const lifecycles = rebindArtifactLifecycles(bundle, runtime, rootDir)
  const paths = new Map(lifecycles
    .filter((record) => record.storageKind === 'source_ref')
    .map((record) => [record.artifactId, record.sourceRef as string] as const))
  const locationPaths = new Map(lifecycles
    .filter((record) => record.storageKind === 'source_ref')
    .map((record) => [record.locationId, record.sourceRef as string] as const))
  const aggregate = structuredClone(bundle.aggregate)
  aggregate.workflow.artifactLocations = aggregate.workflow.artifactLocations.map((location) => {
    const path = locationPaths.get(location.id)
    return path ? { ...location, path, uri: undefined } : location
  })
  aggregate.workflow.workflowEvidence = aggregate.workflow.workflowEvidence.map((evidence) => {
    const path = evidence.artifactId ? paths.get(evidence.artifactId) : undefined
    return path && isLocalReference(evidence.uri) ? { ...evidence, uri: pathToFileURL(path).href } : evidence
  })
  aggregate.audit = aggregate.audit.map((entry) => {
    if (entry.source !== 'workflow_ledger' || !isRecord(entry.value)) return entry
    const event = structuredClone(entry.value)
    if (event.kind === 'workflow.artifact.location.created' && isRecord(event.payload)) {
      const path = locationPaths.get(String(event.payload.id))
      if (path) event.payload = { ...event.payload, path, uri: undefined }
    } else if (event.kind === 'workflow.artifact.lifecycle.registered' && isRecord(event.payload)) {
      const path = paths.get(String(event.payload.artifactId))
      if (path) event.payload = { ...event.payload, sourceRef: path }
    } else if (event.kind === 'workflow.evidence.recorded' && isRecord(event.payload)) {
      const path = paths.get(String(event.payload.artifactId))
      if (path && isLocalReference(typeof event.payload.uri === 'string' ? event.payload.uri : undefined)) {
        event.payload = { ...event.payload, uri: pathToFileURL(path).href }
      }
    }
    return { ...entry, value: event }
  })
  return aggregate
}

function isLocalReference(value: string | undefined): boolean {
  if (!value) return false
  if (isAbsolute(value)) return true
  if (!value.toLowerCase().startsWith('file:')) return false
  try {
    return isAbsolute(fileURLToPath(value))
  } catch {
    return false
  }
}

function requireLifecycle(value: unknown): ArtifactLifecycleRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.artifactId !== 'string' ||
      typeof value.projectId !== 'string' || typeof value.runId !== 'string' ||
      (value.storageKind !== 'blob' && value.storageKind !== 'source_ref') || typeof value.digest !== 'string') {
    throw new Error('Project import Artifact lifecycle is invalid')
  }
  return value as unknown as ArtifactLifecycleRecord
}

function requirePurge(value: unknown): ArtifactPurgeRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.artifactId !== 'string' ||
      typeof value.projectId !== 'string' || typeof value.purgedAt !== 'number') {
    throw new Error('Project import Artifact purge is invalid')
  }
  return value as unknown as ArtifactPurgeRecord
}

function requireRetentionRevision(value: unknown): ArtifactRetentionRevisionRecord {
  const invalid = 'Project import Artifact retention revision is invalid'
  assertImport(isRecord(value), invalid)
  assertImport(value.schemaVersion === 1, invalid)
  assertImport(typeof value.artifactId === 'string', invalid)
  assertImport(typeof value.projectId === 'string', invalid)
  assertImport(Number.isSafeInteger(value.revision), invalid)
  assertImport(Number(value.revision) >= 1, invalid)
  assertImport(isRecord(value.policy), invalid)
  assertImport(value.policy.mode === 'retain' || value.policy.mode === 'expire', invalid)
  assertImport(typeof value.reason === 'string', invalid)
  assertImport(Boolean(value.reason.trim()), invalid)
  assertImport(Number.isFinite(value.createdAt), invalid)
  if (value.policy.mode === 'expire') {
    assertImport(
      validRetainUntil(value.policy.retainUntil),
      'Project import Artifact retention revision expiry is invalid'
    )
  }
  return value as unknown as ArtifactRetentionRevisionRecord
}

function validRetainUntil(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function validateArtifactRetentionRevisions(
  records: readonly ArtifactRetentionRevisionRecord[],
  lifecycleIds: ReadonlySet<string>,
  projectId: string
): void {
  const revisions = new Map<string, number>()
  for (const record of records.slice().sort(byRetentionRevision)) {
    if (record.projectId !== projectId || !lifecycleIds.has(record.artifactId)) {
      throw new Error('Project import Artifact retention revision has no owned lifecycle')
    }
    const expected = (revisions.get(record.artifactId) ?? 0) + 1
    if (record.revision !== expected) throw new Error('Project import Artifact retention revision chain is not continuous')
    revisions.set(record.artifactId, record.revision)
  }
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Project import Artifact blob base64 is not canonical')
  return Uint8Array.from(bytes)
}

function stripAttemptNext(attempt: ModelAttemptRecord): ModelAttemptRecord {
  const { nextAttemptId: _nextAttemptId, ...record } = attempt
  return record
}

function assertSemanticEqual(actual: unknown, expected: unknown, label: string): void {
  if (projectAggregateCanonicalJson(actual) !== projectAggregateCanonicalJson(expected)) {
    throw new Error(`Project import ${label} readback differs from its portable source`)
  }
}

function uniqueIds(values: readonly unknown[], label: string): Set<string> {
  const ids = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || ids.has(value)) throw new Error(`Project import ${label} is invalid`)
    ids.add(value)
  }
  return ids
}

function assertUnique<T>(values: readonly T[], idFor: (value: T) => unknown, label: string): void {
  const ids = new Set<string>()
  for (const value of values) {
    const id = idFor(value)
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error(`Project import ${label} identity is invalid`)
    ids.add(id)
  }
}

function recordId(value: unknown): unknown {
  return isRecord(value) ? value.id : undefined
}

function runtimeResult(runtime: ProjectAggregatePortableRuntime): ProjectPortableRuntimeResult {
  return {
    sessionIds: runtime.sessionIds.length,
    taskSnapshots: runtime.taskSnapshots.length,
    modelAttempts: runtime.modelAttempts.length,
    artifactLifecycles: runtime.artifactLifecycles.length,
    artifactPurges: runtime.artifactPurges.length,
    artifactRetentionRevisions: runtime.artifactRetentionRevisions?.length ?? 0,
    artifactBlobs: runtime.artifactBlobs.length,
    artifactSourceFiles: runtime.artifactSourceFiles?.length ?? 0,
    effectArtifacts: runtime.effectArtifacts?.length ?? 0,
    externalFiles: runtime.externalFiles?.length ?? 0,
    layeredMemory: runtime.layeredMemory?.entries.length ?? 0
  }
}

function emptyResult(): ProjectPortableRuntimeResult {
  return {
    sessionIds: 0,
    taskSnapshots: 0,
    modelAttempts: 0,
    artifactLifecycles: 0,
    artifactPurges: 0,
    artifactRetentionRevisions: 0,
    artifactBlobs: 0,
    artifactSourceFiles: 0,
    effectArtifacts: 0,
    externalFiles: 0,
    layeredMemory: 0
  }
}

function bySnapshot(left: TaskSnapshotRecord, right: TaskSnapshotRecord): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

function byAttempt(left: ModelAttemptRecord, right: ModelAttemptRecord): number {
  return left.startedAt - right.startedAt || left.ordinal - right.ordinal || left.id.localeCompare(right.id)
}

function byLifecycle(left: ArtifactLifecycleRecord, right: ArtifactLifecycleRecord): number {
  return left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId)
}

function byPurge(left: ArtifactPurgeRecord, right: ArtifactPurgeRecord): number {
  return left.purgedAt - right.purgedAt || left.artifactId.localeCompare(right.artifactId)
}

function byRetentionRevision(left: ArtifactRetentionRevisionRecord, right: ArtifactRetentionRevisionRecord): number {
  return left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertImport(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
