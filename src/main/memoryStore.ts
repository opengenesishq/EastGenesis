import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { LearningActor, LearningRecord, MemoryLearningPayload } from '../shared/learning-types'
import {
  approveLearningDraft,
  createLearningDraft,
  deleteLearningRecord,
  getLearningRecord,
  listLearningProject
} from './learning/learning-lifecycle'
import { requireTrustedUserLearningActor, type TrustedLearningDecision } from './learning/learning-security'
import { learningProjectHash } from './learning/learning-store'
import { projectLearningNamespace } from './project-aggregate/project-memory-adapter'
import { writeDurableFile } from './durable-file'

export interface ProjectMemoryEntry {
  id: string
  kind: string
  title: string
  body: string
  source: string
  reason: string
  createdAt: string
  updatedAt: string
  version?: number
  supersedes?: string
  digest?: string
}

const LEGACY_MEMORY_ENTRY_SCHEMA_VERSION = 1 as const
const LEGACY_MEMORY_ENTRY_FORMAT = 'caogen.project-memory-entry.v1' as const

export interface ProjectMemoryDraft extends ProjectMemoryEntry {
  status: 'draft'
}

export interface ProjectMemoryDraftInput {
  kind: string
  title: string
  body: string
  source: string
  reason: string
  supersedes?: string
}

export interface ReadProjectMemoryResult {
  projectHash: string
  markdown: string
  entries: ProjectMemoryEntry[]
  drafts: ProjectMemoryDraft[]
}

export interface DeleteMemoryEntryResult {
  id: string
  deleted: boolean
  deletedFrom: Array<'confirmed' | 'drafts'>
}

export interface ProjectMemoryProposalContext {
  actor?: LearningActor
  confidence?: number
  supersedes?: string
}

export interface ProjectMemoryTarget {
  /** Legacy execution path retained for migration and path-bucket compatibility. */
  projectRoot: string
  /** Canonical ProjectWorkspace identity. New Learning records use this when present. */
  projectId?: string
  /** Explicit compatibility/migration view; canonical runtime reads do not inherit a shared cwd. */
  includeLegacyPathMemory?: boolean
}

export type ProjectMemoryTargetInput = string | ProjectMemoryTarget

interface ResolvedProjectMemoryTarget {
  projectRoot: string
  learningProjectRoot: string
  projectHash: string
  legacyProjectHash: string
  includeLegacyPathMemory: boolean
}

type MemoryBucket = 'confirmed' | 'drafts'

const HASH_NAMESPACE = 'agent-desk-project-memory-v1'
const JSON_INDENT = 2

export function projectHash(projectRoot: string): string {
  return learningProjectHash(projectRoot)
}

export async function readProjectMemory(
  project: ProjectMemoryTargetInput,
  memoryRoot: string
): Promise<ReadProjectMemoryResult> {
  const root = normalizeMemoryRoot(memoryRoot)
  const target = resolveProjectMemoryTarget(project)
  const projectDir = projectMemoryDir(root, target.legacyProjectHash)
  const learningRoot = learningRootForMemoryRoot(root)
  const [learningProjects, legacyEntries, legacyDrafts] = await Promise.all([
    Promise.all(memoryLearningRoots(target).map((projectRoot) => listLearningProject(projectRoot, learningRoot))),
    target.includeLegacyPathMemory ? readBucket<ProjectMemoryEntry>(path.join(projectDir, 'confirmed'), 'confirmed') : [],
    target.includeLegacyPathMemory ? readBucket<ProjectMemoryDraft>(path.join(projectDir, 'drafts'), 'drafts') : []
  ])
  const entries = mergeById(
    learningProjects.flatMap((learning) => learning.active.filter(isProjectMemoryRecord).map(memoryEntryFromRecord)),
    legacyEntries
  )
  const drafts = mergeById(
    learningProjects.flatMap((learning) => learning.drafts.filter(isProjectMemoryRecord).map(memoryDraftFromRecord)),
    legacyDrafts
  )

  return {
    projectHash: target.projectHash,
    markdown: renderPromptMarkdown(entries),
    entries,
    drafts
  }
}

