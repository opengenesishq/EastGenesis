import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { TaskExecutionAuthorityGrant, TaskExecutionAuthorityMutation, TaskExecutionAuthorityView } from '../../shared/task-execution-authority-types'
import { writeDurableFileSync } from '../durable-file'
import { isLimitedFileExecutionReadOnlyCall } from './limited-file-execution-policy'
import { sessionKey } from './preparation-permission-store'
import { assertTaskExecutionAuthoritySessionActive } from './task-execution-authority-lifecycle'
import { normalizeTaskExecutionAuthorityScope, taskExecutionAuthorityPolicyError, type TaskExecutionAuthorityScope } from './task-execution-authority-policy'

interface DirectoryIdentity { device: string; inode: string }
interface AuthorityEvent extends TaskExecutionAuthorityScope {
  revision: number; status: 'granted' | 'revoked'; actorId: string; at: number
}
export interface TaskExecutionAuthorityRecord extends TaskExecutionAuthorityScope {
  schemaVersion: 1
  sessionId: string
  /** Cleanup indexes only; authorization is still bound by bindingDigest. */
  projectId?: string
  workspaceId?: string
  revision: number
  status: 'granted' | 'revoked'
  bindingDigest: string
  directory: string
  directoryIdentity: DirectoryIdentity
  grantedAt?: number
  revokedAt?: number
  events: AuthorityEvent[]
  digest: string
}

/** Private authority is independent of Session snapshots; snapshots retain only a required marker. */
export class TaskExecutionAuthorityStore {
  readonly root: string
  constructor(rootDir: string) { this.root = realpathSync(resolve(rootDir)) }

  /** Any durable decision requires explicit local authority; this never grants execution. */
  hasPersistedRestriction(sessionId: string): boolean {
    return this.read(sessionId) !== undefined
  }

  get(meta: SessionMeta): TaskExecutionAuthorityView {
    const record = this.read(meta.id)
    let directory: string | undefined, bindingDigest: string | undefined, bindingError: string | undefined
    try { directory = realpathSync(meta.cwd); bindingDigest = taskExecutionAuthorityBindingDigest(meta) }
    catch (error) { bindingError = errorText(error) }
    if (!record) return { schemaVersion: 1, sessionId: meta.id, revision: 0,
      status: meta.taskExecutionAuthorityRequired ? 'revoked' : 'legacy', available: false,
      directory, bindingDigest, allowedWriteTools: [], pathPatterns: [], allowedCommandPatterns: [], unavailableReason: bindingError ?? (meta.taskExecutionAuthorityRequired
        ? '此任务需要独立授权；本机没有有效授权，导入或恢复后请重新授权。'
        : '此任务尚未设置独立文件范围，沿用已有策略和权限；这不代表已授予新的文件权限。') }
    let unavailableReason: string | undefined
    try { this.assertCurrent(meta, record) } catch (error) { unavailableReason = errorText(error) }
    if (record.status === 'revoked') unavailableReason = '任务文件执行授权已撤销。'
    else if (meta.taskStrategy !== 'execute') unavailableReason = '当前任务意图不允许正式执行；文件范围授权不会把规划或查看升为执行。'
    return { schemaVersion: 1, sessionId: meta.id, revision: record.revision, status: record.status,
      available: unavailableReason === undefined, directory, bindingDigest, unavailableReason,
      allowedWriteTools: record.allowedWriteTools, pathPatterns: record.pathPatterns, allowedCommandPatterns: record.allowedCommandPatterns, grantedAt: record.grantedAt, revokedAt: record.revokedAt }
  }

  grant(meta: SessionMeta, raw: TaskExecutionAuthorityGrant, actorId: string): TaskExecutionAuthorityView {
    assertActor(actorId)
    this.assertMutation(meta, raw, 'grant')
    const current = this.read(meta.id)
    const scope = normalizeTaskExecutionAuthorityScope(raw)
    // A fresh local decision may rebind an unavailable old grant, but never an old operation token.
    const directory = realpathSync(meta.cwd), now = Date.now(), revision = (current?.revision ?? 0) + 1
    this.persist({ schemaVersion: 1, sessionId: meta.id, revision, status: 'granted', ...scope,
      projectId: meta.projectId, workspaceId: meta.workspaceId,
      bindingDigest: taskExecutionAuthorityBindingDigest(meta), directory, directoryIdentity: directoryIdentity(directory), grantedAt: now,
      events: [...(current?.events ?? []), { revision, status: 'granted', actorId, at: now, ...scope }] })
    return this.get(meta)
  }

