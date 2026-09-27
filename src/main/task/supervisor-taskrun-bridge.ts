import { dirname } from 'node:path'
import type { SessionMeta, TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkItem } from '../../shared/project-workspace-types'
import type { SupervisorRunRecord } from '../../shared/supervisor-types'
import type {
  SupervisorMutationOptions,
  SupervisorRunAccountingBase,
  SupervisorRunCreateInput,
  SupervisorRunInput,
  SupervisorWorkItemLeaseBinding
} from '../../shared/supervisor-types'
import { createProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import {
  SupervisorStateError,
  SupervisorStateStore
} from './supervisor-state'
import {
  bindWorkflowRunToCanonicalWorkItem,
  resolveWorkflowRunCanonicalWorkItem
} from './workflow-run-canonical-binding'

export type SupervisorTaskRunBindingDisposition =
  | 'unscoped'
  | 'canonical_only'
  | 'attached'
  | 'existing'

export interface SupervisorTaskRunBindingResult {
  disposition: SupervisorTaskRunBindingDisposition
  workItem?: WorkItem
  supervisorRun?: SupervisorRunRecord
}

export interface SupervisorTaskRunBridgeOptions {
  /** Root containing both the ProjectWorkspace aggregate and task snapshot DB. */
  rootDir?: string
  /** Reuse one durable Supervisor store when called from SessionManager. */
  store?: SupervisorStateStore
  /** Session totals captured before the first model request for this Run. */
  accountingBase?: SupervisorRunAccountingBase
  /** False rejects a canonical USD Goal budget before reserving a Run. */
  costBudgetEnforceable?: boolean
}

/**
 * Read-only startup probe for an already persisted snapshot.  Recovery must
 * be able to decide whether a historical WorkItem can be rebound without
 * reserving a Supervisor Run or mutating the canonical aggregate.
 */
export async function assertSupervisorRunBindingRecoveryReady(
  meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>,
  run: TaskRunRecord,
  options: SupervisorTaskRunBridgeOptions = {}
): Promise<void> {
  assertTaskRunSessionOwnership(meta, run)
  const { rootDir, store } = resolveSupervisorBindingContext(options)
  if (!store) return
  const resolved = await resolveWorkflowRunCanonicalWorkItem(meta, run, rootDir)
  if (resolved.disposition === 'unscoped') return
  captureCanonicalWorkItemLease(resolved.workItem)
}

interface SupervisorBindingContext {
  rootDir?: string
  store?: SupervisorStateStore
}

interface SupervisorRunReservation {
  run: SupervisorRunRecord
  created: boolean
  workItem: WorkItem
}

type SupervisorRunIdentity =
  Omit<Pick<SupervisorRunInput, 'id' | 'projectId' | 'goalId' | 'workItemId' | 'origin' | 'budget' | 'accountingBase'>, 'id'> &
  { id: string; workItemLease?: SupervisorWorkItemLeaseBinding }

export interface SupervisorRunBindingRecoveryResult {
  attached: string[]
  existing: string[]
  observed: string[]
  unscoped: number
  failures: Array<{ runId: string; error: string }>
}

/** Reserve budget/concurrency ownership before a turn without publishing a dangling WorkItem Run ref. */
export async function reserveSupervisorRunForSend(
  meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>,
  run: TaskRunRecord,
  options: SupervisorTaskRunBridgeOptions = {}
): Promise<SupervisorRunRecord | undefined> {
  const reservation = await reserveSupervisorRun(meta, run, options)
  return reservation?.run
}

/** Create a renderer-requested coordination Run from canonical WorkItem policy. */
export async function createCanonicalSupervisorRun(
  store: SupervisorStateStore,
  rootDir: string,
  input: SupervisorRunCreateInput,
  options: SupervisorMutationOptions = {}
): Promise<SupervisorRunRecord> {
  const workspace = await openProjectWorkspaceStore(rootDir)
  const item = await workspace.getWorkItem(input.workItemId)
  if (!item) throw new Error(`canonical WorkItem does not exist:${input.workItemId}`)
  if (item.projectId !== input.projectId) {
    throw new Error(`canonical WorkItem crosses Workspace boundary:${input.workItemId}`)
  }
  if (input.goalId !== undefined && item.goalId !== input.goalId) {
    throw new Error(`canonical WorkItem crosses Goal boundary:${input.workItemId}`)
  }
  const workItemLease = captureCanonicalWorkItemLease(item)
  const created = await store.createRun({
    ...input,
    ...(item.goalId ? { goalId: item.goalId } : {}),
    ...(workItemLease ? { workItemLease } : {}),
    ...(item.inheritedGoalContract?.budget
      ? { budget: structuredClone(item.inheritedGoalContract.budget) }
      : {})
  }, options)
  try {
    await attachManualSupervisorRun(workspace, rootDir, item, created.id)
    return created
  } catch (error) {
    try {
      await store.cancelRun(created.id, { actorId: 'supervisor-binding-rollback' })
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Supervisor Run ${created.id} canonical binding and rollback both failed`
      )
    }
    throw error
  }
}

async function attachManualSupervisorRun(
  initialStore: Awaited<ReturnType<typeof openProjectWorkspaceStore>>,
  rootDir: string,
  initialItem: WorkItem,
  runId: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const workspace = attempt === 0 ? initialStore : await openProjectWorkspaceStore(rootDir)
    const item = attempt === 0 ? initialItem : await workspace.getWorkItem(initialItem.id)
    if (!item || item.projectId !== initialItem.projectId || item.goalId !== initialItem.goalId) {
      throw new Error(`canonical WorkItem ownership changed:${initialItem.id}`)
    }
    if (item.runRefs.includes(runId)) return
    const commands = createProjectWorkspaceCommandService(workspace, { rootDir })
    await commands.reconcileShadowProjection()
    try {
      await commands.updateWorkItem(
        item.id,
        { runRefs: [...item.runRefs, runId] },
        { expectedRevision: item.revision }
      )
      return
    } catch (error) {
      if (attempt < 2 && isStaleProjectWorkspaceRevision(error)) continue
      throw error
    }
  }
  throw new Error(`canonical Run binding retry exhausted:${runId}`)
}

function isStaleProjectWorkspaceRevision(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'stale_revision')
}

export type SupervisorRestartDisposition =
  | 'terminal'
  | 'waiting_reconciliation'
  | 'retryable'
  | 'manual_approval'
  | 'paused'
  | 'blocked'
  | 'failed_requires_authorization'
  | 'missing_task_run'

export interface SupervisorRestartClassification {
  disposition: SupervisorRestartDisposition
  reason: string
}

export interface SupervisorRestartClassificationInput {
  supervisor: Pick<SupervisorRunRecord, 'status'>
  taskRun?: TaskRunRecord
  /** A durable ModelAttempt reconciliation barrier blocks automatic replay. */
  hasModelAttemptBarrier?: boolean
}

/**
 * Bind one durable TaskRun to the rich WorkItem source and to a Supervisor row.
 *
 * The TaskRun/WorkflowRun identity is the single run key across all three
 * stores. The Supervisor store remains coordination metadata only; canonical
 * WorkItem mutation is delegated to its command boundary by the existing
 * binding helper.
 */
export async function ensureSupervisorRunBinding(
  meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>,
  run: TaskRunRecord,
  options: SupervisorTaskRunBridgeOptions = {}
): Promise<SupervisorTaskRunBindingResult> {
  assertTaskRunSessionOwnership(meta, run)
  const { rootDir, store } = resolveSupervisorBindingContext(options)

  // Callers that only need the historical canonical WorkItem binding (for
  // isolated/unit contexts without a Supervisor store) retain that behavior.
  if (!options.store && !rootDir) {
    const canonical = await bindWorkflowRunToCanonicalWorkItem(meta, run, rootDir)
    if (canonical.disposition === 'unscoped') return canonical
    return { disposition: 'canonical_only', workItem: canonical.workItem }
  }

  if (!store) throw new Error('Supervisor Run binding requires rootDir or a Supervisor store')
  const reservation = await reserveSupervisorRun(meta, run, options)
  if (!reservation) return { disposition: 'unscoped' }

  let canonical
  try {
    canonical = await bindWorkflowRunToCanonicalWorkItem(meta, run, rootDir)
  } catch (error) {
    if (reservation.created) {
      try {
        await store.cancelRun(reservation.run.id, { actorId: 'supervisor-binding-rollback' })
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Supervisor Run ${reservation.run.id} canonical binding and rollback both failed`
        )
      }
    }
    throw error
  }
  if (canonical.disposition === 'unscoped') {
    throw new Error(`Supervisor Run ${reservation.run.id} lost canonical scope during binding`)
  }

  const disposition: Extract<SupervisorTaskRunBindingDisposition, 'attached' | 'existing'> =
    canonical.disposition === 'attached' ? 'attached' : 'existing'
  return {
    disposition,
    workItem: canonical.workItem,
    supervisorRun: reservation.run
  }
}

