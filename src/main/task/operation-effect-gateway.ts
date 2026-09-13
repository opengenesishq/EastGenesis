import { randomUUID } from 'node:crypto'
import type {
  EffectRecord,
  EffectStatus,
  InteractiveOperationKind,
  InteractiveOperationSource,
  SessionMeta,
  TaskRunRecord,
  TaskSnapshotRecord
} from '../../shared/types'
import { reconcileManagedWorktreeGitTarget } from '../git/managed-worktree-effect'
import {
  inspectManagedWorktreeRegistryProjection,
  projectConfirmedManagedWorktreeTarget
} from '../managed-worktree-lifecycle'
import {
  confirmedEffectFromArtifactProjectionError,
  completeEffectExecution,
  markEffectExecutionStarted,
  prepareEffectExecution,
  reconcilePersistedTaskSnapshot,
  runHasUnresolvedEffects,
  type PrepareEffectExecutionInput
} from './effect-runtime'
import { buildTaskSnapshot, deleteTaskSnapshot, getTaskSnapshot, saveTaskSnapshot } from './task-snapshot'
import { effectRecordIntegrityMatches } from './effect-record-integrity'
import { createTaskRun, isTaskRunTerminal, transitionTaskRun } from './task-run'
import { taskRuntimeRegistry } from './task-runtime-registry'
import { withSessionOperationQueue } from '../session-operation-queue'
import { bindWorkflowRunToCanonicalWorkItem } from './workflow-run-canonical-binding'

const activeOperationScopes = new Set<string>()

export interface InteractiveOperationEffectSpec<T> {
  /** Canonical ProjectWorkspace root used by application-owned operations. */
  rootDir?: string
  operationId?: string
  source?: InteractiveOperationSource
  kind: InteractiveOperationKind
  title: string
  sourceSessionId: string
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  cwd: string
  toolName: string
  toolInput: Record<string, unknown>
  execute: (effect: EffectRecord) => T | Promise<T>
  isSuccess: (result: T) => boolean
  resultSummary?: (result: T) => string
  failureDisposition?: () => 'failed' | 'waiting_reconciliation'
}

export type InteractiveOperationEffectOutcome<T> =
  | {
      status: 'completed'
      operationId: string
      effectId: string
      effectStatus: EffectStatus
      effect: EffectRecord
      value?: T
    }
  | {
      status: 'failed'
      operationId: string
      effectId?: string
      effectStatus?: EffectStatus
      value?: T
      error: string
    }
  | {
      status: 'waiting_reconciliation'
      operationId: string
      snapshotId: string
      effectId: string
      effectStatus: EffectStatus
      value?: T
      error: string
    }

interface InteractiveOperationExecutionContext {
  rootDir?: string
  operationId: string
  scopeId: string
  now: number
  run: TaskRunRecord
  meta: SessionMeta
  effectInput: PrepareEffectExecutionInput
}

type InteractiveEffectHandle = NonNullable<Awaited<ReturnType<typeof prepareEffectExecution>>>

interface InteractiveEffectAttempt<T> {
  value?: T
  executionError?: string
}

type InteractiveEffectCompletion<T> =
  | { kind: 'recorded'; effect: EffectRecord }
  | { kind: 'waiting'; outcome: InteractiveOperationEffectOutcome<T> }

/**
 * Runs one application-owned external mutation behind the same durable Effect
 * Ledger used by Agent tools. The synthetic scope is intentionally separate
 * from the source chat session so normal turn cleanup cannot delete it.
 */
export async function executeInteractiveOperationEffect<T>(
  spec: InteractiveOperationEffectSpec<T>
): Promise<InteractiveOperationEffectOutcome<T>> {
  const sourceSessionId = requireText(spec.sourceSessionId, 'sourceSessionId')
  return withSessionOperationQueue(sourceSessionId, async () => {
    const context = createOperationExecutionContext({ ...spec, sourceSessionId })
    activeOperationScopes.add(context.scopeId)
    try {
      return await executeActiveInteractiveOperation(spec, context)
    } catch (error) {
      return await settleFailedInteractiveOperation<T>(context, error)
    } finally {
      activeOperationScopes.delete(context.scopeId)
    }
  })
}