export async function proposeMemoryDraft(
  project: ProjectMemoryTargetInput,
  memoryRoot: string,
  input: ProjectMemoryDraftInput,
  context: ProjectMemoryProposalContext = {}
): Promise<ProjectMemoryDraft> {
  const root = normalizeMemoryRoot(memoryRoot)
  const target = resolveProjectMemoryTarget(project)
  const record = await createLearningDraft(
    target.learningProjectRoot,
    learningRootForMemoryRoot(root), {
      kind: 'memory',
      source: normalizeRequiredText(input.source, 'source'),
      confidence: context.confidence,
      supersedes: context.supersedes ?? input.supersedes,
      payload: {
        type: 'memory',
        memoryKind: normalizeRequiredText(input.kind, 'kind'),
        title: normalizeRequiredText(input.title, 'title'),
        body: normalizeRequiredText(input.body, 'body'),
        reason: input.reason?.trim() || '用户提出的项目记忆'
      }
    }, { actor: context.actor })
  if (!isMemoryRecord(record)) throw new Error('Created learning draft is not a Memory record')
  return memoryDraftFromRecord(record)
}

export async function acceptMemoryDraft(
  project: ProjectMemoryTargetInput,
  memoryRoot: string,
  draftId: string,
  authority?: TrustedLearningDecision
): Promise<ProjectMemoryEntry> {
  requireTrustedUserLearningActor(authority)
  const id = safeEntryId(draftId)
  const root = normalizeMemoryRoot(memoryRoot)
  const target = resolveProjectMemoryTarget(project)
  const projectDir = projectMemoryDir(root, target.legacyProjectHash)
  const learningRoot = learningRootForMemoryRoot(root)
  let recordRoot = target.learningProjectRoot
  let record = await getLearningRecord(recordRoot, learningRoot, id)
  if (!record && target.includeLegacyPathMemory && recordRoot !== target.projectRoot) {
    recordRoot = target.projectRoot
    record = await getLearningRecord(recordRoot, learningRoot, id)
  }
  if (!record) {
    if (!target.includeLegacyPathMemory) throw new Error('项目记忆草稿不存在')
    const draftPath = entryJsonPath(projectDir, 'drafts', id)
    const draft = parseDraft(await readFile(draftPath, 'utf8'), draftPath).entry
    recordRoot = target.learningProjectRoot
    record = await createLearningDraft(recordRoot, learningRoot, {
      kind: 'memory',
      source: draft.source,
      confidence: 1,
      payload: {
        type: 'memory',
        memoryKind: draft.kind,
        title: draft.title,
        body: draft.body,
        reason: draft.reason
      }
    }, {
      actor: { type: 'system', id: 'legacy-memory-migration', source: 'memoryStore.accept' },
      requestedId: draft.id,
      requestedLogicalId: draft.id
    })
  }
  if (!isMemoryRecord(record)) throw new Error('Learning draft is not a Memory record')
  const accepted = await approveLearningDraft(recordRoot, learningRoot, record.id, authority as TrustedLearningDecision)
  if (!isMemoryRecord(accepted)) throw new Error('Approved learning record is not a Memory record')
  if (target.includeLegacyPathMemory) await removeEntryFiles(projectDir, 'drafts', id)
  return memoryEntryFromRecord(accepted)
}

