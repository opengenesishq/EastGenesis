import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFileSync } from '../durable-file'

interface Receipt { read: boolean; revision: number }
interface Document { schemaVersion: 1; revision: number; receipts: Record<string, Receipt> }
/** Reading a scheduled occurrence is independent of accepting its deliverable. */
export class RoutineInboxReadStore {
  private readonly path: string
  constructor(root: string) { this.path = join(root, 'routine-inbox-read-receipts.json') }
  read(): Document {
    let raw: string
    try { raw = readFileSync(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, revision: 0, receipts: {} }
      throw error
    }
    const value = JSON.parse(raw) as Document
    if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !value.receipts || typeof value.receipts !== 'object' || Array.isArray(value.receipts) ||
      Object.entries(value.receipts).some(([key, receipt]) => !/^[a-f0-9]{64}$/.test(key) || !receipt ||
        typeof receipt.read !== 'boolean' || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > value.revision)) {
      throw new Error('定时运行阅读记录无效，原文件已保留。')
    }
    return value
  }
  mark(keys: string[], read: boolean, observedRevision: number): void {
    const document = this.read(), revision = document.revision + 1
    let changed = false
    for (const key of new Set(keys)) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('运行来源版本无效。')
      const existing = document.receipts[key]
      if (existing && (existing.revision > observedRevision || existing.read === read)) continue
      document.receipts[key] = { read, revision }; changed = true
    }
    if (!changed) return
    document.revision = revision
    writeDurableFileSync(this.path, `${JSON.stringify(document)}\n`)
  }
}
