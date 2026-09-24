import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFileSync } from '../durable-file'

interface ReadReceipt { read: boolean; revision: number }
interface ReadDocument { schemaVersion: 1; revision: number; receipts: Record<string, ReadReceipt> }
/** Only user acknowledgements live here; task events remain in the Conversation Ledger. */
export class ActivityReadStore {
  private readonly path: string
  constructor(root: string) { this.path = join(root, 'activity-read-receipts.json') }
  read(): ReadDocument {
    let raw: string
    try { raw = readFileSync(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, revision: 0, receipts: {} }
      throw error
    }
    const value = JSON.parse(raw) as ReadDocument
    if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !value.receipts || typeof value.receipts !== 'object' || Array.isArray(value.receipts) ||
      Object.entries(value.receipts).some(([key, receipt]) => !/^[a-f0-9]{64}$/.test(key) ||
        !receipt || typeof receipt.read !== 'boolean' || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > value.revision)) {
      throw new Error('活动阅读记录格式无效，原文件已保留。')
    }
    return value
  }
  mark(keys: string[], read: boolean, observedRevision: number): void {
    const document = this.read(), revision = document.revision + 1
    let changed = false
    for (const key of new Set(keys)) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('活动来源版本无效。')
      const existing = document.receipts[key]
      // A stale window cannot undo a newer explicit read/unread decision.
      if (existing && (existing.revision > observedRevision || existing.read === read)) continue
      document.receipts[key] = { read, revision }; changed = true
    }
    if (!changed) return
    document.revision = revision
    writeDurableFileSync(this.path, `${JSON.stringify(document)}\n`)
  }
}