export async function deleteMemoryEntry(
  project: ProjectMemoryTargetInput,
  memoryRoot: string,
  entryId: string,
  authority?: TrustedLearningDecision
): Promise<DeleteMemoryEntryResult> {
  requireTrustedUserLearningActor(authority)
  const id = safeEntryId(entryId)
  const root = normalizeMemoryRoot(memoryRoot)
  const target = resolveProjectMemoryTarget(project)
  const projectDir = projectMemoryDir(root, target.legacyProjectHash)
  const learningRoot = learningRootForMemoryRoot(root)
  const deletedFrom: Array<'confirmed' | 'drafts'> = []

  for (const projectRoot of memoryLearningRoots(target)) {
    const record = await getLearningRecord(projectRoot, learningRoot, id)
    if (!record) continue
    if (!isMemoryRecord(record)) throw new Error('Learning record is not a Memory record')
    if (record.status === 'draft') deletedFrom.push('drafts')
    else if (record.status === 'active') deletedFrom.push('confirmed')
    await deleteLearningRecord(projectRoot, learningRoot, id, authority as TrustedLearningDecision)
  }

  if (target.includeLegacyPathMemory) {
    if (await removeEntryFiles(projectDir, 'confirmed', id) && !deletedFrom.includes('confirmed')) deletedFrom.push('confirmed')
    if (await removeEntryFiles(projectDir, 'drafts', id) && !deletedFrom.includes('drafts')) deletedFrom.push('drafts')
  }

  return {
    id,
    deleted: deletedFrom.length > 0,
    deletedFrom
  }
}

function resolveProjectMemoryTarget(input: ProjectMemoryTargetInput): ResolvedProjectMemoryTarget {
  const candidate = typeof input === 'string' ? { projectRoot: input } : input
  if (!candidate || typeof candidate !== 'object') throw new Error('project memory target must be a path or object')
  const projectRoot = normalizeProjectRoot(candidate.projectRoot)
  const projectId = candidate.projectId === undefined
    ? undefined
    : normalizeRequiredText(candidate.projectId, 'projectId')
  const learningProjectRoot = projectId ? projectLearningNamespace(projectId) : projectRoot
  return {
    projectRoot,
    learningProjectRoot,
    projectHash: learningProjectHash(learningProjectRoot),
    legacyProjectHash: learningProjectHash(projectRoot),
    includeLegacyPathMemory: !projectId || candidate.includeLegacyPathMemory === true
  }
}

function memoryLearningRoots(target: ResolvedProjectMemoryTarget): string[] {
  return target.learningProjectRoot === target.projectRoot || !target.includeLegacyPathMemory
    ? [target.learningProjectRoot]
    : [target.learningProjectRoot, target.projectRoot]
}

function learningRootForMemoryRoot(memoryRoot: string): string {
  // Both stores belong to the profile selected by the caller, even when another
  // profile happens to be configured in the process environment.
  return path.join(path.dirname(memoryRoot), 'learning')
}

function isMemoryRecord(record: LearningRecord): record is LearningRecord & { payload: MemoryLearningPayload } {
  return record.kind === 'memory' && record.payload.type === 'memory'
}

function isProjectMemoryRecord(
  record: LearningRecord
): record is LearningRecord & { payload: MemoryLearningPayload } {
  return record.scope === 'project' && isMemoryRecord(record)
}

function memoryEntryFromRecord(record: LearningRecord & { payload: MemoryLearningPayload }): ProjectMemoryEntry {
  return {
    id: record.id,
    kind: record.payload.memoryKind,
    title: record.payload.title,
    body: record.payload.body,
    source: record.source,
    reason: record.payload.reason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    supersedes: record.supersedes,
    digest: record.digest
  }
}

function memoryDraftFromRecord(record: LearningRecord & { payload: MemoryLearningPayload }): ProjectMemoryDraft {
  if (record.status !== 'draft') throw new Error(`Memory learning record is not a draft: ${record.id}`)
  return { ...memoryEntryFromRecord(record), status: 'draft' }
}

function mergeById<T extends ProjectMemoryEntry>(primary: T[], fallback: T[]): T[] {
  const merged = new Map<string, T>()
  for (const item of fallback) merged.set(item.id, item)
  for (const item of primary) merged.set(item.id, item)
  return [...merged.values()].sort(compareEntries)
}

