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
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AgentEvent, AgentEventIdentity, SessionMeta } from '../shared/types'
import {
  activeSessionRecordsFromDocument,
  activeSessionRegistryDocument
} from './active-session-registry-format'
import type { Engine } from './engine'
import { touchProject } from './projects'
import { sessionMetaForRecovery } from './session-create-lifecycle'
import {
  prepareActiveSessionEngines,
  startActiveSessionEngines,
  type PreparedActiveSession
} from './session-active-registry-restore'
import { prepareSessionDomainOwnershipForActivation } from './session-domain-activation'
import { isUnroutedLocalPlan } from './session-local-plan'

export interface ActiveSessionRecoveryPlan {
  records: SessionMeta[]
  restorable: SessionMeta[]
  registryReconciled: boolean
  skippedErrors: string[]
  registryReadError?: string
}

export interface ActiveSessionRegistryRestoreResult {
  registryChanged: boolean
  artifactsCanBePruned: boolean
}

export interface ActiveSessionRegistryRestoreOptions {
  preserveRegistrySessionIds?: ReadonlySet<string>
  /**
   * Allows the owner to keep an otherwise restorable session dormant until its
   * first operation. The default remains eager startup for isolated callers.
   */
  startRestoredEngine?: (record: SessionMeta, engine: Engine) => void | Promise<void>
}

export class ActiveSessionRegistryWriteQuarantinedError extends Error {
  constructor(readonly reason: string) {
    super(`Active Session Registry write quarantine is active: ${reason}`)
    this.name = 'ActiveSessionRegistryWriteQuarantinedError'
  }
}

let registryWriteQuarantineReason: string | undefined

export function quarantineActiveSessionRegistryWrites(reason: string): void {
  if (registryWriteQuarantineReason !== undefined) return
  registryWriteQuarantineReason = reason.trim() || 'unspecified recovery failure'
  console.error('[caogen] active session registry write quarantine enabled:', registryWriteQuarantineReason)
}

export function activeSessionRegistryWriteQuarantineReason(): string | undefined {
  return registryWriteQuarantineReason
}

export async function restoreActiveSessionRegistry(
  snapshotSessionIds: ReadonlySet<string>,
  sessions: Map<string, Engine>,
  snapshotCounts: Map<string, { total: number; sinceSave: number; lastSeq: number; lastEventId?: string }>,
  emit: (sessionId: string, event: AgentEvent, seq: number, identity?: AgentEventIdentity) => void,
  options: ActiveSessionRegistryRestoreOptions = {}
): Promise<ActiveSessionRegistryRestoreResult> {
  if (registryWriteQuarantineReason !== undefined) {
    console.error('[caogen] active session registry 仍处于写隔离状态，拒绝再次恢复:', registryWriteQuarantineReason)
    return { registryChanged: false, artifactsCanBePruned: false }
  }
  const plan = planActiveSessionRecovery(snapshotSessionIds, new Set(sessions.keys()))
  if (plan.registryReadError) {
    quarantineActiveSessionRegistryWrites(`registry read failed: ${plan.registryReadError}`)
    console.error('[caogen] active session registry 不可读取，已阻止覆盖和转录清理:', plan.registryReadError)
    return { registryChanged: false, artifactsCanBePruned: false }
  }
  for (const error of plan.skippedErrors) console.error('[caogen] 跳过不可恢复 active session:', error)
  if (plan.skippedErrors.length > 0) {
    quarantineActiveSessionRegistryWrites(`registry recovery rejected: ${plan.skippedErrors.join('; ')}`)
    return { registryChanged: false, artifactsCanBePruned: false }
  }
  if ((options.preserveRegistrySessionIds?.size ?? 0) > 0) {
    quarantineActiveSessionRegistryWrites(
      `external recovery blocked sessions: ${[...options.preserveRegistrySessionIds!].sort().join(', ')}`
    )
    console.error('[caogen] active session 存在外部恢复阻断，已保留完整 registry 和会话证据')
    return { registryChanged: false, artifactsCanBePruned: false }
  }

  // The active registry is durable recovery input, not an ownership source.
  // Re-check canonical Workspace/Goal/WorkItem state before constructing any
  // Engine so a deleted or tampered no-project task cannot be resurrected and
  // only fail later when its first message is sent.
  let restorable = plan.restorable
  try {
    restorable = await Promise.all(plan.restorable.map(async (record) => {
      const ownership = await prepareSessionDomainOwnershipForActivation(record, app.getPath('userData'))
      return { ...record, ...ownership }
    }))
  } catch (error) {
    quarantineActiveSessionRegistryWrites(
      `canonical ownership recovery rejected: ${error instanceof Error ? error.message : String(error)}`
    )
    console.error('[caogen] active session canonical ownership 预检失败，已阻止部分恢复:', error)
    return { registryChanged: false, artifactsCanBePruned: false }
  }

  const prepared: PreparedActiveSession[] = []
  try {
    prepareActiveSessionEngines(restorable, prepared)
  } catch (error) {
    await disposePreparedEngines(prepared)
    quarantineActiveSessionRegistryWrites(
      `batch recovery preflight failed: ${error instanceof Error ? error.message : String(error)}`
    )
    console.error('[caogen] active session 批次恢复预检失败，已阻止部分恢复:', error)
    return { registryChanged: false, artifactsCanBePruned: false }
  }

  try {
    for (const item of prepared) {
      if (item.projectPath) item.meta.projectId = touchProject(item.projectPath).id
    }
  } catch (error) {
    await disposePreparedEngines(prepared)
    quarantineActiveSessionRegistryWrites(
      `batch recovery project binding failed: ${error instanceof Error ? error.message : String(error)}`
    )
    console.error('[caogen] active session 批次 Project 绑定失败，已阻止部分恢复:', error)
    return { registryChanged: false, artifactsCanBePruned: false }
  }

  for (const item of prepared) {
    snapshotCounts.set(item.meta.id, { total: 0, sinceSave: 0, lastSeq: 0 })
    sessions.set(item.meta.id, item.engine)
  }
  for (const item of prepared) {
    for (const buffered of item.bufferedEvents) {
      emit(item.meta.id, buffered.event, buffered.seq, buffered.identity)
    }
  }
  startActiveSessionEngines(prepared, options.startRestoredEngine)
  const artifactsCanBePruned = activeSessionArtifactsCanBePruned(plan)
  return {
    registryChanged: prepared.length > 0 || plan.registryReconciled,
    artifactsCanBePruned
  }
}

