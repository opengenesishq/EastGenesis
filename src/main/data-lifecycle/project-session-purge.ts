import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { TASK_PLAN_SCHEMA_VERSION } from '../../shared/task-plan-types'
import {
  activeSessionRecordsFromDocument,
  activeSessionRegistryDocument
} from '../active-session-registry-format'
import { historyEntriesFromDocument, historyStoreDocument } from '../history-store-format'
import {
  sessionCreationJournalDocument,
  sessionCreationJournalRecordsFromDocument
} from '../session-creation-journal-format'
import { writeDurableFileSync } from '../durable-file'
import { runtimeContinuationReceiptPath } from '../session-runtime-continuation-path'
import {
  inspectManagedWorktreeRegistryRecord,
  purgeRemovedManagedWorktreeRecordAtRoot
} from '../managed-worktree-lifecycle'
import { TaskPlanContractStore } from '../task/task-plan-contract-store'
import { purgeTaskPlanLedgerForSession } from '../task/task-plan-ledger'
import {
  countWorktreeMergeReceiptsForSession,
  purgeWorktreeMergeReceipts
} from '../worktrees'
import {
  countOwnedProjectTestEvidence,
  purgeOwnedProjectTestEvidence
} from './project-test-evidence'
import {
  countProjectSubmissionReceipts, countSessionSubmissionReceipts, listProjectSubmissionSessionIds,
  purgeProjectSubmissionReceipts, purgeSessionSubmissionReceipts
} from './submission-receipt-files'
import { preparationDataCounts, preparationProjectSessionIds, purgePreparationData } from './preparation-data-files'
import { taskExecutionAuthorityFiles, taskExecutionAuthorityProjectSessionIds, purgeTaskExecutionAuthorityFiles } from './task-execution-authority-data-files'

export interface ProjectSessionInventory {
  sessionIds: string[]
  sdkSessionIds: string[]
}

export interface ProjectSessionPurgeResult extends ProjectSessionInventory {
  removedRecords: Record<string, number>
  removedPaths: string[]
}

export interface StandaloneSessionPurgeResult {
  sessionId: string
  sdkSessionId: string
  removedRecords: Record<string, number>
  removedPaths: string[]
}

export function collectProjectSessionInventory(
  rootDir: string,
  projectId: string,
  knownSessionIds: readonly string[] = [],
  knownSdkSessionIds: readonly string[] = []
): ProjectSessionInventory {
  const root = requiredRoot(rootDir)
  const project = requiredId(projectId, 'projectId')
  const records = [
    ...historyArrayDocument(join(root, 'sessions.json')),
    ...activeSessionArrayDocument(join(root, 'active-sessions.json')),
    ...sessionCreationArrayDocument(join(root, 'session-creation-journal.json'))
  ]
  const sessionIds = collectProjectSessionIds(records, project, knownSessionIds)
  for (const sessionId of listProjectSubmissionSessionIds(root, project)) sessionIds.add(sessionId)
  for (const sessionId of preparationProjectSessionIds(root, project)) sessionIds.add(sessionId)
  for (const sessionId of taskExecutionAuthorityProjectSessionIds(root, project)) sessionIds.add(sessionId)
  addDescendantSessions(records, sessionIds)
  const sdkSessionIds = collectSdkSessionIds(records, sessionIds)
  for (const sdkSessionId of knownSdkSessionIds) {
    sdkSessionIds.add(requiredId(sdkSessionId, 'sdkSessionId'))
  }
  return { sessionIds: [...sessionIds].sort(), sdkSessionIds: [...sdkSessionIds].sort() }
}

function collectProjectSessionIds(
  records: readonly Record<string, unknown>[],
  projectId: string,
  knownSessionIds: readonly string[]
): Set<string> {
  const ids = new Set(knownSessionIds.map((value) => requiredId(value, 'sessionId')))
  for (const record of records.filter((item) => belongsToProject(item, projectId))) {
    const id = sessionIdOf(record)
    if (id) ids.add(id)
  }
  return ids
}

