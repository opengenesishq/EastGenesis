import { app } from 'electron'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import initSqlJs from 'sql.js'
import type {
  EffectRecord, TaskDagFinalizationRecord,
  TaskSnapshotRecord,
  TaskRunRecord
} from '../../shared/types'
export { buildTaskSnapshot } from './task-snapshot-builder'
export type { BuildTaskSnapshotInput } from './task-snapshot-builder'
import { mergeTaskRunRecords } from './task-run'
import { assertFrozenRoutingWrite } from './frozen-routing-policy'
import { assertFrozenRoutingSnapshotOwner } from './frozen-routing-ownership'
import { mergeTaskSnapshots } from './task-snapshot-merge'
import {
  assertTaskDagFinalizationParentDeletable,
  findTaskDagFinalization,
  selectTaskDagFinalizations,
  upsertTaskDagFinalization
} from './task-dag-finalization-store'
import { appendTaskRunEvidence, backfillTaskEvidence, selectTaskRunsForEvidence } from './task-evidence-store'
import { backfillWorkflowLedger, projectRunIntoWorkflow, resolveRunWorkflowProjectionContext } from './workflow-ledger-projection'
import { projectTaskEvidenceIntoWorkflow } from './workflow-ledger-evidence-projection'
import {
  ensureWorkflowLedgerTaskStoreReady,
  type WorkflowLedgerMigrationSource
} from './workflow-ledger-migration'
import { validateLegacyJsonMigrationSource } from './workflow-ledger-readiness'
import { findConflictingEffectLease } from './effect-lease-conflict'
import { setupTaskSnapshotSchema } from './task-snapshot-schema'
import { stableValueDigest } from './tool-idempotency'
import {
  backfillWorkflowRecoverySessions,
  commitWorkflowLedgerReadMode,
  deleteWorkflowRecoverySession,
  findRecoverySnapshot,
  findRecoveryTaskRun,
  getWorkflowLedgerReadMode as getConfiguredWorkflowLedgerReadMode,
  normalizeWorkflowLedgerReadMode,
  selectRecoverySnapshots,
  selectRecoveryTaskRuns,
  upsertWorkflowRecoverySession,
  type WorkflowLedgerReadMode
} from './workflow-ledger-recovery'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
export type TaskSnapshotDatabase = InstanceType<SqlJsStatic['Database']>
type SqlDatabase = TaskSnapshotDatabase

// Finder/Dock may launch the app with cwd="/"; resolve packaged WASM beside the bundled module.
const nodeRequire = createRequire(__filename)
const STORE_VERSION = 9
export const TASK_SNAPSHOT_EVENT_INTERVAL = 5
const TASK_SNAPSHOT_DB_FILE = 'task-snapshots.db'

let sqlPromise: Promise<SqlJsStatic> | null = null
const mutationQueues = new Map<string, Promise<unknown>>()

export function taskSnapshotsFile(rootDir = app.getPath('userData')): string {
  return join(rootDir, 'task-snapshots.json')
}

export function taskSnapshotsDbFile(rootDir = app.getPath('userData')): string {
  return join(rootDir, TASK_SNAPSHOT_DB_FILE)
}

export type { WorkflowLedgerReadMode } from './workflow-ledger-recovery'

export interface SaveTaskSnapshotOptions {
  /** Import already restored the sealed Workflow Ledger projection. */
  projectWorkflow?: boolean
}

export function getWorkflowLedgerReadMode(rootDir?: string): WorkflowLedgerReadMode {
  return getConfiguredWorkflowLedgerReadMode(taskSnapshotsDbFile(rootDir))
}

export async function configureWorkflowLedgerReadMode(
  value: unknown,
  rootDir?: string
): Promise<WorkflowLedgerReadMode> {
  const mode = normalizeWorkflowLedgerReadMode(value)
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir, mode, true)
    try {
      // Exercise both canonical recovery surfaces before publishing the database-scoped flip.
      selectRecoverySnapshots(store.db, mode)
      selectRecoveryTaskRuns(store.db, mode)
    } finally {
      store.db.close()
    }
    commitWorkflowLedgerReadMode(store.path, mode)
    return mode
  })
}

export async function listTaskSnapshots(rootDir?: string): Promise<TaskSnapshotRecord[]> {
  await waitForPendingMutations(rootDir)
  return readStore(rootDir)
}