async function executeActiveInteractiveOperation<T>(
  spec: InteractiveOperationEffectSpec<T>,
  context: InteractiveOperationExecutionContext
): Promise<InteractiveOperationEffectOutcome<T>> {
  await initializeOperationScope(context)
  const started = await startInteractiveEffect(spec, context)
  const attempted = await executeInteractiveEffectCallback(spec, started.effect)
  const projection = ensureManagedWorktreeProjections({ ...context.run, effects: [started.effect] })
  const attempt = 'error' in projection
    ? { ...attempted, executionError: attempted.executionError ?? projection.error }
    : attempted
  const completion = await completeInteractiveEffect(spec, context, started.handle, attempt)
  if (completion.kind === 'waiting') return completion.outcome
  return settleInteractiveEffectOutcome(context, completion.effect, attempt)
}

function createOperationExecutionContext<T>(
  spec: InteractiveOperationEffectSpec<T>
): InteractiveOperationExecutionContext {
  const operationId = normalizeOperationId(spec.operationId ?? randomUUID())
  const scopeId = `operation:${operationId}`
  const toolUseId = `${scopeId}:effect:0`
  const now = Date.now()
  const operation = {
    schemaVersion: 1 as const,
    operationId,
    source: spec.source ?? 'renderer',
    kind: spec.kind,
    sourceSessionId: requireText(spec.sourceSessionId, 'sourceSessionId'),
    ...(spec.projectId?.trim() ? { projectId: spec.projectId.trim() } : {}),
    title: requireText(spec.title, 'title')
  }
  const run = transitionTaskRun(
    createTaskRun({ id: scopeId, sessionId: scopeId, taskId: operationId, operation, now }),
    'executing',
    { now }
  )
  const meta = operationMeta(scopeId, spec.cwd, operation.title, spec, now)
  const effectInput: PrepareEffectExecutionInput = {
    rootDir: spec.rootDir,
    sessionId: scopeId,
    cwd: spec.cwd,
    toolUseId,
    toolName: spec.toolName,
    toolInput: spec.toolInput
  }
  return { rootDir: spec.rootDir, operationId, scopeId, now, run, meta, effectInput }
}

async function initializeOperationScope(context: InteractiveOperationExecutionContext): Promise<void> {
  const persisted = await saveTaskSnapshot(buildTaskSnapshot({
    meta: context.meta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'important-event',
    run: context.run,
    subtasks: [],
    dagExecutions: [],
    now: context.now
  }), context.rootDir)
  context.run = persisted.run ?? context.run
  context.effectInput.toolUseId = nextOperationEffectToolUseId(context.scopeId, context.run)
  taskRuntimeRegistry.set(context.scopeId, context.run)
  await bindWorkflowRunToCanonicalWorkItem(context.meta, context.run, context.rootDir)
}

function nextOperationEffectToolUseId(scopeId: string, run: TaskRunRecord): string {
  const prefix = `${scopeId}:effect:`
  const generation = (run.effects ?? []).reduce((max, effect) => {
    if (!effect.toolUseId.startsWith(prefix)) return max
    const candidate = Number.parseInt(effect.toolUseId.slice(prefix.length), 10)
    return Number.isInteger(candidate) && candidate >= 0 ? Math.max(max, candidate + 1) : max
  }, 0)
  return `${prefix}${generation}`
}

async function startInteractiveEffect<T>(
  spec: InteractiveOperationEffectSpec<T>,
  context: InteractiveOperationExecutionContext
): Promise<{ handle: InteractiveEffectHandle; effect: EffectRecord }> {
  const handle = await prepareEffectExecution(context.effectInput)
  if (!handle) throw new Error(`工具 ${spec.toolName} 未被识别为外部副作用，已拒绝执行`)
  await markEffectExecutionStarted(handle, context.effectInput)
  const effect = taskRuntimeRegistry.get(context.scopeId)?.effects?.find((item) => item.id === handle.effectId)
  if (!effect || effect.status !== 'executing') {
    throw new Error('EffectRecord 未以 executing 状态跨过持久化屏障，已拒绝执行')
  }
  return { handle, effect }
}

async function executeInteractiveEffectCallback<T>(
  spec: InteractiveOperationEffectSpec<T>,
  effect: EffectRecord
): Promise<InteractiveEffectAttempt<T>> {
  try {
    return { value: await spec.execute(effect) }
  } catch (error) {
    return { executionError: errorText(error) }
  }
}

