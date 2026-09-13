import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type {
  MutationOptions,
  ProjectWorkspaceEvent,
  ProjectWorkspaceState
} from '../../shared/project-workspace-types'
import { PROJECT_WORKSPACE_SCHEMA_VERSION } from '../../shared/project-workspace-types'
import { canonicalJson, clone, digest, redact } from './codec'
import { ProjectWorkspaceError } from './errors'

const STORE_FILE_NAME = 'project-workspace.json'
const LOCK_FILE_SUFFIX = '.lock'
const LOCK_WAIT_MS = 15
const LOCK_TIMEOUT_MS = 15_000
const LOCK_STALE_MS = 120_000

export const PROJECT_WORKSPACE_FORMAT = 'caogen.project-workspace.v1'

export function resolveProjectWorkspaceRoot(rootDir?: string): string {
  return rootDir || process.env.CAOGEN_USER_DATA || join(homedir(), '.caogen')
}

export function projectWorkspaceFile(rootDir?: string): string {
  return join(resolveProjectWorkspaceRoot(rootDir), STORE_FILE_NAME)
}

export function projectWorkspaceLockFile(rootDir?: string): string {
  return `${projectWorkspaceFile(rootDir)}${LOCK_FILE_SUFFIX}`
}

function emptyState(): ProjectWorkspaceState {
  return {
    schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    revision: 0,
    workspaces: [],
    goals: [],
    workItems: [],
    squads: [],
    members: [],
    invitations: [],
    comments: [],
    sharedApprovals: [],
    inboxReceipts: [],
    events: []
  }
}

function assertState(value: unknown): asserts value is ProjectWorkspaceState {
  if (!value || typeof value !== 'object') {
    throw new ProjectWorkspaceError('corrupt_store', 'project workspace store is not an object')
  }
  const candidate = value as Partial<ProjectWorkspaceState>
  if (candidate.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION) {
    throw new ProjectWorkspaceError(
      'unsupported_schema',
      `project workspace schema ${String(candidate.schemaVersion)} is not supported`
    )
  }
  if (!Number.isInteger(candidate.revision) || (candidate.revision as number) < 0) {
    throw new ProjectWorkspaceError('corrupt_store', 'project workspace store revision is invalid')
  }
  for (const field of ['workspaces', 'goals', 'workItems', 'events'] as const) {
    if (!Array.isArray(candidate[field])) {
      throw new ProjectWorkspaceError('corrupt_store', `project workspace store ${field} is invalid`)
    }
  }
  for (const field of ['squads', 'members', 'invitations', 'comments', 'sharedApprovals', 'inboxReceipts'] as const) {
    if (candidate[field] !== undefined && !Array.isArray(candidate[field])) {
      throw new ProjectWorkspaceError('corrupt_store', `project workspace store ${field} is invalid`)
    }
  }
}

export async function readProjectWorkspaceState(filePath: string): Promise<ProjectWorkspaceState> {
  try {
    return parseProjectWorkspaceState(await readFile(filePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyState()
    if (error instanceof ProjectWorkspaceError) throw error
    throw new ProjectWorkspaceError('corrupt_store', `cannot read project workspace store: ${String(error)}`)
  }
}

export function parseProjectWorkspaceState(raw: string): ProjectWorkspaceState {
  const value: unknown = JSON.parse(raw)
  assertState(value)
  return {
    ...value,
    squads: value.squads ?? [],
    members: value.members ?? [],
    invitations: value.invitations ?? [],
    comments: value.comments ?? [],
    sharedApprovals: value.sharedApprovals ?? [],
    inboxReceipts: value.inboxReceipts ?? []
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Directory fsync is not available on every filesystem.
  }
}

export async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let handle: FileHandle | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, filePath)
    await fsyncDirectory(dirname(filePath))
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function releaseLock(lockPath: string, lock: FileHandle, owner: string): Promise<void> {
  await lock.close().catch(() => undefined)
  const current = await readFile(lockPath, 'utf8').catch(() => undefined)
  if (current === owner) await unlink(lockPath).catch(() => undefined)
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath)
    const owner = await readFile(lockPath, 'utf8').catch(() => undefined)
    const pid = owner ? Number.parseInt(owner.split(':', 1)[0], 10) : Number.NaN
    const abandoned = Number.isSafeInteger(pid) && pid > 0
      ? !processIsAlive(pid)
      : Date.now() - lockStat.mtimeMs > LOCK_STALE_MS
    if (!abandoned) return
    const current = await readFile(lockPath, 'utf8').catch(() => undefined)
    if (current === owner) await unlink(lockPath)
  } catch {
    // A concurrent owner may release the lock between stat and unlink.
  }
}

async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EEXIST') return true
  if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) return false

  try {
    await stat(lockPath)
    return true
  } catch {
    // Windows can deny both exclusive create and stat while another handle is
    // closing or deleting the lock. Keep that transient inside the bounded loop.
    return true
  }
}

async function acquireLock(filePath: string): Promise<{ path: string; handle: FileHandle; owner: string }> {
  const lockPath = `${filePath}${LOCK_FILE_SUFFIX}`
  await mkdir(dirname(filePath), { recursive: true })
  const started = Date.now()
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      const owner = `${process.pid}:${randomUUID()}\n`
      await handle.writeFile(owner, 'utf8')
      await handle.sync()
      return { path: lockPath, handle, owner }
    } catch (error) {
      if (!(await isLockContention(error, lockPath))) throw error
      await removeStaleLock(lockPath)
      await sleep(LOCK_WAIT_MS)
    }
  }
  throw new ProjectWorkspaceError('lock_timeout', 'timed out waiting for project workspace store lock')
}

