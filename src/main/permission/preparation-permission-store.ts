import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PREPARATION_WRITE_TOOLS, type PreparationPermissionMutation, type PreparationPermissionView, type PreparationWriteTool } from '../../shared/preparation-permission-types'
import type { SessionMeta } from '../../shared/types'
import { writeDurableFileSync } from '../durable-file'

interface DirectoryIdentity { device: string; inode: string }
export interface PreparationPermissionRecord {
  schemaVersion: 1
  sessionId: string
  revision: number
  status: 'granted' | 'revoked'
  /** Legacy missing scope grants only write_file. */
  allowedWriteTools?: readonly PreparationWriteTool[]
  /** Imported records retain evidence only; a local explicit grant collects destination ownership. */
  importedNeedsReauthorization?: true
  bindingDigest: string
  directory: string
  directoryIdentity: DirectoryIdentity
  grantedAt: number
  revokedAt?: number
  events: { revision: number; status: 'granted' | 'revoked'; actorId: string; at: number; allowedWriteTools?: readonly PreparationWriteTool[] }[]
  digest: string
}

/** Permission authority lives outside Session snapshots and is never restored from one. */
export class PreparationPermissionStore {
  readonly root: string
  constructor(rootDir: string) { this.root = realpathSync(resolve(rootDir)) }

  get(meta: SessionMeta): PreparationPermissionView {
    const record = this.read(meta.id)
    if (!record) return { schemaVersion: 1, sessionId: meta.id, revision: 0, status: 'none', available: false,
      allowedWriteTools: ['write_file'], unavailableReason: '尚未授权准备区；当前没有可写的起草目录。' }
    let unavailableReason: string | undefined
    try { this.assertCurrent(meta, record) } catch (error) { unavailableReason = errorText(error) }
    if (record.status === 'revoked') unavailableReason = '准备区写入授权已撤销。'
    else if (meta.taskStrategy === 'view') unavailableReason = '查看策略不允许起草文件；请先明确选择规划或执行。'
    return { schemaVersion: 1, sessionId: record.sessionId, revision: record.revision, status: record.status,
      available: unavailableReason === undefined, directory: record.directory, unavailableReason,
      grantedAt: record.grantedAt, revokedAt: record.revokedAt, allowedWriteTools: record.allowedWriteTools ?? ['write_file'] }
  }

  grant(meta: SessionMeta, raw: PreparationPermissionMutation, actorId: string): PreparationPermissionView {
    assertIdle(meta); assertActor(actorId)
    if (meta.taskStrategy === 'view') throw new Error('查看策略不能申请写入准备区；请先明确选择规划或执行。')
    const current = this.read(meta.id)
    assertRevision(raw, current?.revision ?? 0, true)
    const allowedWriteTools = normalizeWriteTools(raw.allowedWriteTools ?? (current?.status === 'granted' ? current.allowedWriteTools : undefined) ?? ['write_file'])
    if (current && !current.importedNeedsReauthorization) this.assertCurrent(meta, current)
    if (current?.status === 'granted' && JSON.stringify(allowedWriteTools) === JSON.stringify(current.allowedWriteTools ?? ['write_file'])) return this.get(meta)
    const directory = this.directory(meta.id)
    const sourceCwd = realpathSync(meta.cwd)
    if (inside(sourceCwd, directory) || inside(directory, sourceCwd)) throw new Error('准备区必须与正式工作目录分离。')
    ensurePrivateDirectory(this.root, directory)
    const now = Date.now(), revision = (current?.revision ?? 0) + 1
    const record: Omit<PreparationPermissionRecord, 'digest'> = {
      schemaVersion: 1, sessionId: meta.id, revision, status: 'granted', allowedWriteTools, bindingDigest: bindingDigest(meta),
      directory, directoryIdentity: directoryIdentity(directory), grantedAt: now,
      events: [...(current?.events ?? []), { revision, status: 'granted', actorId, at: now, allowedWriteTools }]
    }
    this.persist(record)
    return this.get(meta)
  }

