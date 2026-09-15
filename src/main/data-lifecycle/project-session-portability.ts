import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, posix, relative, resolve, sep } from 'node:path'
import type {
  ProjectAggregatePortableFile,
  ProjectAggregatePortableRuntime,
  ProjectAggregatePortableTaskPlan
} from '../../shared/project-aggregate-types'
import { TASK_PLAN_SCHEMA_VERSION } from '../../shared/task-plan-types'
import { validateTaskPlanSessionRecord } from '../task/task-plan-contract-store'
import {
  activeSessionRecordsFromDocument,
  activeSessionRegistryDocument
} from '../active-session-registry-format'
import { writeDurableFileSync } from '../durable-file'
import { runtimeContinuationReceiptPath } from '../session-runtime-continuation-path'
import { historyEntriesFromDocument, historyStoreDocument } from '../history-store-format'
import {
  sessionCreationJournalDocument,
  sessionCreationJournalRecordsFromDocument
} from '../session-creation-journal-format'
import { contentDigest } from '../task/artifact-lifecycle-content'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'
import { collectProjectSessionInventory } from './project-session-purge'
import { assertTaskExecutionAuthorityMarkersPortable, portableCreationAuthorityMarkers } from './task-execution-authority-portability'
import {
  assertPortableProjectTestEvidence,
  collectOwnedProjectTestEvidencePaths
} from './project-test-evidence'
import {
  assertProjectSubmissionReceiptsImportable, collectProjectSubmissionReceipts,
  importProjectSubmissionReceipts, validateProjectSubmissionReceipts, verifyProjectSubmissionReceipts
} from './submission-receipt-portability'
import {
  assertProjectPreparationImportable, collectProjectPreparation, importProjectPreparation,
  validateProjectPreparation, verifyProjectPreparation
} from './preparation-portability'

export type ProjectSessionPortableSlice = Pick<ProjectAggregatePortableRuntime,
  'sessionIds' | 'sdkSessionIds' | 'sessionHistory' | 'activeSessions' |
  'sessionCreationJournal' | 'taskPlans' | 'sessionFiles' | 'submissionReceipts' | 'preparation'>

export function collectProjectSessionPortableSlice(
  rootDir: string,
  projectId: string,
  knownSessionIds: readonly string[],
  taskSnapshots: readonly unknown[] = []
): ProjectSessionPortableSlice {
  const root = requiredRoot(rootDir)
  const project = requiredId(projectId, 'projectId')
  const inventory = collectProjectSessionInventory(root, project, knownSessionIds)
  const sessionIds = new Set(inventory.sessionIds)
  const sdkSessionIds = new Set(inventory.sdkSessionIds)
  const sessionHistory = historyRecords(root).filter((record) => matchesSessionOrProject(record, sessionIds, project))
  const activeSessions = activeSessionRecords(root).filter((record) => matchesSessionOrProject(record, sessionIds, project))
  const sessionCreationJournal = portableCreationAuthorityMarkers(root,
    creationRecords(root).filter((record) => matchesSessionOrProject(record, sessionIds, project)),
    [...sessionHistory, ...activeSessions, ...taskSnapshots])
  assertTaskExecutionAuthorityMarkersPortable(root, sessionIds,
    [...sessionHistory, ...activeSessions, ...sessionCreationJournal, ...taskSnapshots])
  const taskPlans = projectTaskPlans(root, project, sessionIds)
  const sessionFiles = collectOwnedFiles(root, project, sessionIds, sdkSessionIds)
  const submissionReceipts = collectProjectSubmissionReceipts(root, project, {
    sessionIds: [...sessionIds], sessionFiles, sessionHistory, activeSessions, sessionCreationJournal, taskPlans, taskSnapshots
  })
  const preparation = collectProjectPreparation(root, project, {
    sessionIds: [...sessionIds], sessionHistory, activeSessions, sessionCreationJournal,
    taskSnapshots: taskSnapshots as ProjectAggregatePortableRuntime['taskSnapshots']
  })
  return {
    sessionIds: [...sessionIds].sort(),
    sdkSessionIds: [...sdkSessionIds].sort(),
    sessionHistory: sessionHistory.sort(byRecordIdentity),
    activeSessions: activeSessions.sort(byRecordIdentity),
    sessionCreationJournal: sessionCreationJournal.sort(byRecordIdentity),
    taskPlans,
    sessionFiles,
    submissionReceipts,
    preparation
  }
}

