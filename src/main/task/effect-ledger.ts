import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type {
  EffectEvidenceKind,
  EffectEvidenceRecord,
  EffectRecord,
  EffectStatus,
  EffectTarget,
  TaskRunRecord,
  ToolExecutionRecord
} from '../../shared/types'
import type { EffectDescriptor, EffectReconciliationResult } from './effect-reconciler'
import { effectTargetsConflict } from './effect-target-conflict'
import { normalizeToolName, stableValueDigest } from './tool-idempotency'

export const EFFECT_LEASE_TTL_MS = 30 * 60 * 1000

export interface EffectExecutionHandle {
  /** Optional application-owned data root; omitted for ordinary Agent tools. */
  rootDir?: string
  sessionId: string
  effectId: string
  effectKey: string
  resourceKey: string
  leaseId: string
  ownerId: string
  fencingToken: number
  toolUseId: string
  target: EffectTarget
  targetDigest: string
}

export interface PrepareEffectInput {
  sessionId: string
  cwd: string
  toolUseId: string
  toolName: string
  descriptor: EffectDescriptor
  ownerId: string
  now?: number
  leaseTtlMs?: number
}

interface PrepareEffectResult {
  run: TaskRunRecord
  handle: EffectExecutionHandle
  created: boolean
}

export function prepareEffect(
  run: TaskRunRecord,
  input: PrepareEffectInput
): PrepareEffectResult {
  const now = input.now ?? Date.now()
  const toolName = normalizeToolName(input.toolName)
  const effectKey = buildEffectKey(input.cwd, toolName, input.descriptor)
  const resourceKey = buildResourceKey(input.cwd, toolName, input.descriptor, effectKey)
  const existing = existingPreparation(run, input, effectKey, resourceKey)
  if (existing) return existing
  const effects = run.effects ?? []
  const sameKey = effects.filter((effect) => effect.effectKey === effectKey)
  const sameResource = effects.filter((effect) =>
    effect.resourceKey === resourceKey ||
    effectTargetsConflict(effect.target, input.descriptor.target)
  )
  assertEffectCanBePrepared(sameKey, sameResource)
  const effect = createPreparedEffect(run, input, toolName, effectKey, resourceKey, sameKey, sameResource, now)
  const next = updateRun(run, [...effects, effect], now)
  return {
    run: projectEffectToToolExecution(next, effect),
    handle: handleForEffect(effect) as EffectExecutionHandle,
    created: true
  }
}

function existingPreparation(
  run: TaskRunRecord,
  input: PrepareEffectInput,
  effectKey: string,
  resourceKey: string
): PrepareEffectResult | undefined {
  const effect = (run.effects ?? []).find((candidate) => candidate.toolUseId === input.toolUseId)
  if (!effect) return undefined
  if (effect.effectKey !== effectKey || effect.resourceKey !== resourceKey) {
    throw new Error('同一 toolUseId 的效果意图发生变化，已按 fail-closed 阻止')
  }
  const handle = handleForEffect(effect)
  if (!handle || effect.lease?.ownerId !== input.ownerId) {
    throw new Error('效果记录已存在但当前执行者不持有 lease')
  }
  return { run, handle, created: false }
}

function assertEffectCanBePrepared(sameKey: EffectRecord[], sameResource: EffectRecord[]): void {
  const unresolved = sameResource.find((effect) =>
    effect.status === 'prepared' ||
    effect.status === 'executing' ||
    effect.status === 'waiting_reconciliation'
  )
  if (unresolved) {
    throw new Error(`相同外部效果仍未收敛(${unresolved.status})，同一资源禁止创建第二个执行 lease`)
  }
  const latest = [...sameKey].sort((left, right) => right.generation - left.generation)[0]
  if (
    latest &&
    (latest.status === 'failed' || latest.status === 'abandoned') &&
    !latest.evidence.some((item) => item.kind === 'retry_authorized')
  ) {
    throw new Error('上一代效果没有可验证的重试授权证据，禁止创建新 lease')
  }
}