export async function getTaskSnapshot(snapshotId: string, rootDir?: string): Promise<TaskSnapshotRecord | null> {
  const id = snapshotId.trim()
  if (!id) return null
  await waitForPendingMutations(rootDir)
  const store = await openStore(rootDir)
  try {
    return findRecoverySnapshot(store.db, id, id, store.readMode)
  } finally {
    store.db.close()
  }
}

export function saveTaskSnapshot(
  snapshot: TaskSnapshotRecord,
  rootDir?: string,
  options: SaveTaskSnapshotOptions = {}
): Promise<TaskSnapshotRecord> {
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      const previous = findRecoverySnapshot(store.db, snapshot.id, snapshot.sessionId, store.readMode)
      let nextSnapshot = previous ? mergeTaskSnapshots(previous, snapshot) : snapshot
      if (nextSnapshot.run) {
        const persistedRun = upsertTaskRun(
          store.db,
          nextSnapshot.run,
          store.readMode,
          nextSnapshot.meta.projectId,
          nextSnapshot,
          options.projectWorkflow !== false
        )
        nextSnapshot = {
          ...nextSnapshot,
          updatedAt: Math.max(nextSnapshot.updatedAt, persistedRun.updatedAt),
          run: persistedRun
        }
      }
      upsertSnapshot(store.db, nextSnapshot, store.readMode)
      await persistStore(store)
      return nextSnapshot
    } finally {
      store.db.close()
    }
  })
}

export async function listTaskDagFinalizations(
  parentSessionId?: string,
  rootDir?: string
): Promise<TaskDagFinalizationRecord[]> {
  await waitForPendingMutations(rootDir)
  const store = await openStore(rootDir)
  try {
    return selectTaskDagFinalizations(store.db, parentSessionId)
  } finally {
    store.db.close()
  }
}

export async function getTaskDagFinalization(
  executionId: string,
  rootDir?: string
): Promise<TaskDagFinalizationRecord | null> {
  const id = executionId.trim()
  if (!id) return null
  await waitForPendingMutations(rootDir)
  const store = await openStore(rootDir)
  try {
    return findTaskDagFinalization(store.db, id)
  } finally {
    store.db.close()
  }
}

export function saveTaskDagFinalizationBarrier(
  snapshot: TaskSnapshotRecord,
  finalization: TaskDagFinalizationRecord,
  options: { expectedRevision?: number; rootDir?: string } = {}
): Promise<{ snapshot: TaskSnapshotRecord; finalization: TaskDagFinalizationRecord }> {
  return enqueueMutation(options.rootDir, async () => {
    const store = await openStore(options.rootDir)
    try {
      const currentFinalization = findTaskDagFinalization(store.db, finalization.executionId)
      const currentRevision = currentFinalization?.revision ?? 0
      const expectedRevision = options.expectedRevision ?? Math.max(0, finalization.revision - 1)
      if (currentRevision !== expectedRevision) {
        throw new Error(
          `stale_revision: DAG finalizer ${finalization.executionId} 已从 ${expectedRevision} 更新到 ${currentRevision}`
        )
      }
      if (finalization.revision !== currentRevision + 1) {
        throw new Error(
          `DAG finalizer revision 必须连续递增:${finalization.revision} != ${currentRevision + 1}`
        )
      }
      if (snapshot.sessionId !== finalization.parentSessionId) {
        throw new Error('DAG finalizer parentSessionId 与任务快照不一致')
      }
      const previousSnapshot = findRecoverySnapshot(
        store.db, snapshot.id, snapshot.sessionId, store.readMode
      )
      let nextSnapshot = previousSnapshot ? mergeTaskSnapshots(previousSnapshot, snapshot) : snapshot
      if (nextSnapshot.run) {
        const persistedRun = upsertTaskRun(
          store.db, nextSnapshot.run, store.readMode, nextSnapshot.meta.projectId, nextSnapshot
        )
        nextSnapshot = {
          ...nextSnapshot,
          updatedAt: Math.max(nextSnapshot.updatedAt, persistedRun.updatedAt),
          run: persistedRun
        }
      }
      upsertSnapshot(store.db, nextSnapshot, store.readMode)
      upsertTaskDagFinalization(store.db, finalization)
      await persistStore(store)
      return { snapshot: nextSnapshot, finalization }
    } finally {
      store.db.close()
    }
  })
}