async function completeInteractiveEffect<T>(
  spec: InteractiveOperationEffectSpec<T>,
  context: InteractiveOperationExecutionContext,
  handle: InteractiveEffectHandle,
  attempt: InteractiveEffectAttempt<T>
): Promise<InteractiveEffectCompletion<T>> {
  try {
    const effect = await completeEffectExecution(handle, {
      ok: attempt.executionError === undefined && attempt.value !== undefined && spec.isSuccess(attempt.value),
      output: attempt.executionError ?? summarizeResult(attempt.value, spec.resultSummary)
    })
    if (!effect) throw new Error('Effect Runtime 未返回外部效果记录')
    return { kind: 'recorded', effect }
  } catch (error) {
    const confirmedEffect = confirmedEffectFromArtifactProjectionError(error)
    if (confirmedEffect) {
      const message = `外部操作效果已确认，但 Artifact/Evidence/Acceptance 投影未收敛:${errorText(error)}`
      await ensureOperationWaiting(context, message)
      return {
        kind: 'waiting',
        outcome: waitingOutcome(context, confirmedEffect.id, attempt.value, message, confirmedEffect.status)
      }
    }
    return {
      kind: 'waiting',
      outcome: waitingOutcome(
        context,
        handle.effectId,
        attempt.value,
        `外部操作已经开始，但结果账本未能收敛:${errorText(error)}`
      )
    }
  }
}

async function settleInteractiveEffectOutcome<T>(
  context: InteractiveOperationExecutionContext,
  effect: EffectRecord,
  attempt: InteractiveEffectAttempt<T>
): Promise<InteractiveOperationEffectOutcome<T>> {
  if (isConfirmedEffect(effect)) {
    const projectionError = await finalizeOperationScope(context, 'completed')
    if (projectionError) {
      return waitingOutcome(context, effect.id, attempt.value, projectionError, effect.status)
    }
    return completedOutcome(context.operationId, effect, attempt.value)
  }
  if (isUnresolvedEffect(effect)) {
    await ensureOperationWaiting(context)
    const error = attempt.executionError ?? effect.error ?? '外部操作结果无法唯一确认，已禁止自动重放'
    return waitingOutcome(context, effect.id, attempt.value, error, effect.status)
  }
  const error = attempt.executionError ?? effect.error ?? '外部操作失败'
  await finalizeOperationScope(context, 'failed', error)
  return failedEffectOutcome(context.operationId, effect, attempt.value, error)
}

async function settleFailedInteractiveOperation<T>(
  context: InteractiveOperationExecutionContext,
  error: unknown
): Promise<InteractiveOperationEffectOutcome<T>> {
  const settled = await settleOperationAfterPreExecutionFailure(context)
  if (settled?.run?.status === 'waiting_reconciliation') {
    const effect = latestEffect(settled.run)
    return waitingRecoveryOutcome(
      context,
      effect?.id ?? `${context.scopeId}:unknown`,
      errorText(error)
    )
  }
  return { status: 'failed', operationId: context.operationId, error: errorText(error) }
}

function completedOutcome<T>(
  operationId: string,
  effect: EffectRecord,
  value: T | undefined
): InteractiveOperationEffectOutcome<T> {
  return { status: 'completed', operationId, effectId: effect.id, effectStatus: effect.status, effect, value }
}

function waitingOutcome<T>(
  context: InteractiveOperationExecutionContext,
  effectId: string,
  value: T | undefined,
  error: string,
  effectStatus: EffectStatus = 'waiting_reconciliation'
): InteractiveOperationEffectOutcome<T> {
  return {
    status: 'waiting_reconciliation',
    operationId: context.operationId,
    snapshotId: context.scopeId,
    effectId,
    effectStatus,
    value,
    error
  }
}

function waitingRecoveryOutcome<T>(
  context: InteractiveOperationExecutionContext,
  effectId: string,
  error: string
): InteractiveOperationEffectOutcome<T> {
  return {
    status: 'waiting_reconciliation',
    operationId: context.operationId,
    snapshotId: context.scopeId,
    effectId,
    effectStatus: 'waiting_reconciliation',
    error
  }
}

function failedEffectOutcome<T>(
  operationId: string,
  effect: EffectRecord,
  value: T | undefined,
  error: string
): InteractiveOperationEffectOutcome<T> {
  return { status: 'failed', operationId, effectId: effect.id, effectStatus: effect.status, value, error }
}