function createPreparedEffect(
  run: TaskRunRecord,
  input: PrepareEffectInput,
  toolName: string,
  effectKey: string,
  resourceKey: string,
  sameKey: EffectRecord[],
  sameResource: EffectRecord[],
  now: number
): EffectRecord {
  const generation = sameKey.reduce((max, effect) => Math.max(max, effect.generation), 0) + 1
  const fencingToken = sameResource.reduce(
    (max, effect) => Math.max(max, effect.lease?.fencingToken ?? 0),
    0
  ) + 1
  const lease = {
    id: randomUUID(),
    ownerId: input.ownerId,
    fencingToken,
    acquiredAt: now,
    expiresAt: now + Math.max(1_000, input.leaseTtlMs ?? EFFECT_LEASE_TTL_MS)
  }
  const toolExecution = run.toolExecutions?.find((execution) => execution.toolUseId === input.toolUseId)
  const activeStep = [...(run.steps ?? [])].reverse().find((step) =>
    step.status !== 'completed' && step.status !== 'failed' && step.status !== 'cancelled'
  )
  return {
    schemaVersion: 1,
    id: randomUUID(),
    effectKey,
    resourceKey,
    sessionId: input.sessionId,
    runId: run.id,
    stepId: toolExecution?.stepId ?? activeStep?.id,
    toolExecutionId: toolExecution?.id,
    toolUseId: input.toolUseId,
    toolName,
    generation,
    revision: 1,
    status: 'prepared',
    reconcilability: input.descriptor.reconcilability,
    target: input.descriptor.target,
    targetDigest: input.descriptor.targetDigest,
    intentDigest: input.descriptor.intentDigest,
    inputDigest: input.descriptor.inputDigest,
    lease,
    evidence: [evidence('prepared', now, generation, 'effect-ledger-v1', {
      effectKey,
      resourceKey,
      targetDigest: input.descriptor.targetDigest,
      intentDigest: input.descriptor.intentDigest,
      leaseId: lease.id,
      fencingToken
    })],
    createdAt: now,
    updatedAt: now
  }
}

export function markEffectExecuting(
  run: TaskRunRecord,
  handle: EffectExecutionHandle,
  now = Date.now()
): TaskRunRecord {
  const effect = requireEffect(run, handle)
  requireFence(effect, handle, now, true)
  if (effect.status === 'executing') return run
  if (effect.status !== 'prepared') throw new Error(`效果状态不能开始执行:${effect.status}`)
  const next = transitionEffect(effect, 'executing', now, [
    evidence('executing', now, effect.generation, 'effect-ledger-v1', {
      effectId: effect.id,
      leaseId: handle.leaseId,
      fencingToken: handle.fencingToken
    })
  ])
  return projectEffectToToolExecution(replaceEffect(run, next, now), next)
}

export function completeEffect(
  run: TaskRunRecord,
  handle: EffectExecutionHandle,
  outcome: 'confirmed' | 'failed' | 'waiting_reconciliation',
  resultDigest: string,
  reason: string,
  now = Date.now()
): TaskRunRecord {
  const effect = requireEffect(run, handle)
  requireFence(effect, handle, now, false)
  if (effect.status === 'confirmed' || effect.status === 'failed' || effect.status === 'abandoned') return run
  const next = transitionEffect(effect, outcome, now, [
    evidence('execution_result', now, effect.generation, 'effect-runtime-v1', {
      outcome,
      resultDigest,
      reason,
      fencingToken: handle.fencingToken
    }),
    ...(outcome === 'failed'
      ? [evidence('retry_authorized', now, effect.generation, 'effect-runtime-v1', {
          effectKey: effect.effectKey,
          resultDigest,
          reason
        })]
      : [])
  ], reason)
  return projectEffectToToolExecution(replaceEffect(run, next, now), next)
}

