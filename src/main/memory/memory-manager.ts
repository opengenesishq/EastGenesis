import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeDurableFile } from '../durable-file'

export type MemoryLayer = 'working' | 'project' | 'user'

export interface LayeredMemoryEntry {
  id: string
  layer: MemoryLayer
  projectHash?: string
  title: string
  body: string
  source: string
  tags: string[]
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  archivedAt?: string
  vector: Record<string, number>
}

export interface MemoryWriteInput {
  layer: MemoryLayer
  projectRoot?: string
  title: string
  body: string
  source: string
  tags?: string[]
}

export interface MemoryUpdateInput {
  title?: string
  body?: string
  tags?: string[]
  archivedAt?: string | null
}

export interface MemorySearchInput {
  query: string
  projectRoot?: string
  layers?: MemoryLayer[]
  includeArchived?: boolean
  limit?: number
}

export interface MemorySearchHit {
  entry: LayeredMemoryEntry
  score: number
}

interface MemoryFile {
  version: 1
  entries: LayeredMemoryEntry[]
}

const STORE_FILE = 'memory-index.json'
const HASH_NAMESPACE = 'caogen-layered-memory-v1'

export function memoryProjectHash(projectRoot: string): string {
  return createHash('sha256').update(`${HASH_NAMESPACE}\0${path.resolve(projectRoot)}`).digest('hex')
}

export async function addMemory(rootDir: string, input: MemoryWriteInput): Promise<LayeredMemoryEntry> {
  const file = await readStore(rootDir)
  const now = new Date().toISOString()
  const entry: LayeredMemoryEntry = {
    id: randomUUID(),
    layer: input.layer,
    ...(input.projectRoot ? { projectHash: memoryProjectHash(input.projectRoot) } : {}),
    title: requireText(input.title, 'title'),
    body: requireText(input.body, 'body'),
    source: requireText(input.source, 'source'),
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    vector: vectorize(`${input.title}\n${input.body}\n${(input.tags ?? []).join(' ')}`)
  }
  file.entries.push(entry)
  await writeStore(rootDir, file.entries)
  return entry
}