function isConfirmedEffect(effect: EffectRecord): boolean {
  return effect.status === 'confirmed' || effect.status === 'compensated'
}

function isUnresolvedEffect(effect: EffectRecord): boolean {
  return effect.status === 'waiting_reconciliation' || effect.status === 'executing' || effect.status === 'prepared'
}

export function isInteractiveOperationSnapshot(snapshot: TaskSnapshotRecord): boolean {
  return snapshot.run?.operation !== undefined
}

export function isInteractiveOperationActive(snapshotOrScopeId: TaskSnapshotRecord | string): boolean {
  const scopeId = typeof snapshotOrScopeId === 'string'
    ? snapshotOrScopeId
    : snapshotOrScopeId.sessionId
  return activeOperationScopes.has(scopeId)
}

/** Reconciles a stopped operation and removes recovery state only after settlement. */
export async function settleStoppedInteractiveOperationSnapshot(
  snapshot: TaskSnapshotRecord
): Promise<TaskSnapshotRecord | null> {
  if (!isInteractiveOperationSnapshot(snapshot)) return snapshot
  if (isInteractiveOperationActive(snapshot)) return null
  const stored = await getTaskSnapshot(snapshot.id)
  let current = stored ?? snapshot
  const projection = ensureManagedWorktreeProjections(current.run)
  if ('error' in projection) return await saveProjectionWaitingSnapshot(current, projection.error)
  if (current.run && (runHasUnresolvedEffects(current.run) ||
      current.run.status === 'waiting_reconciliation')) {
    current = await reconcilePersistedTaskSnapshot(current)
  }
  if (runHasUnresolvedEffects(current.run)) return current
  const successful = current.run?.effects?.length
    ? current.run.effects.every((effect) => effect.status === 'confirmed' || effect.status === 'compensated')
    : false
  const finalRun = current.run
    ? settleRun(current.run, successful ? 'completed' : 'failed', successful ? undefined : '交互操作未完成')
    : undefined
  await deleteTaskSnapshot(current.id, undefined, finalRun)
  taskRuntimeRegistry.delete(current.sessionId)
  return null
}

async function ensureOperationWaiting(
  context: Pick<InteractiveOperationExecutionContext, 'scopeId' | 'rootDir'>,
  error?: string
): Promise<void> {
  const { scopeId, rootDir } = context
  const snapshot = await getTaskSnapshot(scopeId, rootDir)
  const current = taskRuntimeRegistry.get(scopeId) ?? snapshot?.run
  if (!snapshot || !current) return
  const transitioned = current.status === 'waiting_reconciliation'
    ? current
    : transitionTaskRun(current, 'waiting_reconciliation')
  const run = error ? { ...transitioned, error } : transitioned
  await saveTaskSnapshot({ ...snapshot, updatedAt: Date.now(), run }, rootDir)
  taskRuntimeRegistry.set(scopeId, run)
}

async function finalizeOperationScope(
  context: Pick<InteractiveOperationExecutionContext, 'scopeId' | 'rootDir'>,
  status: 'completed' | 'failed',
  error?: string
): Promise<string | undefined> {
  const { scopeId, rootDir } = context
  const snapshot = await getTaskSnapshot(scopeId, rootDir)
  const current = taskRuntimeRegistry.get(scopeId) ?? snapshot?.run
  if (!current) throw new Error('交互操作的 TaskRun 已丢失，无法收敛恢复入口')
  if (status === 'completed') {
    const projection = ensureManagedWorktreeProjections(current)
    if ('error' in projection) {
      const message = `外部效果已确认，但 managed worktree projection 未收敛: ${projection.error}`
      await ensureOperationWaiting(context, message)
      return message
    }
  }
  const finalRun = settleRun(current, status, error)
  await deleteTaskSnapshot(scopeId, rootDir, finalRun)
  taskRuntimeRegistry.delete(scopeId)
  return undefined
}