export function abandonPreparedEffect(
  run: TaskRunRecord,
  handle: EffectExecutionHandle,
  reason: string,
  now = Date.now()
): TaskRunRecord {
  const effect = requireEffect(run, handle)
  requireFence(effect, handle, now, false)
  if (effect.status === 'abandoned') return run
  if (effect.status !== 'prepared' && effect.status !== 'executing') return run
  const next = transitionEffect(effect, 'abandoned', now, [
    evidence('execution_result', now, effect.generation, 'effect-runtime-v1', {
      outcome: 'not_executed',
      reason,
      fencingToken: handle.fencingToken
    }),
    evidence('retry_authorized', now, effect.generation, 'effect-runtime-v1', {
      effectKey: effect.effectKey,
      reason
    })
  ], reason)
  return projectEffectToToolExecution(replaceEffect(run, next, now), next)
}

export function applyEffectReconciliation(
  run: TaskRunRecord,
  effectId: string,
  result: EffectReconciliationResult,
  now = Date.now()
): TaskRunRecord {
  const effect = (run.effects ?? []).find((item) => item.id === effectId)
  if (!effect) throw new Error(`未找到 EffectRecord:${effectId}`)
  if (effect.status === 'confirmed' || effect.status === 'failed' || effect.status === 'compensated') return run
  const reconciliationEvidence = evidence(
    'reconciliation',
    now,
    effect.generation,
    result.verifier,
    { result: result.kind, evidenceDigest: result.evidenceDigest, reason: result.reason }
  )
  const previousReconciliation = [...effect.evidence]
    .reverse()
    .find((item) => item.kind === 'reconciliation')
  if (
    effect.status === 'waiting_reconciliation' &&
    result.kind === 'unresolved' &&
    previousReconciliation?.digest === reconciliationEvidence.digest
  ) {
    return run
  }
  let next: EffectRecord
  if (result.kind === 'confirmed') {
    next = transitionEffect(effect, 'confirmed', now, [reconciliationEvidence], result.reason)
  } else if (result.kind === 'not_applied') {
    const retryEvidence = evidence(
      'retry_authorized',
      now,
      effect.generation,
      result.verifier,
      { reconciliationEvidenceDigest: reconciliationEvidence.digest, effectKey: effect.effectKey }
    )
    next = transitionEffect(effect, 'abandoned', now, [reconciliationEvidence, retryEvidence], result.reason)
  } else {
    next = transitionEffect(effect, 'waiting_reconciliation', now, [reconciliationEvidence], result.reason)
  }
  return projectEffectToToolExecution(replaceEffect(run, next, now), next)
}

export function manuallyResolveEffect(
  run: TaskRunRecord,
  effectId: string,
  resolution: 'confirmed_applied' | 'confirmed_not_applied',
  now = Date.now()
): TaskRunRecord {
  const effect = (run.effects ?? []).find((item) => item.id === effectId)
  if (!effect) throw new Error(`未找到 EffectRecord:${effectId}`)
  if (effect.status !== 'waiting_reconciliation') {
    throw new Error(`EffectRecord 不在等待对账状态:${effect.status}`)
  }
  const manual = evidence('manual_confirmation', now, effect.generation, 'human-v1', {
    effectId,
    effectKey: effect.effectKey,
    resolution
  })
  const status: EffectStatus = resolution === 'confirmed_applied' ? 'confirmed' : 'abandoned'
  const extras = resolution === 'confirmed_not_applied'
    ? [manual, evidence('retry_authorized', now, effect.generation, 'human-v1', {
        manualEvidenceDigest: manual.digest,
        effectKey: effect.effectKey
      })]
    : [manual]
  const next = transitionEffect(effect, status, now, extras, `人工处置:${resolution}`)
  return projectEffectToToolExecution(replaceEffect(run, next, now), next)
}