export async function searchMemories(rootDir: string, input: MemorySearchInput): Promise<MemorySearchHit[]> {
  const file = await readStore(rootDir)
  const queryVector = vectorize(input.query)
  const layers = new Set(input.layers ?? ['working', 'project', 'user'])
  const projectHash = input.projectRoot ? memoryProjectHash(input.projectRoot) : undefined
  const limit = clampLimit(input.limit)
  const hits = file.entries
    .filter((entry) => layers.has(entry.layer))
    .filter((entry) => input.includeArchived || !entry.archivedAt)
    .filter((entry) => entry.layer === 'user' || !projectHash || entry.projectHash === projectHash)
    .map((entry) => ({ entry, score: cosine(queryVector, entry.vector) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, limit)

  if (hits.length > 0) await touchMemories(rootDir, hits.map((hit) => hit.entry.id))
  return hits
}

export async function listMemories(rootDir: string): Promise<LayeredMemoryEntry[]> {
  return (await readStore(rootDir)).entries
}

export async function deleteMemory(rootDir: string, entryId: string): Promise<boolean> {
  const file = await readStore(rootDir)
  const next = file.entries.filter((entry) => entry.id !== entryId)
  if (next.length === file.entries.length) return false
  await writeStore(rootDir, next)
  return true
}

export async function updateMemory(
  rootDir: string,
  entryId: string,
  patch: MemoryUpdateInput
): Promise<LayeredMemoryEntry | null> {
  const file = await readStore(rootDir)
  const index = file.entries.findIndex((entry) => entry.id === entryId)
  if (index === -1) return null
  const current = file.entries[index]
  const title = patch.title === undefined ? current.title : requireText(patch.title, 'title')
  const body = patch.body === undefined ? current.body : requireText(patch.body, 'body')
  const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags)
  const next: LayeredMemoryEntry = {
    ...current,
    title,
    body,
    tags,
    updatedAt: new Date().toISOString(),
    vector: vectorize(`${title}\n${body}\n${tags.join(' ')}`)
  }
  if (patch.archivedAt !== undefined) {
    if (patch.archivedAt === null || patch.archivedAt.trim() === '') delete next.archivedAt
    else next.archivedAt = patch.archivedAt
  }
  file.entries[index] = next
  await writeStore(rootDir, file.entries)
  return next
}

export async function archiveStaleMemories(rootDir: string, olderThanDays = 90, now = Date.now()): Promise<number> {
  const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000
  const file = await readStore(rootDir)
  let archived = 0
  const next = file.entries.map((entry) => {
    if (entry.archivedAt) return entry
    const lastUsed = Date.parse(entry.lastUsedAt)
    if (!Number.isFinite(lastUsed) || lastUsed >= cutoff) return entry
    archived++
    return { ...entry, archivedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }
  })
  if (archived > 0) await writeStore(rootDir, next)
  return archived
}

export async function exportMemories(rootDir: string): Promise<string> {
  const entries = await listMemories(rootDir)
  return JSON.stringify({ version: 1, entries }, null, 2)
}

async function touchMemories(rootDir: string, ids: string[]): Promise<void> {
  const wanted = new Set(ids)
  const file = await readStore(rootDir)
  const now = new Date().toISOString()
  const next = file.entries.map((entry) => (wanted.has(entry.id) ? { ...entry, lastUsedAt: now } : entry))
  await writeStore(rootDir, next)
}

async function readStore(rootDir: string): Promise<MemoryFile> {
  const filePath = storePath(rootDir)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return normalizeStore(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] }
    throw new Error(`Memory store is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeStore(rootDir: string, entries: LayeredMemoryEntry[]): Promise<void> {
  const filePath = storePath(rootDir)
  await writeDurableFile(filePath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
}

function normalizeStore(value: unknown): MemoryFile {
  if (!isRecord(value) || !Array.isArray(value.entries)) return { version: 1, entries: [] }
  return {
    version: 1,
    entries: value.entries.filter(isMemoryEntry)
  }
}

function isMemoryEntry(value: unknown): value is LayeredMemoryEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.layer === 'working' || value.layer === 'project' || value.layer === 'user') &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    typeof value.source === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    isRecord(value.vector)
  )
}

export function vectorize(text: string): Record<string, number> {
  const tokens = tokenize(text)
  const vector: Record<string, number> = {}
  for (const token of tokens) vector[token] = (vector[token] ?? 0) + 1
  const length = Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0)) || 1
  for (const key of Object.keys(vector)) vector[key] = Number((vector[key] / length).toFixed(6))
  return vector
}

function normalizeTags(value: string[]): string[] {
  if (!Array.isArray(value)) throw new Error('tags 必须是字符串数组')
  return [...new Set(value.map((tag) => requireText(tag, 'tag')).filter(Boolean))].slice(0, 20)
}

export function cosine(left: Record<string, number>, right: Record<string, number>): number {
  let score = 0
  const keys = Object.keys(left)
  for (const key of keys) score += (left[key] ?? 0) * (right[key] ?? 0)
  return Number(score.toFixed(6))
}

function tokenize(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!normalized) return []
  const words = normalized.split(/\s+/).filter((token) => token.length > 1)
  const chinese = Array.from(normalized.matchAll(/[\u4e00-\u9fa5]{2,}/g)).flatMap((match) => {
    const text = match[0]
    const out: string[] = []
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i + size <= text.length; i++) out.push(text.slice(i, i + size))
    }
    return out
  })
  return [...words, ...chinese]
}

function storePath(rootDir: string): string {
  return path.join(path.resolve(requireText(rootDir, 'rootDir')), STORE_FILE)
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  if (value.includes('\0')) throw new Error(`${field} 包含非法字符`)
  return value.trim()
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 8
  return Math.max(1, Math.min(50, Math.floor(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
