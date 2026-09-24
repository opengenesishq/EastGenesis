import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerHistoryPolicy, ComputerHistoryRecord } from '../../shared/computer-history-types'
import { DEFAULT_HISTORY_POLICY, isBundleId, isExcludedBundleId, isRecord } from './policy'

interface HistoryDocument { schemaVersion: 1; policy: ComputerHistoryPolicy; records: ComputerHistoryRecord[] }
const MAX_RECORDS = 5_000
const MAX_BYTES = 12 * 1024 * 1024

/** One main-process owner. No copies, text indexes, screenshots, or model uploads. */
export class ComputerHistoryStore {
  private document: HistoryDocument
  private readonly file: string
  constructor(private readonly directory: string) {
    this.file = join(directory, 'history.json')
    this.assertPaths()
    if (!existsSync(this.file)) this.document = { schemaVersion: 1, policy: structuredClone(DEFAULT_HISTORY_POLICY), records: [] }
    else {
      if (lstatSync(this.file).size > MAX_BYTES) throw new Error('电脑历史存储超出支持大小，已停止采集。')
      this.document = parseDocument(JSON.parse(readFileSync(this.file, 'utf8')))
    }
  }
  policy(): ComputerHistoryPolicy { return structuredClone(this.document.policy) }
  records(): ComputerHistoryRecord[] { return this.document.records.map(row => ({ ...row })) }
  setPolicy(policy: ComputerHistoryPolicy, now: number): void {
    this.write({ ...this.document, policy: structuredClone(policy), records: this.retained(now, policy.retentionDays) })
  }
  prune(now: number): void {
    const records = this.retained(now, this.document.policy.retentionDays)
    if (records.length !== this.document.records.length) this.write({ ...this.document, records })
  }
  append(record: ComputerHistoryRecord, now: number): void {
    this.write({ ...this.document, records: [...this.retained(now, this.document.policy.retentionDays), { ...record }].slice(-MAX_RECORDS) })
  }
  delete(ids: ReadonlySet<string>): number {
    const records = this.document.records.filter(row => !ids.has(row.id)), deleted = this.document.records.length - records.length
    if (deleted) this.write({ ...this.document, records })
    return deleted
  }
  private retained(now: number, days: number): ComputerHistoryRecord[] { return this.document.records.filter(row => row.capturedAt >= now - days * 86_400_000).slice(-MAX_RECORDS) }
  private assertPaths(): void {
    if (existsSync(this.directory) && (lstatSync(this.directory).isSymbolicLink() || !lstatSync(this.directory).isDirectory())) throw new Error('电脑历史目录必须是本地真实目录。')
    if (existsSync(this.file) && (lstatSync(this.file).isSymbolicLink() || !lstatSync(this.file).isFile())) throw new Error('电脑历史文件不可使用符号链接。')
  }
  private write(next: HistoryDocument): void {
    this.assertPaths()
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temp = join(this.directory, `.history-${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(next), 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temp, this.file)
      this.document = next
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
}

function parseDocument(raw: unknown): HistoryDocument {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.policy) || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) throw new Error('电脑历史存储无效，已停止采集。')
  const p = raw.policy
  if (typeof p.enabled !== 'boolean' || typeof p.paused !== 'boolean' || ![7, 30, 90].includes(Number(p.retentionDays)) || typeof p.retentionDays !== 'number' ||
      !Number.isSafeInteger(p.revision) || Number(p.revision) < 0 || !Array.isArray(p.allowedApps) || p.allowedApps.length > 100 ||
      !p.allowedApps.every(item => isRecord(item) && isBundleId(item.bundleId) && !isExcludedBundleId(item.bundleId) && typeof item.name === 'string' && item.name.length <= 160) ||
      (p.enabled && p.allowedApps.length === 0)) throw new Error('电脑历史策略无效，已停止采集。')
  if (!raw.records.every(row => isRecord(row) && typeof row.id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(row.id) &&
      Number.isSafeInteger(row.capturedAt) && Number(row.capturedAt) >= 0 && isBundleId(row.bundleId) && typeof row.appName === 'string' && row.appName.length <= 160 &&
      typeof row.title === 'string' && row.title.length <= 600)) throw new Error('电脑历史记录无效，已停止采集。')
  return { schemaVersion: 1, policy: { enabled: p.enabled, paused: p.paused, retentionDays: p.retentionDays as 7 | 30 | 90, revision: Number(p.revision),
    allowedApps: p.allowedApps.map(item => ({ bundleId: item.bundleId as string, name: item.name as string })) },
    records: raw.records.map(row => ({ id: row.id as string, capturedAt: Number(row.capturedAt), bundleId: row.bundleId as string, appName: row.appName as string, title: row.title as string })) }
}