export function markEffectCompensated(
  run: TaskRunRecord,
  effectId: string,
  compensationEffectId: string,
  evidenceDigest: string,
  now = Date.now()
): TaskRunRecord {
  const effect = (run.effects ?? []).find((item) => item.id === effectId)
  if (!effect || effect.status !== 'confirmed') throw new Error('只有已确认效果可以标记为已补偿')
  const next = {
    ...transitionEffect(effect, 'compensated', now, [
      evidence('compensation', now, effect.generation, 'effect-ledger-v1', {
        compensationEffectId,
        evidenceDigest
      })
    ]),
    compensationEffectId
  }
  return projectEffectToToolExecution(replaceEffect(run, next, now), next)
}

export function hasWaitingReconciliation(run: TaskRunRecord | undefined): boolean {
  return !!run?.effects?.some((effect) => effect.status === 'waiting_reconciliation')
}

export function hasUnresolvedEffects(run: TaskRunRecord | undefined): boolean {
  return !!run?.effects?.some((effect) =>
    effect.status === 'prepared' ||
    effect.status === 'executing' ||
    effect.status === 'waiting_reconciliation'
  )
}

export function isActiveLease(effect: EffectRecord, now = Date.now()): boolean {
  return (
    (effect.status === 'prepared' || effect.status === 'executing') &&
    !!effect.lease &&
    effect.lease.releasedAt === undefined &&
    effect.lease.expiresAt > now
  )
}

function buildEffectKey(
  cwd: string,
  toolName: string,
  descriptor: EffectDescriptor
): string {
  const target = descriptor.target
  // Patch artifacts are regenerated on a retry. Their temp path and inode are
  // intentionally volatile, while the repository/HEAD/digest/direction define
  // the same externally visible operation and must share one generation chain.
  const stableTargetDigest = target.kind === 'worktree_patch_apply'
    ? stableValueDigest({
        kind: target.kind,
        repoRoot: realpathSync(resolve(target.repoRoot)),
        worktreePath: realpathSync(resolve(target.worktreePath)),
        baseSha: target.baseSha,
        headSha: target.headSha,
        patchSha256: target.patchSha256,
        patchBytes: target.patchBytes,
        changedPaths: [...target.changedPaths].sort(),
        mode: target.mode ?? 'apply'
      })
    : target.kind === 'code_forge_patch'
      ? stableValueDigest({
          kind: target.kind,
          repoRoot: realpathSync(resolve(target.repoRoot)),
          worktreePath: realpathSync(resolve(target.worktreePath)),
          baseSha: target.baseSha,
          headSha: target.headSha,
          patchSha256: target.patchSha256,
          patchBytes: target.patchBytes,
          artifactPath: resolve(target.artifactPath)
        })
    : descriptor.targetDigest
  return `effect-v1:${stableValueDigest({
    cwd: realpathSync(resolve(cwd)),
    toolName,
    targetDigest: stableTargetDigest,
    intentDigest: target.kind === 'worktree_patch_apply' || target.kind === 'code_forge_patch'
      ? stableValueDigest({ toolName, targetDigest: stableTargetDigest })
      : descriptor.intentDigest
  })}`
}