export function deleteTaskSnapshot(
  snapshotId: string,
  rootDir?: string,
  finalRun?: TaskRunRecord
): Promise<boolean> {
  const id = snapshotId.trim()
  if (!id) return Promise.resolve(false)
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      assertTaskDagFinalizationParentDeletable(store.db, id)
      const previous = findRecoverySnapshot(store.db, id, id, store.readMode)
      if (finalRun) {
        upsertTaskRun(store.db, finalRun, store.readMode, previous?.meta.projectId, previous ?? undefined)
      }
      if (!previous) {
        if (finalRun) await persistStore(store)
        return false
      }
      store.db.run('DELETE FROM task_snapshots WHERE id = ? OR session_id = ?', [id, id])
      deleteWorkflowRecoverySession(store.db, id)
      await persistStore(store)
      return true
    } finally {
      store.db.close()
    }
  })
}

export async function listTaskRuns(sessionId?: string, rootDir?: string): Promise<TaskRunRecord[]> {
  await waitForPendingMutations(rootDir)
  const store = await openStore(rootDir)
  try {
    return selectRecoveryTaskRuns(store.db, store.readMode, sessionId)
  } finally {
    store.db.close()
  }
}

/**
 * Write-ahead barrier for external effects. The returned promise resolves only
 * after the run and any matching recovery snapshot have reached durable storage.
 */
export function saveTaskRunBarrier(run: TaskRunRecord, rootDir?: string): Promise<TaskRunRecord> {
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      const persistedRuns = selectRecoveryTaskRuns(store.db, store.readMode)
      const previous = persistedRuns.find((item) => item.id === run.id) ?? null
      const candidateRun = previous ? mergeTaskRunRecords(previous, run) : run
      const conflictingEffect = await findConflictingEffectLease(persistedRuns, candidateRun, rootDir ?? app.getPath('userData'))
      if (conflictingEffect) {
        throw new Error(
          `相同资源的外部效果在其他会话仍未收敛(${conflictingEffect.status})，已阻止第二个执行 lease`
        )
      }
      const matchingSnapshots = selectRecoverySnapshots(store.db, store.readMode).filter((snapshot) =>
        snapshot.sessionId === candidateRun.sessionId && (!snapshot.run || snapshot.run.id === candidateRun.id)
      )
      if (matchingSnapshots.length === 0) {
        throw new Error('效果持久化屏障缺少可恢复任务快照，已阻止外部执行')
      }
      const persistedRun = assignResourceFencingTokens(store.db, candidateRun, persistedRuns)
      upsertTaskRun(
        store.db, persistedRun, store.readMode, matchingSnapshots[0]?.meta.projectId, matchingSnapshots[0]
      )
      for (const snapshot of matchingSnapshots) {
        upsertSnapshot(store.db, {
          ...snapshot,
          updatedAt: Math.max(snapshot.updatedAt, persistedRun.updatedAt),
          run: snapshot.run ? mergeTaskRunRecords(snapshot.run, persistedRun) : persistedRun
        }, store.readMode)
      }
      await persistStore(store)
      return persistedRun
    } finally {
      store.db.close()
    }
  })
}

function assignResourceFencingTokens(
  db: SqlDatabase,
  incomingRun: TaskRunRecord,
  persistedRuns: TaskRunRecord[]
): TaskRunRecord {
  const persistedEffects = persistedRuns.flatMap((run) => run.effects ?? [])
  const persistedById = new Map(persistedEffects.map((effect) => [effect.id, effect]))
  const maxByResource = new Map<string, number>()
  for (const effect of persistedEffects) {
    if (!effect.lease) continue
    const resourceKey = effectResourceKey(effect)
    maxByResource.set(
      resourceKey,
      Math.max(maxByResource.get(resourceKey) ?? 0, effect.lease.fencingToken)
    )
  }

  let changed = false
  const effects = (incomingRun.effects ?? []).map((effect) => {
    if (!effect.lease) return effect
    const resourceKey = effectResourceKey(effect)
    const persistedEffect = persistedById.get(effect.id)
    const observedMax = Math.max(
      maxByResource.get(resourceKey) ?? 0,
      readResourceFencingToken(db, resourceKey)
    )
    const fencingToken = persistedEffect?.lease?.fencingToken ?? observedMax + 1
    const nextMax = Math.max(observedMax, fencingToken)
    maxByResource.set(resourceKey, nextMax)
    writeResourceFencingToken(db, resourceKey, nextMax)
    if (effect.lease.fencingToken === fencingToken) return effect
    changed = true
    return withFencingToken(effect, fencingToken)
  })
  return changed ? { ...incomingRun, effects } : incomingRun
}

