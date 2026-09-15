import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Goal, ProjectWorkspaceState, WorkItem } from '../../shared/project-workspace-types'
import { canonicalJson, digest } from './codec'
import {
  commitProjectWorkspaceStateToWorkflowLedger,
  type ProjectWorkspaceCanonicalWriteMigrationOptions,
  type ProjectWorkspaceLedgerMigrationResult
} from './ledger-migration'
import { assertCanonicalAcceptanceBeforeTerminalWrite } from './ledger-shadow-acceptance'
import type { ProjectWorkspaceLedgerShadowMutation } from './ledger-shadow-types'
import { withProjectWorkspaceLedgerShadowLock } from './ledger-shadow-lock'
import {
  atomicWrite,
  parseProjectWorkspaceState,
  projectWorkspaceFile,
  readProjectWorkspaceState,
  replaceProjectWorkspaceState,
  type ProjectWorkspaceBeforeCommit,
  type ProjectWorkspaceMutationCommit
} from './persistence'
import { ProjectWorkspaceError } from './errors'
import { readVerifiedCanonicalProjectWorkspaceView } from './ledger-canonical-view'

const CANONICAL_WRITE_FORMAT = 'caogen.project-workspace-canonical-write.v1'
const CANONICAL_WRITE_DIR = 'canonical-journals'
const SHADOW_DIR = 'project-workspace-ledger-shadow'
const LOCK_FILE = 'command-write.lock'

type CanonicalWriteState = 'prepared' | 'canonical_committed' | 'projection_committed' | 'aborted'

interface CanonicalWriteJournal {
  schemaVersion: 1
  format: typeof CANONICAL_WRITE_FORMAT
  operationId: string
  mutation: ProjectWorkspaceLedgerShadowMutation
  state: CanonicalWriteState
  before: { revision: number; digest: string }
  desired?: {
    revision: number
    digest: string
    statePath: string
    stateSha256: string
    workspaceId: string
    entityRevision: number
    projectionDigest?: string
    sourceSha256?: string
    migrationId?: string
    migrationJournalPath?: string
  }
  attempts: number
  createdAt: number
  updatedAt: number
  lastError?: { name: string; message: string; code?: string; at: number }
  journalDigest: string
}

export interface ProjectWorkspaceCanonicalWriteOptions {
  now?: () => number
  migrate?: (
    state: ProjectWorkspaceState,
    workspaceId: string,
    rootDir: string,
    options: ProjectWorkspaceCanonicalWriteMigrationOptions
  ) => Promise<ProjectWorkspaceLedgerMigrationResult>
  faultAt?: 'after_prepare' | 'before_canonical_commit' | 'after_canonical_commit' | 'after_json_commit_before_journal'
  onFault?: (checkpoint: string, journal: CanonicalWriteJournal) => Promise<void> | void
}

export interface ProjectWorkspaceCanonicalWriteReadiness {
  enabled: true
  ready: boolean
  rootDir: string
  totalJournals: number
  pendingJournals: number
  prepared: number
  canonicalCommitted: number
  projectionCommitted: number
  aborted: number
  pending: Array<{
    operationId: string
    command: string
    entityType: string
    entityId: string
    workspaceId?: string
    state: 'prepared' | 'canonical_committed'
    attempts: number
    journalPath: string
    lastError?: CanonicalWriteJournal['lastError']
  }>
}

export class ProjectWorkspaceCanonicalWriteBoundary {
  readonly rootDir: string
  readonly journalDir: string
  readonly lockPath: string
  private readonly now: () => number
  private readonly migrate: NonNullable<ProjectWorkspaceCanonicalWriteOptions['migrate']>
  private readonly options: ProjectWorkspaceCanonicalWriteOptions

  constructor(rootDir: string, options: ProjectWorkspaceCanonicalWriteOptions = {}) {
    this.rootDir = resolve(rootDir)
    this.journalDir = join(this.rootDir, SHADOW_DIR, CANONICAL_WRITE_DIR)
    this.lockPath = join(this.rootDir, SHADOW_DIR, LOCK_FILE)
    this.now = options.now ?? Date.now
    this.options = options
    this.migrate = options.migrate ?? ((state, workspaceId, root, migrationOptions) =>
      commitProjectWorkspaceStateToWorkflowLedger(state, workspaceId, root, migrationOptions))
  }

