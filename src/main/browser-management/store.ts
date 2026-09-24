import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserDownloadRecord, BrowserHistoryQuery, BrowserHistoryRecord, BrowserManagementEvent, BrowserPreferences, BrowserPreferencesSnapshot } from '../../shared/browser-preferences-types'
import { writeDurableFileSync } from '../durable-file'
import { browserLogTitle, browserLogUrl, defaultBrowserPreferences, normalizeBrowserPreferences } from './preferences'

function readDocument(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('浏览器管理数据无法读取，请保留文件并修复后重试。') }
}
export class BrowserManagementStore {
  private preferences?: BrowserPreferencesSnapshot
  private history?: BrowserHistoryRecord[]
  private downloads?: BrowserDownloadRecord[]
  private revision = 0
  private readonly listeners = new Set<(event: BrowserManagementEvent) => void>()
  constructor(readonly root: string, private readonly defaultDownloadDirectory: string) {}
  subscribe(listener: (event: BrowserManagementEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  notify(kind: BrowserManagementEvent['kind'], contextId?: string): void { const event = { kind, contextId, revision: ++this.revision }; for (const listener of this.listeners) listener(event) }
  getPreferences(): BrowserPreferencesSnapshot {
    if (!this.preferences) {
      const raw = readDocument(join(this.root, 'preferences.json')) as BrowserPreferencesSnapshot | undefined
      if (raw && (!Number.isSafeInteger(raw.revision) || raw.revision < 0)) throw new Error('浏览器设置版本无效。')
      this.preferences = raw ? { revision: raw.revision, preferences: normalizeBrowserPreferences(raw.preferences) } : { revision: 0, preferences: defaultBrowserPreferences(this.defaultDownloadDirectory) }
    }
    return structuredClone(this.preferences)
  }
  savePreferences(expectedRevision: number, raw: BrowserPreferences): BrowserPreferencesSnapshot {
    if (expectedRevision !== this.getPreferences().revision) throw new Error('浏览器设置已被其他窗口修改，请重新载入。')
    const snapshot = { revision: expectedRevision + 1, preferences: normalizeBrowserPreferences(raw, true) }
    writeDurableFileSync(join(this.root, 'preferences.json'), JSON.stringify(snapshot))
    this.preferences = snapshot; this.pruneHistory(); this.notify('preferences'); return structuredClone(snapshot)
  }
  private readHistory(): BrowserHistoryRecord[] {
    if (!this.history) {
      const raw = readDocument(join(this.root, 'history.json'))
      if (raw !== undefined && !Array.isArray(raw)) throw new Error('浏览器历史格式无效。')
      this.history = ((raw ?? []) as BrowserHistoryRecord[]).filter(item => item && typeof item.id === 'string' && typeof item.url === 'string' && typeof item.contextId === 'string' && Number.isFinite(item.visitedAt)).slice(0, 5_000)
    }
    return this.history
  }
  private pruneHistory(): void {
    const records = this.readHistory(), cutoff = Date.now() - this.getPreferences().preferences.retentionDays * 86_400_000
    const next = records.filter(item => item.visitedAt >= cutoff).slice(0, 5_000)
    if (next.length !== records.length) { this.history = next; this.persistHistory(); this.notify('history') }
  }
  recordVisit(input: Omit<BrowserHistoryRecord, 'id' | 'visitedAt'>): void {
    if (!this.getPreferences().preferences.recordHistory) return
    const url = browserLogUrl(input.url)
    if (!/^https?:\/\//.test(url)) return
    const records = this.readHistory()
    const existing = records.find(item => item.tabId === input.tabId && item.contextEpoch === input.contextEpoch && item.navigationRevision === input.navigationRevision)
    if (existing) { existing.title = browserLogTitle(input.title); existing.url = url }
    else records.unshift({ ...input, url, title: browserLogTitle(input.title), id: randomUUID(), visitedAt: Math.max(Date.now(), (records[0]?.visitedAt ?? 0) + 1) })
    this.pruneHistory(); this.persistHistory(); this.notify('history', input.contextId)
  }
  updateTitle(tabId: string, contextEpoch: string, navigationRevision: number, title: string): void {
    if (!this.getPreferences().preferences.recordHistory) return
    const item = this.readHistory().find(value => value.tabId === tabId && value.contextEpoch === contextEpoch && value.navigationRevision === navigationRevision)
    if (item && item.title !== browserLogTitle(title)) { item.title = browserLogTitle(title); this.persistHistory(); this.notify('history', item.contextId) }
  }
  listHistory(query: BrowserHistoryQuery = {}): { items: BrowserHistoryRecord[]; nextBefore?: number } {
    this.pruneHistory()
    const text = (query.query ?? '').trim().toLocaleLowerCase(), limit = Math.min(200, Math.max(1, query.limit ?? 100))
    const results = this.readHistory().filter(item => (!query.contextId || item.contextId === query.contextId) &&
      (query.before === undefined || item.visitedAt < query.before) && (!text || `${item.url} ${item.title}`.toLocaleLowerCase().includes(text)))
    const items = results.slice(0, limit)
    return { items: structuredClone(items), ...(results.length > limit ? { nextBefore: items.at(-1)?.visitedAt } : {}) }
  }
  clearHistory(ids: string[]): number {
    const selected = new Set(ids), records = this.readHistory(), next = records.filter(item => !selected.has(item.id))
    this.history = next; this.persistHistory(); this.notify('history'); return records.length - next.length
  }
  private persistHistory(): void { writeDurableFileSync(join(this.root, 'history.json'), JSON.stringify(this.readHistory())) }
  listDownloads(contextId?: string): BrowserDownloadRecord[] {
    if (!this.downloads) {
      const raw = readDocument(join(this.root, 'downloads.json'))
      if (raw !== undefined && !Array.isArray(raw)) throw new Error('浏览器下载记录格式无效。')
      this.downloads = ((raw ?? []) as BrowserDownloadRecord[]).filter(item => item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id) && typeof item.contextId === 'string' && typeof item.filename === 'string').slice(0, 1_000).map(item =>
        ['progressing', 'awaiting-location'].includes(item.state) ? { ...item, state: 'interrupted', error: '应用重启，下载未完成。', updatedAt: Date.now() } : item)
    }
    return structuredClone(this.downloads.filter(item => !contextId || item.contextId === contextId))
  }
  putDownload(item: BrowserDownloadRecord, persist = true): void {
    this.listDownloads()
    const index = this.downloads!.findIndex(record => record.id === item.id)
    if (index >= 0) this.downloads![index] = structuredClone(item)
    else this.downloads!.unshift(structuredClone(item))
    this.downloads = this.downloads!.slice(0, 1_000)
    if (persist) this.persistDownloads()
    this.notify('downloads', item.contextId)
  }
  removeDownload(id: string): void { this.listDownloads(); this.downloads = this.downloads!.filter(item => item.id !== id); this.persistDownloads(); this.notify('downloads') }
  private persistDownloads(): void { writeDurableFileSync(join(this.root, 'downloads.json'), JSON.stringify(this.downloads ?? [])) }
}