function addDescendantSessions(records: readonly Record<string, unknown>[], sessionIds: Set<string>): void {
  let changed = true
  while (changed) {
    changed = false
    for (const record of records) {
      const parent = stringAt(record, 'parentSessionId') ?? stringAt(nested(record, 'draft', 'baseMeta'), 'parentSessionId')
      const id = sessionIdOf(record)
      if (!id || !parent || !sessionIds.has(parent) || sessionIds.has(id)) continue
      sessionIds.add(id)
      changed = true
    }
  }
}

function collectSdkSessionIds(
  records: readonly Record<string, unknown>[],
  sessionIds: ReadonlySet<string>
): Set<string> {
  const ids = new Set<string>()
  for (const record of records) {
    const id = sessionIdOf(record)
    if (!id || !sessionIds.has(id)) continue
    const sdk = stringAt(record, 'sdkSessionId') ?? stringAt(nested(record, 'draft', 'baseMeta'), 'sdkSessionId')
    if (sdk) ids.add(sdk)
  }
  return ids
}

export function purgeProjectSessionData(
  rootDir: string,
  projectId: string,
  knownSessionIds: readonly string[],
  knownSdkSessionIds: readonly string[]
): ProjectSessionPurgeResult {
  const root = requiredRoot(rootDir)
  const project = requiredId(projectId, 'projectId')
  const inventory = collectProjectSessionInventory(root, project, knownSessionIds)
  const sessionIds = new Set(inventory.sessionIds)
  const sdkSessionIds = new Set([...inventory.sdkSessionIds, ...knownSdkSessionIds.map((value) => requiredId(value, 'sdkSessionId'))])
  assertProjectSessionPurgeable(root, sessionIds)
  const removedRecords: Record<string, number> = {}
  removedRecords.history = filterHistoryDocument(join(root, 'sessions.json'), (record) =>
    !matchesSessionOrProject(record, sessionIds, project))
  removedRecords.activeSessions = filterActiveSessionDocument(join(root, 'active-sessions.json'), (record) =>
    !matchesSessionOrProject(record, sessionIds, project))
  removedRecords.sessionCreationJournal = filterSessionCreationDocument(join(root, 'session-creation-journal.json'), (record) =>
    !matchesSessionOrProject(record, sessionIds, project))
  removedRecords.taskPlans = purgeTaskPlanSessions(join(root, 'task-plans', 'task-plan-contracts.json'), sessionIds, project)

  const removedPaths: string[] = []
  removedPaths.push(...purgePreparationData(root, sessionIds))
  removedPaths.push(...purgeTaskExecutionAuthorityFiles(root, sessionIds))
  removedPaths.push(...purgeProjectSubmissionReceipts(root, project, sessionIds))
  for (const sessionId of sessionIds) {
    const component = sessionFileComponent(sessionId)
    if (!component) continue
    removeOwned(root, join(root, 'attachments', component), removedPaths)
    removeOwned(root, join(root, 'browser-annotations', component), removedPaths)
    removeOwned(root, join(root, 'preview-annotations', component), removedPaths)
    removeOwned(root, join(root, 'task-audit', `${component}.jsonl`), removedPaths)
    removeOwned(root, join(root, 'patches', `${component}.patch`), removedPaths)
    removeOwned(root, runtimeContinuationReceiptPath(root, sessionId), removedPaths)
    removeOwnedTimestampedPatches(root, component, removedPaths)
  }
  for (const sdkSessionId of sdkSessionIds) {
    const component = safeComponent(sdkSessionId, 'sdkSessionId')
    removeOwned(root, join(root, 'transcripts', `${component}.jsonl`), removedPaths)
    removeOwned(root, join(root, 'event-receipts', `${component}.jsonl`), removedPaths)
  }
  const removedTestEvidence = purgeOwnedProjectTestEvidence(root, project, sessionIds)
  removedRecords.projectTestEvidence = removedTestEvidence.length
  removedPaths.push(...removedTestEvidence)
  removedRecords.managedWorktreeRegistry = 0
  removedRecords.worktreeMergeReceipts = 0
  for (const sessionId of sessionIds) {
    if (purgeRemovedManagedWorktreeRecordAtRoot(sessionId, root)) {
      removedRecords.managedWorktreeRegistry += 1
    }
    removedRecords.worktreeMergeReceipts += purgeWorktreeMergeReceipts(sessionId, root)
  }
  removeOwned(root, workspaceExecutionRoot(root, project), removedPaths)
  return {
    sessionIds: [...sessionIds].sort(),
    sdkSessionIds: [...sdkSessionIds].sort(),
    removedRecords,
    removedPaths: removedPaths.sort()
  }
}