function effectResourceKey(effect: EffectRecord): string {
  return effect.resourceKey || effect.effectKey
}

function readResourceFencingToken(db: SqlDatabase, resourceKey: string): number {
  const stmt = db.prepare(
    'SELECT fencing_token FROM effect_resource_fences WHERE resource_key = ? LIMIT 1'
  )
  try {
    stmt.bind([resourceKey])
    if (!stmt.step()) return 0
    const value = stmt.getAsObject().fencing_token
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
  } finally {
    stmt.free()
  }
}

function writeResourceFencingToken(db: SqlDatabase, resourceKey: string, fencingToken: number): void {
  db.run(
    `
      INSERT INTO effect_resource_fences(resource_key, fencing_token)
      VALUES (?, ?)
      ON CONFLICT(resource_key) DO UPDATE SET
        fencing_token = MAX(effect_resource_fences.fencing_token, excluded.fencing_token)
    `,
    [resourceKey, fencingToken]
  )
}

function withFencingToken(effect: EffectRecord, fencingToken: number): EffectRecord {
  if (!effect.lease) return effect
  const evidence = effect.evidence.map((item) =>
    item.kind === 'prepared' &&
    item.generation === effect.generation &&
    item.verifier === 'effect-ledger-v1'
      ? {
          ...item,
          digest: stableValueDigest({
            effectKey: effect.effectKey,
            resourceKey: effect.resourceKey,
            targetDigest: effect.targetDigest,
            intentDigest: effect.intentDigest,
            leaseId: effect.lease?.id,
            fencingToken
          })
        }
      : item
  )
  return { ...effect, lease: { ...effect.lease, fencingToken }, evidence }
}

export function supersedeToolExecution(
  executionId: string,
  replacementExecutionId: string,
  now = Date.now(),
  rootDir?: string
): Promise<boolean> {
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      let changed = false
      const persistedUpdates = new Map<string, TaskRunRecord>()
      const snapshots = selectRecoverySnapshots(store.db, store.readMode)
      for (const run of selectRecoveryTaskRuns(store.db, store.readMode)) {
        const updated = markToolExecutionSuperseded(run, executionId, replacementExecutionId, now)
        if (!updated) continue
        const snapshot = snapshots.find((candidate) => candidate.run?.id === run.id)
        persistedUpdates.set(
          run.id,
          upsertTaskRun(store.db, updated, store.readMode, snapshot?.meta.projectId, snapshot)
        )
        changed = true
      }
      for (const snapshot of snapshots) {
        if (!snapshot.run) continue
        const persisted = persistedUpdates.get(snapshot.run.id)
        const updatedRun = persisted ?? markToolExecutionSuperseded(
          snapshot.run, executionId, replacementExecutionId, now
        )
        if (!updatedRun) continue
        const nextRun = persisted ?? upsertTaskRun(
          store.db, updatedRun, store.readMode, snapshot.meta.projectId, snapshot
        )
        persistedUpdates.set(nextRun.id, nextRun)
        upsertSnapshot(store.db, {
          ...snapshot,
          updatedAt: Math.max(snapshot.updatedAt, now, nextRun.updatedAt),
          run: nextRun
        }, store.readMode)
        changed = true
      }
      if (changed) await persistStore(store)
      return changed
    } finally {
      store.db.close()
    }
  })
}

export function flushTaskSnapshotMutations(rootDir?: string): Promise<void> {
  return waitForPendingMutations(rootDir)
}

/** Read the shared task database under the same mutation queue used by snapshots. */
export async function readTaskSnapshotDatabase<T>(
  rootDir: string | undefined,
  reader: (db: TaskSnapshotDatabase) => T | Promise<T>
): Promise<T> {
  await waitForPendingMutations(rootDir)
  const store = await openStore(rootDir)
  try {
    return await reader(store.db)
  } finally {
    store.db.close()
  }
}