  revoke(meta: SessionMeta, raw: TaskExecutionAuthorityMutation, actorId: string): TaskExecutionAuthorityView {
    assertActor(actorId)
    this.assertMutation(meta, raw, 'revoke')
    const current = this.read(meta.id)
    if (current?.status === 'revoked') return this.get(meta)
    const now = Date.now(), revision = (current?.revision ?? 0) + 1
    const scope = { allowedWriteTools: current?.allowedWriteTools ?? [], pathPatterns: current?.pathPatterns ?? [], allowedCommandPatterns: current?.allowedCommandPatterns ?? [] }
    const directory = current?.directory ?? realpathSync(meta.cwd)
    this.persist({ schemaVersion: 1, sessionId: meta.id, revision, status: 'revoked', ...scope,
      projectId: current?.projectId ?? meta.projectId, workspaceId: current?.workspaceId ?? meta.workspaceId,
      bindingDigest: current?.bindingDigest ?? taskExecutionAuthorityBindingDigest(meta), directory,
      directoryIdentity: current?.directoryIdentity ?? directoryIdentity(directory), grantedAt: current?.grantedAt, revokedAt: now,
      events: [...(current?.events ?? []), { revision, status: 'revoked', actorId, at: now, ...scope }] })
    return this.get(meta)
  }

  /** Validate the full request before IPC durably sets the no-legacy marker. No writes. */
  assertMutation(meta: SessionMeta, raw: TaskExecutionAuthorityMutation, operation: 'grant' | 'revoke'): void {
    assertTaskExecutionAuthoritySessionActive(this.root, meta)
    const current = this.read(meta.id)
    assertRevision(raw, current?.revision ?? 0, operation === 'grant')
    if (operation === 'grant') {
      if (meta.status !== 'idle' || meta.taskStrategy !== 'execute') throw new Error('请先暂停任务，并明确选择执行意图，再授权正式文件范围。')
      if ((raw as TaskExecutionAuthorityGrant).expectedBindingDigest !== taskExecutionAuthorityBindingDigest(meta)) throw new Error('任务或工作目录已变化，请刷新授权范围后重试。')
      normalizeTaskExecutionAuthorityScope(raw as TaskExecutionAuthorityGrant)
    }
    // Also validate the real directory and full identity before persisting a marker.
    taskExecutionAuthorityBindingDigest(meta)
  }

  /** Capture a revision before approval, then read authority afresh immediately before physical commit. */
  assertAllowed(meta: SessionMeta, name: string, input: Record<string, unknown>, cwd: string, expectedRevision?: number): void {
    if (isLimitedFileExecutionReadOnlyCall(name, input)) return
    const record = this.read(meta.id)
    if (expectedRevision !== undefined && expectedRevision !== (record?.revision ?? 0)) throw new Error('任务执行授权已撤销或变更，旧操作不得继续写入。')
    if (!record && !meta.taskExecutionAuthorityRequired) return // explicit legacy compatibility, never a new grant
    if (!record || record.status !== 'granted') throw new Error('任务文件执行授权已撤销或缺失，请重新授权。')
    this.assertCurrent(meta, record)
    if (meta.taskStrategy !== 'execute') throw new Error('当前任务意图不允许正式执行。')
    if (realpathSync(cwd) !== record.directory) throw new Error('工具工作目录与任务授权根目录不一致。')
    const error = taskExecutionAuthorityPolicyError(record, name, input, record.directory)
    if (error) throw new Error(error)
  }

  private assertCurrent(meta: SessionMeta, record: TaskExecutionAuthorityRecord): void {
    assertTaskExecutionAuthoritySessionActive(this.root, meta, record.grantedAt)
    if (record.bindingDigest !== taskExecutionAuthorityBindingDigest(meta) || realpathSync(meta.cwd) !== record.directory ||
      hash(directoryIdentity(record.directory)) !== hash(record.directoryIdentity)) throw new Error('任务、项目、目标、工作项或真实目录身份已变化，原文件授权失效。')
  }