async function reserveSupervisorRun(
  meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>,
  run: TaskRunRecord,
  options: SupervisorTaskRunBridgeOptions
): Promise<SupervisorRunReservation | undefined> {
  assertTaskRunSessionOwnership(meta, run)
  const { rootDir, store } = resolveSupervisorBindingContext(options)
  if (!store) throw new Error('Supervisor Run reservation requires rootDir or a Supervisor store')
  const existingBeforeBinding = await getSupervisorRun(store, run.id)
  if (existingBeforeBinding) assertClaimedSupervisorIdentity(existingBeforeBinding, meta)
  const resolved = await resolveWorkflowRunCanonicalWorkItem(meta, run, rootDir)
  if (resolved.disposition === 'unscoped') return undefined
  const workItemLease = captureCanonicalWorkItemLease(resolved.workItem)
  assertCostBudgetEnforceable(resolved.workItem, options.costBudgetEnforceable)
  const input = supervisorRunIdentity(run.id, resolved.workItem, workItemLease, options.accountingBase)
  const reservation = await createOrLoadSupervisorRun(store, input, existingBeforeBinding)
  assertSupervisorRunIdentity(reservation.run, input)
  return { ...reservation, workItem: resolved.workItem }
}

function assertCostBudgetEnforceable(workItem: WorkItem, enforceable: boolean | undefined): void {
  const budget = workItem.inheritedGoalContract?.budget
  if (enforceable !== false || (budget?.amount ?? 0) <= 0) return
  const currency = budget?.currency?.trim().toUpperCase() || 'USD'
  if (currency !== 'USD') return
  throw new SupervisorStateError(
    'budget_exhausted',
    `Goal ${workItem.goalId ?? 'unscoped'} has a USD cost budget but the selected engine does not report auditable cost`,
    { goalId: workItem.goalId, currency, amountUsd: budget?.amount }
  )
}