  execute<T extends Goal | WorkItem>(
    mutation: ProjectWorkspaceLedgerShadowMutation,
    writeSource: (hook: ProjectWorkspaceBeforeCommit) => Promise<T>
  ): Promise<T> {
    assertFileChangeMutation(mutation)
    return this.withLock(async () => {
      await this.reconcilePendingLocked()
      const before = await readProjectWorkspaceState(projectWorkspaceFile(this.rootDir))
      await assertCanonicalAcceptanceBeforeTerminalWrite(this.rootDir, before, mutation)
      const operationId = randomUUID()
      const journalPath = join(this.journalDir, `${operationId}.json`)
      let journal = sealJournal({
        schemaVersion: 1,
        format: CANONICAL_WRITE_FORMAT,
        operationId,
        mutation,
        state: 'prepared',
        before: { revision: before.revision, digest: digest(before) },
        attempts: 0,
        createdAt: this.now(),
        updatedAt: this.now()
      })
      await writeJournal(journalPath, journal)
      await this.checkpoint('after_prepare', journal)
      try {
        let result: T | undefined
        const hook: ProjectWorkspaceBeforeCommit = async (commit) => {
          journal = await this.commitCanonical(journalPath, journal, commit)
        }
        result = await writeSource(hook)
        const current = await readProjectWorkspaceState(projectWorkspaceFile(this.rootDir))
        if (!journal.desired || current.revision !== journal.desired.revision || digest(current) !== journal.desired.digest) {
          throw this.failure('canonical_write_projection_unproven', journalPath, journal, true)
        }
        await this.assertCanonicalState(journal)
        await this.checkpoint('after_json_commit_before_journal', journal)
        journal = updateJournal(journal, { state: 'projection_committed', updatedAt: this.now() })
        await writeJournal(journalPath, journal)
        return result as T
      } catch (error) {
        throw this.wrapFailure(error, journalPath, journal)
      }
    })
  }

  async reconcile(): Promise<ProjectWorkspaceCanonicalWriteReadiness> {
    return this.withLock(async () => {
      await this.reconcilePendingLocked()
      return this.readinessLocked()
    })
  }

  readiness(): Promise<ProjectWorkspaceCanonicalWriteReadiness> {
    return this.withLock(() => this.readinessLocked())
  }