export function scanProjectSessionResiduals(
  rootDir: string,
  projectId: string,
  knownSessionIds: readonly string[],
  knownSdkSessionIds: readonly string[]
): Record<string, number> {
  const root = requiredRoot(rootDir)
  const project = requiredId(projectId, 'projectId')
  const sessionIds = new Set(knownSessionIds)
  const sdkSessionIds = new Set(knownSdkSessionIds)
  const counts: Record<string, number> = {
    ...preparationDataCounts(root, new Set([...sessionIds, ...preparationProjectSessionIds(root, project)])),
    taskExecutionAuthorities: taskExecutionAuthorityFiles(root, new Set([...sessionIds, ...taskExecutionAuthorityProjectSessionIds(root, project)])).length,
    ...countProjectSubmissionReceipts(root, project, sessionIds),
    history: historyArrayDocument(join(root, 'sessions.json')).filter((record) => matchesSessionOrProject(record, sessionIds, project)).length,
    activeSessions: activeSessionArrayDocument(join(root, 'active-sessions.json')).filter((record) => matchesSessionOrProject(record, sessionIds, project)).length,
    sessionCreationJournal: sessionCreationArrayDocument(join(root, 'session-creation-journal.json')).filter((record) => matchesSessionOrProject(record, sessionIds, project)).length,
    taskPlans: countTaskPlanSessions(join(root, 'task-plans', 'task-plan-contracts.json'), sessionIds, project),
    projectTestEvidence: countOwnedProjectTestEvidence(root, project, sessionIds),
    ownedPaths: 0
  }
  for (const sessionId of sessionIds) {
    const component = sessionFileComponent(sessionId)
    if (!component) continue
    for (const target of [
      join(root, 'attachments', component),
      join(root, 'browser-annotations', component),
      join(root, 'preview-annotations', component),
      join(root, 'task-audit', `${component}.jsonl`),
      runtimeContinuationReceiptPath(root, sessionId),
      join(root, 'patches', `${component}.patch`)
    ]) if (existsSync(target)) counts.ownedPaths += 1
    counts.ownedPaths += countTimestampedPatches(root, component)
    const worktree = inspectManagedWorktreeRegistryRecord(sessionId, root)
    if ('error' in worktree) throw new Error(worktree.error)
    if (worktree.record) counts.ownedPaths += 1
    counts.ownedPaths += countWorktreeMergeReceiptsForSession(sessionId, root)
  }
  for (const sdkSessionId of sdkSessionIds) {
    const component = safeComponent(sdkSessionId, 'sdkSessionId')
    for (const target of [
      join(root, 'transcripts', `${component}.jsonl`),
      join(root, 'event-receipts', `${component}.jsonl`)
    ]) if (existsSync(target)) counts.ownedPaths += 1
  }
  if (existsSync(workspaceExecutionRoot(root, project))) counts.ownedPaths += 1
  return counts
}

export function assertProjectSessionPurgeable(
  rootDir: string,
  sessionIdsInput: Iterable<string>
): void {
  const root = requiredRoot(rootDir)
  for (const sessionIdInput of sessionIdsInput) {
    const sessionId = requiredId(sessionIdInput, 'sessionId')
    const lookup = inspectManagedWorktreeRegistryRecord(sessionId, root)
    if ('error' in lookup) throw new Error(lookup.error)
    if (lookup.record?.state === 'active') {
      throw new Error(`Project Session ${sessionId} still owns an active managed worktree`)
    }
  }
}