function assertTaskRunSessionOwnership(
  meta: Pick<SessionMeta, 'id'>,
  run: TaskRunRecord
): void {
  if (run.sessionId !== meta.id) {
    throw new Error(`Supervisor Run ${run.id} crosses session ownership`)
  }
}

function resolveSupervisorBindingContext(options: SupervisorTaskRunBridgeOptions): SupervisorBindingContext {
  const rootDir = options.rootDir ?? (options.store ? dirname(options.store.filePath) : undefined)
  const store = options.store ?? (rootDir ? new SupervisorStateStore(rootDir) : undefined)
  return { rootDir, store }
}

async function getSupervisorRun(
  store: SupervisorStateStore | undefined,
  runId: string
): Promise<SupervisorRunRecord | undefined> {
  return store ? store.getRun(runId) : undefined
}

function supervisorRunIdentity(
  runId: string,
  workItem: WorkItem,
  workItemLease: SupervisorWorkItemLeaseBinding | undefined,
  accountingBase: SupervisorRunAccountingBase | undefined
): SupervisorRunIdentity {
  return {
    id: runId,
    projectId: workItem.projectId,
    ...(workItem.goalId === undefined ? {} : { goalId: workItem.goalId }),
    workItemId: workItem.id,
    origin: 'task_run',
    ...(workItemLease ? { workItemLease } : {}),
    ...(workItem.inheritedGoalContract?.budget
      ? { budget: structuredClone(workItem.inheritedGoalContract.budget) }
      : {}),
    ...(accountingBase ? { accountingBase: structuredClone(accountingBase) } : {})
  }
}

async function createOrLoadSupervisorRun(
  store: SupervisorStateStore,
  input: SupervisorRunIdentity,
  existingBeforeBinding: SupervisorRunRecord | undefined
): Promise<{ run: SupervisorRunRecord; created: boolean }> {
  try {
    if (existingBeforeBinding) return { run: existingBeforeBinding, created: false }
    return {
      run: await store.createRun(input, { actorId: 'supervisor-bridge' }),
      created: true
    }
  } catch (error) {
    if (!(error instanceof SupervisorStateError) || error.code !== 'already_exists') throw error
    const existing = await store.getRun(input.id)
    if (!existing) {
      throw new Error(`Supervisor Run ${input.id} disappeared after already_exists`)
    }
    assertSupervisorRunIdentity(existing, input)
    return { run: existing, created: false }
  }
}