export function planActiveSessionRecovery(
  snapshotSessionIds: ReadonlySet<string>,
  activeSessionIds: ReadonlySet<string>
): ActiveSessionRecoveryPlan {
  const records: SessionMeta[] = []
  const restorable: SessionMeta[] = []
  const skippedErrors: string[] = []
  let registryReconciled = false
  const registry = readActiveSessionRegistry()
  if (registry.error) {
    quarantineActiveSessionRegistryWrites(`registry read failed: ${registry.error}`)
    return { records, restorable, registryReconciled, skippedErrors, registryReadError: registry.error }
  }
  for (const record of registry.records) {
    let reconciled: SessionMeta
    try {
      reconciled = sessionMetaForRecovery(record)
    } catch (error) {
      registryReconciled = true
      skippedErrors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    registryReconciled ||= !sameSessionPlacement(record, reconciled)
    records.push(reconciled)
    if (activeSessionIds.has(record.id) || snapshotSessionIds.has(record.id) || !record.sdkSessionId) continue
    restorable.push(reconciled)
  }
  if (skippedErrors.length > 0) {
    quarantineActiveSessionRegistryWrites(`registry recovery rejected: ${skippedErrors.join('; ')}`)
  }
  return { records, restorable, registryReconciled, skippedErrors }
}

export function activeSessionRegistryPreserveIds(
  plan: ActiveSessionRecoveryPlan,
  blockedSessionIds: ReadonlySet<string>,
  authoritativeSdkSessionIds: ReadonlyMap<string, string>
): Set<string> {
  return new Set(plan.records.flatMap((record) => {
    if (!blockedSessionIds.has(record.id)) return []
    const authoritativeSdkSessionId = authoritativeSdkSessionIds.get(record.id)
    return record.sdkSessionId && record.sdkSessionId === authoritativeSdkSessionId ? [] : [record.id]
  }))
}

export function activeSessionArtifactsCanBePruned(
  plan: ActiveSessionRecoveryPlan,
  externalRecoveryBlocked = false
): boolean {
  return registryWriteQuarantineReason === undefined &&
    plan.registryReadError === undefined && plan.skippedErrors.length === 0 && !externalRecoveryBlocked
}

export function writeActiveSessionRegistry(records: SessionMeta[], strict = false): void {
  try {
    assertActiveSessionRegistryWritesAllowed()
    writeRegistry(records)
  } catch (error) {
    if (strict) throw error
    console.error('[caogen] 写入 active session registry 失败:', error)
  }
}

export function updateActiveSessionRegistryWorktreeState(
  sessionId: string,
  state: SessionMeta['worktreeState']
): void {
  const registry = readActiveSessionRegistry()
  if (registry.error) {
    console.error('[caogen] active session registry 不可读取，已阻止 worktree 状态覆盖:', registry.error)
    return
  }
  const records = registry.records
  const index = records.findIndex((record) => record.id === sessionId)
  if (index < 0 || records[index].worktreeState === state) return
  records[index] = { ...records[index], worktreeState: state }
  writeActiveSessionRegistry(records)
}

function sameSessionPlacement(left: SessionMeta, right: SessionMeta): boolean {
  return left.cwd === right.cwd &&
    left.isolated === right.isolated &&
    left.sourceCwd === right.sourceCwd &&
    left.repoRoot === right.repoRoot &&
    left.worktreePath === right.worktreePath &&
    left.branch === right.branch &&
    left.baseBranch === right.baseBranch &&
    left.baseSha === right.baseSha &&
    left.worktreeState === right.worktreeState
}

function readActiveSessionRegistry(): { records: SessionMeta[]; error?: string } {
  const file = activeSessionsFile()
  if (!existsSync(file)) return { records: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return { records: activeSessionMetaRecordsFromDocument(parsed, file) }
  } catch (error) {
    return { records: [], error: error instanceof Error ? error.message : String(error) }
  }
}

function writeRegistry(records: SessionMeta[]): void {
  const file = activeSessionsFile()
  assertWritableRegistryVersion(file)
  assertActiveSessionMetaRecords(records, 'active session registry candidate')
  const root = dirname(file)
  mkdirSync(root, { recursive: true })
  const temp = join(root, `.active-sessions.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temp, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(activeSessionRegistryDocument(records), null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temp, file)
    fsyncDirectory(root)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function assertWritableRegistryVersion(file: string): void {
  if (!existsSync(file)) return
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  activeSessionMetaRecordsFromDocument(parsed, file)
}

function activeSessionMetaRecordsFromDocument(value: unknown, file: string): SessionMeta[] {
  const records = activeSessionRecordsFromDocument<unknown>(value, file)
  assertActiveSessionMetaRecords(records, file)
  return records as SessionMeta[]
}

function assertActiveSessionMetaRecords(records: readonly unknown[], source: string): void {
  const invalidIndex = records.findIndex((record) => !isSessionMetaRecord(record))
  if (invalidIndex >= 0) throw new Error(`${source} session at index ${invalidIndex} is invalid`)
  const ids = new Set<string>()
  const sdkSessionIds = new Set<string>()
  for (const [index, value] of records.entries()) {
    const record = value as SessionMeta
    if (ids.has(record.id)) throw new Error(`${source} session at index ${index} has duplicate id: ${record.id}`)
    ids.add(record.id)
    if (!record.sdkSessionId) continue
    if (sdkSessionIds.has(record.sdkSessionId)) {
      throw new Error(`${source} session at index ${index} has duplicate sdkSessionId: ${record.sdkSessionId}`)
    }
    sdkSessionIds.add(record.sdkSessionId)
  }
}

function activeSessionsFile(): string {
  return join(app.getPath('userData'), 'active-sessions.json')
}

async function disposePreparedEngines(prepared: ReadonlyArray<{ engine: Engine }>): Promise<void> {
  const results = await Promise.allSettled(prepared.map((item) => item.engine.dispose()))
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[caogen] active session 批次回滚 dispose 失败:', result.reason)
    }
  }
}

function fsyncDirectory(root: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(root, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function isSessionMetaRecord(value: unknown): value is SessionMeta {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return isRequiredSessionText(record.id) &&
    typeof record.title === 'string' &&
    isRequiredSessionText(record.cwd) &&
    isSessionModel(record.model) &&
    (isRequiredSessionText(record.providerId) || isLocalPlanRegistryRecord(record)) &&
    isRequiredSessionText(record.permissionMode) &&
    isRequiredSessionText(record.status) &&
    (record.sdkSessionId === undefined || isRequiredSessionText(record.sdkSessionId)) &&
    typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) &&
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
}

/** Only the canonical, non-executing local plan may persist an unbound target. */
function isLocalPlanRegistryRecord(record: Record<string, unknown>): boolean {
  return record.providerId === '' && record.engine === 'openai' && record.permissionMode === 'default' &&
    (record.status === 'starting' || record.status === 'idle' || record.status === 'error') &&
    isRequiredSessionText(record.workspaceId) && isRequiredSessionText(record.goalId) &&
    isRequiredSessionText(record.workItemId) && isUnroutedLocalPlan(record as unknown as SessionMeta)
}

function assertActiveSessionRegistryWritesAllowed(): void {
  if (registryWriteQuarantineReason !== undefined) {
    throw new ActiveSessionRegistryWriteQuarantinedError(registryWriteQuarantineReason)
  }
}

function isSessionModel(value: unknown): value is string {
  return value === '' || isRequiredSessionText(value)
}

function isRequiredSessionText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    value.length <= 1024 && !/[\0-\x1f\x7f]/.test(value)
}