/**
 * Deletes private Session projections while preserving canonical Run, Attempt,
 * Artifact, Evidence, and budget records owned by their Workflow contracts.
 */
export async function purgeStandaloneSessionData(
  rootDir: string,
  sessionIdInput: string,
  sdkSessionIdInput: string
): Promise<StandaloneSessionPurgeResult> {
  const stores = await purgeStandaloneSessionStores(rootDir, sessionIdInput, sdkSessionIdInput)
  const removedPaths = purgeStandaloneSessionFiles(rootDir, sessionIdInput, sdkSessionIdInput)
  return { ...stores, removedPaths }
}

export async function purgeStandaloneSessionStores(
  rootDir: string,
  sessionIdInput: string,
  sdkSessionIdInput: string
): Promise<Omit<StandaloneSessionPurgeResult, 'removedPaths'>> {
  const root = requiredRoot(rootDir)
  const sessionId = requiredId(sessionIdInput, 'sessionId')
  const sdkSessionId = requiredId(sdkSessionIdInput, 'sdkSessionId')
  const removedRecords: Record<string, number> = {}
  removedRecords.history = filterHistoryDocument(join(root, 'sessions.json'), (record) =>
    !matchesStandaloneSession(record, sessionId, sdkSessionId))
  removedRecords.activeSessions = filterActiveSessionDocument(join(root, 'active-sessions.json'), (record) =>
    !matchesStandaloneSession(record, sessionId, sdkSessionId))
  removedRecords.sessionCreationJournal = filterSessionCreationDocument(
    join(root, 'session-creation-journal.json'),
    (record) => !matchesStandaloneSession(record, sessionId, sdkSessionId)
  )
  removedRecords.taskPlanLedgerEvents = await purgeTaskPlanLedgerForSession(root, sessionId)
  removedRecords.taskPlans = new TaskPlanContractStore(() => root).deleteSession(sessionId) ? 1 : 0

  return { sessionId, sdkSessionId, removedRecords }
}

export function purgeStandaloneSessionFiles(
  rootDir: string,
  sessionIdInput: string,
  sdkSessionIdInput: string
): string[] {
  const root = requiredRoot(rootDir)
  const sessionId = requiredId(sessionIdInput, 'sessionId')
  const sdkSessionId = requiredId(sdkSessionIdInput, 'sdkSessionId')
  const component = safeComponent(sessionId, 'sessionId')
  const sdkComponent = safeComponent(sdkSessionId, 'sdkSessionId')
  const removedPaths: string[] = []
  removedPaths.push(...purgePreparationData(root, [sessionId]))
  removedPaths.push(...purgeTaskExecutionAuthorityFiles(root, [sessionId]))
  removedPaths.push(...purgeSessionSubmissionReceipts(root, sessionId))
  for (const target of [
    join(root, 'attachments', component),
    join(root, 'browser-annotations', component),
    join(root, 'preview-annotations', component),
    join(root, 'task-audit', `${component}.jsonl`),
    join(root, 'patches', `${component}.patch`),
    join(root, 'transcripts', `${sdkComponent}.jsonl`),
    runtimeContinuationReceiptPath(root, sessionId),
    join(root, 'event-receipts', `${sdkComponent}.jsonl`)
  ]) removeOwned(root, target, removedPaths)
  removeOwnedTimestampedPatches(root, component, removedPaths)
  return removedPaths.sort()
}