async function settleOperationAfterPreExecutionFailure(
  context: Pick<InteractiveOperationExecutionContext, 'scopeId' | 'rootDir'>
): Promise<TaskSnapshotRecord | null> {
  const { scopeId, rootDir } = context
  const snapshot = await getTaskSnapshot(scopeId, rootDir)
  if (!snapshot) {
    taskRuntimeRegistry.delete(scopeId)
    return null
  }
  if (runHasUnresolvedEffects(snapshot.run)) return snapshot
  const projection = ensureManagedWorktreeProjections(snapshot.run)
  if (!projection.ok) return snapshot
  const run = snapshot.run ? settleRun(snapshot.run, 'failed', '交互操作在外部执行前停止') : undefined
  await deleteTaskSnapshot(scopeId, rootDir, run)
  taskRuntimeRegistry.delete(scopeId)
  return null
}

function ensureManagedWorktreeProjections(
  run: TaskRunRecord | undefined
): { ok: true; projected: boolean } | { ok: false; error: string } {
  let projected = false
  for (const effect of run?.effects ?? []) {
    if (effect.target.kind !== 'git_worktree_create' && effect.target.kind !== 'git_worktree_remove') continue
    if (!effectRecordIntegrityMatches(effect)) {
      return { ok: false, error: 'managed worktree EffectRecord 摘要校验失败，已拒绝 registry projection' }
    }
    const registry = inspectManagedWorktreeRegistryProjection(effect.target)
    if (registry.kind === 'confirmed') continue
    const gitState = reconcileManagedWorktreeGitTarget(effect.target)
    if (gitState.kind !== 'confirmed') {
      if (effect.status === 'confirmed') {
        return { ok: false, error: 'Effect 已确认，但 managed worktree Git 后置条件不成立' }
      }
      continue
    }
    const projection = projectConfirmedManagedWorktreeTarget(effect.target)
    if ('error' in projection) return { ok: false, error: projection.error }
    projected = true
  }
  return { ok: true, projected }
}

async function saveProjectionWaitingSnapshot(
  snapshot: TaskSnapshotRecord,
  error: string
): Promise<TaskSnapshotRecord> {
  if (!snapshot.run) return snapshot
  const transitioned = snapshot.run.status === 'waiting_reconciliation'
    ? snapshot.run
    : transitionTaskRun(snapshot.run, 'waiting_reconciliation')
  const run = { ...transitioned, error }
  const saved = await saveTaskSnapshot({ ...snapshot, updatedAt: Date.now(), run })
  taskRuntimeRegistry.set(run.sessionId, run)
  return saved
}

function settleRun(
  current: TaskRunRecord,
  status: 'completed' | 'failed',
  error?: string
): TaskRunRecord {
  if (isTaskRunTerminal(current.status)) return current
  let base = current
  if (status === 'completed' && base.status === 'waiting_reconciliation') {
    base = transitionTaskRun(base, 'executing')
  }
  return transitionTaskRun(base, status, { error })
}

function operationMeta(
  scopeId: string,
  cwd: string,
  title: string,
  ownership: Pick<InteractiveOperationEffectSpec<unknown>, 'projectId' | 'workspaceId' | 'goalId' | 'workItemId'>,
  createdAt: number
): SessionMeta {
  const projectId = ownership.projectId?.trim()
  const workspaceId = ownership.workspaceId?.trim()
  const goalId = ownership.goalId?.trim()
  const workItemId = ownership.workItemId?.trim()
  return {
    id: scopeId,
    title: `操作恢复: ${title}`,
    cwd: requireText(cwd, 'cwd'),
    ...(projectId ? { projectId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(goalId ? { goalId } : {}),
    ...(workItemId ? { workItemId } : {}),
    model: '',
    providerId: '',
    taskStrategy: 'execute',
    permissionMode: 'default',
    status: 'running',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt
  }
}

function latestEffect(run: TaskRunRecord | undefined): EffectRecord | undefined {
  return [...(run?.effects ?? [])].sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

function summarizeResult<T>(value: T | undefined, formatter?: (result: T) => string): string {
  if (value === undefined) return '外部操作没有返回结果'
  if (formatter) return formatter(value).slice(0, 8_192)
  try {
    return JSON.stringify(value).slice(0, 8_192)
  } catch {
    return String(value).slice(0, 8_192)
  }
}

function normalizeOperationId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.includes('\0') || normalized.includes(':')) {
    throw new Error('operationId 不能为空或包含非法字符')
  }
  return normalized
}

function requireText(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.includes('\0')) throw new Error(`${field} 不能为空或包含非法字符`)
  return normalized
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
