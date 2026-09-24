import type {
  EffectRecord,
  EffectStatus,
  TaskSnapshotRecord,
  WorktreeApplyResult,
  WorktreePullRequestResult
} from '../../shared/types'
import { app } from 'electron'
import type { WorktreePullRequestDraftSubmitInput } from '../../shared/worktree-pr-draft-types'
import { getWorktreePullRequestDraftService } from '../git/worktree-pr-draft-runtime'
import { effectMatchesDraft } from '../git/worktree-pr-draft-service'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gitPush, type GitPushOperationResult } from '../git/git-helper'
import {
  exactMarkerRecords,
  executePullRequestEffectTarget,
  queryPullRequestEffectTarget,
  type PullRequestEffectExecutionResult
} from '../git/pull-request-effect'
import {
  executeManagedWorktreeCreateTarget,
  executeManagedWorktreeRemoveTarget,
  type ManagedWorktreeCreateTarget,
  type ManagedWorktreeRemoveTarget
} from '../git/managed-worktree-effect'
import { applySquashPatch, patchSha256, reverseSquashPatch } from '../worktreeMerge'
import { reconcileEffect } from '../task/effect-reconciler'
import { listTaskRuns } from '../task/task-snapshot'
import type {
  InteractiveOperationEffectOutcome,
  executeInteractiveOperationEffect
} from '../task/operation-effect-gateway'
import {
  applyPreparedManagedWorktreePatch,
  prepareManagedWorktreeRemoveEffect,
  prepareManagedWorktreePatchEffect,
  prepareManagedWorktreePullRequestEffect,
  projectManagedWorktreeCreated,
  projectManagedWorktreeRemoved,
  type ManagedWorktreeCreateEffectPlan,
  type ManagedWorktreeRemoveEffectPlan,
  type ManagedWorktreePullRequestEffectPlan,
  type WorktreePrepareResult
} from '../worktrees'

type OperationGateway = typeof executeInteractiveOperationEffect
type CompletedOutcome<T> = Extract<InteractiveOperationEffectOutcome<T>, { status: 'completed' }>
type IncompleteOutcome<T> = Exclude<InteractiveOperationEffectOutcome<T>, { status: 'completed' }>

export type ManagedWorktreeCreateEffectResult = WorktreePrepareResult & {
  effectStatus?: EffectStatus
  operationId?: string
  snapshotId?: string
  recoverySnapshot?: TaskSnapshotRecord
}

