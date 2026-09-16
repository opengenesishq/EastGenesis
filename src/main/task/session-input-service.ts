import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SendMessagePayload, SessionMeta } from '../../shared/types'
import type { SessionInputRecord } from '../../shared/session-input-types'
import { writeDurableFileSync } from '../durable-file'
import { stableValueDigest } from './tool-idempotency'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { messagePayloadDigest } from '../message-payload-digest'
import { normalizeRequirementRevisionIntent } from '../../shared/session-requirement-revision'
import { applySessionRequirementRevision } from './session-requirement-revision'
import { withSessionOperationQueue } from '../session-operation-queue'

export interface SessionInputRuntime {
  meta(sessionId: string): SessionMeta | undefined
  send(sessionId: string, payload: SendMessagePayload): Promise<boolean>
  accepted(record: SessionInputRecord): Promise<boolean>
  /** Deterministic local checks before a send barrier; rejection keeps the outbox queued. */
  preflight?(record: SessionInputRecord): Promise<void>
}

/** Receipts index the existing transcript/Run. They do not own task or execution state. */
export class SessionInputService {
  private readonly operations = new Map<string, Promise<SessionInputRecord>>()

  constructor(private readonly rootDir: string, private readonly runtime: SessionInputRuntime) {}

  async list(sessionId: string): Promise<SessionInputRecord[]> {
    checkedId(sessionId)
    let files: string[]
    try { files = readdirSync(this.directory(sessionId)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: SessionInputRecord[] = []
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = this.parse(JSON.parse(readFileSync(join(this.directory(sessionId), file), 'utf8')))
      if (record.sessionId !== sessionId || this.path(sessionId, record.id) !== join(this.directory(sessionId), file)) {
        throw new Error('补充要求的会话身份不一致')
      }
      // A currently sending operation owns its receipt; a read cannot race its write.
      records.push(this.operations.has(this.key(sessionId, record.id)) ? record : await this.reconcile(record))
    }
    return records.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  queue(sessionId: string, id: string, payload: SendMessagePayload): Promise<SessionInputRecord> {
    return withDataLifecycleMutation(this.rootDir, async () => this.performQueue(sessionId, id, payload))
  }

  private performQueue(sessionId: string, id: string, payload: SendMessagePayload): SessionInputRecord {
    checkedId(sessionId)
    checkedId(id)
    const meta = this.runtime.meta(sessionId)
    if (!meta || meta.status === 'closed') throw new Error('当前任务已关闭，请先恢复此任务')
    const existing = this.read(sessionId, id)
    if (existing) {
      this.assertIdentity(existing, meta)
      if (stableValueDigest(existing.payload) !== stableValueDigest(payload)) throw new Error('相同提交标识不能用于不同补充要求')
      return existing
    }
    if (typeof payload.text !== 'string' || payload.text.length > 200_000 ||
        (!payload.text.trim() && !payload.images?.length && !payload.documents?.length) || payload.messageId) {
      throw new Error('补充要求内容无效')
    }
    if (payload.requirementRevisionIntent) {
      normalizeRequirementRevisionIntent(payload.requirementRevisionIntent)
      if (!meta.workspaceId || !meta.goalId || !meta.workItemId || meta.parentSessionId || payload.officeRevisionIntent || payload.images?.length || payload.documents?.length) {
        throw new Error('交付要求修订必须绑定原目标和工作项，且不能夹带文件执行或附件')
      }
    }
    const now = Date.now()
    const record: SessionInputRecord = {
      schemaVersion: 1, revision: 1, id, sessionId,
      workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId,
      messageId: `session-input:${sessionId}:${id}`, payload,
      phase: 'queued', createdAt: now, updatedAt: now
    }
    writeDurableFileSync(this.path(sessionId, id), JSON.stringify(record), { replace: false })
    return record
  }

  apply(sessionId: string, id: string): Promise<SessionInputRecord> {
    const key = this.key(sessionId, id)
    const existing = this.operations.get(key)
    if (existing) return existing
    const operation = this.performApply(sessionId, id).finally(() => this.operations.delete(key))
    this.operations.set(key, operation)
    return operation
  }

  cancel(sessionId: string, id: string): Promise<SessionInputRecord> {
    return withDataLifecycleMutation(this.rootDir, async () => {
      if (this.operations.has(this.key(sessionId, id))) throw new Error('补充要求正在提交，请等待结果')
      const record = this.required(sessionId, id)
      if (record.phase !== 'queued') throw new Error('只能撤回尚未提交的补充要求')
      return this.save(record, { phase: 'cancelled', error: undefined })
    })
  }

  private async performApply(sessionId: string, id: string): Promise<SessionInputRecord> {
    let record = await this.reconcile(this.required(sessionId, id))
    if (record.phase === 'applied' || record.phase === 'requirements_applied') return record
    if (record.phase !== 'queued') throw new Error(record.error ?? '此补充要求不能重发，请先核对执行记录')
    const meta = this.runtime.meta(sessionId)
    if (!meta) throw new Error('请先恢复原任务，再应用补充要求')
    this.assertIdentity(record, meta)
    if (meta.status === 'running' || meta.status === 'starting') throw new Error('任务仍在运行；请等待本轮结束或先暂停')
    if (meta.status === 'closed') throw new Error('当前任务已关闭，请先恢复此任务')
    if (record.payload.requirementRevisionIntent) {
      return withSessionOperationQueue(sessionId, () => withDataLifecycleMutation(this.rootDir, async () => {
        const current = this.required(sessionId, id)
        const currentMeta = this.runtime.meta(sessionId)
        if (!currentMeta || currentMeta.status === 'closed' || currentMeta.status === 'running' || currentMeta.status === 'starting') {
          throw new Error('当前任务状态已变化，请在本轮结束后重新确认交付要求')
        }
        this.assertIdentity(current, currentMeta)
        if (currentMeta.parentSessionId) throw new Error('请回到原目标任务修改交付要求')
        if (current.phase !== 'queued') throw new Error('修订请求已变化，请核对原回执')
        const requirementRevision = await applySessionRequirementRevision(this.rootDir, current)
        return this.save(current, { phase: 'requirements_applied', error: undefined, requirementRevision })
      }))
    }
    await this.runtime.preflight?.(record)
    // Persist the dispatch barrier before entering the existing authorization/Run path.
    record = await this.save(record, { phase: 'dispatching', error: undefined })
    try {
      const accepted = await this.runtime.send(sessionId, { ...record.payload, messageId: record.messageId })
      if (await this.runtime.accepted(record)) return this.save(record, { phase: 'applied' })
      return this.save(record, { phase: 'needs_reconciliation', error: accepted
        ? '接收结果缺少完整持久记录。要求已保存，请核对执行记录；不会自动重发。'
        : '执行引擎未确认接收。要求已保存，请核对任务中的错误和执行记录；不会自动重发。' })
    } catch (error) {
      // Even false/throw may follow an accepted send; only positive evidence resolves it.
      record = await this.save(record, { phase: 'needs_reconciliation', error: `提交结果待核对：${error instanceof Error ? error.message : String(error)}` })
      return this.reconcile(record)
    }
  }

  private async reconcile(record: SessionInputRecord): Promise<SessionInputRecord> {
    if (record.phase === 'queued' && record.payload.requirementRevisionIntent) {
      // A failed canonical transaction stays queued. Explicit apply recovers its
      // command journal and matching source event before creating another revision.
      return record
    }
    if (record.phase !== 'dispatching' && record.phase !== 'needs_reconciliation') return record
    const meta = this.runtime.meta(record.sessionId)
    if (meta) this.assertIdentity(record, meta)
    if (await this.runtime.accepted(record)) return this.save(record, { phase: 'applied', error: undefined })
    if (record.phase === 'dispatching') return this.save(record, { phase: 'needs_reconciliation', error: '上次提交结果尚未确认，请核对原任务的执行记录；不会自动重发。' })
    return record
  }

  private assertIdentity(record: SessionInputRecord, meta: SessionMeta): void {
    if (record.sessionId !== meta.id || record.workspaceId !== meta.workspaceId ||
        record.goalId !== meta.goalId || record.workItemId !== meta.workItemId) throw new Error('补充要求与原任务归属不一致')
  }

  private required(sessionId: string, id: string): SessionInputRecord {
    const record = this.read(sessionId, id)
    if (!record) throw new Error('找不到此任务的补充要求')
    return record
  }

  private read(sessionId: string, id: string): SessionInputRecord | null {
    let raw: string
    try { raw = readFileSync(this.path(sessionId, id), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const record = this.parse(JSON.parse(raw))
    if (record.sessionId !== sessionId || record.id !== id) throw new Error('补充要求回执身份不一致')
    return record
  }

  private parse(value: unknown): SessionInputRecord {
    const record = value as SessionInputRecord | null
    if (!record || record.schemaVersion !== 1 || typeof record.id !== 'string' || typeof record.sessionId !== 'string' ||
        !['queued', 'dispatching', 'applied', 'requirements_applied', 'needs_reconciliation', 'cancelled'].includes(record.phase) ||
        record.messageId !== `session-input:${record.sessionId}:${record.id}` ||
        typeof record.payload?.text !== 'string' || record.payload.text.length > 200_000 || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
      throw new Error('补充要求回执损坏，已阻止提交')
    }
    checkedId(record.id)
    checkedId(record.sessionId)
    if (record.payload.requirementRevisionIntent) normalizeRequirementRevisionIntent(record.payload.requirementRevisionIntent)
    if (record.phase === 'requirements_applied' && (!record.payload.requirementRevisionIntent ||
        record.requirementRevision?.schemaVersion !== 1 || !record.requirementRevision.sourceEventId ||
        !Number.isSafeInteger(record.requirementRevision.goalRevision) || !Number.isSafeInteger(record.requirementRevision.workItemRevision))) {
      throw new Error('交付要求修订回执无效')
    }
    if (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 1)) throw new Error('补充要求回执版本无效')
    if (record.importedPayloadDigest !== undefined && (!/^[a-f0-9]{64}$/.test(record.importedPayloadDigest) || record.phase === 'queued')) {
      throw new Error('导入补充要求的接收证据无效')
    }
    if (record.importedPayloadDigest !== undefined && record.importedPayloadPaths === undefined) {
      throw new Error('导入补充要求缺少源请求证据')
    }
    if (record.importedPayloadPaths !== undefined) {
      const paths = record.importedPayloadPaths
      const valid = paths && Array.isArray(paths.images) && Array.isArray(paths.documents) &&
        paths.images.length === (record.payload.images?.length ?? 0) &&
        paths.documents.length === (record.payload.documents?.length ?? 0) &&
        [...paths.images, ...paths.documents].every((path) => typeof path === 'string' &&
          (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) && !/[\0-\x1f]/.test(path))
      if (!valid || record.importedPayloadDigest === undefined || record.phase === 'queued') {
        throw new Error('导入补充要求的源附件证据无效')
      }
      const source = { ...record.payload,
        ...(record.payload.images ? { images: record.payload.images.map((item, index) => ({ ...item, path: paths.images[index] })) } : {}),
        ...(record.payload.documents ? { documents: record.payload.documents.map((item, index) => ({ ...item, path: paths.documents[index] })) } : {}) }
      if (messagePayloadDigest(source) !== record.importedPayloadDigest) throw new Error('导入补充要求的源请求摘要不一致')
    }
    return { ...record, revision: record.revision ?? 1 }
  }

  private save(record: SessionInputRecord, patch: Pick<SessionInputRecord, 'phase'> & Pick<Partial<SessionInputRecord>, 'error' | 'requirementRevision'>): Promise<SessionInputRecord> {
    return withDataLifecycleMutation(this.rootDir, async () => {
      // Serialize with deletion/retention and compare the durable version inside the same lock.
      const current = this.required(record.sessionId, record.id)
      if (current.revision !== record.revision || current.phase !== record.phase ||
          current.messageId !== record.messageId || stableValueDigest(current.payload) !== stableValueDigest(record.payload)) {
        throw new Error('补充要求回执已变化，已停止写入')
      }
      const next = { ...current, ...patch, revision: current.revision! + 1, updatedAt: Date.now() }
      writeDurableFileSync(this.path(record.sessionId, record.id), JSON.stringify(next))
      return next
    })
  }

  private key(sessionId: string, id: string): string { return `${checkedId(sessionId)}:${checkedId(id)}` }
  private directory(sessionId: string): string {
    return join(this.rootDir, 'private', 'session-inputs', digest(checkedId(sessionId)))
  }
  private path(sessionId: string, id: string): string { return join(this.directory(sessionId), `${digest(checkedId(id))}.json`) }
}

function checkedId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('会话或提交标识无效')
  return value
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