function buildResourceKey(
  cwd: string,
  toolName: string,
  descriptor: EffectDescriptor,
  effectKey: string
): string {
  const target = descriptor.target
  if (target.kind === 'gui_postcondition') {
    return `resource-v1:${stableValueDigest({
      scope: 'gui-window',
      platform: target.platform,
      windowId: target.postcondition.windowId
    })}`
  }
  if (target.kind === 'file_content') {
    const rootPath = realpathSync(resolve(target.rootPath))
    const fullPath = resolve(rootPath, target.relativePath)
    const relativePath = relative(rootPath, fullPath).split(sep).join('/')
    return `resource-v1:${stableValueDigest({ scope: 'file', rootPath, relativePath })}`
  }
  if (target.kind === 'git_commit') {
    const repoRoot = realpathSync(resolve(target.repoRoot))
    const ref = target.branch.startsWith('refs/') ? target.branch : `refs/heads/${target.branch}`
    return `resource-v1:${stableValueDigest({ scope: 'git-local-ref', repoRoot, ref })}`
  }
  if (target.kind === 'git_merge') {
    const repoRoot = realpathSync(resolve(target.repoRoot))
    return `resource-v1:${stableValueDigest({
      scope: 'git-local-ref',
      repoRoot,
      ref: target.destinationRef
    })}`
  }
  if (target.kind === 'git_index_update') {
    return `resource-v1:${stableValueDigest({
      scope: 'git-index',
      gitCommonDir: realpathSync(resolve(target.gitCommonDir)),
      worktreeGitDir: realpathSync(resolve(target.worktreeGitDir)),
      indexPath: resolve(target.indexPath)
    })}`
  }
  if (target.kind === 'git_push') {
    return `resource-v1:${stableValueDigest({
      scope: 'git-remote-ref',
      pushUrlDigest: target.pushUrlDigest,
      ref: target.ref
    })}`
  }
  if (target.kind === 'worktree_patch_apply') {
    return `resource-v1:${stableValueDigest({
      scope: 'git-worktree-files',
      repoRoot: realpathSync(resolve(target.repoRoot))
    })}`
  }
  if (target.kind === 'code_forge_patch') {
    return `resource-v1:${stableValueDigest({
      scope: 'code-forge-patch-artifact',
      artifactRoot: realpathSync(resolve(target.artifactRoot)),
      artifactPath: resolve(target.artifactPath)
    })}`
  }
  if (target.kind === 'git_worktree_create' || target.kind === 'git_worktree_remove') {
    return `resource-v1:${stableValueDigest({
      scope: 'git-worktree-lifecycle',
      gitCommonDir: realpathSync(resolve(target.gitCommonDir))
    })}`
  }
  if (target.kind === 'pull_request_create') {
    return `resource-v1:${stableValueDigest({
      scope: 'pull-request-source',
      repositoryDigest: target.repositoryDigest,
      sourceBranch: target.sourceBranch
    })}`
  }
  if (target.kind === 'issue_create') {
    return `resource-v1:${stableValueDigest({
      scope: 'issue-marker',
      repositoryDigest: target.repositoryDigest,
      markerToken: target.markerToken
    })}`
  }
  if (target.kind === 'mcp_tool_call') {
    if (
      !target.pluginRegistryItemKey || !target.pluginContentDigest ||
      !target.pluginCapabilityDigest || !target.pluginServerId
    ) {
      return `resource-v1:${stableValueDigest({
        scope: 'mcp-tool-call',
        serverIdentityDigest: target.serverIdentityDigest,
        toolName: target.toolName,
        toolArgumentsDigest: target.toolArgumentsDigest
      })}`
    }
    return `resource-v1:${stableValueDigest({
      scope: 'mcp-tool-call-plugin-bound-v2',
      serverIdentityDigest: target.serverIdentityDigest,
      pluginRegistryItemKey: target.pluginRegistryItemKey,
      pluginContentDigest: target.pluginContentDigest,
      pluginCapabilityDigest: target.pluginCapabilityDigest,
      pluginServerId: target.pluginServerId,
      toolName: target.toolName,
      toolArgumentsDigest: target.toolArgumentsDigest
    })}`
  }
  if (target.kind === 'webhook_message_send') {
    return `resource-v1:${stableValueDigest({
      scope: 'webhook-message',
      connectorId: target.connectorId,
      payloadDigest: target.payloadDigest
    })}`
  }
  if (target.kind === 'media_job_operation') {
    return `resource-v1:${stableValueDigest({
      scope: 'media-job',
      mediaJobId: target.mediaJobId
    })}`
  }
  return `resource-v1:${stableValueDigest({
    scope: 'opaque',
    cwd: realpathSync(resolve(cwd)),
    toolName,
    effectKey
  })}`
}