export function scanStandaloneSessionResiduals(
  rootDir: string,
  sessionIdInput: string,
  sdkSessionIdInput: string
): Record<string, number> {
  const root = requiredRoot(rootDir)
  const sessionId = requiredId(sessionIdInput, 'sessionId')
  const sdkSessionId = requiredId(sdkSessionIdInput, 'sdkSessionId')
  const component = safeComponent(sessionId, 'sessionId')
  const sdkComponent = safeComponent(sdkSessionId, 'sdkSessionId')
  const taskPlans = new TaskPlanContractStore(() => root)
  const counts: Record<string, number> = {
    ...preparationDataCounts(root, [sessionId]),
    taskExecutionAuthorities: taskExecutionAuthorityFiles(root, [sessionId]).length,
    ...countSessionSubmissionReceipts(root, sessionId),
    history: historyArrayDocument(join(root, 'sessions.json')).filter((record) =>
      matchesStandaloneSession(record, sessionId, sdkSessionId)).length,
    activeSessions: activeSessionArrayDocument(join(root, 'active-sessions.json')).filter((record) =>
      matchesStandaloneSession(record, sessionId, sdkSessionId)).length,
    sessionCreationJournal: sessionCreationArrayDocument(join(root, 'session-creation-journal.json')).filter((record) =>
      matchesStandaloneSession(record, sessionId, sdkSessionId)).length,
    taskPlans: taskPlans.hasPlan(sessionId) ? 1 : 0,
    ownedPaths: 0
  }
  for (const target of [
    join(root, 'attachments', component),
    join(root, 'browser-annotations', component),
    join(root, 'preview-annotations', component),
    join(root, 'task-audit', `${component}.jsonl`),
    join(root, 'patches', `${component}.patch`),
    join(root, 'transcripts', `${sdkComponent}.jsonl`),
    runtimeContinuationReceiptPath(root, sessionId),
    join(root, 'event-receipts', `${sdkComponent}.jsonl`)
  ]) if (existsSync(target)) counts.ownedPaths += 1
  counts.ownedPaths += countTimestampedPatches(root, component)
  return counts
}

function workspaceExecutionRoot(root: string, projectId: string): string {
  const digest = createHash('sha256').update(`caogen.workspace-cwd.v1\0${projectId}`).digest('hex').slice(0, 24)
  return join(root, 'workspace-execution', digest)
}

function matchesSessionOrProject(record: Record<string, unknown>, sessionIds: ReadonlySet<string>, projectId: string): boolean {
  const id = sessionIdOf(record)
  return Boolean((id && sessionIds.has(id)) || belongsToProject(record, projectId))
}

function belongsToProject(record: Record<string, unknown>, projectId: string): boolean {
  const candidates = [record, nested(record, 'draft', 'baseMeta'), nested(record, 'draft', 'opts')]
  return candidates.some((candidate) =>
    stringAt(candidate, 'workspaceId') === projectId || stringAt(candidate, 'projectId') === projectId)
}

function sessionIdOf(record: Record<string, unknown>): string | undefined {
  return stringAt(record, 'sessionId') ?? stringAt(record, 'id') ?? stringAt(nested(record, 'draft', 'baseMeta'), 'id')
}

function sdkSessionIdOf(record: Record<string, unknown>): string | undefined {
  return stringAt(record, 'sdkSessionId') ?? stringAt(nested(record, 'draft', 'baseMeta'), 'sdkSessionId')
}

function matchesStandaloneSession(
  record: Record<string, unknown>,
  sessionId: string,
  sdkSessionId: string
): boolean {
  return sessionIdOf(record) === sessionId || sdkSessionIdOf(record) === sdkSessionId
}

function filterSessionCreationDocument(file: string, keep: (record: Record<string, unknown>) => boolean): number {
  if (!existsSync(file)) return 0
  const current = sessionCreationArrayDocument(file)
  const next = current.filter(keep)
  if (next.length !== current.length) atomicJsonWrite(file, sessionCreationJournalDocument(next))
  return current.length - next.length
}

function filterHistoryDocument(file: string, keep: (record: Record<string, unknown>) => boolean): number {
  if (!existsSync(file)) return 0
  const current = historyArrayDocument(file)
  const next = current.filter(keep)
  if (next.length !== current.length) atomicJsonWrite(file, historyStoreDocument(next))
  return current.length - next.length
}

function filterActiveSessionDocument(file: string, keep: (record: Record<string, unknown>) => boolean): number {
  if (!existsSync(file)) return 0
  const current = activeSessionArrayDocument(file)
  const next = current.filter(keep)
  if (next.length !== current.length) atomicJsonWrite(file, activeSessionRegistryDocument(next))
  return current.length - next.length
}