export async function executeManagedWorktreeCreateEffect(
  plan: ManagedWorktreeCreateEffectPlan,
  projectId: string | undefined,
  runOperation: OperationGateway,
  canonicalOwnership?: { workspaceId?: string; goalId?: string; workItemId?: string }
): Promise<ManagedWorktreeCreateEffectResult> {
  const outcome = await runOperation({
    source: 'session_lifecycle',
    kind: 'managed_worktree_create',
    title: '创建 managed worktree',
    sourceSessionId: plan.record.sessionId,
    projectId,
    ...canonicalOwnership,
    cwd: plan.record.sourceCwd,
    toolName: 'managed_worktree_create',
    toolInput: { ...plan.toolInput },
    execute: (effect) => {
      if (effect.target.kind !== 'git_worktree_create') {
        throw new Error('managed worktree create EffectTarget 类型不匹配')
      }
      return executeManagedWorktreeCreateTarget(effect.target)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedWorktreeCreateResult(plan, outcome)
    : await incompleteWorktreeLifecycleResult(outcome, plan.record.sourceCwd)
}

export async function executeInteractiveOperationEffectRemoveWorktree(
  id: string,
  opts: { deleteBranch?: boolean; force?: boolean },
  runOperation: OperationGateway
) {
  const { sessionManager } = await import('../sessionManager.js')
  const session = sessionManager.get(id)
  if (session?.meta.status === 'running') {
    return { ok: false, error: '会话正在运行，停止后才能丢弃 worktree' }
  }
  const prepared = prepareManagedWorktreeRemoveEffect(id, opts)
  if ('error' in prepared) return { ok: false, error: prepared.error, record: prepared.record }
  if ('noop' in prepared) {
    sessionManager.updateWorktreeState(id, prepared.noop.record.state)
    return { ok: true, record: { ...prepared.noop.record } }
  }
  const plan = prepared.plan
  const outcome = await runOperation({
    kind: 'managed_worktree_remove',
    title: '移除 managed worktree',
    sourceSessionId: id,
    projectId: session?.meta.projectId,
    cwd: plan.previousRecord.sourceCwd,
    toolName: 'managed_worktree_remove',
    toolInput: { ...plan.toolInput },
    execute: (effect) => {
      if (effect.target.kind !== 'git_worktree_remove') {
        throw new Error('managed worktree remove EffectTarget 类型不匹配')
      }
      return executeManagedWorktreeRemoveTarget(effect.target)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  if (outcome.status !== 'completed') {
    return await incompleteWorktreeLifecycleResult(outcome, plan.previousRecord.sourceCwd)
  }
  const result = completedWorktreeRemoveResult(plan, outcome)
  if (result.ok && result.record) sessionManager.updateWorktreeState(id, result.record.state)
  return result
}

export interface TaskDagAutoMergePatchEffectInput {
  executionId: string
  taskId: string
  sourceSessionId: string
  projectId?: string
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  patchPath: string
  patchSha256: string
  patchText: string
  direction?: 'apply' | 'reverse'
}

export async function executeInteractiveOperationEffectApplyPatch(
  id: string,
  runOperation: OperationGateway
) {
  const { sessionManager } = await import('../sessionManager.js')
  const session = sessionManager.get(id)
  if (session?.meta.status === 'running') {
    return { ok: false, error: '会话正在运行，停止后才能合并 worktree 改动' }
  }
  const prepared = prepareManagedWorktreePatchEffect(id)
  if ('error' in prepared) return { ok: false, error: prepared.error }
  if ('noop' in prepared) return prepared.noop
  const plan = prepared.plan
  const outcome = await runOperation({
    kind: 'worktree_patch_apply',
    title: '应用 worktree patch',
    sourceSessionId: id,
    projectId: session?.meta.projectId,
    cwd: plan.repoRoot,
    toolName: 'worktree_patch_apply',
    toolInput: {
      repoRoot: plan.repoRoot,
      worktreePath: plan.worktreePath,
      baseSha: plan.baseSha,
      headSha: plan.headSha,
      patchPath: plan.patchPath,
      patchSha256: plan.patchSha256
    },
    execute: (effect) => {
      if (effect.target.kind !== 'worktree_patch_apply') {
        throw new Error('worktree patch EffectTarget 类型不匹配')
      }
      return applyPreparedManagedWorktreePatch(plan)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedPatchResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeTaskDagAutoMergePatchEffect(
  input: TaskDagAutoMergePatchEffectInput,
  runOperation: OperationGateway
): Promise<WorktreeApplyResult> {
  const operationId = taskDagAutoMergePatchOperationId(input)
  const replay = await replayTaskDagAutoMergePatchEffect(input)
  if (replay) return replay
  const outcome = await runOperation({
    operationId,
    source: 'dag',
    kind: 'worktree_patch_apply',
    title: `DAG autoMerge: ${input.taskId}`,
    sourceSessionId: input.sourceSessionId,
    projectId: input.projectId,
    cwd: input.repoRoot,
    toolName: 'worktree_patch_apply',
    toolInput: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      baseSha: input.baseSha,
      headSha: input.headSha,
      patchPath: input.patchPath,
      patchSha256: input.patchSha256,
      executionId: input.executionId,
      taskId: input.taskId,
      direction: input.direction ?? 'apply'
    },
    execute: (effect) => {
      if (effect.target.kind !== 'worktree_patch_apply') {
        throw new Error('DAG autoMerge worktree patch EffectTarget 类型不匹配')
      }
      const patchText = readFileSync(effect.target.patchPath, 'utf8')
      if (
        patchSha256(patchText) !== effect.target.patchSha256 ||
        patchSha256(patchText) !== input.patchSha256 ||
        patchText !== input.patchText
      ) {
        throw new Error('DAG autoMerge patch artifact 已偏离冻结输入')
      }
      return (input.direction ?? 'apply') === 'reverse'
        ? reverseSquashPatch(effect.target.repoRoot, patchText)
        : applySquashPatch(effect.target.repoRoot, patchText)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedDagAutoMergePatchResult(outcome, input)
    : incompleteOperationResult(outcome)
}

export function replayTaskDagAutoMergePatchEffect(
  input: TaskDagAutoMergePatchEffectInput
): Promise<WorktreeApplyResult | null> {
  return replayTaskDagAutoMergePatchEffectById(taskDagAutoMergePatchOperationId(input), input)
}

export function taskDagAutoMergePatchOperationId(input: TaskDagAutoMergePatchEffectInput): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      executionId: input.executionId,
      taskId: input.taskId,
      patchSha256: input.patchSha256,
      direction: input.direction ?? 'apply'
    }))
    .digest('hex')
  return `dag-${digest.slice(0, 40)}`
}

async function replayTaskDagAutoMergePatchEffectById(
  operationId: string,
  input: TaskDagAutoMergePatchEffectInput
): Promise<WorktreeApplyResult | null> {
  const scopeId = `operation:${operationId}`
  const run = (await listTaskRuns(scopeId)).find((candidate) => candidate.id === scopeId)
  const effect = latestMatchingDagPatchEffect(run?.effects ?? [], input)
  if (!effect) return null
  if (!dagPatchTargetMatchesInput(effect, input)) {
    return dagPatchTargetMismatch(effect, operationId, scopeId)
  }
  const reconciliation = await reconcileDagPatchEffect(effect, operationId, scopeId)
  if ('error' in reconciliation) return reconciliation
  return projectDagPatchReplay(effect, operationId, scopeId, reconciliation)
}

async function reconcileDagPatchEffect(
  effect: EffectRecord,
  operationId: string,
  scopeId: string
) {
  try {
    return await reconcileEffect(effect)
  } catch (error) {
    return {
      ok: false,
      error: `DAG autoMerge 已持久化 Effect 对账失败:${error instanceof Error ? error.message : String(error)}`,
      effectStatus: effect.status,
      operationId,
      snapshotId: scopeId
    } as const
  }
}

function projectDagPatchReplay(
  effect: EffectRecord,
  operationId: string,
  scopeId: string,
  reconciliation: { kind: string }
): WorktreeApplyResult | null {
  const manuallyConfirmed = effect.evidence.some(
    (item) => item.kind === 'manual_confirmation' && item.verifier === 'human-v1'
  )
  if (effect.status === 'abandoned' && hasRetryAuthorization(effect)) {
    if (reconciliation.kind === 'confirmed') return confirmedDagPatchReplayResult(effect, operationId)
    if (reconciliation.kind === 'not_applied' || (reconciliation.kind === 'unresolved' && manuallyConfirmed)) return null
  }
  if (effect.status === 'confirmed' && (reconciliation.kind === 'confirmed' || manuallyConfirmed)) {
    return confirmedDagPatchReplayResult(effect, operationId)
  }
  return {
    ok: false,
    error: `DAG autoMerge operation 尚未唯一收敛:${effect.status}/${reconciliation.kind}`,
    effectStatus: effect.status,
    operationId,
    snapshotId: scopeId,
    reconciliationRequired: true
  }
}

function dagPatchTargetMismatch(effect: EffectRecord, operationId: string, scopeId: string): WorktreeApplyResult {
  return {
    ok: false,
    error: '确定性 DAG autoMerge operationId 已绑定到不同 patch 目标，已拒绝重放',
    effectStatus: effect.status,
    operationId,
    snapshotId: scopeId
  }
}

function confirmedDagPatchReplayResult(effect: EffectRecord, operationId: string): WorktreeApplyResult {
  const target = effect.target
  if (target.kind !== 'worktree_patch_apply') {
    return { ok: false, error: 'DAG autoMerge 已确认 EffectTarget 类型不匹配', operationId }
  }
  return {
    ok: true,
    repoRoot: target.repoRoot,
    worktreePath: target.worktreePath,
    baseSha: target.baseSha,
    headSha: target.headSha,
    path: target.patchPath,
    bytes: target.patchBytes,
    changedFiles: target.changedPaths.length,
    applied: true,
    effectStatus: 'confirmed',
    operationId
  }
}

function hasRetryAuthorization(effect: EffectRecord): boolean {
  return effect.evidence.some((item) => item.kind === 'retry_authorized')
}

function latestMatchingDagPatchEffect(
  effects: EffectRecord[],
  input: TaskDagAutoMergePatchEffectInput
): EffectRecord | undefined {
  const mode = input.direction ?? 'apply'
  return [...effects]
    .sort(compareEffectRecencyDescending)
    .find((effect) => effect.target.kind === 'worktree_patch_apply' && (effect.target.mode ?? 'apply') === mode)
}

function compareEffectRecencyDescending(left: EffectRecord, right: EffectRecord): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.generation !== right.generation) return right.generation - left.generation
  if (left.revision !== right.revision) return right.revision - left.revision
  const leftTerminalAt = left.terminalAt ?? Number.NEGATIVE_INFINITY
  const rightTerminalAt = right.terminalAt ?? Number.NEGATIVE_INFINITY
  if (leftTerminalAt !== rightTerminalAt) return rightTerminalAt - leftTerminalAt
  return right.id.localeCompare(left.id)
}

function dagPatchTargetMatchesInput(effect: EffectRecord, input: TaskDagAutoMergePatchEffectInput): boolean {
  const target = effect.target
  return target.kind === 'worktree_patch_apply' &&
    target.repoRoot === input.repoRoot &&
    target.worktreePath === input.worktreePath &&
    target.baseSha === input.baseSha &&
    target.headSha === input.headSha &&
    target.patchSha256 === input.patchSha256 &&
    (target.mode ?? 'apply') === (input.direction ?? 'apply')
}

const activePrSubmissions = new Map<string, { input: string; result: Promise<WorktreePullRequestResult> }>()
export async function executeInteractiveOperationEffectCreatePr(
  id: string, runOperation: OperationGateway, input?: WorktreePullRequestDraftSubmitInput
): Promise<WorktreePullRequestResult> {
  if (!input) return { ok: false, error: '请先打开 PR 准备页，核对差异并保存草稿后提交' }
  const key = JSON.stringify(input), active = activePrSubmissions.get(id)
  if (active) return active.input === key ? active.result : { ok: false, error: '当前任务已有 PR 提交正在处理' }
  const result = submitWorktreeDraft(id, runOperation, input).finally(() => { if (activePrSubmissions.get(id)?.result === result) activePrSubmissions.delete(id) })
  activePrSubmissions.set(id, { input: key, result })
  return result
}

async function submitWorktreeDraft(id: string, runOperation: OperationGateway, input: WorktreePullRequestDraftSubmitInput): Promise<WorktreePullRequestResult> {
  const { sessionManager } = await import('../sessionManager.js')
  const session = sessionManager.get(id)
  if (!session || ['running', 'starting', 'closed'].includes(session.meta.status)) return { ok: false, error: '请先停止并打开原任务，再提交 PR' }
  const service = getWorktreePullRequestDraftService(app.getPath('userData'))
  let phase: 'push' | 'pr' | undefined
  try {
    let draft = await service.freezeSubmission(id, input)
    if (!draft.submission) throw new Error('PR 草稿缺少冻结提交回执')
    if (draft.submission.status === 'completed') {
      if (draft.submission.result?.ok) return draft.submission.result
      const effect = await service.confirmedPrEffect(id, input)
      if (!effect) return { ok: false, error: 'PR 已记录完成，原效果记录尚未核对；不会再次创建' }
      const result = await completedPullRequestResult({ status: 'completed', effect, effectStatus: effect.status,
        effectId: effect.id, operationId: draft.submission.prOperationId })
      await service.recordOutcome(id, input, 'pr', { status: 'completed', effectId: effect.id, result })
      return result
    }
    if (!['prepared', 'pushed'].includes(draft.submission.status)) {
      const operationId = draft.submission.phase === 'pr' ? draft.submission.prOperationId : draft.submission.pushOperationId
      return { ok: false, error: draft.submission.error ?? '原提交结果待核对；请使用执行记录核对原操作，不会自动重发',
        operationId, snapshotId: `operation:${operationId}`, effectStatus: 'waiting_reconciliation' }
    }
    const prepared = prepareManagedWorktreePullRequestEffect(id, draft)
    if ('error' in prepared) return { ok: false, error: prepared.error }
    if ('unavailable' in prepared) return { ok: true, created: false, message: prepared.message }
    let plan = prepared.plan
    if (draft.submission.status === 'prepared') {
      draft = await service.markPhase(id, input, 'push'); phase = 'push'; plan = { ...plan, draft }
      const push = await pushWorktreeBranch(id, session.meta.projectId, plan, runOperation)
      if (push.status === 'completed' && !effectMatchesDraft(push.effect, draft, 'push')) throw new Error('已完成的 Push 回执与冻结草稿不一致，请核对原操作')
      draft = await service.recordOutcome(id, input, phase, { status: push.status, effectId: push.effectId,
        ...('error' in push ? { error: push.error } : {}) })
      phase = undefined
      if (push.status !== 'completed') return incompleteOperationResult(push)
    }
    draft = await service.markPhase(id, input, 'pr'); phase = 'pr'; plan = { ...plan, draft }
    const pullRequest = await createPullRequest(id, session.meta.projectId, plan, runOperation)
    if (pullRequest.status === 'completed' && !effectMatchesDraft(pullRequest.effect, draft, 'pr')) throw new Error('已完成的 PR 回执与冻结草稿不一致，请核对原操作')
    const result = pullRequest.status === 'completed' ? await completedPullRequestResult(pullRequest) : incompleteOperationResult(pullRequest)
    await service.recordOutcome(id, input, phase, { status: pullRequest.status, effectId: pullRequest.effectId, result,
      ...('error' in pullRequest ? { error: pullRequest.error } : {}) })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (phase) await service.recordOutcome(id, input, phase, { status: 'waiting_reconciliation', error: message }).catch(() => undefined)
    return { ok: false, error: message, ...(phase ? { effectStatus: 'waiting_reconciliation' as const } : {}) }
  }
}

function completedWorktreeCreateResult(
  plan: ManagedWorktreeCreateEffectPlan,
  outcome: CompletedOutcome<ReturnType<typeof executeManagedWorktreeCreateTarget>>
): ManagedWorktreeCreateEffectResult {
  const target = outcome.effect.target
  if (target.kind !== 'git_worktree_create' || !createTargetMatchesPlan(target, plan)) {
    return {
      ok: false,
      isolated: true,
      cwd: plan.record.sourceCwd,
      error: `managed worktree 已确认创建，但 EffectTarget 与冻结 plan 不匹配: ${lifecycleIdentityDiff(
        target.kind === 'git_worktree_create' ? target : undefined,
        plan.record
      )}`
    }
  }
  const projection = projectManagedWorktreeCreated(plan)
  if ('error' in projection) {
    return {
      ok: false,
      isolated: true,
      cwd: plan.record.sourceCwd,
      error: `managed worktree 外部效果已确认，但 registry projection 失败: ${projection.error}`,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  return {
    ok: true,
    isolated: true,
    cwd: projection.record.cwd,
    record: { ...projection.record },
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function completedWorktreeRemoveResult(
  plan: ManagedWorktreeRemoveEffectPlan,
  outcome: CompletedOutcome<ReturnType<typeof executeManagedWorktreeRemoveTarget>>
) {
  const target = outcome.effect.target
  if (target.kind !== 'git_worktree_remove' || !removeTargetMatchesPlan(target, plan)) {
    return { ok: false, error: 'managed worktree 已确认移除，但 EffectTarget 与冻结 plan 不匹配' }
  }
  const projection = projectManagedWorktreeRemoved(plan)
  if ('error' in projection) {
    return {
      ok: false,
      error: `managed worktree 外部效果已确认，但 registry projection 失败: ${projection.error}`,
      record: projection.record,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  return {
    ok: true,
    record: { ...projection.record },
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function createTargetMatchesPlan(
  target: ManagedWorktreeCreateTarget,
  plan: ManagedWorktreeCreateEffectPlan
): boolean {
  return target.sessionId === plan.record.sessionId
    && target.repoRoot === plan.record.repoRoot
    && target.worktreePath === plan.record.worktreePath
    && target.worktreeCwd === plan.record.cwd
    && target.branch === plan.record.branch
    && target.baseSha === plan.record.baseSha
    && target.baseBranch === plan.record.baseBranch
}

function lifecycleIdentityDiff(
  target: ManagedWorktreeCreateTarget | undefined,
  record: ManagedWorktreeCreateEffectPlan['record']
): string {
  if (!target) return 'target kind mismatch'
  return JSON.stringify({
    sessionId: [target.sessionId, record.sessionId],
    repoRoot: [target.repoRoot, record.repoRoot],
    worktreePath: [target.worktreePath, record.worktreePath],
    worktreeCwd: [target.worktreeCwd, record.cwd],
    branch: [target.branch, record.branch],
    baseSha: [target.baseSha, record.baseSha],
    baseBranch: [target.baseBranch, record.baseBranch]
  })
}

function removeTargetMatchesPlan(
  target: ManagedWorktreeRemoveTarget,
  plan: ManagedWorktreeRemoveEffectPlan
): boolean {
  return target.sessionId === plan.previousRecord.sessionId
    && target.repoRoot === plan.previousRecord.repoRoot
    && target.worktreePath === plan.previousRecord.worktreePath
    && target.worktreeCwd === plan.previousRecord.cwd
    && target.branch === plan.previousRecord.branch
    && target.baseSha === plan.previousRecord.baseSha
    && target.baseBranch === plan.previousRecord.baseBranch
    && target.force === plan.options.force
    && target.deleteBranch === plan.options.deleteBranch
}

function completedDagAutoMergePatchResult(
  outcome: CompletedOutcome<ReturnType<typeof applySquashPatch>>,
  input: TaskDagAutoMergePatchEffectInput
): WorktreeApplyResult {
  if (outcome.value?.ok) {
    return {
      ...outcome.value,
      worktreePath: input.worktreePath,
      baseSha: input.baseSha,
      headSha: input.headSha,
      path: input.patchPath,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  const target = outcome.effect.target
  if (target.kind !== 'worktree_patch_apply') {
    return { ok: false, error: 'DAG autoMerge patch 已确认生效，但 EffectTarget 类型不匹配' }
  }
  return {
    ok: true,
    repoRoot: target.repoRoot,
    worktreePath: target.worktreePath,
    baseSha: target.baseSha,
    headSha: target.headSha,
    path: target.patchPath,
    bytes: target.patchBytes,
    changedFiles: target.changedPaths.length,
    applied: true,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function pushWorktreeBranch(
  sourceSessionId: string,
  projectId: string | undefined,
  plan: ManagedWorktreePullRequestEffectPlan,
  runOperation: OperationGateway
): Promise<InteractiveOperationEffectOutcome<GitPushOperationResult>> {
  return runOperation({
    kind: 'git_push',
    ...(plan.draft ? { rootDir: app.getPath('userData'), operationId: plan.draft.submission!.pushOperationId,
      workspaceId: plan.draft.snapshot.binding.workspaceId, goalId: plan.draft.snapshot.binding.goalId, workItemId: plan.draft.snapshot.binding.workItemId } : {}),
    title: '推送 worktree 分支',
    sourceSessionId,
    projectId,
    cwd: plan.worktreePath,
    toolName: 'git_push',
    toolInput: { branch: plan.branch },
    execute: (effect) => {
      if (effect.target.kind !== 'git_push') throw new Error('git push EffectTarget 类型不匹配')
      if (!plan.draft || !effectMatchesDraft(effect, plan.draft, 'push')) throw new Error('Push Effect 与已确认 PR 草稿不一致')
      getWorktreePullRequestDraftService(app.getPath('userData')).assertCurrentDraft(sourceSessionId, {
        draftId: plan.draft.id, expectedRevision: plan.draft.revision, snapshotDigest: plan.draft.snapshot.digest
      }, 'push')
      return gitPush(plan.worktreePath, plan.branch, effect.target)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
}

function createPullRequest(
  sourceSessionId: string,
  projectId: string | undefined,
  plan: ManagedWorktreePullRequestEffectPlan,
  runOperation: OperationGateway
): Promise<InteractiveOperationEffectOutcome<PullRequestEffectExecutionResult>> {
  return runOperation({
    kind: 'pull_request_create',
    ...(plan.draft ? { rootDir: app.getPath('userData'), operationId: plan.draft.submission!.prOperationId,
      workspaceId: plan.draft.snapshot.binding.workspaceId, goalId: plan.draft.snapshot.binding.goalId, workItemId: plan.draft.snapshot.binding.workItemId } : {}),
    title: '创建 PR/MR',
    sourceSessionId,
    projectId,
    cwd: plan.worktreePath,
    toolName: 'git_create_pr',
    toolInput: { title: plan.title, body: plan.body, ...(plan.base ? { base: plan.base } : {}) },
    execute: (effect) => {
      if (effect.target.kind !== 'pull_request_create') {
        throw new Error('pull request EffectTarget 类型不匹配')
      }
      if (!plan.draft || !effectMatchesDraft(effect, plan.draft, 'pr')) throw new Error('PR Effect 与已确认的草稿文案或 HEAD 不一致')
      getWorktreePullRequestDraftService(app.getPath('userData')).assertCurrentDraft(sourceSessionId, {
        draftId: plan.draft.id, expectedRevision: plan.draft.revision, snapshotDigest: plan.draft.snapshot.digest
      }, 'pr')
      return executePullRequestEffectTarget({ target: effect.target, title: plan.title, body: plan.body })
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
}

function completedPatchResult(outcome: CompletedOutcome<WorktreeApplyResult>) {
  if (outcome.value?.ok) {
    return { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
  }
  const target = outcome.effect.target
  if (target.kind !== 'worktree_patch_apply') {
    return { ok: false, error: 'worktree patch 已确认生效，但 EffectTarget 类型不匹配' }
  }
  return {
    ok: true,
    repoRoot: target.repoRoot,
    worktreePath: target.worktreePath,
    baseSha: target.baseSha,
    headSha: target.headSha,
    path: target.patchPath,
    bytes: target.patchBytes,
    changedFiles: target.changedPaths.length,
    applied: true,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

async function completedPullRequestResult(
  outcome: CompletedOutcome<PullRequestEffectExecutionResult>
): Promise<WorktreePullRequestResult & { effectStatus?: string; operationId?: string }> {
  const value = outcome.value
  if (value?.ok) {
    return {
      ok: true,
      created: true,
      tool: value.tool,
      branch: value.branch,
      url: value.url,
      pushed: true,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  const target = outcome.effect.target
  if (target.kind !== 'pull_request_create') {
    return { ok: false, error: 'PR/MR 已确认创建，但 EffectTarget 类型不匹配' }
  }
  const observation = await queryPullRequestEffectTarget(target)
  const exact = observation.complete ? exactMarkerRecords(target, observation.records) : []
  if (exact.length !== 1) {
    return { ok: false, error: 'PR/MR 已确认创建，但无法再次读取唯一 URL；请在远端仓库核对' }
  }
  return {
    ok: true,
    created: true,
    tool: target.provider === 'github' ? 'gh' : 'glab',
    branch: target.sourceBranch,
    url: exact[0].url,
    pushed: true,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function incompleteOperationResult<T>(outcome: IncompleteOutcome<T>) {
  return {
    ok: false as const,
    error: outcome.error,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId,
    reconciliationRequired: outcome.status === 'waiting_reconciliation',
    ...(outcome.status === 'waiting_reconciliation' ? { snapshotId: outcome.snapshotId } : {})
  }
}

async function incompleteWorktreeLifecycleResult<T>(
  outcome: IncompleteOutcome<T>,
  sourceCwd: string
): Promise<ManagedWorktreeCreateEffectResult> {
  if (outcome.status !== 'waiting_reconciliation') {
    return { ...incompleteOperationResult(outcome), isolated: true, cwd: sourceCwd }
  }
  const { getTaskSnapshot } = await import('../task/task-snapshot.js')
  const recoverySnapshot = await getTaskSnapshot(outcome.snapshotId)
  return {
    ...incompleteOperationResult(outcome),
    isolated: true,
    cwd: sourceCwd,
    ...(recoverySnapshot ? { recoverySnapshot } : {})
  }
}
