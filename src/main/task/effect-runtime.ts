import { randomUUID } from 'node:crypto'
import type { EffectRecord, TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import { projectConfirmedManagedWorktreeTarget } from '../managed-worktree-lifecycle'
import { isObservedMediaCancellationNotApplied } from '../media/media-cancel-reconciliation'
import {
  abandonPreparedEffect,
  applyEffectReconciliation,
  completeEffect,
  hasUnresolvedEffects,
  hasWaitingReconciliation,
  manuallyResolveEffect,
  markEffectExecuting,
  prepareEffect,
  type EffectExecutionHandle
} from './effect-ledger'
import { effectRecordIntegrityMatches } from './effect-record-integrity'
import { buildEffectDescriptor, reconcileEffect } from './effect-reconciler'
import {
  effectEntryReplayPolicyForTool,
  type EffectEntryReplayPolicy
} from './effect-entry-inventory'
import {
  officeArtifactEffectHasOutputBinding,
  registerConfirmedRunArtifactLifecycles
} from './artifact-lifecycle-producer'
import { getTaskSnapshot, saveTaskRunBarrier, saveTaskSnapshot } from './task-snapshot'
import { taskRuntimeRegistry } from './task-runtime-registry'
import { isTaskRunTerminal, transitionTaskRun } from './task-run'
import { isSideEffectingToolCall, stableValueDigest } from './tool-idempotency'

const PROCESS_OWNER_ID = `caogen:${process.pid}:${randomUUID()}`
const sessionQueues = new Map<string, Promise<unknown>>()

export interface PrepareEffectExecutionInput {
  /** Canonical application data root for Project-owned operations. */
  rootDir?: string
  sessionId: string
  cwd: string
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
}

export interface CompleteEffectExecutionInput {
  ok: boolean
  output: string
  /**
   * Some application-owned operations have an atomic local failure boundary.
   * They may explicitly classify a callback failure as terminal; all other
   * queryable effects remain waiting_reconciliation by default.
   */
  failureDisposition?: 'failed' | 'waiting_reconciliation'
}

export class ConfirmedEffectArtifactProjectionError extends Error {
  readonly effect: EffectRecord
  readonly projectionCause: unknown

  constructor(effect: EffectRecord, cause: unknown) {
    super(`Effect ${effect.id} is confirmed, but Artifact projection failed: ${errorText(cause)}`)
    this.name = 'ConfirmedEffectArtifactProjectionError'
    this.effect = effect
    this.projectionCause = cause
  }
}

export function confirmedEffectFromArtifactProjectionError(error: unknown): EffectRecord | undefined {
  return error instanceof ConfirmedEffectArtifactProjectionError ? error.effect : undefined
}

export async function prepareEffectExecution(
  input: PrepareEffectExecutionInput
): Promise<EffectExecutionHandle | null> {
  if (!isSideEffectingToolCall(input.toolName, input.toolInput)) return null
  return withSessionQueue(input.sessionId, async () => {
    const run = requireRun(input.sessionId)
    const descriptor = await buildEffectDescriptor({
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      cwd: input.cwd
    })
    // The inventory is the policy authority for native tool entrypoints. An
    // opaque/delegated/direct-user entry must stay opaque even when its target
    // happens to have a generic reconciler; otherwise a restart could turn a
    // static manual barrier into an automatic retry.
    const replayPolicy = effectEntryReplayPolicyForTool(input.toolName)
    // Keep a dedicated read-only reconciler (for example an MCP state query)
    // available even when the entry's replay policy is manual. The gate below
    // removes only automatic retry authorization from a `not_applied` probe;
    // an observed confirmed state remains safe to accept.
    const gatedDescriptor = descriptor
    const prepared = prepareEffect(run, {
      sessionId: input.sessionId,
      cwd: input.cwd,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      descriptor: gatedDescriptor,
      ownerId: PROCESS_OWNER_ID
    })
    if (!prepared.created) return { ...prepared.handle, rootDir: input.rootDir }
    const persisted = await persistRun(prepared.run, prepared.handle.effectId, input.rootDir)
    return { ...effectHandleFromRecord(requireEffect(persisted, prepared.handle.effectId)), rootDir: input.rootDir }
  })
}

export async function markEffectExecutionStarted(
  handle: EffectExecutionHandle | null,
  input: PrepareEffectExecutionInput
): Promise<void> {
  if (!handle) return
  await withSessionQueueByHandle(handle, async (run) => {
    const effect = requireEffect(run, handle.effectId)
    let descriptor
    try {
      descriptor = await buildEffectDescriptor({
        sessionId: input.sessionId,
        toolName: input.toolName,
        toolInput: input.toolInput,
        cwd: input.cwd
      })
    } catch (error) {
      const reason = `执行前无法重新验证效果目标:${error instanceof Error ? error.message : String(error)}`
      const abandoned = abandonPreparedEffect(run, handle, reason)
      if (abandoned !== run) await persistRun(abandoned, handle.effectId, input.rootDir ?? handle.rootDir)
      throw new Error(reason)
    }
    if (
      input.sessionId !== handle.sessionId ||
      input.toolUseId !== handle.toolUseId ||
      descriptor.targetDigest !== effect.targetDigest ||
      descriptor.intentDigest !== effect.intentDigest ||
      descriptor.inputDigest !== effect.inputDigest
    ) {
      const reason = '执行前目标或输入已变化，旧审批与效果意图失效；请基于当前状态重新审批'
      const abandoned = abandonPreparedEffect(run, handle, reason)
      if (abandoned !== run) await persistRun(abandoned, handle.effectId, input.rootDir ?? handle.rootDir)
      throw new Error(reason)
    }
    const next = markEffectExecuting(run, handle)
    if (next !== run) await persistRun(next, handle.effectId, input.rootDir ?? handle.rootDir)
  })
}

export async function completeEffectExecution(
  handle: EffectExecutionHandle | null,
  result: CompleteEffectExecutionInput
): Promise<EffectRecord | null> {
  if (!handle) return null
  return withSessionQueueByHandle(handle, async (run) => {
    const effect = requireEffect(run, handle.effectId)
    const replayPolicy = effectEntryReplayPolicyForTool(effect.toolName)
    let next: TaskRunRecord
    if (requiresManualReplay(replayPolicy) && effect.reconcilability === 'queryable') {
      const observed = completeEffect(
        run,
        handle,
        'waiting_reconciliation',
        stableValueDigest({ ok: result.ok, output: result.output }),
        result.ok
          ? '入口策略禁止自动重试，正在执行只读目标对账'
          : '入口策略禁止自动重试，正在执行只读目标对账'
      )
      const probed = await reconcileEffect(requireEffect(observed, effect.id), {}, handle.rootDir)
      next = applyEffectReconciliation(
        observed,
        effect.id,
        gateReplayResult(effect, replayPolicy, probed)
      )
    } else if (requiresManualReplay(replayPolicy)) {
      if (result.ok) {
        next = completeEffect(
          run,
          handle,
          'confirmed',
          stableValueDigest({ ok: true, output: result.output }),
          '工具返回成功；入口策略要求重启后人工对账，已跳过自动查询'
        )
      } else {
        const waiting = completeEffect(
          run,
          handle,
          'waiting_reconciliation',
          stableValueDigest({ ok: false, output: result.output }),
          '入口策略要求人工对账，已跳过自动查询'
        )
        next = applyEffectReconciliation(waiting, effect.id, manualReplayBarrier(effect, replayPolicy))
      }
    } else if (effect.reconcilability === 'queryable' &&
        !result.ok && result.failureDisposition === 'failed') {
      next = completeEffect(
        run,
        handle,
        'failed',
        stableValueDigest({ ok: false, output: result.output }),
        '应用操作报告了可确定的失败，未进入外部副作用对账'
      )
    } else if (effect.reconcilability === 'queryable') {
      const observed = completeEffect(
        run,
        handle,
        'waiting_reconciliation',
        stableValueDigest({ ok: result.ok, output: result.output }),
        result.ok
          ? '工具报告成功，正在验证目标后置条件'
          : '工具报告失败，正在查询目标是否已产生部分副作用'
      )
      const probed = await reconcileEffect(requireEffect(observed, effect.id), {}, handle.rootDir)
      const reconciliation = result.ok && probed.kind === 'not_applied'
        ? {
            kind: 'unresolved' as const,
            evidenceDigest: stableValueDigest({
              effectId: effect.id,
              toolResultDigest: stableValueDigest(result),
              probeEvidenceDigest: probed.evidenceDigest,
              reason: 'successful_tool_missing_postcondition'
            }),
            verifier: 'effect-runtime-postcondition-v1',
            reason: '工具报告成功，但目标后置条件未出现；可能执行了不同效果，已禁止自动重试'
          }
        : probed
      next = applyEffectReconciliation(observed, effect.id, reconciliation)
    } else if (result.ok) {
      next = completeEffect(
        run,
        handle,
        'confirmed',
        stableValueDigest({ ok: true, output: result.output }),
        '工具返回明确成功结果'
      )
    } else {
      next = completeEffect(
        run,
        handle,
        'waiting_reconciliation',
        stableValueDigest({ ok: false, output: result.output }),
        '不可查询工具返回失败，但可能已产生部分副作用，已按 fail-closed 等待人工对账'
      )
    }
    const persisted = await persistRun(next, handle.effectId, handle.rootDir)
    return requireEffect(persisted, handle.effectId)
  })
}

export async function cancelEffectExecution(
  handle: EffectExecutionHandle | null,
  reason: string
): Promise<void> {
  if (!handle) return
  await withSessionQueueByHandle(handle, async (run) => {
    const next = abandonPreparedEffect(run, handle, reason)
    if (next !== run) {
      await persistRun(next, handle.effectId, handle.rootDir)
    }
  })
}

async function reconcileStoppedTaskRunEffects(
  run: TaskRunRecord,
  engine: TaskSnapshotRecord['engine'],
  rootDir?: string
): Promise<TaskRunRecord> {
  let next = run
  const candidates = (run.effects ?? []).filter((effect) =>
    effect.status === 'prepared' ||
    effect.status === 'executing' ||
    effect.status === 'waiting_reconciliation'
  )
  for (const candidate of candidates) {
    const current = requireEffect(next, candidate.id)
    if (current.status === 'prepared' && (usesPreExecutionNativeToolGate(engine) || run.operation !== undefined)) {
      const handle = effectHandleFromRecord(current)
      next = abandonPreparedEffect(
        next,
        handle,
        run.operation !== undefined
          ? `${run.operation.source} 操作仍处于 prepared 状态；Gateway 尚未跨过 executing 屏障，已确认外部执行未开始`
          : `${engine} 原生工具仍处于审批前 prepared 状态，已确认外部执行未开始`
      )
      continue
    }
    const replayPolicy = effectEntryReplayPolicyForTool(current.toolName)
    if (requiresManualReplay(replayPolicy)) {
      if (current.reconcilability === 'queryable') {
        const probed = await reconcileEffect(current, {}, rootDir)
        next = applyEffectReconciliation(next, current.id, gateReplayResult(current, replayPolicy, probed))
      } else {
        next = applyEffectReconciliation(next, current.id, manualReplayBarrier(current, replayPolicy))
      }
      continue
    }
    const probed = await reconcileEffect(current, {}, rootDir)
    const result = probed.kind === 'not_applied' && current.lease?.ownerId === PROCESS_OWNER_ID && !isObservedMediaCancellationNotApplied(probed, current.target)
      ? {
          kind: 'unresolved' as const,
          evidenceDigest: stableValueDigest({
            effectId: current.id,
            ownerId: current.lease.ownerId,
            probeEvidenceDigest: probed.evidenceDigest,
            reason: 'same_process_owner_not_stopped'
          }),
          verifier: 'effect-runtime-owner-fence-v1',
          reason: '效果仍由当前进程持有，尚无独立的执行器终止证据；已拒绝采信 not_applied 并禁止自动重试'
        }
      : probed
    next = applyEffectReconciliation(next, current.id, result)
  }
  return next
}

function requiresManualReplay(policy: EffectEntryReplayPolicy | undefined): boolean {
  return policy === 'manual_reconciliation' || policy === 'never' || policy === 'downstream_barrier'
}

function manualReplayBarrier(
  effect: EffectRecord,
  policy: EffectEntryReplayPolicy | undefined
): {
  kind: 'unresolved'
  evidenceDigest: string
  verifier: string
  reason: string
} {
  const label = policy ?? 'unclassified'
  return {
    kind: 'unresolved',
    evidenceDigest: stableValueDigest({
      effectId: effect.id,
      effectKey: effect.effectKey,
      generation: effect.generation,
      replayPolicy: label
    }),
    verifier: 'effect-entry-replay-gate-v1',
    reason: `入口策略 ${label} 禁止自动重放；需要人工对账或下游屏障`
  }
}

function gateReplayResult(
  effect: EffectRecord,
  policy: EffectEntryReplayPolicy | undefined,
  result: Awaited<ReturnType<typeof reconcileEffect>>
): Awaited<ReturnType<typeof reconcileEffect>> {
  if (result.kind !== 'not_applied') return result
  const barrier = manualReplayBarrier(effect, policy)
  return {
    ...barrier,
    evidenceDigest: stableValueDigest({
      effectId: effect.id,
      replayPolicy: policy ?? 'unclassified',
      probeEvidenceDigest: result.evidenceDigest
    }),
    reason: `${barrier.reason}；只读对账结果为 not_applied，未授予 retry_authorized`
  }
}

function usesPreExecutionNativeToolGate(engine: TaskSnapshotRecord['engine']): boolean {
  return engine === 'openai' || engine === 'anthropic' || engine === 'gemini'
}

function effectHandleFromRecord(effect: EffectRecord): EffectExecutionHandle {
  if (!effect.lease) throw new Error(`EffectRecord 缺少 lease:${effect.id}`)
  return {
    sessionId: effect.sessionId,
    effectId: effect.id,
    effectKey: effect.effectKey,
    resourceKey: effect.resourceKey,
    leaseId: effect.lease.id,
    ownerId: effect.lease.ownerId,
    fencingToken: effect.lease.fencingToken,
    toolUseId: effect.toolUseId,
    target: effect.target,
    targetDigest: effect.targetDigest
  }
}

export async function reconcileTaskSnapshotEffects(
  snapshot: TaskSnapshotRecord,
  options: { processStopped: true; rootDir?: string }
): Promise<TaskSnapshotRecord> {
  if (options.processStopped !== true) throw new Error('外部效果只能在确认原执行进程已停止后对账')
  if (!snapshot.run?.effects?.length) return snapshot
  let run = await reconcileStoppedTaskRunEffects(
    snapshot.run,
    snapshot.engine ?? snapshot.meta.engine,
    options.rootDir
  )
  if (hasWaitingReconciliation(run) && !isTaskRunTerminal(run.status) && run.status !== 'waiting_reconciliation') {
    run = transitionTaskRun(run, 'waiting_reconciliation', {
      lastEventKind: snapshot.execution.lastEventKind
    })
  }
  return run === snapshot.run
    ? snapshot
    : { ...snapshot, updatedAt: Math.max(snapshot.updatedAt, run.updatedAt), run }
}

export async function reconcilePersistedTaskSnapshot(
  candidate: TaskSnapshotRecord,
  rootDir?: string
): Promise<TaskSnapshotRecord> {
  const reconciled = await reconcileQueuedTaskSnapshot(candidate, false, rootDir)
  if (!reconciled) throw new Error('任务快照在对账期间意外消失')
  return reconciled
}

/** Reconcile a list result without recreating a snapshot deleted after that list read. */
export function reconcileExistingPersistedTaskSnapshot(
  candidate: TaskSnapshotRecord,
  rootDir?: string
): Promise<TaskSnapshotRecord | null> {
  return reconcileQueuedTaskSnapshot(candidate, true, rootDir)
}

function reconcileQueuedTaskSnapshot(
  candidate: TaskSnapshotRecord,
  requireStored: boolean,
  rootDir?: string
): Promise<TaskSnapshotRecord | null> {
  return withSessionQueue(candidate.sessionId, async () => {
    const stored = await getTaskSnapshot(candidate.id, rootDir)
    if (requireStored && !stored) return null
    const base = stored && compareSnapshotFreshness(stored, candidate) >= 0 ? stored : candidate
    const reconciled = await reconcileTaskSnapshotEffects(base, { processStopped: true, rootDir })
    const persisted = reconciled === stored ? stored : await saveTaskSnapshot(reconciled, rootDir)
    if (!persisted) throw new Error('任务快照在对账期间被删除')
    if (persisted.run) {
      taskRuntimeRegistry.set(persisted.run.sessionId, persisted.run)
      await registerConfirmedRunArtifactLifecycles(persisted.run, rootDir)
    }
    return persisted
  })
}

export async function resolvePersistedTaskEffect(
  snapshotId: string,
  effectId: string,
  expectedRevision: number,
  resolution: 'confirmed_applied' | 'confirmed_not_applied',
  options: { beforePersist?(effect: EffectRecord): void | Promise<void> } = {}
): Promise<TaskSnapshotRecord> {
  return withSessionQueue(snapshotId, async () => {
    const snapshot = await getTaskSnapshot(snapshotId)
    if (!snapshot?.run) throw new Error('任务快照没有可处置的效果账本')
    const effect = snapshot.run.effects?.find((item) => item.id === effectId)
    if (!effect) throw new Error(`未找到 EffectRecord:${effectId}`)
    if (effect.revision !== expectedRevision) {
      throw new Error(`stale_revision: EffectRecord 已从 ${expectedRevision} 更新到 ${effect.revision}`)
    }
    const managedWorktreeEffect = isManagedWorktreeEffect(effect)
    if (managedWorktreeEffect && !effectRecordIntegrityMatches(effect)) {
      throw new Error('managed worktree EffectRecord 摘要校验失败，已拒绝人工处置')
    }
    if (resolution === 'confirmed_applied' && managedWorktreeEffect) {
      const projection = projectConfirmedManagedWorktreeTarget(effect.target)
      if ('error' in projection) {
        throw new Error(`Effect 已由用户确认，但 managed worktree projection 失败: ${projection.error}`)
      }
    }
    if (resolution === 'confirmed_applied' && effect.target.kind === 'office_artifact' &&
        !officeArtifactEffectHasOutputBinding(effect)) {
      throw new Error(
        '旧版 Office Effect 缺少确定性输出绑定，禁止确认已应用；请选择未应用后重新生成，或重新审批'
      )
    }
    await options.beforePersist?.(effect)
    const run = manuallyResolveEffect(snapshot.run, effectId, resolution)
    const persisted = await saveTaskSnapshot({ ...snapshot, updatedAt: Date.now(), run })
    const persistedRun = persisted.run ?? run
    taskRuntimeRegistry.set(run.sessionId, persistedRun)
    await registerConfirmedRunArtifactLifecycles(persistedRun)
    return persisted
  })
}

function isManagedWorktreeEffect(effect: EffectRecord): effect is EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'git_worktree_create' | 'git_worktree_remove' }>
} {
  return effect.target.kind === 'git_worktree_create' || effect.target.kind === 'git_worktree_remove'
}

