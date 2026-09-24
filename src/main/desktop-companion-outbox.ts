import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeDurableFileSync } from './durable-file'
import type { DesktopCompanionDraftDelivery, DesktopCompanionDraftReceipt } from '../shared/desktop-companion-types'
import type { SessionMeta } from '../shared/types'

type Binding = Pick<SessionMeta, 'id' | 'createdAt' | 'workspaceId' | 'goalId' | 'workItemId'>
interface RecordEntry extends DesktopCompanionDraftReceipt { binding: Binding; digest: string; text?: string; createdAt: number }
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const binding = (meta: Binding): Binding => ({ id: meta.id, createdAt: meta.createdAt, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId })
const sameBinding = (left: Binding, right: Binding): boolean => JSON.stringify(binding(left)) === JSON.stringify(binding(right))

/** Persist before dispatch. A delivered receipt is written only after the receiver stores the draft. */
export class DesktopCompanionOutbox {
  constructor(private readonly file: string) {}
  private read(): RecordEntry[] {
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) throw new Error('随侍草稿记录无法读取，请检查本地存储。')
    const seen = new Set<string>()
    for (const item of parsed.items) {
      if (!item || typeof item.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.requestId) || seen.has(item.requestId) ||
        typeof item.sessionId !== 'string' || item.binding?.id !== item.sessionId || !Number.isFinite(item.binding?.createdAt) ||
        !['pending', 'delivered', 'rejected'].includes(item.status) || !/^[a-f0-9]{64}$/.test(item.digest) ||
        !Number.isFinite(item.createdAt) || (item.status === 'pending' && (typeof item.text !== 'string' || item.text.length > 20_000 || digest(item.text) !== item.digest))) {
        throw new Error('随侍草稿记录损坏，已停止交付。')
      }
      seen.add(item.requestId)
    }
    return parsed.items
  }
  private write(items: RecordEntry[]): void { writeDurableFileSync(this.file, JSON.stringify({ version: 1, items })) }
  enqueue(input: { requestId: string; sessionId: string; text: string }, meta: SessionMeta): DesktopCompanionDraftReceipt {
    if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) ||
      typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20_000 || input.sessionId !== meta.id || meta.status === 'closed') throw new Error('请指定可用任务，并输入 20,000 字符以内的文字。')
    const items = this.read(), existing = items.find(item => item.requestId === input.requestId)
    if (existing) {
      if (!sameBinding(existing.binding, meta) || existing.digest !== digest(input.text)) throw new Error('草稿交付标识已用于其他内容或任务。')
      return this.receipt(existing)
    }
    if (items.filter(item => item.status === 'pending').length >= 100) throw new Error('随侍草稿队列已满，请先处理已有草稿。')
    const entry: RecordEntry = { ...input, binding: binding(meta), digest: digest(input.text), createdAt: Date.now(), status: 'pending' }
    this.write([...items, entry])
    return this.receipt(entry)
  }
  pending(resolve: (id: string) => SessionMeta | undefined): DesktopCompanionDraftDelivery[] {
    const items = this.read(), result: DesktopCompanionDraftDelivery[] = []
    let changed = false
    for (const item of items) {
      if (item.status !== 'pending') continue
      const meta = resolve(item.sessionId)
      if (!meta || meta.status === 'closed' || !sameBinding(item.binding, meta)) {
        item.status = 'rejected'; item.error = '任务已关闭、移除或归属变化，未加入草稿。'; delete item.text; changed = true
      } else result.push({ deliveryId: item.requestId, requestId: item.requestId, sessionId: item.sessionId, binding: item.binding, text: item.text! })
    }
    if (changed) this.write(items)
    return result
  }
  acknowledge(input: DesktopCompanionDraftDelivery): void {
    const items = this.read(), item = items.find(entry => entry.requestId === input?.requestId)
    if (!item || item.sessionId !== input.sessionId || input.deliveryId !== item.requestId || !input.binding || !sameBinding(item.binding, input.binding) || typeof input.text !== 'string' || digest(input.text) !== item.digest || !['delivered', 'rejected'].includes(input.status ?? '')) throw new Error('草稿回执与交付内容不匹配。')
    if (item.status !== 'pending') { if (item.status !== input.status) throw new Error('草稿已有不同回执。'); return }
    item.status = input.status as 'delivered' | 'rejected'
    if (input.status === 'rejected') item.error = typeof input.error === 'string' ? input.error.slice(0, 300) : '工作台未接收草稿。'
    delete item.text
    this.write(items)
  }
  receipts(): DesktopCompanionDraftReceipt[] { return this.read().slice(-20).map(item => this.receipt(item)) }
  purge(sessionIds: Iterable<string>): void {
    const ids = new Set(sessionIds), items = this.read(), next = items.filter(item => !ids.has(item.sessionId))
    if (next.length !== items.length) this.write(next)
  }
  private receipt(item: RecordEntry): DesktopCompanionDraftReceipt { return { requestId: item.requestId, sessionId: item.sessionId, status: item.status, error: item.error } }
}