  private read(sessionId: string): TaskExecutionAuthorityRecord | undefined {
    const file = this.file(sessionId)
    let raw: string
    try {
      ensurePrivateDirectory(this.root, dirname(file), false)
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('任务执行授权记录必须是普通文件。')
      raw = readFileSync(file, 'utf8')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    return parseTaskExecutionAuthorityRecord(JSON.parse(raw), sessionId)
  }

  private persist(record: Omit<TaskExecutionAuthorityRecord, 'digest'>): void {
    const file = this.file(record.sessionId)
    ensurePrivateDirectory(this.root, dirname(file), true)
    const body = JSON.parse(JSON.stringify(record)) as Omit<TaskExecutionAuthorityRecord, 'digest'>
    writeDurableFileSync(file, JSON.stringify({ ...body, digest: hash(body) }))
  }
  private file(sessionId: string): string { return join(this.root, 'private', 'task-execution-authorities', `${sessionKey(sessionId)}.json`) }
}

export function parseTaskExecutionAuthorityRecord(value: unknown, sessionId: string): TaskExecutionAuthorityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务执行授权记录损坏，已阻止使用。')
  const record = value as TaskExecutionAuthorityRecord
  const { digest, ...body } = record
  if (record.schemaVersion !== 1 || record.sessionId !== sessionId || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    !['granted', 'revoked'].includes(record.status) || typeof record.directory !== 'string' || !isAbsolute(record.directory) || record.directory.includes('\0') ||
    !record.directoryIdentity || typeof record.directoryIdentity.device !== 'string' || typeof record.directoryIdentity.inode !== 'string' ||
    !/^\d+$/.test(record.directoryIdentity.device) || !/^\d+$/.test(record.directoryIdentity.inode) ||
    typeof record.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.bindingDigest) || digest !== hash(body) ||
    (record.status === 'granted' && !Number.isFinite(record.grantedAt)) || (record.status === 'revoked' && !Number.isFinite(record.revokedAt)) ||
    !Array.isArray(record.events) || record.events.length !== record.revision || record.events.some((event, index) =>
      !event || event.revision !== index + 1 || !['granted', 'revoked'].includes(event.status) || !Number.isFinite(event.at) ||
      typeof event.actorId !== 'string' || !event.actorId.startsWith('local-user:')) || record.events.at(-1)?.status !== record.status) {
    throw new Error('任务执行授权记录损坏，已阻止使用。')
  }
  // Records written before command-level authorization remain valid and have no command grant.
  for (const event of [record, ...record.events]) {
    if (event.allowedCommandPatterns === undefined) event.allowedCommandPatterns = []
    if (event.status === 'revoked' && Array.isArray(event.allowedWriteTools) && event.allowedWriteTools.length === 0 &&
      Array.isArray(event.pathPatterns) && event.pathPatterns.length === 0 &&
      Array.isArray(event.allowedCommandPatterns) && event.allowedCommandPatterns.length === 0) continue
    normalizeTaskExecutionAuthorityScope(event)
  }
  const last = record.events.at(-1)!
  const recordScopeDigest = hash([record.allowedWriteTools, record.pathPatterns, record.allowedCommandPatterns])
  const eventScopeDigest = hash([last.allowedWriteTools, last.pathPatterns, last.allowedCommandPatterns])
  if (recordScopeDigest !== eventScopeDigest) throw new Error('任务执行范围与最后授权事件不一致。')
  return record
}

export function taskExecutionAuthorityBindingDigest(meta: SessionMeta): string {
  const directory = realpathSync(meta.cwd)
  return hash([meta.id, meta.createdAt, directory, directoryIdentity(directory), meta.projectId ?? null, meta.workspaceId ?? null,
    meta.goalId ?? null, meta.workItemId ?? null, meta.businessLineId ?? null, meta.personalWorkspaceId ?? null, meta.parentSessionId ?? null])
}
function directoryIdentity(directory: string): DirectoryIdentity {
  const info = lstatSync(directory, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('任务授权目录不是实际目录。')
  return { device: info.dev.toString(), inode: info.ino.toString() }
}
function assertRevision(raw: TaskExecutionAuthorityMutation, current: number, grant = false): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key =>
    key !== 'expectedRevision' && !(grant && ['allowedWriteTools', 'pathPatterns', 'allowedCommandPatterns', 'expectedBindingDigest'].includes(key))) ||
    !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0 || raw.expectedRevision !== current) throw new Error('任务执行授权版本已变化，请刷新后重试。')
}
function assertActor(value: string): void {
  if (typeof value !== 'string' || !value.startsWith('local-user:') || value.length <= 'local-user:'.length) throw new Error('任务执行授权必须来自已验证的本地用户。')
}
function ensurePrivateDirectory(root: string, directory: string, create: boolean): void {
  const rel = relative(root, directory)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('任务授权记录超出应用数据目录。')
  let current = root
  directoryIdentity(current)
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    try { directoryIdentity(current) } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 }); directoryIdentity(current)
    }
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