export function validateProjectSessionPortableSlice(
  projectId: string,
  value: ProjectSessionPortableSlice
): void {
  const project = requiredId(projectId, 'projectId')
  const sessionIds = uniqueIds(value.sessionIds, 'sessionId')
  const sdkSessionIds = uniqueIds(value.sdkSessionIds, 'sdkSessionId')
  validateSessionRecords(project, sessionIds, [
    ['history', value.sessionHistory],
    ['active session', value.activeSessions],
    ['session creation', value.sessionCreationJournal]
  ])
  validateTaskPlans(value.taskPlans, sessionIds)
  validateSessionFiles(value.sessionFiles, project, sessionIds, sdkSessionIds)
  validateProjectSubmissionReceipts(project, value.submissionReceipts, value)
  validateProjectPreparation(project, value.preparation, value)
}

function validateSessionRecords(
  projectId: string,
  sessionIds: ReadonlySet<string>,
  groups: ReadonlyArray<readonly [string, readonly unknown[]]>
): void {
  for (const [label, records] of groups) {
    if (!Array.isArray(records) || !records.every(isRecord)) throw new Error(`Project import ${label} records are invalid`)
    assertUniqueRecordIdentities(records, label)
    if (records.some((record) => !matchesSessionOrProject(record, sessionIds, projectId))) {
      throw new Error(`Project import ${label} crosses Project ownership`)
    }
  }
}

function validateTaskPlans(plans: readonly ProjectAggregatePortableTaskPlan[], sessionIds: ReadonlySet<string>): void {
  if (!Array.isArray(plans)) throw new Error('Project import Task Plans are invalid')
  const planIds = new Set<string>()
  for (const plan of plans) {
    if (!isRecord(plan) || typeof plan.sessionId !== 'string' || !sessionIds.has(plan.sessionId) ||
        planIds.has(plan.sessionId) || !isRecord(plan.value)) {
      throw new Error('Project import Task Plan identity is invalid')
    }
    validateTaskPlanSessionRecord(plan.sessionId, plan.value)
    planIds.add(plan.sessionId)
  }
}

function validateSessionFiles(
  files: readonly ProjectAggregatePortableFile[],
  projectId: string,
  sessionIds: ReadonlySet<string>,
  sdkSessionIds: ReadonlySet<string>
): void {
  if (!Array.isArray(files)) throw new Error('Project import Session files are invalid')
  const allowed = allowedPathRules(projectId, sessionIds, sdkSessionIds)
  const filePaths = new Set<string>()
  for (const file of files) {
    if (!isPortableFile(file) || filePaths.has(file.path) || !allowed.some((rule) => rule(file.path))) {
      throw new Error(`Project import Session file path is invalid: ${String((file as { path?: unknown })?.path)}`)
    }
    const bytes = decodeBase64(file.data)
    if (bytes.byteLength !== file.sizeBytes || contentDigest(bytes) !== file.digest) {
      throw new Error(`Project import Session file digest mismatch: ${file.path}`)
    }
    if (file.path.startsWith('project-test-evidence/')) {
      assertPortableProjectTestEvidence(file.path, bytes, projectId, sessionIds)
    }
    filePaths.add(file.path)
  }
}