/**
 * Startup binding for every persisted snapshot. A single failure is returned
 * to the caller so SessionManager can keep the recovery surface fail-closed.
 */
export async function recoverSupervisorRunBindings(
  snapshots: readonly TaskSnapshotRecord[],
  options: SupervisorTaskRunBridgeOptions = {}
): Promise<SupervisorRunBindingRecoveryResult> {
  const recoveryStore = resolveSupervisorBindingContext(options).store
  const result: SupervisorRunBindingRecoveryResult = {
    attached: [],
    existing: [],
    observed: [],
    unscoped: 0,
    failures: []
  }
  for (const snapshot of snapshots) {
    if (!snapshot.run) continue
    try {
      const bound = await ensureSupervisorRunBinding(snapshot.meta, snapshot.run, options)
      if (bound.disposition === 'unscoped' || bound.disposition === 'canonical_only') {
        result.unscoped += 1
      } else {
        result[bound.disposition].push(snapshot.run.id)
        if (!recoveryStore) throw new Error('Supervisor recovery observation requires a durable store')
        await reconcileSupervisorRunObservation(snapshot, recoveryStore)
        result.observed.push(snapshot.run.id)
      }
    } catch (error) {
      result.failures.push({
        runId: snapshot.run.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

async function reconcileSupervisorRunObservation(
  snapshot: TaskSnapshotRecord,
  store: SupervisorStateStore
): Promise<void> {
  const run = snapshot.run
  if (!run) return
  const turnResults = transcriptEntriesForRun(snapshot)
    .filter((entry) => entry.event.kind === 'turn-result')
  for (const entry of turnResults) {
    const event = entry.event
    if (event.kind !== 'turn-result') continue
    await store.observeRun(run.id, {
      taskRunStatus: run.status,
      sourceEventId: entry.eventId?.trim() || `snapshot:${snapshot.id}:turn:${entry.seq}`,
      usage: event.usage ?? emptyUsage(),
      costUsd: snapshot.meta.costUsd,
      turnCompleted: true,
      observedAt: entry.occurredAt ?? snapshot.updatedAt
    }, { actorId: 'supervisor-startup' })
  }
  if (turnResults.length === 0 && snapshot.execution.lastEventKind === 'turn-result') {
    await store.observeRun(run.id, {
      taskRunStatus: run.status,
      sourceEventId: snapshot.execution.lastEventId?.trim() ||
        `snapshot:${snapshot.id}:last-turn:${snapshot.execution.lastSeq}`,
      usage: snapshot.meta.usage,
      costUsd: snapshot.meta.costUsd,
      turnCompleted: true,
      observedAt: snapshot.execution.lastEventAt
    }, { actorId: 'supervisor-startup' })
  }
  await store.observeRun(run.id, {
    taskRunStatus: run.status,
    sourceEventId: `snapshot:${snapshot.id}:run:${run.id}:revision:${run.revision}`,
    usage: emptyUsage(),
    costUsd: snapshot.meta.costUsd,
    observedAt: snapshot.updatedAt
  }, { actorId: 'supervisor-startup' })
}

function transcriptEntriesForRun(snapshot: TaskSnapshotRecord): TaskSnapshotRecord['transcript'] {
  const run = snapshot.run
  if (!run) return []
  if (run.messageId) {
    const anchor = snapshot.transcript.findIndex((entry) =>
      entry.event.kind === 'user-message' && entry.event.messageId === run.messageId)
    if (anchor >= 0) return snapshot.transcript.slice(anchor + 1)
  }
  return snapshot.transcript.filter((entry) =>
    entry.occurredAt !== undefined && entry.occurredAt >= run.createdAt)
}

function emptyUsage(): SessionMeta['usage'] {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

/**
 * Classify a persisted Supervisor/TaskRun pair after a process restart.
 * Classification is deliberately pure: callers must perform any state
 * transition or user-authorized retry separately.
 */
export function classifySupervisorRestart(
  input: SupervisorRestartClassificationInput
): SupervisorRestartClassification {
  const { supervisor, taskRun } = input
  if (supervisor.status === 'completed' || supervisor.status === 'cancelled') {
    return { disposition: 'terminal', reason: `Supervisor is terminal: ${supervisor.status}` }
  }
  if (input.hasModelAttemptBarrier === true) {
    return {
      disposition: 'waiting_reconciliation',
      reason: 'ModelAttempt result is unknown; explicit reconciliation is required'
    }
  }
  if (supervisor.status === 'waiting_reconciliation') {
    return {
      disposition: 'waiting_reconciliation',
      reason: 'Supervisor is already waiting for reconciliation'
    }
  }
  if (!taskRun) {
    return {
      disposition: 'missing_task_run',
      reason: 'Supervisor Run has no matching durable TaskRun'
    }
  }
  if (hasUnresolvedTaskRunState(taskRun)) {
    return {
      disposition: 'waiting_reconciliation',
      reason: 'TaskRun contains an unresolved Effect or unknown tool outcome'
    }
  }
  if (taskRun.status === 'completed' || taskRun.status === 'cancelled') {
    return { disposition: 'terminal', reason: `TaskRun is terminal: ${taskRun.status}` }
  }
  if (taskRun.status === 'failed' || supervisor.status === 'failed') {
    return {
      disposition: 'failed_requires_authorization',
      reason: 'Retry requires an explicit authorization'
    }
  }
  if (supervisor.status === 'paused') {
    return { disposition: 'paused', reason: 'Supervisor was paused before restart' }
  }
  if (supervisor.status === 'blocked') {
    return { disposition: 'blocked', reason: 'Supervisor is blocked pending operator action' }
  }
  if (supervisor.status === 'waiting_approval' || taskRun.status === 'waiting_approval') {
    return { disposition: 'manual_approval', reason: 'Approval is pending and must be resolved explicitly' }
  }
  return {
    disposition: 'retryable',
    reason: `Non-terminal TaskRun can be resumed from ${taskRun.status}`
  }
}

function hasUnresolvedTaskRunState(run: TaskRunRecord): boolean {
  if (run.status === 'waiting_reconciliation') return true
  if ((run.effects ?? []).some((effect) =>
    effect.status === 'prepared' ||
    effect.status === 'executing' ||
    effect.status === 'waiting_reconciliation')) return true
  return (run.toolExecutions ?? []).some((execution) => execution.status === 'unknown_outcome')
}

function assertSupervisorRunIdentity(
  existing: SupervisorRunRecord,
  input: SupervisorRunIdentity
): void {
  if (
    existing.id !== input.id ||
    existing.projectId !== input.projectId ||
    existing.goalId !== input.goalId ||
    existing.workItemId !== input.workItemId ||
    (existing.origin !== undefined && existing.origin !== input.origin)
  ) {
    throw new Error(`Supervisor Run ${input.id} immutable canonical ownership changed`)
  }
  if (!sameWorkItemLease(existing.workItemLease, input.workItemLease)) {
    throw new Error(`Supervisor Run ${input.id} canonical WorkItem execution lease changed`)
  }
}

/**
 * A running canonical WorkItem is executable only while its source lease is
 * active.  The lease identity is copied into the Supervisor row so a later
 * release/takeover cannot accidentally continue an old Run under a new fence.
 * Ready WorkItems remain unbound until their caller promotes them to running;
 * this preserves the planning boundary for ordinary Session creation.
 */
function captureCanonicalWorkItemLease(item: WorkItem): SupervisorWorkItemLeaseBinding | undefined {
  if (item.status !== 'running') return undefined
  const lease = item.lease
  if (!lease || lease.expiresAt <= Date.now()) {
    throw new Error(`canonical WorkItem execution lease is missing or expired:${item.id}`)
  }
  return {
    id: lease.id,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken
  }
}

function sameWorkItemLease(
  left: SupervisorWorkItemLeaseBinding | undefined,
  right: SupervisorWorkItemLeaseBinding | undefined
): boolean {
  return left?.id === right?.id && left?.ownerId === right?.ownerId &&
    left?.fencingToken === right?.fencingToken
}

function assertClaimedSupervisorIdentity(
  existing: SupervisorRunRecord,
  meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>
): void {
  if (meta.workspaceId !== undefined && existing.projectId !== meta.workspaceId) {
    throw new Error(`Supervisor Run ${existing.id} immutable Workspace ownership changed`)
  }
  if (meta.goalId !== undefined && existing.goalId !== meta.goalId) {
    throw new Error(`Supervisor Run ${existing.id} immutable Goal ownership changed`)
  }
  if (meta.workItemId !== undefined && existing.workItemId !== meta.workItemId) {
    throw new Error(`Supervisor Run ${existing.id} immutable WorkItem ownership changed`)
  }
}