/** Mutate the shared task database atomically with snapshot/effect writes. */
export function mutateTaskSnapshotDatabase<T>(
  rootDir: string | undefined,
  mutator: (db: TaskSnapshotDatabase) => T | Promise<T>
): Promise<T> {
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      const result = await mutator(store.db)
      await persistStore(store)
      return result
    } finally {
      store.db.close()
    }
  })
}

/** Serialize maintenance that replaces the task database with normal writers. */
export function withTaskSnapshotDatabaseMutationBarrier<T>(
  rootDir: string | undefined,
  maintenance: () => Promise<T>
): Promise<T> {
  return enqueueMutation(rootDir, maintenance)
}

async function readStore(rootDir?: string): Promise<TaskSnapshotRecord[]> {
  const store = await openStore(rootDir)
  try {
    return selectRecoverySnapshots(store.db, store.readMode)
  } finally {
    store.db.close()
  }
}

async function openStore(
  rootDir?: string,
  requestedReadMode?: WorkflowLedgerReadMode,
  forceReadinessRefresh = false
): Promise<{ db: SqlDatabase; path: string; readMode: WorkflowLedgerReadMode }> {
  const SQL = await loadSql()
  const dbPath = taskSnapshotsDbFile(rootDir)
  const readMode = requestedReadMode ?? getConfiguredWorkflowLedgerReadMode(dbPath)
  const readiness = {
    databasePath: dbPath,
    legacyJsonPath: taskSnapshotsFile(rootDir),
    supportedStoreVersion: STORE_VERSION,
    targetStoreVersion: STORE_VERSION,
    readMode,
    buildCandidate: buildMigrationCandidate
  }
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 })
  await ensureWorkflowLedgerTaskStoreReady({ ...readiness, forceRefresh: forceReadinessRefresh })
  let bytes: Uint8Array
  try {
    bytes = await readFile(dbPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A test runner or external cleanup can remove an ephemeral userData root
    // after the first-open readiness result was cached. Re-run the strict gate
    // instead of leaking a raw ENOENT through every Project surface.
    await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 })
    await ensureWorkflowLedgerTaskStoreReady({ ...readiness, forceRefresh: true })
    bytes = await readFile(dbPath)
  }
  const db = new SQL.Database(bytes)
  try {
    const previousVersion = readStoreVersion(db)
    if (previousVersion > STORE_VERSION) {
      throw new Error(`任务快照数据库版本过新:${previousVersion} > ${STORE_VERSION}`)
    }
    return { db, path: dbPath, readMode }
  } catch (error) { db.close(); throw error }
}

/** Build migration bytes without touching the production database path. */
async function buildMigrationCandidate(source: WorkflowLedgerMigrationSource): Promise<Uint8Array> {
  const SQL = await loadSql()
  const db = source.sourceKind === 'sqlite'
    ? new SQL.Database(source.sourceBytes)
    : new SQL.Database()
  try {
    const previousVersion = readStoreVersion(db)
    if (previousVersion > STORE_VERSION) {
      throw new Error(`任务快照数据库版本过新:${previousVersion} > ${STORE_VERSION}`)
    }
    setupTaskSnapshotSchema(db, STORE_VERSION)
    if (source.sourceKind === 'legacy_json') {
      importLegacySnapshots(db, source.sourceBytes)
    }
    const snapshots = selectRecoverySnapshots(db, 'legacy')
    const taskRuns = selectTaskRunsForEvidence(db)
    backfillTaskEvidence(
      db,
      taskRuns,
      snapshots.map(({ sessionId, meta }) => ({ sessionId, projectId: meta.projectId }))
    )
    backfillWorkflowLedger(db, taskRuns, snapshots)
    projectTaskEvidenceIntoWorkflow(db)
    backfillWorkflowRecoverySessions(db, snapshots)
    return db.export()
  } finally {
    db.close()
  }
}

function importLegacySnapshots(db: SqlDatabase, sourceBytes: Uint8Array): void {
  const snapshots = validateLegacyJsonSource(sourceBytes)
  for (const snapshot of snapshots) {
    if (snapshot.run) {
      db.run(
        `INSERT INTO task_runs(id, session_id, updated_at, payload) VALUES (?, ?, ?, ?)`,
        [snapshot.run.id, snapshot.run.sessionId, snapshot.run.updatedAt, JSON.stringify(snapshot.run)]
      )
    }
    db.run(
      `INSERT INTO task_snapshots(id, session_id, updated_at, payload) VALUES (?, ?, ?, ?)`,
      [snapshot.id, snapshot.sessionId, snapshot.updatedAt, JSON.stringify(snapshot)]
    )
  }
}