function transitionEffect(
  effect: EffectRecord,
  status: EffectStatus,
  now: number,
  addedEvidence: EffectEvidenceRecord[],
  reason?: string
): EffectRecord {
  const terminal = status === 'confirmed' || status === 'failed' || status === 'compensated' || status === 'abandoned'
  const releaseLease = status !== 'prepared' && status !== 'executing'
  return {
    ...effect,
    status,
    revision: effect.revision + 1,
    lease: releaseLease && effect.lease && effect.lease.releasedAt === undefined
      ? { ...effect.lease, releasedAt: now }
      : effect.lease,
    evidence: [...effect.evidence, ...addedEvidence],
    updatedAt: now,
    terminalAt: terminal ? now : undefined,
    error: status === 'confirmed' || status === 'compensated' ? undefined : reason
  }
}

function evidence(
  kind: EffectEvidenceKind,
  observedAt: number,
  generation: number,
  verifier: string,
  payload: unknown
): EffectEvidenceRecord {
  return {
    id: randomUUID(),
    kind,
    digest: stableValueDigest(payload),
    observedAt,
    verifier,
    generation
  }
}

function requireEffect(run: TaskRunRecord, handle: EffectExecutionHandle): EffectRecord {
  const effect = (run.effects ?? []).find((item) => item.id === handle.effectId)
  if (!effect) throw new Error(`未找到 EffectRecord:${handle.effectId}`)
  if (
    effect.effectKey !== handle.effectKey ||
    effect.resourceKey !== handle.resourceKey ||
    effect.toolUseId !== handle.toolUseId ||
    effect.targetDigest !== handle.targetDigest ||
    stableValueDigest(handle.target) !== effect.targetDigest
  ) {
    throw new Error('Effect handle 与持久记录不一致')
  }
  return effect
}

function requireFence(
  effect: EffectRecord,
  handle: EffectExecutionHandle,
  now: number,
  requireUnexpired: boolean
): void {
  const lease = effect.lease
  if (
    !lease ||
    lease.id !== handle.leaseId ||
    lease.ownerId !== handle.ownerId ||
    lease.fencingToken !== handle.fencingToken ||
    lease.releasedAt !== undefined
  ) {
    throw new Error('stale_fence: effect lease 已失效')
  }
  if (requireUnexpired && lease.expiresAt <= now) {
    throw new Error('stale_fence: effect lease 已过期，必须先对账')
  }
}

function handleForEffect(effect: EffectRecord): EffectExecutionHandle | null {
  if (!effect.lease) return null
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

function replaceEffect(run: TaskRunRecord, effect: EffectRecord, now: number): TaskRunRecord {
  const effects = (run.effects ?? []).map((item) => item.id === effect.id ? effect : item)
  return updateRun(run, effects, now)
}

function updateRun(run: TaskRunRecord, effects: EffectRecord[], now: number): TaskRunRecord {
  return {
    ...run,
    revision: run.revision + 1,
    updatedAt: Math.max(run.updatedAt, now),
    effects
  }
}

function projectEffectToToolExecution(run: TaskRunRecord, effect: EffectRecord): TaskRunRecord {
  const toolExecutions = (run.toolExecutions ?? []).map((execution) =>
    execution.toolUseId === effect.toolUseId
      ? projectToolExecution(execution, effect)
      : execution
  )
  return { ...run, toolExecutions }
}

function projectToolExecution(execution: ToolExecutionRecord, effect: EffectRecord): ToolExecutionRecord {
  let status = execution.status
  if (effect.status === 'confirmed' || effect.status === 'compensated') status = 'succeeded'
  if (effect.status === 'waiting_reconciliation') status = 'unknown_outcome'
  if (effect.status === 'failed') status = 'failed'
  if (effect.status === 'abandoned') status = 'cancelled'
  return {
    ...execution,
    status,
    effectId: effect.id,
    effectKey: effect.effectKey,
    effectStatus: effect.status,
    updatedAt: Math.max(execution.updatedAt, effect.updatedAt),
    finishedAt:
      effect.status === 'confirmed' || effect.status === 'failed' || effect.status === 'abandoned'
        ? effect.terminalAt ?? effect.updatedAt
        : execution.finishedAt,
    error: effect.status === 'confirmed' ? undefined : effect.error ?? execution.error
  }
}