async function writeEntry(
  projectRoot: string,
  memoryRoot: string,
  bucket: MemoryBucket,
  entry: ProjectMemoryEntry | ProjectMemoryDraft
): Promise<void> {
  const root = normalizeMemoryRoot(memoryRoot)
  const hash = projectHash(projectRoot)
  const projectDir = projectMemoryDir(root, hash)
  const bucketDir = path.join(projectDir, bucket)

  await mkdir(bucketDir, { recursive: true })
  await atomicWriteText(entryJsonPath(projectDir, bucket, entry.id), `${JSON.stringify(storedMemoryEntry(entry), null, JSON_INDENT)}\n`)
  await atomicWriteText(entryMarkdownPath(projectDir, bucket, entry.id), renderEntryMarkdown(entry))
}

async function readBucket<T extends ProjectMemoryEntry | ProjectMemoryDraft>(
  bucketDir: string,
  bucket: MemoryBucket
): Promise<T[]> {
  const names = await readdir(bucketDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const jsonNames = names.filter((name) => name.endsWith('.json')).sort()
  const entries: T[] = []

  for (const name of jsonNames) {
    const id = safeEntryId(name.slice(0, -'.json'.length))
    const filePath = path.join(bucketDir, `${id}.json`)
    const raw = await readFile(filePath, 'utf8')
    const parsed = bucket === 'drafts' ? parseDraft(raw, filePath) : parseConfirmed(raw, filePath)
    entries.push(parsed.entry as T)
    if (parsed.legacy) {
      await atomicWriteText(filePath, `${JSON.stringify(storedMemoryEntry(parsed.entry), null, JSON_INDENT)}\n`)
    }
  }

  return entries.sort(compareEntries)
}

function parseConfirmed(raw: string, filePath: string): { entry: ProjectMemoryEntry; legacy: boolean } {
  const value = parseJsonObject(raw, filePath)
  const legacy = legacyMemoryDocument(value)
  const record = memoryEntryRecord(value, filePath, legacy)
  const entry: ProjectMemoryEntry = {
    id: readString(record, 'id', filePath),
    kind: readString(record, 'kind', filePath),
    title: readString(record, 'title', filePath),
    body: readString(record, 'body', filePath),
    source: readString(record, 'source', filePath),
    reason: readString(record, 'reason', filePath),
    createdAt: readString(record, 'createdAt', filePath),
    updatedAt: readString(record, 'updatedAt', filePath)
  }
  safeEntryId(entry.id)
  return { entry, legacy }
}

function parseDraft(raw: string, filePath: string): { entry: ProjectMemoryDraft; legacy: boolean } {
  const value = parseJsonObject(raw, filePath)
  const legacy = legacyMemoryDocument(value)
  const record = memoryEntryRecord(value, filePath, legacy)
  const status = readString(record, 'status', filePath)
  if (status !== 'draft') throw new Error(`记忆草稿状态无效: ${filePath}`)

  return {
    entry: {
      ...parseConfirmed(raw, filePath).entry,
      status
    },
    legacy
  }
}

function legacyMemoryDocument(value: Record<string, unknown>): boolean {
  return !Object.prototype.hasOwnProperty.call(value, 'schemaVersion') &&
    !Object.prototype.hasOwnProperty.call(value, 'format') &&
    Object.prototype.hasOwnProperty.call(value, 'id')
}

function memoryEntryRecord(
  value: Record<string, unknown>,
  filePath: string,
  legacy: boolean
): Record<string, unknown> {
  if (legacy) return value
  if (value.schemaVersion !== LEGACY_MEMORY_ENTRY_SCHEMA_VERSION || value.format !== LEGACY_MEMORY_ENTRY_FORMAT) {
    throw new Error(`不支持的记忆 schema 版本或格式: ${filePath}`)
  }
  const { schemaVersion: _schemaVersion, format: _format, ...entry } = value
  return entry
}

function storedMemoryEntry(entry: ProjectMemoryEntry | ProjectMemoryDraft): Record<string, unknown> {
  return {
    schemaVersion: LEGACY_MEMORY_ENTRY_SCHEMA_VERSION,
    format: LEGACY_MEMORY_ENTRY_FORMAT,
    ...entry
  }
}

function parseJsonObject(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`记忆 JSON 无法解析: ${filePath}: ${errorMessage(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`记忆 JSON 必须是对象: ${filePath}`)
  }
  return parsed as Record<string, unknown>
}

function readString(value: Record<string, unknown>, key: string, filePath: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error(`记忆字段 ${key} 必须是非空字符串: ${filePath}`)
  }
  return field
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await writeDurableFile(filePath, content)
}

async function removeEntryFiles(projectDir: string, bucket: MemoryBucket, id: string): Promise<boolean> {
  const results = await Promise.all([
    removeIfExists(entryJsonPath(projectDir, bucket, id)),
    removeIfExists(entryMarkdownPath(projectDir, bucket, id))
  ])
  return results.some(Boolean)
}

async function removeIfExists(filePath: string): Promise<boolean> {
  try {
    await rm(filePath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function renderPromptMarkdown(entries: ProjectMemoryEntry[]): string {
  if (entries.length === 0) return ''

  const blocks = entries.map((entry) => {
    const meta = [
      `- Kind: ${entry.kind}`,
      `- Source: ${entry.source}`,
      `- Reason: ${entry.reason}`,
      `- Updated: ${entry.updatedAt}`
    ].join('\n')

    return `### ${entry.title}\n${meta}\n\n${entry.body}`
  })

  return `## Project Memory\n\nConfirmed project memories for this workspace:\n\n${blocks.join('\n\n')}\n`
}