function validateLegacyJsonSource(sourceBytes: Uint8Array): TaskSnapshotRecord[] {
  // Keep the migration parser strict; the normal reader must never silently
  // discard a legacy row that the preservation gate is expected to retain.
  return [...validateLegacyJsonMigrationSource(sourceBytes)]
}

async function persistStore(store: { db: SqlDatabase; path: string }): Promise<void> {
  const tmpPath = `${store.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(store.path), { recursive: true, mode: 0o700 })
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(store.db.export())
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmpPath, store.path)
    await syncParentDirectory(store.path)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dirname(path), 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function renameWithRetry(tmpPath: string, targetPath: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(tmpPath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= maxAttempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error
      }
      await delay(20 * attempt)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readStoreVersion(db: SqlDatabase): number {
  const result = db.exec('PRAGMA user_version')
  const value = result[0]?.values[0]?.[0]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function upsertSnapshot(
  db: SqlDatabase,
  snapshot: TaskSnapshotRecord,
  readMode: WorkflowLedgerReadMode
): void {
  const previous = findRecoverySnapshot(db, snapshot.id, snapshot.sessionId, readMode)
  const next = previous ? mergeTaskSnapshots(previous, snapshot) : snapshot
  assertFrozenRoutingSnapshotOwner(next)
  db.run(
    `
      INSERT INTO task_snapshots(id, session_id, updated_at, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `,
    [next.id, next.sessionId, next.updatedAt, JSON.stringify(next)]
  )
  upsertWorkflowRecoverySession(db, next)
}

function upsertTaskRun(
  db: SqlDatabase,
  run: TaskRunRecord,
  readMode: WorkflowLedgerReadMode,
  projectId?: string,
  snapshot?: TaskSnapshotRecord,
  projectWorkflow = true
): TaskRunRecord {
  const previous = findRecoveryTaskRun(db, run.id, readMode)
  const next = previous ? mergeTaskRunRecords(previous, run) : run
  assertFrozenRoutingWrite(previous ?? undefined, next)
  const workflowContext = projectWorkflow
    ? resolveRunWorkflowProjectionContext(db, next, projectId, snapshot)
    : undefined
  db.run(
    `
      INSERT INTO task_runs(id, session_id, updated_at, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `,
    [next.id, next.sessionId, next.updatedAt, JSON.stringify(next)]
  )
  if (workflowContext) {
    appendTaskRunEvidence(db, next, workflowContext.projectId)
    projectRunIntoWorkflow(db, next, workflowContext)
    projectTaskEvidenceIntoWorkflow(db, { runId: next.id })
  }
  return next
}

function markToolExecutionSuperseded(
  run: TaskRunRecord,
  executionId: string,
  replacementExecutionId: string,
  now: number
): TaskRunRecord | null {
  const executions = run.toolExecutions ?? []
  const index = executions.findIndex(
    (execution) => execution.id === executionId && execution.status === 'unknown_outcome'
  )
  if (index < 0) return null
  const toolExecutions = [...executions]
  toolExecutions[index] = {
    ...toolExecutions[index],
    status: 'superseded',
    supersededByExecutionId: replacementExecutionId,
    updatedAt: now,
    finishedAt: now,
    error: '未知结果已由用户确认后的成功重试取代'
  }
  return {
    ...run,
    revision: run.revision + 1,
    updatedAt: Math.max(run.updatedAt, now),
    toolExecutions
  }
}

function enqueueMutation<T>(rootDir: string | undefined, task: () => Promise<T>): Promise<T> {
  const key = taskSnapshotsDbFile(rootDir)
  const previous = mutationQueues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  const release = (): void => {
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key)
  }
  const queued = next.then(release, release)
  mutationQueues.set(key, queued)
  return next
}
async function waitForPendingMutations(rootDir: string | undefined): Promise<void> {
  const pending = mutationQueues.get(taskSnapshotsDbFile(rootDir))
  if (pending) await pending.catch(() => undefined)
}
function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) =>
        file.endsWith('.wasm') ? nodeRequire.resolve('sql.js/dist/sql-wasm.wasm') : file
    })
  }
  return sqlPromise
}