export function assertProjectSessionPortableSliceImportable(
  rootDir: string,
  projectId: string,
  slice: ProjectSessionPortableSlice
): void {
  validateProjectSessionPortableSlice(projectId, slice)
  const root = requiredRoot(rootDir)
  const conflicts = [
    ...recordConflicts(historyRecords(root), slice.sessionHistory).map((id) => `history:${id}`),
    ...recordConflicts(activeSessionRecords(root), slice.activeSessions).map((id) => `active:${id}`),
    ...recordConflicts(creationRecords(root), slice.sessionCreationJournal).map((id) => `creation:${id}`),
    ...taskPlanConflicts(root, slice.taskPlans).map((id) => `task_plan:${id}`)
  ].sort()
  if (conflicts.length > 0) throw new Error(`Project import Session identity conflict: ${conflicts.join(', ')}`)
  for (const file of slice.sessionFiles) assertExistingFileCompatible(root, file)
  assertProjectSubmissionReceiptsImportable(root, projectId, slice.submissionReceipts, slice)
  assertProjectPreparationImportable(root, projectId, slice.preparation, slice)
}

export function importProjectSessionPortableSlice(
  rootDir: string,
  projectId: string,
  slice: ProjectSessionPortableSlice
): void {
  validateProjectSessionPortableSlice(projectId, slice)
  const root = requiredRoot(rootDir)
  assertProjectSubmissionReceiptsImportable(root, projectId, slice.submissionReceipts, slice)
  assertProjectPreparationImportable(root, projectId, slice.preparation, slice)
  mergeDocument(
    join(root, 'sessions.json'),
    historyRecords(root),
    slice.sessionHistory,
    historyStoreDocument
  )
  mergeDocument(
    join(root, 'active-sessions.json'),
    activeSessionRecords(root),
    slice.activeSessions,
    activeSessionRegistryDocument
  )
  mergeDocument(
    join(root, 'session-creation-journal.json'),
    creationRecords(root),
    slice.sessionCreationJournal,
    sessionCreationJournalDocument
  )
  mergeTaskPlans(root, slice.taskPlans)
  for (const file of slice.sessionFiles) {
    const target = safeTarget(root, file.path)
    if (existsSync(target)) {
      assertExistingFileCompatible(root, file)
      continue
    }
    writeDurableFileSync(target, decodeBase64(file.data), { mode: 0o600, replace: false })
  }
  importProjectSubmissionReceipts(root, projectId, slice.submissionReceipts, slice)
  importProjectPreparation(root, projectId, slice.preparation, slice)
}

export function verifyProjectSessionPortableSlice(
  rootDir: string,
  projectId: string,
  slice: ProjectSessionPortableSlice
): void {
  validateProjectSessionPortableSlice(projectId, slice)
  const target = collectProjectSessionPortableSlice(rootDir, projectId, slice.sessionIds,
    (slice as ProjectAggregatePortableRuntime).taskSnapshots ?? [])
  assertSame(target.sessionHistory, slice.sessionHistory, 'Session history')
  assertSame(target.activeSessions, slice.activeSessions, 'Active Session')
  assertSame(target.sessionCreationJournal, slice.sessionCreationJournal, 'Session creation journal')
  assertSame(target.taskPlans, slice.taskPlans, 'Task Plan')
  const expectedPaths = new Set(slice.sessionFiles.map((file) => file.path))
  assertSame(target.sessionFiles.filter((file) => expectedPaths.has(file.path)), slice.sessionFiles, 'Session files')
  verifyProjectSubmissionReceipts(rootDir, projectId, slice.submissionReceipts, slice)
  verifyProjectPreparation(rootDir, projectId, slice.preparation, slice)
}

function collectOwnedFiles(
  root: string,
  projectId: string,
  sessionIds: ReadonlySet<string>,
  sdkSessionIds: ReadonlySet<string>
): ProjectAggregatePortableFile[] {
  const targets: string[] = []
  for (const sessionId of sessionIds) {
    const component = sessionFileComponent(sessionId)
    if (!component) continue
    targets.push(
      join(root, 'attachments', component),
      join(root, 'preview-annotations', component),
      join(root, 'task-audit', `${component}.jsonl`),
      runtimeContinuationReceiptPath(root, sessionId),
      join(root, 'patches', `${component}.patch`)
    )
  }
  for (const sdkSessionId of sdkSessionIds) {
    const component = safeComponent(sdkSessionId, 'sdkSessionId')
    targets.push(
      join(root, 'transcripts', `${component}.jsonl`),
      join(root, 'event-receipts', `${component}.jsonl`)
    )
  }
  targets.push(workspaceExecutionRoot(root, projectId))
  targets.push(...collectOwnedProjectTestEvidencePaths(root, projectId, sessionIds))
  const files = [...new Set(targets.flatMap((target) => filesBelow(target)))].sort()
  return files.map((file) => portableFile(root, file))
}