function renderEntryMarkdown(entry: ProjectMemoryEntry | ProjectMemoryDraft): string {
  const statusLine = 'status' in entry ? `- Status: ${entry.status}\n` : ''
  return `# ${entry.title}

${statusLine}- Kind: ${entry.kind}
- Source: ${entry.source}
- Reason: ${entry.reason}
- Created: ${entry.createdAt}
- Updated: ${entry.updatedAt}

${entry.body}
`
}

function compareEntries(a: ProjectMemoryEntry, b: ProjectMemoryEntry): number {
  const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
  if (byUpdated !== 0) return byUpdated
  const byTitle = a.title.localeCompare(b.title)
  if (byTitle !== 0) return byTitle
  return a.id.localeCompare(b.id)
}

function normalizeProjectRoot(projectRoot: string): string {
  const normalized = normalizeRequiredText(projectRoot, 'projectRoot')
  if (normalized.includes('\0')) throw new Error('projectRoot 包含非法字符')
  return path.resolve(normalized)
}

function normalizeMemoryRoot(memoryRoot: string): string {
  const normalized = normalizeRequiredText(memoryRoot, 'memoryRoot')
  if (normalized.includes('\0')) throw new Error('memoryRoot 包含非法字符')
  return path.resolve(normalized)
}

function normalizeRequiredText(value: string, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} 不能为空`)
  return normalized
}

function safeEntryId(id: string): string {
  const normalized = normalizeRequiredText(id, 'entryId')
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) throw new Error('entryId 包含非法字符')
  return normalized
}

function projectMemoryDir(memoryRoot: string, hash: string): string {
  return path.join(memoryRoot, 'projects', hash)
}

function entryJsonPath(projectDir: string, bucket: MemoryBucket, id: string): string {
  return path.join(projectDir, bucket, `${safeEntryId(id)}.json`)
}

function entryMarkdownPath(projectDir: string, bucket: MemoryBucket, id: string): string {
  return path.join(projectDir, bucket, `${safeEntryId(id)}.md`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