  revoke(meta: SessionMeta, raw: PreparationPermissionMutation, actorId: string): PreparationPermissionView {
    assertActor(actorId)
    const current = this.read(meta.id)
    assertRevision(raw, current?.revision ?? 0)
    if (!current || current.status === 'revoked') return this.get(meta)
    const now = Date.now(), revision = current.revision + 1
    const { digest: _digest, ...record } = current
    this.persist({ ...record, revision, status: 'revoked', revokedAt: now,
      events: [...record.events, { revision, status: 'revoked', actorId, at: now }] })
    return this.get(meta)
  }

  /** Read and validate the current durable revision again immediately before a write. */
  assertWritable(meta: SessionMeta, revision: number, directory: string, toolName = 'write_file'): void {
    const record = this.read(meta.id)
    if (!record || record.status !== 'granted' || record.revision !== revision || record.directory !== directory) {
      throw new Error('准备区授权已撤销或变更，旧操作不得继续写入。')
    }
    this.assertCurrent(meta, record)
    if (meta.taskStrategy === 'view') throw new Error('查看策略不允许写入准备区。')
    if (!['read_file', 'view', 'list_dir'].includes(toolName) && !(record.allowedWriteTools ?? ['write_file']).includes(toolName as PreparationWriteTool)) {
      throw new Error('此工具未适配当前准备区授权范围；请先明确开启对应的起草权限。')
    }
  }

  private assertCurrent(meta: SessionMeta, record: PreparationPermissionRecord): void {
    if (record.bindingDigest !== bindingDigest(meta)) throw new Error('准备区授权与当前任务或工作目录身份不一致；恢复不能扩大原授权。')
    assertPrivateDirectory(this.root, record.directory)
    const actual = directoryIdentity(record.directory)
    if (actual.device !== record.directoryIdentity.device || actual.inode !== record.directoryIdentity.inode) {
      throw new Error('准备区目录身份已变化，原授权失效。')
    }
  }

  private read(sessionId: string): PreparationPermissionRecord | undefined {
    const file = this.file(sessionId)
    let raw: string
    try {
      assertPrivateDirectory(this.root, dirname(file))
      const info = lstatSync(file)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('准备区授权记录必须是普通文件。')
      raw = readFileSync(file, 'utf8')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    return parsePreparationPermissionRecord(JSON.parse(raw), sessionId, this.directory(sessionId))
  }

  private persist(record: Omit<PreparationPermissionRecord, 'digest'>): void {
    const file = this.file(record.sessionId)
    ensurePrivateDirectory(this.root, dirname(file))
    writeDurableFileSync(file, JSON.stringify({ ...record, digest: hash(record) }))
  }
  private file(sessionId: string): string { return join(this.root, 'private', 'preparation-permissions', `${sessionKey(sessionId)}.json`) }
  private directory(sessionId: string): string { return join(this.root, 'preparation-drafts', sessionKey(sessionId), 'files') }
}

/** Validate the source body before any normalization; digest uses its original JSON key order. */
export function parsePreparationPermissionRecord(value: unknown, sessionId: string, expectedDirectory?: string): PreparationPermissionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('准备区授权记录损坏，已阻止使用。')
  const record = value as PreparationPermissionRecord
  const { digest, ...body } = record
  if (record.schemaVersion !== 1 || record.sessionId !== sessionId ||
    typeof record.directory !== 'string' || (!isAbsolute(record.directory) && !/^[A-Za-z]:[\\/]/.test(record.directory)) || record.directory.includes('\0') ||
    (expectedDirectory !== undefined && record.directory !== expectedDirectory) ||
    !Number.isSafeInteger(record.revision) || record.revision < 1 || !['granted', 'revoked'].includes(record.status) ||
    (record.importedNeedsReauthorization !== undefined && (record.importedNeedsReauthorization !== true || record.status !== 'revoked')) ||
    !record.directoryIdentity || typeof record.directoryIdentity.device !== 'string' || typeof record.directoryIdentity.inode !== 'string' ||
    !/^\d+$/.test(record.directoryIdentity.device) || !/^\d+$/.test(record.directoryIdentity.inode) ||
    !Number.isFinite(record.grantedAt) || (record.status === 'revoked' && !Number.isFinite(record.revokedAt)) ||
    typeof record.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.bindingDigest) || digest !== hash(body) || !Array.isArray(record.events) ||
    record.events.length !== record.revision || record.events.some((event, index) => !event || event.revision !== index + 1 ||
      !['granted', 'revoked'].includes(event.status) || typeof event.actorId !== 'string' || !event.actorId.startsWith('local-user:') || !Number.isFinite(event.at)) ||
    record.events.at(-1)?.status !== record.status) throw new Error('准备区授权记录损坏，已阻止使用。')
  sessionKey(sessionId)
  if (record.allowedWriteTools !== undefined) normalizeWriteTools(record.allowedWriteTools)
  for (const event of record.events) if (event.allowedWriteTools !== undefined) normalizeWriteTools(event.allowedWriteTools)
  const lastGrant = [...record.events].reverse().find(event => event.status === 'granted')
  if (JSON.stringify(record.allowedWriteTools ?? ['write_file']) !== JSON.stringify(lastGrant?.allowedWriteTools ?? ['write_file'])) {
    throw new Error('准备区工具范围与最后授权事件不一致。')
  }
  return record
}