  withConsistentProjectionRead<T>(callback: (rootDir: string) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      await this.reconcilePendingLocked()
      const readiness = await this.readinessLocked()
      if (!readiness.ready) {
        throw new ProjectWorkspaceError('ledger_reconciliation_required', 'canonical ProjectWorkspace write recovery is pending', {
          pendingJournals: readiness.pendingJournals
        })
      }
      return callback(this.rootDir)
    })
  }

  private async commitCanonical(
    journalPath: string,
    journal: CanonicalWriteJournal,
    commit: ProjectWorkspaceMutationCommit
  ): Promise<CanonicalWriteJournal> {
    if (digest(commit.before) !== journal.before.digest || commit.before.revision !== journal.before.revision) {
      throw this.failure('canonical_write_source_conflict', journalPath, journal, false)
    }
    const entity = journal.mutation.entityType === 'goal'
      ? commit.after.goals.find((candidate) => candidate.id === journal.mutation.entityId)
      : commit.after.workItems.find((candidate) => candidate.id === journal.mutation.entityId)
    if (!entity) throw this.failure('canonical_write_entity_missing', journalPath, journal, false)
    const workspaceId = entity.projectId
    const statePath = join(this.journalDir, `${journal.operationId}.state.json`)
    const stateDigest = digest(commit.after)
    await atomicWrite(statePath, commit.after)
    let next = updateJournal(journal, {
      desired: {
        revision: commit.after.revision,
        digest: stateDigest,
        statePath,
        stateSha256: sha256(`${canonicalJson(commit.after)}\n`),
        workspaceId,
        entityRevision: entity.revision
      },
      attempts: journal.attempts + 1,
      updatedAt: this.now()
    })
    await writeJournal(journalPath, next)
    await this.checkpoint('before_canonical_commit', next)
    const migration = await this.migrate(commit.after, workspaceId, this.rootDir, {
      now: this.now,
      faultAt: undefined,
      fileChangeImpact: journal.mutation.fileChangeImpact,
      assertCurrentJsonUnchanged: async () => {
        const current = await readProjectWorkspaceState(projectWorkspaceFile(this.rootDir))
        if (current.revision !== commit.before.revision || digest(current) !== journal.before.digest) {
          throw new ProjectWorkspaceError('canonical_write_source_conflict', 'ProjectWorkspace JSON changed before canonical commit')
        }
      }
    })
    next = updateJournal(next, {
      state: 'canonical_committed',
      desired: { ...next.desired!, projectionDigest: migration.projectionDigest, sourceSha256: migration.sourceSha256, migrationId: migration.migrationId, migrationJournalPath: migration.journalPath },
      updatedAt: this.now()
    })
    await writeJournal(journalPath, next)
    await this.checkpoint('after_canonical_commit', next)
    return next
  }

  private async reconcilePendingLocked(): Promise<void> {
    for (const entry of await listJournals(this.journalDir)) {
      let journal = entry.journal
      if (journal.state === 'projection_committed' || journal.state === 'aborted') continue
      if (!journal.desired) {
        const current = await readProjectWorkspaceState(projectWorkspaceFile(this.rootDir))
        if (current.revision === journal.before.revision && digest(current) === journal.before.digest) {
          await writeJournal(entry.path, updateJournal(journal, { state: 'aborted', updatedAt: this.now() }))
          continue
        }
        throw this.failure('canonical_write_recovery_required', entry.path, journal, false)
      }
      const current = await readProjectWorkspaceState(projectWorkspaceFile(this.rootDir))
      const currentIsBefore = current.revision === journal.before.revision && digest(current) === journal.before.digest
      const currentIsDesired = current.revision === journal.desired.revision && digest(current) === journal.desired.digest
      if (!currentIsBefore && !currentIsDesired) throw this.failure('canonical_write_source_conflict', entry.path, journal, true)
      if (currentIsBefore && journal.state === 'prepared') {
        const desiredState = await this.readDesiredState(entry.path, journal)
        const migration = await this.migrate(desiredState, journal.desired.workspaceId, this.rootDir, {
          now: this.now,
          faultAt: undefined,
          fileChangeImpact: journal.mutation.fileChangeImpact,
          assertCurrentJsonUnchanged: async () => {
            const latest = await readProjectWorkspaceState(projectWorkspaceFile(this.rootDir))
            if (latest.revision !== journal.before.revision || digest(latest) !== journal.before.digest) {
              throw this.failure('canonical_write_source_conflict', entry.path, journal, false)
            }
          }
        })
        journal = updateJournal(journal, {
          state: 'canonical_committed',
          desired: {
            ...journal.desired,
            projectionDigest: migration.projectionDigest,
            sourceSha256: migration.sourceSha256,
            migrationId: migration.migrationId,
            migrationJournalPath: migration.journalPath
          },
          attempts: journal.attempts + 1,
          updatedAt: this.now()
        })
        await writeJournal(entry.path, journal)
      }
      await this.assertCanonicalState(journal)
      if (currentIsBefore) {
        const desired = await this.readDesiredState(entry.path, journal)
        await replaceProjectWorkspaceState(this.rootDir, journal.before, desired)
      }
      await writeJournal(entry.path, updateJournal(journal, { state: 'projection_committed', updatedAt: this.now() }))
    }
  }

  private async readDesiredState(journalPath: string, journal: CanonicalWriteJournal): Promise<ProjectWorkspaceState> {
    const desired = journal.desired
    if (!desired) throw this.failure('canonical_write_state_sidecar_missing', journalPath, journal, false)
    const raw = await readFile(desired.statePath, 'utf8')
    if (sha256(raw) !== desired.stateSha256) {
      throw this.failure('canonical_write_state_sidecar_mismatch', journalPath, journal, true)
    }
    const state = parseProjectWorkspaceState(raw)
    if (state.revision !== desired.revision || digest(state) !== desired.digest) {
      throw this.failure('canonical_write_state_sidecar_mismatch', journalPath, journal, true)
    }
    return state
  }

  private async assertCanonicalState(journal: CanonicalWriteJournal): Promise<void> {
    const desired = journal.desired
    if (!desired?.projectionDigest) throw this.failure('canonical_write_projection_missing', 'canonical-write', journal, true)
    const view = await readVerifiedCanonicalProjectWorkspaceView(desired.workspaceId, this.rootDir)
    if (view.stateRevision !== desired.revision || view.projectionDigest !== desired.projectionDigest) {
      throw this.failure('canonical_write_projection_mismatch', 'canonical-write', journal, true)
    }
  }

  private async readinessLocked(): Promise<ProjectWorkspaceCanonicalWriteReadiness> {
    const entries = await listJournals(this.journalDir)
    const pending = entries.filter(({ journal }) => journal.state === 'prepared' || journal.state === 'canonical_committed')
    const count = (state: CanonicalWriteState) => entries.filter(({ journal }) => journal.state === state).length
    return {
      enabled: true,
      ready: pending.length === 0,
      rootDir: this.rootDir,
      totalJournals: entries.length,
      pendingJournals: pending.length,
      prepared: count('prepared'),
      canonicalCommitted: count('canonical_committed'),
      projectionCommitted: count('projection_committed'),
      aborted: count('aborted'),
      pending: pending.map(({ path, journal }) => ({
        operationId: journal.operationId,
        command: journal.mutation.command,
        entityType: journal.mutation.entityType,
        entityId: journal.mutation.entityId,
        workspaceId: journal.desired?.workspaceId ?? journal.mutation.workspaceId,
        state: journal.state as 'prepared' | 'canonical_committed',
        attempts: journal.attempts,
        journalPath: path,
        lastError: journal.lastError
      }))
    }
  }

  private async checkpoint(checkpoint: ProjectWorkspaceCanonicalWriteOptions['faultAt'] & string, journal: CanonicalWriteJournal): Promise<void> {
    if (this.options.faultAt !== checkpoint) return
    await this.options.onFault?.(checkpoint, journal)
    throw this.failure('canonical_write_fault_injected', checkpoint, 'canonical-write', journal, journal.state === 'canonical_committed')
  }

  private failure(code: string, journalPath: string, journal: CanonicalWriteJournal, committed: boolean): ProjectWorkspaceError
  private failure(code: string, message: string, journalPath: string, journal: CanonicalWriteJournal, committed: boolean): ProjectWorkspaceError
  private failure(code: string, first: string, second: string | CanonicalWriteJournal, third?: CanonicalWriteJournal | boolean, fourth?: boolean): ProjectWorkspaceError {
    const message = typeof second === 'string' ? first : code
    const journalPath = typeof second === 'string' ? second : first
    const journal = typeof second === 'string' ? third as CanonicalWriteJournal : second
    const committed = typeof second === 'string' ? fourth === true : third === true
    return new ProjectWorkspaceError(code, message, {
      operationId: journal.operationId,
      journalPath,
      sourceCommitted: committed,
      reconciliationRequired: committed || journal.state !== 'aborted'
    })
  }

  private wrapFailure(error: unknown, journalPath: string, journal: CanonicalWriteJournal): ProjectWorkspaceError {
    if (error instanceof ProjectWorkspaceError) return error
    return this.failure('canonical_write_failed', error instanceof Error ? error.message : String(error), journalPath, journal, journal.state === 'canonical_committed')
  }

  private withLock<T>(callback: () => Promise<T>): Promise<T> {
    return withProjectWorkspaceLedgerShadowLock(this.lockPath, this.now, callback)
  }
}