export function runHasWaitingEffects(run: TaskRunRecord | undefined): boolean {
  return hasWaitingReconciliation(run)
}

export function runHasUnresolvedEffects(run: TaskRunRecord | undefined): boolean {
  return hasUnresolvedEffects(run)
}

async function withSessionQueueByHandle<T>(
  handle: EffectExecutionHandle,
  task: (run: TaskRunRecord) => Promise<T>
): Promise<T> {
  return withSessionQueue(handle.sessionId, async () => task(await requireRunForHandle(handle)))
}

async function requireRunForHandle(handle: EffectExecutionHandle): Promise<TaskRunRecord> {
  const current = taskRuntimeRegistry.get(handle.sessionId)
  if (current) return current

  const snapshot = await getTaskSnapshot(handle.sessionId, handle.rootDir)
  const run = snapshot?.run
  if (!run || run.sessionId !== handle.sessionId) {
    throw new Error('当前会话没有 TaskRun，已按 fail-closed 阻止外部副作用')
  }
  const effect = run.effects?.find((candidate) => candidate.id === handle.effectId)
  const lease = effect?.lease
  if (!effect || !lease || effect.effectKey !== handle.effectKey ||
      effect.resourceKey !== handle.resourceKey || effect.toolUseId !== handle.toolUseId ||
      effect.targetDigest !== handle.targetDigest || lease.id !== handle.leaseId ||
      lease.ownerId !== handle.ownerId || lease.fencingToken !== handle.fencingToken) {
    throw new Error('持久化 EffectRecord 与执行 handle 不一致，已按 fail-closed 阻止外部副作用')
  }
  taskRuntimeRegistry.set(handle.sessionId, run)
  return taskRuntimeRegistry.get(handle.sessionId) ?? run
}