function purgeTaskPlanSessions(file: string, sessionIds: ReadonlySet<string>, projectId: string): number {
  if (!existsSync(file)) return 0
  const state = objectDocument(file)
  assertTaskPlanStoreVersion(state, file)
  const sessions = objectAt(state, 'sessions')
  let removed = 0
  let removedEntries = 0
  for (const [sessionId, value] of Object.entries(sessions)) {
    const record = isRecord(value) ? value : {}
    if (sessionIds.has(sessionId) || taskPlanBelongsToProject(record, projectId)) {
      delete sessions[sessionId]
      removed += 1
      removedEntries += (Array.isArray(record.versions) ? record.versions.length : 0) +
        (Array.isArray(record.approvalEvents) ? record.approvalEvents.length : 0)
    }
  }
  if (removed > 0) {
    if (typeof state.revision === 'number') state.revision -= removedEntries
    atomicJsonWrite(file, state)
  }
  return removed
}

function countTaskPlanSessions(file: string, sessionIds: ReadonlySet<string>, projectId: string): number {
  if (!existsSync(file)) return 0
  const state = objectDocument(file)
  assertTaskPlanStoreVersion(state, file)
  const sessions = objectAt(state, 'sessions')
  return Object.entries(sessions).filter(([sessionId, value]) =>
    sessionIds.has(sessionId) || (isRecord(value) && taskPlanBelongsToProject(value, projectId))).length
}

function taskPlanBelongsToProject(record: Record<string, unknown>, projectId: string): boolean {
  const versions = Array.isArray(record.versions) ? record.versions : []
  return versions.some((version) => isRecord(version) && isRecord(version.binding) &&
    (version.binding.workspaceId === projectId || version.binding.projectId === projectId))
}

function sessionCreationArrayDocument(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const records = sessionCreationJournalRecordsFromDocument<unknown>(value, file)
  if (!records.every(isRecord)) throw new Error(`Project session store is invalid: ${file}`)
  return structuredClone(records) as Array<Record<string, unknown>>
}

function historyArrayDocument(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const entries = historyEntriesFromDocument<unknown>(value, file)
  if (!entries.every(isRecord)) throw new Error(`Project session store is invalid: ${file}`)
  return structuredClone(entries) as Array<Record<string, unknown>>
}

function activeSessionArrayDocument(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const sessions = activeSessionRecordsFromDocument<unknown>(value, file)
  if (!sessions.every(isRecord)) throw new Error(`Project session store is invalid: ${file}`)
  return structuredClone(sessions) as Array<Record<string, unknown>>
}

function objectDocument(file: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`Project session store is invalid: ${file}`)
  return structuredClone(value)
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`Project session store field is invalid: ${key}`)
  return value
}

function assertTaskPlanStoreVersion(state: Record<string, unknown>, file: string): void {
  if (state.schemaVersion !== TASK_PLAN_SCHEMA_VERSION) {
    throw new Error(`Project session store schema version is unsupported: ${file}`)
  }
}

function nested(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  let current: Record<string, unknown> = record
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

function removeOwned(root: string, target: string, removed: string[]): void {
  const resolved = resolve(target)
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== resolved) throw new Error('refusing to delete outside userData')
  if (!existsSync(resolved)) return
  const stat = lstatSync(resolved)
  if (stat.isSymbolicLink()) throw new Error(`refusing to follow application-data symlink: ${resolved}`)
  rmSync(resolved, { recursive: stat.isDirectory(), force: true })
  removed.push(resolved)
}

function removeOwnedTimestampedPatches(root: string, component: string, removed: string[]): void {
  const directory = join(root, 'patches')
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(`${component}-`) || !name.endsWith('.patch')) continue
    removeOwned(root, join(directory, name), removed)
  }
}

function countTimestampedPatches(root: string, component: string): number {
  const directory = join(root, 'patches')
  if (!existsSync(directory)) return 0
  return readdirSync(directory).filter((name) =>
    name.startsWith(`${component}-`) && name.endsWith('.patch')).length
}

function atomicJsonWrite(file: string, value: unknown): void {
  writeDurableFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
