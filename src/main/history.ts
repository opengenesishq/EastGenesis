import { app } from 'electron'
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
import type { HistoryEntry } from '../shared/types'
import {
  HistoryStoreFormatError,
  historyEntriesFromDocument,
  historyStoreDocument
} from './history-store-format'
import { normalizeTaskStrategy } from './task/task-strategy'
import { migrateLegacyEngineRecord } from './native-engine-migration'

const MAX_ENTRIES = 100

let cache: HistoryEntry[] | null = null

function historyFile(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

export function listHistory(): HistoryEntry[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(historyFile(), 'utf8')) as unknown
    cache = historyEntriesFromDocument<HistoryEntry>(raw).map(normalizeHistoryEntry)
  } catch (error) {
    if (error instanceof HistoryStoreFormatError) throw error
    cache = []
  }
  return cache
}

function normalizeHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...migrateLegacyHistoryEngine(entry),
    taskStrategy: normalizeTaskStrategy(entry.taskStrategy)
  }
}

function migrateLegacyHistoryEngine(entry: HistoryEntry): HistoryEntry {
  return migrateLegacyEngineRecord(entry as HistoryEntry & { engine?: string }) as HistoryEntry
}

function persist(next: HistoryEntry[]): void {
  const file = historyFile()
  const directory = dirname(file)
  const temporary = join(directory, `.sessions.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(historyStoreDocument(next), null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    syncHistoryStoreDirectory(directory)
  } catch (err) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* canonical History Store remains authoritative */ }
    }
    console.error('[agent-desk] 保存会话历史失败:', err)
    throw err
  }
  cache = next
}

function truncate(list: HistoryEntry[]): HistoryEntry[] {
  if (list.length <= MAX_ENTRIES) return list
  const kept: HistoryEntry[] = []
  const normal: HistoryEntry[] = []
  for (const entry of list) {
    if (entry.pinned || entry.archived) kept.push(entry)
    else normal.push(entry)
  }
  return [...kept, ...normal].slice(0, Math.max(MAX_ENTRIES, kept.length))
}

export function upsertHistory(entry: HistoryEntry): void {
  const current = listHistory()
  const prev = current.find((e) => e.id === entry.id || e.sdkSessionId === entry.sdkSessionId)
  if (prev?.digitalWorkerBinding && (!entry.digitalWorkerBinding ||
    JSON.stringify(prev.digitalWorkerBinding) !== JSON.stringify(entry.digitalWorkerBinding))) {
    throw new Error(`Session ${entry.id} DigitalWorker identity binding is immutable`)
  }
  // 恢复的会话是新 id + 同一 sdkSessionId,两个维度都要去重,否则同一对话反复出现
  const list = current.filter(
    (e) => e.id !== entry.id && e.sdkSessionId !== entry.sdkSessionId
  )
  list.unshift({ ...entry, archived: entry.archived ?? prev?.archived, pinned: entry.pinned ?? prev?.pinned })
  persist(truncate(list))
}

export function setHistoryArchived(id: string, archived: boolean): void {
  const current = listHistory()
  if (!current.some((entry) => entry.id === id)) return
  persist(current.map((entry) => entry.id === id ? { ...entry, archived } : entry))
}

export function setHistoryPinned(id: string, pinned: boolean): void {
  const current = listHistory()
  if (!current.some((entry) => entry.id === id)) return
  persist(current.map((entry) => entry.id === id ? { ...entry, pinned } : entry))
}

export function renameHistory(id: string, title: string): void {
  const current = listHistory()
  const item = current.find((entry) => entry.id === id)
  const nextTitle = title.trim()
  if (!item || !nextTitle) return
  persist(current.map((entry) => entry.id === id ? { ...entry, title: nextTitle } : entry))
}

export function deleteHistory(id: string): void {
  persist(listHistory().filter((entry) => entry.id !== id))
}

export function invalidateHistoryCache(): void {
  cache = null
}

function syncHistoryStoreDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // The file is fsynced; some filesystems reject directory fsync.
  }
}