export function createProjectWorkspaceCanonicalWriteBoundary(
  rootDir: string,
  options?: ProjectWorkspaceCanonicalWriteOptions
): ProjectWorkspaceCanonicalWriteBoundary {
  return new ProjectWorkspaceCanonicalWriteBoundary(rootDir, options)
}

interface JournalEntry { path: string; journal: CanonicalWriteJournal }

async function listJournals(directory: string): Promise<JournalEntry[]> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const result: JournalEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.state.json')) continue
    const path = resolve(directory, entry.name)
    result.push({ path, journal: parseJournal(path, await readFile(path, 'utf8')) })
  }
  return result.sort((left, right) => left.journal.createdAt - right.journal.createdAt)
}

function sealJournal(value: Omit<CanonicalWriteJournal, 'journalDigest'>): CanonicalWriteJournal {
  return { ...value, journalDigest: digest(value) }
}

function updateJournal(current: CanonicalWriteJournal, patch: Partial<Omit<CanonicalWriteJournal, 'schemaVersion' | 'format' | 'operationId' | 'journalDigest'>>): CanonicalWriteJournal {
  const { journalDigest: _digest, ...base } = current
  return sealJournal({ ...base, ...patch })
}

function writeJournal(path: string, journal: CanonicalWriteJournal): Promise<void> {
  return atomicWrite(path, journal)
}

function parseJournal(path: string, raw: string): CanonicalWriteJournal {
  let value: unknown
  try { value = JSON.parse(raw) } catch (error) { throw new ProjectWorkspaceError('canonical_write_journal_invalid', `cannot parse ${path}: ${String(error)}`) }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.format !== CANONICAL_WRITE_FORMAT || typeof value.operationId !== 'string' ||
      basename(path) !== `${value.operationId}.json` || !isRecord(value.mutation) || !isRecord(value.before) ||
      !['prepared', 'canonical_committed', 'projection_committed', 'aborted'].includes(String(value.state))) {
    throw new ProjectWorkspaceError('canonical_write_journal_invalid', `invalid canonical write journal ${path}`)
  }
  const { journalDigest, ...unsealed } = value as unknown as CanonicalWriteJournal
  if (typeof journalDigest !== 'string' || digest(unsealed) !== journalDigest) {
    throw new ProjectWorkspaceError('canonical_write_journal_invalid', `canonical write journal digest mismatch ${path}`)
  }
  assertFileChangeMutation((value as unknown as CanonicalWriteJournal).mutation)
  return value as unknown as CanonicalWriteJournal
}

function assertFileChangeMutation(mutation: ProjectWorkspaceLedgerShadowMutation): void {
  if ((mutation.command === 'work_item.reopen_for_file_change') !== Boolean(mutation.fileChangeImpact) ||
      (mutation.fileChangeImpact && mutation.workspaceId !== mutation.fileChangeImpact.projectId)) {
    throw new ProjectWorkspaceError('canonical_write_journal_invalid', 'File change impact requires its dedicated canonical Project command')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