async function withFileLock<T>(filePath: string, callback: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(filePath)
  try {
    return await callback()
  } finally {
    await releaseLock(lock.path, lock.handle, lock.owner)
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function entityExpectedRevision(options: MutationOptions | number | undefined): number | undefined {
  return typeof options === 'number' ? options : options?.expectedRevision
}

export function storeExpectedRevision(options: MutationOptions | number | undefined): number | undefined {
  if (typeof options === 'number') return options
  return options?.expectedStoreRevision ?? options?.expectedRevision
}

export function appendEvent(
  state: ProjectWorkspaceState,
  projectId: string,
  entityType: ProjectWorkspaceEvent['entityType'],
  entityId: string,
  kind: string,
  revision: number,
  payload: Record<string, unknown>,
  occurredAt: number
): void {
  state.events.push({
    schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    id: randomUUID(),
    projectId,
    entityType,
    entityId,
    kind,
    revision,
    occurredAt,
    payload: redact(clone(payload)) as Record<string, unknown>
  })
}

export interface MutationContext {
  state: ProjectWorkspaceState
  commitRevision: number
  now: number
}

export interface ProjectWorkspaceMutationCommit<T = unknown> {
  before: ProjectWorkspaceState
  after: ProjectWorkspaceState
  result: T
}

export type ProjectWorkspaceBeforeCommit = (mutation: ProjectWorkspaceMutationCommit) => Promise<void>

export class ProjectWorkspacePersistence {
  readonly rootDir: string
  readonly filePath: string
  private readonly beforeCommit = new AsyncLocalStorage<ProjectWorkspaceBeforeCommit>()

  constructor(rootDir?: string) {
    this.rootDir = resolveProjectWorkspaceRoot(rootDir)
    this.filePath = projectWorkspaceFile(this.rootDir)
  }

  async open(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      try {
        await stat(this.filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
        await atomicWrite(this.filePath, emptyState())
      }
    })
  }

  async read(): Promise<ProjectWorkspaceState> {
    return clone(await readProjectWorkspaceState(this.filePath))
  }

  async revision(): Promise<number> {
    return (await readProjectWorkspaceState(this.filePath)).revision
  }

  async mutate<T>(
    options: MutationOptions | number | undefined,
    callback: (context: MutationContext) => T
  ): Promise<T> {
    const expectedRevision = typeof options === 'number' ? undefined : options?.expectedStoreRevision
    return withFileLock(this.filePath, async () => {
      const state = await readProjectWorkspaceState(this.filePath)
      this.assertGlobalRevision(state, expectedRevision)
      const before = clone(state)
      const context = { state, commitRevision: state.revision + 1, now: Date.now() }
      const result = callback(context)
      state.revision = context.commitRevision
      const hook = this.beforeCommit.getStore()
      if (hook) {
        await hook({ before, after: clone(state), result: clone(result) })
      }
      await atomicWrite(this.filePath, state)
      return clone(result)
    })
  }

  withBeforeCommit<T>(hook: ProjectWorkspaceBeforeCommit, callback: () => Promise<T>): Promise<T> {
    return this.beforeCommit.run(hook, callback)
  }

  assertGlobalRevision(state: ProjectWorkspaceState, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new ProjectWorkspaceError('invalid_input', 'expected store revision must be a non-negative integer')
    }
    if (state.revision !== expectedRevision) {
      throw new ProjectWorkspaceError(
        'stale_revision',
        `store is at revision ${state.revision}, expected ${expectedRevision}`,
        { expectedRevision, actualRevision: state.revision }
      )
    }
  }

  assertCreateRevision(state: ProjectWorkspaceState, options: MutationOptions | number | undefined): void {
    this.assertGlobalRevision(state, storeExpectedRevision(options))
  }

  assertEntityRevision(actual: number, options: MutationOptions | number | undefined, label: string): void {
    const expected = entityExpectedRevision(options)
    if (expected === undefined) return
    if (!Number.isInteger(expected) || expected < 1) {
      throw new ProjectWorkspaceError('invalid_input', `${label} expectedRevision must be a positive integer`)
    }
    if (actual !== expected) {
      throw new ProjectWorkspaceError('stale_revision', `${label} is at revision ${actual}, expected ${expected}`, {
        expectedRevision: expected,
        actualRevision: actual
      })
    }
  }
}

export async function replaceProjectWorkspaceState(
  rootDir: string | undefined,
  expected: { revision: number; digest: string },
  next: ProjectWorkspaceState
): Promise<void> {
  const filePath = projectWorkspaceFile(rootDir)
  await withFileLock(filePath, async () => {
    const current = await readProjectWorkspaceState(filePath)
    if (current.revision !== expected.revision || digest(current) !== expected.digest) {
      throw new ProjectWorkspaceError(
        'canonical_write_source_conflict',
        'ProjectWorkspace JSON changed while recovering canonical write',
        { expectedRevision: expected.revision, actualRevision: current.revision }
      )
    }
    await atomicWrite(filePath, next)
  })
}