function filesBelow(target: string): string[] {
  if (!existsSync(target)) return []
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) throw new Error(`Project Session export refuses symlink: ${target}`)
  if (stat.isFile()) return [target]
  if (!stat.isDirectory()) throw new Error(`Project Session export requires regular data: ${target}`)
  return readdirSync(target).sort().flatMap((entry) => filesBelow(join(target, entry)))
}

function portableFile(root: string, file: string): ProjectAggregatePortableFile {
  const bytes = readFileSync(file)
  const path = portablePath(relative(root, file))
  return {
    path,
    digest: contentDigest(bytes),
    sizeBytes: bytes.byteLength,
    encoding: 'base64',
    data: bytes.toString('base64')
  }
}

function allowedPathRules(
  projectId: string,
  sessionIds: ReadonlySet<string>,
  sdkSessionIds: ReadonlySet<string>
): Array<(path: string) => boolean> {
  const exact = new Set<string>()
  const directories: string[] = []
  for (const sessionId of sessionIds) {
    const component = sessionFileComponent(sessionId)
    if (!component) continue
    directories.push(`attachments/${component}/`, `preview-annotations/${component}/`)
    exact.add(`task-audit/${component}.jsonl`)
    exact.add(`patches/${component}.patch`)
    exact.add(portablePath(runtimeContinuationReceiptPath('', sessionId)))
  }
  for (const sdkSessionId of sdkSessionIds) {
    const component = safeComponent(sdkSessionId, 'sdkSessionId')
    exact.add(`transcripts/${component}.jsonl`)
    exact.add(`event-receipts/${component}.jsonl`)
  }
  const execution = portablePath(relative(resolve('/'), workspaceExecutionRoot(resolve('/'), projectId)))
  directories.push(`${execution}/`)
  return [
    (path) => exact.has(path),
    (path) => /^project-test-evidence\/[a-f0-9]{24}\/[A-Za-z0-9._-]+\.json$/.test(path),
    (path) => directories.some((prefix) => path.startsWith(prefix) && path.length > prefix.length)
  ]
}