function bindingDigest(meta: SessionMeta): string {
  return hash([meta.id, meta.createdAt, realpathSync(meta.cwd), directoryIdentity(realpathSync(meta.cwd)),
    meta.workspaceId ?? null, meta.goalId ?? null, meta.workItemId ?? null, meta.businessLineId ?? null,
    meta.personalWorkspaceId ?? null, meta.parentSessionId ?? null])
}
function directoryIdentity(directory: string): DirectoryIdentity {
  const info = lstatSync(directory, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('准备区或正式目录不是实际目录。')
  return { device: info.dev.toString(), inode: info.ino.toString() }
}
function assertRevision(raw: PreparationPermissionMutation, current: number, grant = false): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'expectedRevision' && !(grant && key === 'allowedWriteTools')) ||
    !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0 || raw.expectedRevision !== current) {
    throw new Error('准备区授权版本已变化，请刷新当前授权后重试。')
  }
}
function normalizeWriteTools(value: unknown): PreparationWriteTool[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some(tool => !PREPARATION_WRITE_TOOLS.includes(tool))) {
    throw new Error('准备区工具范围无效。')
  }
  return PREPARATION_WRITE_TOOLS.filter(tool => value.includes(tool))
}
function assertIdle(meta: SessionMeta): void {
  if (meta.status === 'running' || meta.status === 'starting') throw new Error('请先暂停并等待当前操作结束，再变更准备区授权。')
  if (meta.status === 'closed') throw new Error('已关闭会话不能变更准备区授权。')
}
function assertActor(value: string): void { if (!value.startsWith('local-user:')) throw new Error('准备区授权必须来自已验证的本地用户。') }
export function sessionKey(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0-\x1f]/.test(value)) throw new Error('会话身份无效。')
  return hash(value)
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function inside(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
function assertPrivateDirectory(root: string, directory: string): void {
  if (!inside(root, directory)) throw new Error('准备区路径超出应用数据目录。')
  let current = root
  directoryIdentity(current)
  for (const part of relative(root, directory).split(/[\\/]/).filter(Boolean)) { current = join(current, part); directoryIdentity(current) }
}
function ensurePrivateDirectory(root: string, directory: string): void {
  if (!inside(root, directory)) throw new Error('准备区路径超出应用数据目录。')
  let current = root
  directoryIdentity(current)
  for (const part of relative(root, directory).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    try { directoryIdentity(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 }); directoryIdentity(current)
    }
  }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