async function persistRun(
  run: TaskRunRecord,
  requiredEffectId?: string,
  rootDir?: string
): Promise<TaskRunRecord> {
  const persisted = await saveTaskRunBarrier(run, rootDir)
  if (requiredEffectId) {
    const expected = run.effects?.find((effect) => effect.id === requiredEffectId)
    const stored = persisted.effects?.find((effect) => effect.id === requiredEffectId)
    if (!expected || !stored || stored.revision < expected.revision) {
      throw new Error('效果记录未以预期 revision 跨过持久化屏障，已阻止外部执行')
    }
  }
  taskRuntimeRegistry.set(persisted.sessionId, persisted)
  try {
    await registerConfirmedRunArtifactLifecycles(persisted, rootDir)
  } catch (error) {
    const effect = requiredEffectId
      ? persisted.effects?.find((candidate) => candidate.id === requiredEffectId)
      : undefined
    if (effect?.status === 'confirmed') {
      throw new ConfirmedEffectArtifactProjectionError(effect, error)
    }
    throw error
  }
  return persisted
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireRun(sessionId: string): TaskRunRecord {
  const run = taskRuntimeRegistry.get(sessionId)
  if (!run) throw new Error('当前会话没有 TaskRun，已按 fail-closed 阻止外部副作用')
  return run
}

function requireEffect(run: TaskRunRecord, effectId: string): EffectRecord {
  const effect = run.effects?.find((item) => item.id === effectId)
  if (!effect) throw new Error(`未找到 EffectRecord:${effectId}`)
  return effect
}

function withSessionQueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  const release = (): void => {
    if (sessionQueues.get(sessionId) === queued) sessionQueues.delete(sessionId)
  }
  const queued = next.then(release, release)
  sessionQueues.set(sessionId, queued)
  return next
}

function compareSnapshotFreshness(left: TaskSnapshotRecord, right: TaskSnapshotRecord): number {
  const leftSeq = left.execution.cursor?.seq ?? left.execution.lastSeq
  const rightSeq = right.execution.cursor?.seq ?? right.execution.lastSeq
  if (leftSeq !== rightSeq) return leftSeq - rightSeq
  const leftRevision = left.run?.revision ?? 0
  const rightRevision = right.run?.revision ?? 0
  if (leftRevision !== rightRevision) return leftRevision - rightRevision
  return left.updatedAt - right.updatedAt
}
