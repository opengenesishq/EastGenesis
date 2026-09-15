import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export interface OwnedSubmissionReceipt {
  path: string
  sessionId: string
  projectId?: string
  kind: 'sessionInputs' | 'projectGoalSubmissions'
}

/** Validated regular-file inventory; callers must additionally validate the full portable schema. */
export function listProjectSubmissionReceiptFiles(root: string, projectId: string, sessionIds: ReadonlySet<string>): OwnedSubmissionReceipt[] {
  return projectReceipts(root, projectId, sessionIds)
}

/** Main-process send/recovery gate. Importing an outbox never authorizes replay of an uncertain send. */
export function unresolvedImportedSessionInputReason(root: string, sessionId: string): string | undefined {
  const directory = join(resolve(root), 'private', 'session-inputs', sha256(requiredId(sessionId)))
  for (const file of entries(root, directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
    const record = readRecord(root, join(directory, file))
    if (record.sessionId !== sessionId || typeof record.id !== 'string' || file !== `${sha256(record.id)}.json`) {
      throw new Error('Imported Session input receipt identity mismatch')
    }
    if (record.importedPayloadDigest !== undefined && (record.phase === 'dispatching' || record.phase === 'needs_reconciliation')) {
      return '导入任务有提交结果尚未确认的补充要求；请先核对接收记录，已阻止自动续跑和重复提交。'
    }
  }
  return undefined
}

/** These private recovery files follow their existing Session/Project deletion authority. */
export function listProjectSubmissionSessionIds(root: string, projectId: string): string[] {
  return [...new Set(readReceipts(root).filter((record) => record.projectId === projectId).map((record) => record.sessionId))].sort()
}

export function purgeProjectSubmissionReceipts(root: string, projectId: string, sessionIds: ReadonlySet<string>): string[] {
  return removeReceipts(root, projectReceipts(root, projectId, sessionIds))
}

export function purgeSessionSubmissionReceipts(root: string, sessionId: string): string[] {
  return removeReceipts(root, readReceipts(root).filter((record) => record.sessionId === sessionId))
}

export function countProjectSubmissionReceipts(root: string, projectId: string, sessionIds: ReadonlySet<string>): Record<string, number> {
  return counts(projectReceipts(root, projectId, sessionIds))
}

export function countSessionSubmissionReceipts(root: string, sessionId: string): Record<string, number> {
  return counts(readReceipts(root).filter((record) => record.sessionId === sessionId))
}

function projectReceipts(root: string, projectId: string, sessionIds: ReadonlySet<string>): OwnedSubmissionReceipt[] {
  return readReceipts(root).filter((record) => {
    if (record.projectId === projectId) return true
    if (!sessionIds.has(record.sessionId)) return false
    if (record.projectId) throw new Error('Submission receipt belongs to another Project')
    return true
  })
}

function counts(records: readonly OwnedSubmissionReceipt[]): Record<string, number> {
  return { sessionInputs: records.filter((record) => record.kind === 'sessionInputs').length,
    projectGoalSubmissions: records.filter((record) => record.kind === 'projectGoalSubmissions').length }
}

function readReceipts(rootDir: string): OwnedSubmissionReceipt[] {
  const root = resolve(rootDir)
  const records: OwnedSubmissionReceipt[] = []
  const inputRoot = join(root, 'private', 'session-inputs')
  for (const folder of entries(root, inputRoot)) {
    if (!/^[a-f0-9]{64}$/.test(folder)) throw new Error('Invalid private Session input directory')
    const directory = join(inputRoot, folder)
    for (const file of entries(root, directory)) {
      const published = publishedName(file)
      if (!/^[a-f0-9]{64}\.json$/.test(published)) throw new Error('Invalid private Session input filename')
      const path = join(directory, file)
      const record = readRecord(root, path)
      const sessionId = requiredId(record.sessionId)
      const id = requiredId(record.id)
      if (record.schemaVersion !== 1 || sha256(sessionId) !== folder || `${sha256(id)}.json` !== published ||
          record.messageId !== `session-input:${sessionId}:${id}`) throw new Error('Session input receipt identity mismatch')
      records.push({ path, sessionId, projectId: optionalId(record.workspaceId), kind: 'sessionInputs' })
    }
  }
  const goalRoot = join(root, 'private', 'project-goal-submissions')
  for (const file of entries(root, goalRoot)) {
    const published = publishedName(file)
    if (!/^goal-[a-f0-9]{24}\.json$/.test(published)) throw new Error('Invalid Project submission filename')
    const path = join(goalRoot, file)
    const record = readRecord(root, path)
    if (!isRecord(record.input)) throw new Error('Invalid Project submission input')
    const projectId = requiredId(record.input.projectId)
    const requestId = requiredId(record.input.requestId)
    const sessionId = requiredId(record.sessionId)
    const expected = `goal-${sha256(`caogen.project-goal-task.v1\0${projectId}\0${requestId}`).slice(0, 24)}.json`
    if (record.schemaVersion !== 1 || published !== expected) throw new Error('Project submission receipt identity mismatch')
    records.push({ path, sessionId, projectId, kind: 'projectGoalSubmissions' })
  }
  return records
}

function removeReceipts(root: string, records: readonly OwnedSubmissionReceipt[]): string[] {
  // Ownership and regular-file checks for the whole slice complete before removal.
  for (const record of records) assertRegularPath(root, record.path, false)
  for (const record of records) unlinkSync(record.path)
  for (const directory of new Set(records.filter((record) => record.kind === 'sessionInputs').map((record) => dirname(record.path)))) {
    if (readdirSync(directory).length === 0) rmdirSync(directory)
  }
  return records.map((record) => record.path).sort()
}

function entries(root: string, path: string): string[] {
  if (!assertRegularPath(root, path, true)) return []
  return readdirSync(path).sort()
}

function readRecord(root: string, path: string): Record<string, unknown> {
  assertRegularPath(root, path, false)
  const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(record)) throw new Error('Private submission receipt is invalid')
  return record
}

/** Validate every component, so a symlink in a parent cannot redirect a purge. */
function assertRegularPath(rootInput: string, pathInput: string, directory: boolean): boolean {
  const root = resolve(rootInput), path = resolve(pathInput)
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..')) throw new Error('Submission receipt escapes application data')
  let current = root
  const parts = rel.split(/[/\\]/)
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(current) } catch (error) {
      if (directory && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    const expectDirectory = index < parts.length - 1 || directory
    if (stat.isSymbolicLink() || (expectDirectory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Private submission receipt path is not regular application data')
    }
  }
  return true
}

function publishedName(file: string): string {
  // A crash may leave an unpublished durable-file temporary containing the same private payload.
  return file.replace(/^\.(.+\.json)\.\d+\.[a-f0-9-]{36}\.tmp$/, '$1')
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('Private submission receipt owner identity is invalid')
  }
  return value
}
function optionalId(value: unknown): string | undefined { return value === undefined ? undefined : requiredId(value) }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