function projectTaskPlans(
  root: string,
  projectId: string,
  sessionIds: ReadonlySet<string>
): ProjectAggregatePortableTaskPlan[] {
  const file = join(root, 'task-plans', 'task-plan-contracts.json')
  if (!existsSync(file)) return []
  const document = objectDocument(file)
  assertTaskPlanVersion(document, file)
  const sessions = objectAt(document, 'sessions')
  return Object.entries(sessions)
    .filter(([sessionId, value]) => sessionIds.has(sessionId) || (isRecord(value) && taskPlanBelongsToProject(value, projectId)))
    .map(([sessionId, value]) => ({ sessionId, value: structuredClone(value) }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
}

function mergeTaskPlans(root: string, incoming: readonly ProjectAggregatePortableTaskPlan[]): void {
  if (incoming.length === 0) return
  const file = join(root, 'task-plans', 'task-plan-contracts.json')
  const document = existsSync(file)
    ? objectDocument(file)
    : { schemaVersion: TASK_PLAN_SCHEMA_VERSION, revision: 0, sessions: {} }
  assertTaskPlanVersion(document, file)
  const sessions = objectAt(document, 'sessions')
  let addedEntries = 0
  for (const plan of incoming) {
    if (sessions[plan.sessionId] !== undefined) {
      if (projectAggregateCanonicalJson(sessions[plan.sessionId]) !== projectAggregateCanonicalJson(plan.value)) {
        throw new Error(`Project import Task Plan conflicts with ${plan.sessionId}`)
      }
      continue
    }
    sessions[plan.sessionId] = structuredClone(plan.value)
    const value = plan.value as { versions?: unknown[]; approvalEvents?: unknown[] }
    addedEntries += (Array.isArray(value.versions) ? value.versions.length : 0) +
      (Array.isArray(value.approvalEvents) ? value.approvalEvents.length : 0)
  }
  document.revision = Number(document.revision ?? 0) + addedEntries
  writeJson(file, document)
}

function taskPlanConflicts(root: string, incoming: readonly ProjectAggregatePortableTaskPlan[]): string[] {
  const file = join(root, 'task-plans', 'task-plan-contracts.json')
  if (!existsSync(file)) return []
  const document = objectDocument(file)
  assertTaskPlanVersion(document, file)
  const sessions = objectAt(document, 'sessions')
  return incoming.filter((plan) => sessions[plan.sessionId] !== undefined).map((plan) => plan.sessionId)
}

function mergeDocument(
  file: string,
  existing: Record<string, unknown>[],
  incoming: readonly unknown[],
  documentFor: (records: readonly Record<string, unknown>[]) => unknown
): void {
  if (incoming.length === 0) return
  const records = incoming.map((record) => structuredClone(record) as Record<string, unknown>)
  const conflicts = recordConflicts(existing, records)
  if (conflicts.length > 0) {
    const byIdentity = new Map(existing.map((record) => [recordIdentity(record), record]))
    if (records.some((record) => projectAggregateCanonicalJson(byIdentity.get(recordIdentity(record))) !==
        projectAggregateCanonicalJson(record))) {
      throw new Error(`Project import Session record conflicts with ${conflicts.join(', ')}`)
    }
  }
  const current = new Set(existing.map(recordIdentity))
  const merged = [...existing, ...records.filter((record) => !current.has(recordIdentity(record)))]
    .sort(byRecordIdentity)
  writeJson(file, documentFor(merged))
}

function historyRecords(root: string): Record<string, unknown>[] {
  const file = join(root, 'sessions.json')
  if (!existsSync(file)) return []
  return recordsFrom(historyEntriesFromDocument(JSON.parse(readFileSync(file, 'utf8')), file), file)
}

function activeSessionRecords(root: string): Record<string, unknown>[] {
  const file = join(root, 'active-sessions.json')
  if (!existsSync(file)) return []
  return recordsFrom(activeSessionRecordsFromDocument(JSON.parse(readFileSync(file, 'utf8')), file), file)
}

function creationRecords(root: string): Record<string, unknown>[] {
  const file = join(root, 'session-creation-journal.json')
  if (!existsSync(file)) return []
  return recordsFrom(sessionCreationJournalRecordsFromDocument(JSON.parse(readFileSync(file, 'utf8')), file), file)
}

function recordsFrom(values: unknown[], file: string): Record<string, unknown>[] {
  if (!values.every(isRecord)) throw new Error(`Project Session store is invalid: ${file}`)
  return structuredClone(values) as Record<string, unknown>[]
}

function recordConflicts(existing: readonly unknown[], incoming: readonly unknown[]): string[] {
  const ids = new Set(existing.filter(isRecord).map(recordIdentity))
  return incoming.filter(isRecord).map(recordIdentity).filter((id) => ids.has(id))
}

function assertUniqueRecordIdentities(records: readonly Record<string, unknown>[], label: string): void {
  const ids = records.map(recordIdentity)
  if (new Set(ids).size !== ids.length) throw new Error(`Project import ${label} contains duplicate identities`)
}

function recordIdentity(record: Record<string, unknown>): string {
  const draftMeta = nested(record, 'draft', 'baseMeta')
  const id = stringAt(record, 'sessionId') ?? stringAt(record, 'id') ?? stringAt(draftMeta, 'id') ??
    stringAt(record, 'requestId')
  if (!id) throw new Error('Project Session record identity is missing')
  return id
}

function byRecordIdentity(left: unknown, right: unknown): number {
  return recordIdentity(left as Record<string, unknown>).localeCompare(recordIdentity(right as Record<string, unknown>))
}

function matchesSessionOrProject(
  record: Record<string, unknown>,
  sessionIds: ReadonlySet<string>,
  projectId: string
): boolean {
  const id = stringAt(record, 'sessionId') ?? stringAt(record, 'id') ?? stringAt(nested(record, 'draft', 'baseMeta'), 'id')
  return Boolean((id && sessionIds.has(id)) || belongsToProject(record, projectId))
}

function belongsToProject(record: Record<string, unknown>, projectId: string): boolean {
  return [record, nested(record, 'draft', 'baseMeta'), nested(record, 'draft', 'opts')].some((candidate) =>
    stringAt(candidate, 'workspaceId') === projectId || stringAt(candidate, 'projectId') === projectId)
}

function taskPlanBelongsToProject(record: Record<string, unknown>, projectId: string): boolean {
  const versions = Array.isArray(record.versions) ? record.versions : []
  return versions.some((version) => isRecord(version) && isRecord(version.binding) &&
    (version.binding.workspaceId === projectId || version.binding.projectId === projectId))
}

function workspaceExecutionRoot(root: string, projectId: string): string {
  const digest = createHash('sha256').update(`caogen.workspace-cwd.v1\0${projectId}`).digest('hex').slice(0, 24)
  return join(root, 'workspace-execution', digest)
}

function assertExistingFileCompatible(root: string, file: ProjectAggregatePortableFile): void {
  const target = safeTarget(root, file.path)
  if (!existsSync(target)) return
  const stat = lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Project import Session file target is unsafe: ${file.path}`)
  const bytes = readFileSync(target)
  if (bytes.byteLength !== file.sizeBytes || contentDigest(bytes) !== file.digest) {
    throw new Error(`Project import Session file conflicts with ${file.path}`)
  }
}

function isPortableFile(value: unknown): value is ProjectAggregatePortableFile {
  return isRecord(value) && typeof value.path === 'string' && typeof value.digest === 'string' &&
    Number.isSafeInteger(value.sizeBytes) && value.encoding === 'base64' && typeof value.data === 'string'
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Project import Session file base64 is not canonical')
  return Uint8Array.from(bytes)
}

function allowedPortablePath(path: string): boolean {
  return Boolean(path) && path === posix.normalize(path) && !path.startsWith('/') &&
    path !== '..' && !path.startsWith('../') && !path.includes('\0') && !path.includes('\\')
}

function safeTarget(root: string, path: string): string {
  if (!allowedPortablePath(path)) throw new Error(`Project import Session path is unsafe: ${path}`)
  const target = resolve(root, ...path.split('/'))
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== target) throw new Error('Project import Session path escapes userData')
  return target
}

function portablePath(path: string): string {
  const value = path.split(sep).join('/')
  if (!allowedPortablePath(value)) throw new Error(`Project Session path is not portable: ${path}`)
  return value
}

function writeJson(file: string, value: unknown): void {
  writeDurableFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function objectDocument(file: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`Project Session store is invalid: ${file}`)
  return structuredClone(value)
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`Project Session store field is invalid: ${key}`)
  return value
}

function assertTaskPlanVersion(document: Record<string, unknown>, file: string): void {
  if (document.schemaVersion !== TASK_PLAN_SCHEMA_VERSION || !Number.isSafeInteger(document.revision) ||
      !isRecord(document.sessions)) throw new Error(`Project Session Task Plan schema is unsupported: ${file}`)
}

function nested(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  let current = record
  for (const key of keys) {
    if (!isRecord(current[key])) return {}
    current = current[key]
  }
  return current
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uniqueIds(values: readonly unknown[], label: string): Set<string> {
  const ids = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || ids.has(value)) throw new Error(`Project import ${label} is invalid`)
    ids.add(value)
  }
  return ids
}

function safeComponent(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') throw new Error(`${label} is not a safe path component`)
  return value
}

function sessionFileComponent(sessionId: string): string | undefined {
  if (/^operation:[A-Za-z0-9._-]+$/.test(sessionId)) return undefined
  return safeComponent(sessionId, 'sessionId')
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('rootDir is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function assertSame(actual: unknown, expected: unknown, label: string): void {
  if (projectAggregateCanonicalJson(actual) !== projectAggregateCanonicalJson(expected)) {
    throw new Error(`Project import ${label} readback differs from its portable source`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
