import { spawnSync } from 'node:child_process'
import { parseWslHostPath } from '../wsl/binding'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  canFastApplyPatch,
  createSquashPatch,
  getConflictFiles,
  inspectMerge,
  patchSha256,
  reverseSquashPatch
} from '../worktreeMerge'
import type { InspectMergeSuccess } from '../worktreeMerge'
import { buildConflictResolverRequest } from '../agent/conflict-resolver'
import type {
  EffectStatus,
  TaskDagAutoMergeConflict,
  TaskDagAutoMergeEntry,
  TaskDagAutoMergeRollback,
  TaskDagAutoMergeRollbackEntry,
  TaskDagAutoMergeVerification,
  TaskDagAutoMergeView,
  TaskDagExecutionTask,
  TaskDagExecutionView,
  WorktreeApplyResult
} from '../../shared/types'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

export interface TaskDagAutoMergeSession {
  sessionId: string
  taskId?: string
  repoRoot?: string
  worktreePath?: string
  baseSha?: string
  branch?: string
  resultText?: string
}

export interface RunTaskDagAutoMergeOptions {
  execution: TaskDagExecutionView
  sessions: TaskDagAutoMergeSession[]
  verificationCommand?: string
  verificationTimeoutMs?: number
  applyPatch: (input: TaskDagAutoMergePatchInput) => Promise<WorktreeApplyResult>
  replayPatch?: (input: TaskDagAutoMergePatchInput) => Promise<WorktreeApplyResult | null>
  rollbackPatch?: (input: TaskDagAutoMergePatchInput) => Promise<WorktreeApplyResult>
  onVerificationStart?: (
    command: string | undefined,
    startedAt: number,
    progress: TaskDagAutoMergeProgress
  ) => void | Promise<void>
  onRollbackStart?: (progress: TaskDagAutoMergeProgress) => void | Promise<void>
}

export interface TaskDagAutoMergeProgress {
  autoMerge: TaskDagAutoMergeEffectView
  appliedPatches: TaskDagAutoMergePatchInput[]
}

export interface TaskDagAutoMergePatchInput {
  executionId: string
  taskId: string
  sourceSessionId: string
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  patchPath: string
  patchSha256: string
  patchText: string
}

export interface TaskDagAutoMergeEffectEntry extends TaskDagAutoMergeEntry {
  effectStatus?: EffectStatus
  operationId?: string
}

export interface TaskDagAutoMergeEffectView extends Omit<TaskDagAutoMergeView, 'entries'> {
  entries: TaskDagAutoMergeEffectEntry[]
}

interface AppliedPatch {
  entryIndex: number
  input: TaskDagAutoMergePatchInput
}

type MergeTaskEntry = TaskDagAutoMergeEffectEntry & { repoRoot?: string }

interface MergeTaskInput {
  executionId: string
  entryIndex: number
  taskState: TaskDagExecutionTask
  sessionMap: Map<string, TaskDagAutoMergeSession>
  repoRoot?: string
  applied: AppliedPatch[]
  applyPatch: RunTaskDagAutoMergeOptions['applyPatch']
  replayPatch?: RunTaskDagAutoMergeOptions['replayPatch']
}

type ReadyAutoMergeSession = TaskDagAutoMergeSession & {
  repoRoot: string
  worktreePath: string
  baseSha: string
}

type MergeTaskSelection =
  | { ready: true; taskId: string; sessionId: string; session: ReadyAutoMergeSession }
  | { ready: false; entry: MergeTaskEntry }

const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
const MAX_VERIFY_OUTPUT_CHARS = 5000
const VERIFY_CONFIG_FILES = ['caogen.md', '.caogen.md'] as const

export async function runTaskDagAutoMerge(
  options: RunTaskDagAutoMergeOptions
): Promise<TaskDagAutoMergeEffectView> {
  const state = await mergeTaskPatches(options)
  const verification = await verifyMergedPatches(state, options)
  const rollback = await rollbackFailedVerification(state, verification, options)
  return buildAutoMergeView(state, verification, rollback)
}

interface AutoMergeRunState {
  startedAt: number
  entries: TaskDagAutoMergeEffectEntry[]
  applied: AppliedPatch[]
  repoRoot?: string
}

async function mergeTaskPatches(options: RunTaskDagAutoMergeOptions): Promise<AutoMergeRunState> {
  const state: AutoMergeRunState = {
    startedAt: Date.now(),
    entries: [],
    applied: []
  }
  const sessionMap = new Map(options.sessions.map((session) => [session.sessionId, session]))
  const tasks = orderedTasks(options.execution)
  for (const [entryIndex, taskState] of tasks.entries()) {
    const entry = await mergeTask({
      executionId: options.execution.id,
      entryIndex,
      taskState,
      sessionMap,
      repoRoot: state.repoRoot,
      applied: state.applied,
      applyPatch: options.applyPatch,
      replayPatch: options.replayPatch
    })
    if (!state.repoRoot && entry.repoRoot) state.repoRoot = entry.repoRoot
    state.entries.push(stripRepoRoot(entry))
    if (isUnsettledPatchEntry(entry)) {
      appendReconciliationSkips(state.entries, tasks.slice(entryIndex + 1), entry)
      break
    }
  }
  return state
}

async function verifyMergedPatches(
  state: AutoMergeRunState,
  options: RunTaskDagAutoMergeOptions
): Promise<TaskDagAutoMergeVerification> {
  const hasBlockingFailure = state.entries.some(
    (entry) => entry.status === 'blocked' || entry.status === 'failed'
  )
  const hasMergedPatch = state.entries.some((entry) => entry.status === 'merged')
  if (!state.repoRoot || hasBlockingFailure || !hasMergedPatch) {
    return {
      status: 'not-run',
      error: hasBlockingFailure ? '存在阻塞或失败的合并项' : '没有可验收的合并项'
    }
  }

  const command = resolveVerificationCommand(state.repoRoot, options.verificationCommand)
  const verificationStartedAt = Date.now()
  if (command) {
    await options.onVerificationStart?.(
      command,
      verificationStartedAt,
      taskDagAutoMergeProgress(state.startedAt, state.repoRoot, state.entries, state.applied, {
        status: 'not-run',
        command,
        cwd: state.repoRoot,
        error: '验收命令尚未结算'
      })
    )
  }
  return runConfiguredVerification(
    state.repoRoot,
    command,
    options.verificationTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    verificationStartedAt
  )
}

async function rollbackFailedVerification(
  state: AutoMergeRunState,
  verification: TaskDagAutoMergeVerification,
  options: RunTaskDagAutoMergeOptions
): Promise<TaskDagAutoMergeRollback | undefined> {
  if (verification.status !== 'failed') return undefined
  await options.onRollbackStart?.(
    taskDagAutoMergeProgress(state.startedAt, state.repoRoot, state.entries, state.applied, verification)
  )
  const rollback = await rollbackAppliedPatches(state.applied, options.rollbackPatch)
  if (rollback.ok) markAppliedEntriesRolledBack(state.entries, state.applied)
  return rollback
}

function buildAutoMergeView(
  state: AutoMergeRunState,
  verification: TaskDagAutoMergeVerification,
  rollback: TaskDagAutoMergeRollback | undefined
): TaskDagAutoMergeEffectView {
  const mergedCount = state.entries.filter((entry) => entry.status === 'merged').length
  const blockedCount = state.entries.filter((entry) => entry.status === 'blocked').length
  const skippedCount = state.entries.filter((entry) => entry.status === 'skipped').length
  const failedCount = state.entries.filter((entry) => entry.status === 'failed').length
  const rolledBackCount = state.entries.filter((entry) => entry.status === 'rolled-back').length
  const status = summarizeStatus({
    mergedCount,
    blockedCount,
    failedCount,
    rolledBackCount,
    verification,
    rollback
  })
  return {
    enabled: true,
    status,
    startedAt: state.startedAt,
    completedAt: Date.now(),
    repoRoot: state.repoRoot,
    entries: state.entries,
    mergedCount,
    blockedCount,
    skippedCount,
    verification,
    rollback,
    summary: buildSummary(mergedCount, blockedCount, skippedCount, failedCount, rolledBackCount, verification),
    error: status === 'failed' ? firstError(state.entries, verification, rollback) : undefined
  }
}

function isUnsettledPatchEntry(entry: TaskDagAutoMergeEffectEntry): boolean {
  return Boolean(
    entry.reconciliationRequired ||
    entry.effectStatus === 'prepared' ||
    entry.effectStatus === 'executing' ||
    entry.effectStatus === 'waiting_reconciliation'
  )
}

function appendReconciliationSkips(
  entries: TaskDagAutoMergeEffectEntry[],
  tasks: TaskDagExecutionTask[],
  unsettled: TaskDagAutoMergeEffectEntry
): void {
  for (const blocked of tasks) {
    entries.push({
      taskId: blocked.task.id,
      sessionId: blocked.sessionIds[blocked.sessionIds.length - 1],
      status: 'skipped',
      error: `前序 patch Effect 尚未唯一收敛:${unsettled.taskId}/${unsettled.effectStatus ?? 'missing'}`
    })
  }
}

function markAppliedEntriesRolledBack(
  entries: TaskDagAutoMergeEffectEntry[],
  applied: AppliedPatch[]
): void {
  for (const patch of applied) {
    const entry = entries[patch.entryIndex]
    if (entry?.status === 'merged') entry.status = 'rolled-back'
  }
}

function taskDagAutoMergeProgress(
  startedAt: number,
  repoRoot: string | undefined,
  entries: TaskDagAutoMergeEffectEntry[],
  applied: AppliedPatch[],
  verification: TaskDagAutoMergeVerification
): TaskDagAutoMergeProgress {
  const snapshotEntries = entries.map((entry) => ({
    ...entry,
    ...(entry.conflicts ? { conflicts: entry.conflicts.map((conflict) => ({ ...conflict })) } : {})
  }))
  return {
    autoMerge: {
      enabled: true,
      status: 'running',
      startedAt,
      ...(repoRoot ? { repoRoot } : {}),
      entries: snapshotEntries,
      mergedCount: snapshotEntries.filter((entry) => entry.status === 'merged').length,
      blockedCount: snapshotEntries.filter((entry) => entry.status === 'blocked').length,
      skippedCount: snapshotEntries.filter((entry) => entry.status === 'skipped').length,
      verification: { ...verification },
      summary: 'DAG autoMerge 正在完成耐久验收/回滚。'
    },
    appliedPatches: applied.map((patch) => ({ ...patch.input }))
  }
}

async function mergeTask(input: MergeTaskInput): Promise<MergeTaskEntry> {
  const selection = selectMergeTask(input)
  if ('entry' in selection) return selection.entry
  const { taskId, sessionId, session } = selection

  const inspect = inspectMerge(session.repoRoot, session.worktreePath, session.baseSha)
  if (!inspect.ok) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'failed',
      error: resultError(inspect, '合并检查失败')
    }
  }

  const patch = createSquashPatch(session.repoRoot, session.worktreePath, patchOutputRoot(), session.baseSha)
  if (!patch.ok) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'failed',
      changedFiles: inspect.changedFiles,
      insertions: inspect.insertions,
      deletions: inspect.deletions,
      conflictRisk: inspect.conflictRisk,
      error: resultError(patch, '生成 squash patch 失败')
    }
  }

  if (!patch.patchText.trim()) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'skipped',
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      conflictRisk: 'low',
      patchPath: patch.path,
      error: '没有可合并的 diff'
    }
  }

  const digest = patchSha256(patch.patchText)
  const patchInput: TaskDagAutoMergePatchInput = {
    executionId: input.executionId,
    taskId,
    sourceSessionId: sessionId,
    repoRoot: session.repoRoot,
    worktreePath: session.worktreePath,
    baseSha: session.baseSha,
    headSha: patch.headSha,
    patchPath: patch.path,
    patchSha256: digest,
    patchText: patch.patchText
  }

  if (input.replayPatch) {
    const replay = await input.replayPatch(patchInput)
    if (replay) {
      return mergePatchResultEntry({
        input,
        session,
        taskId,
        sessionId,
        inspect,
        patchInput,
        result: replay
      })
    }
  }

  const canApply = canFastApplyPatch(session.repoRoot, patch.patchText)
  if (!canApply.ok || !canApply.canApply) {
    const conflicts = loadConflicts(session.repoRoot, session.worktreePath, session.baseSha)
    const resolver = buildConflictResolverRequest({
      taskId,
      sessionId,
      branch: session.branch,
      taskSummary: session.resultText,
      conflicts
    })
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'blocked',
      changedFiles: inspect.changedFiles,
      insertions: inspect.insertions,
      deletions: inspect.deletions,
      conflictRisk: inspect.conflictRisk,
      patchSha256: digest,
      patchPath: patch.path,
      error: resultError(canApply, 'patch 无法干净应用'),
      conflicts,
      resolverPrompt: resolver.prompt
    }
  }

  let apply: WorktreeApplyResult
  try {
    apply = await input.applyPatch(patchInput)
  } catch (error) {
    apply = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return mergePatchResultEntry({
    input,
    session,
    taskId,
    sessionId,
    inspect,
    patchInput,
    result: apply
  })
}

function mergePatchResultEntry(args: {
  input: MergeTaskInput
  session: ReadyAutoMergeSession
  taskId: string
  sessionId: string
  inspect: InspectMergeSuccess
  patchInput: TaskDagAutoMergePatchInput
  result: WorktreeApplyResult
}): MergeTaskEntry {
  const { input, session, taskId, sessionId, inspect, patchInput, result } = args
  if (!result.ok || result.effectStatus !== 'confirmed') {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'failed',
      changedFiles: inspect.changedFiles,
      insertions: inspect.insertions,
      deletions: inspect.deletions,
      conflictRisk: inspect.conflictRisk,
      patchSha256: patchInput.patchSha256,
      patchPath: patchInput.patchPath,
      effectStatus: result.effectStatus,
      operationId: result.operationId,
      reconciliationRequired: result.reconciliationRequired,
      error: !result.ok
        ? resultError(result, '通过 Operation Effect Gateway 应用 patch 失败')
        : `Operation Effect 未确认生效:${result.effectStatus ?? 'missing'}`
    }
  }

  input.applied.push({
    entryIndex: input.entryIndex,
    input: patchInput
  })
  return {
    taskId,
    sessionId,
    branch: session.branch,
    worktreePath: session.worktreePath,
    repoRoot: session.repoRoot,
    status: result.applied ? 'merged' : 'skipped',
    changedFiles: result.changedFiles,
    insertions: inspect.insertions,
    deletions: inspect.deletions,
    conflictRisk: inspect.conflictRisk,
    patchSha256: patchInput.patchSha256,
    patchPath: patchInput.patchPath,
    commitSha: patchInput.headSha,
    effectStatus: result.effectStatus,
    operationId: result.operationId
  }
}

function selectMergeTask(input: MergeTaskInput): MergeTaskSelection {
  const taskId = input.taskState.task.id
  if (input.taskState.status !== 'success') {
    return { ready: false, entry: { taskId, status: 'skipped', error: `任务状态为 ${input.taskState.status}` } }
  }
  const sessionId = input.taskState.sessionIds[input.taskState.sessionIds.length - 1]
  if (!sessionId) {
    return { ready: false, entry: { taskId, status: 'skipped', error: '任务没有可合并的子会话' } }
  }
  const session = input.sessionMap.get(sessionId)
  if (!session) {
    return { ready: false, entry: { taskId, sessionId, status: 'skipped', error: '找不到子会话元数据' } }
  }
  if (!hasMergeCoordinates(session)) {
    return {
      ready: false,
      entry: {
        taskId,
        sessionId,
        branch: session.branch,
        worktreePath: session.worktreePath,
        status: 'skipped',
        error: '子会话缺少 repoRoot/worktreePath/baseSha'
      }
    }
  }
  if (input.repoRoot && path.resolve(input.repoRoot) !== path.resolve(session.repoRoot)) {
    return {
      ready: false,
      entry: {
        taskId,
        sessionId,
        branch: session.branch,
        worktreePath: session.worktreePath,
        status: 'blocked',
        error: 'DAG 自动合并暂不跨仓库合并'
      }
    }
  }
  return { ready: true, taskId, sessionId, session }
}

function hasMergeCoordinates(session: TaskDagAutoMergeSession): session is ReadyAutoMergeSession {
  return Boolean(session.repoRoot && session.worktreePath && session.baseSha)
}

function orderedTasks(execution: TaskDagExecutionView): TaskDagExecutionTask[] {
  const byId = new Map(execution.tasks.map((task) => [task.task.id, task]))
  const ordered: TaskDagExecutionTask[] = []
  const seen = new Set<string>()
  for (const layer of execution.layers) {
    for (const taskId of layer) {
      const task = byId.get(taskId)
      if (!task || seen.has(taskId)) continue
      ordered.push(task)
      seen.add(taskId)
    }
  }
  for (const task of execution.tasks) {
    if (seen.has(task.task.id)) continue
    ordered.push(task)
  }
  return ordered
}

function stripRepoRoot(
  entry: TaskDagAutoMergeEffectEntry & { repoRoot?: string }
): TaskDagAutoMergeEffectEntry {
  const { repoRoot: _repoRoot, ...view } = entry
  return view
}

function loadConflicts(repoRoot: string, worktreePath: string, baseSha: string): TaskDagAutoMergeConflict[] {
  const result = getConflictFiles(repoRoot, worktreePath, baseSha)
  if (!result.ok || !result.files) return []
  return result.files.map((file) => ({
    path: file.path,
    base: file.base,
    worktree: file.worktree,
    main: file.main,
    baseMissing: file.baseMissing,
    worktreeMissing: file.worktreeMissing,
    mainMissing: file.mainMissing,
    truncated: file.truncated
  }))
}

function runConfiguredVerification(
  repoRoot: string,
  command: string | undefined,
  timeoutMs: number,
  startedAt: number
): TaskDagAutoMergeVerification {
  if (!command) return { status: 'skipped', cwd: repoRoot, error: '未在 caogen.md 中找到验收命令' }
  if (parseWslHostPath(repoRoot)) {
    return { status: 'failed', command, cwd: repoRoot, durationMs: Date.now() - startedAt,
      error: 'WSL 自动合并的旧式宿主 Shell 验证入口不可用；请先通过此任务已绑定的 Agent Bash 执行验收。' }
  }

  const shell = process.platform === 'win32'
    ? {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${command}"`],
        windowsVerbatimArguments: true
      }
    : { command: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false }
  const result = spawnSync(shell.command, shell.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: buildMinimalSubprocessEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsVerbatimArguments: shell.windowsVerbatimArguments
  })
  const output = capOutput([result.stdout, result.stderr].filter((item): item is string => typeof item === 'string').join('\n'))
  if (result.error) {
    return {
      status: 'failed',
      command,
      cwd: repoRoot,
      exitCode: result.status,
      durationMs: Date.now() - startedAt,
      output,
      error: result.error.message
    }
  }
  return {
    status: result.status === 0 ? 'passed' : 'failed',
    command,
    cwd: repoRoot,
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    output,
    error: result.status === 0 ? undefined : `验收命令退出码 ${result.status ?? 'null'}`
  }
}

export function resolveVerificationCommand(repoRoot: string, overrideCommand?: string): string | undefined {
  const override = overrideCommand?.trim()
  if (override) return override
  for (const fileName of VERIFY_CONFIG_FILES) {
    const filePath = path.join(repoRoot, fileName)
    if (!existsSync(filePath)) continue
    const content = readFileSync(filePath, 'utf8')
    const command = extractVerificationCommand(content)
    if (command) return command
  }
  return undefined
}

function extractVerificationCommand(content: string): string | undefined {
  const direct = /^\s*(?:[-*]\s*)?(?:验证命令|测试命令|验收命令|verify|test)\s*[:：]\s*`?([^`\r\n]+)`?\s*$/im.exec(content)
  const directCommand = direct?.[1]?.trim()
  if (directCommand) return directCommand

  const heading = /^#{1,6}\s*(?:验证|测试|验收|verify|test)\s*$/im.exec(content)
  if (!heading || heading.index === undefined) return undefined
  const afterHeading = content.slice(heading.index + heading[0].length)
  const fenced = /```(?:bash|sh|powershell|pwsh|cmd)?\s*\r?\n([^\r\n`]+)\r?\n```/i.exec(afterHeading)
  return fenced?.[1]?.trim() || undefined
}

async function rollbackAppliedPatches(
  applied: AppliedPatch[],
  rollbackPatch: RunTaskDagAutoMergeOptions['rollbackPatch']
): Promise<TaskDagAutoMergeRollback> {
  if (applied.length === 0) return { attempted: false, ok: true }
  const entries: TaskDagAutoMergeRollbackEntry[] = []
  for (const patch of [...applied].reverse()) {
    const entry = rollbackPatch
      ? await rollbackPatchThroughEffect(patch.input, rollbackPatch)
      : rollbackPatchDirectly(patch.input)
    entries.push(entry)
    if (entry.status === 'failed') {
      return { attempted: true, ok: false, entries, error: entry.error ?? '反向 patch 回滚失败' }
    }
  }
  return { attempted: true, ok: true, entries }
}

async function rollbackPatchThroughEffect(
  input: TaskDagAutoMergePatchInput,
  rollbackPatch: NonNullable<RunTaskDagAutoMergeOptions['rollbackPatch']>
): Promise<TaskDagAutoMergeRollbackEntry> {
  let result: WorktreeApplyResult
  try {
    result = await rollbackPatch(input)
  } catch (error) {
    return {
      taskId: input.taskId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (!result.ok || result.effectStatus !== 'confirmed') {
    return {
      taskId: input.taskId,
      status: 'failed',
      effectStatus: result.effectStatus,
      operationId: result.operationId,
      reconciliationRequired: result.reconciliationRequired,
      error: !result.ok
        ? resultError(result, '通过 Operation Effect Gateway 回滚 patch 失败')
        : `Rollback Operation Effect 未确认生效:${result.effectStatus ?? 'missing'}`
    }
  }
  return {
    taskId: input.taskId,
    status: 'rolled-back',
    effectStatus: result.effectStatus,
    operationId: result.operationId,
    reconciliationRequired: result.reconciliationRequired
  }
}

function rollbackPatchDirectly(input: TaskDagAutoMergePatchInput): TaskDagAutoMergeRollbackEntry {
  const reverted = reverseSquashPatch(input.repoRoot, input.patchText)
  return reverted.ok
    ? { taskId: input.taskId, status: 'rolled-back' }
    : {
        taskId: input.taskId,
        status: 'failed',
        error: resultError(reverted, '反向 patch 回滚失败')
      }
}

function resultError(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: unknown }).error
    if (typeof error === 'string' && error.trim()) return error
  }
  return fallback
}

function summarizeStatus(input: {
  mergedCount: number
  blockedCount: number
  failedCount: number
  rolledBackCount: number
  verification: TaskDagAutoMergeVerification
  rollback?: TaskDagAutoMergeView['rollback']
}): TaskDagAutoMergeView['status'] {
  if (input.rolledBackCount > 0) return 'rolled-back'
  if (input.rollback && !input.rollback.ok) return 'failed'
  if (input.failedCount > 0) return 'failed'
  if (input.blockedCount > 0) return input.mergedCount > 0 ? 'partial' : 'failed'
  if (input.verification.status === 'failed') return 'failed'
  return 'success'
}

function buildSummary(
  mergedCount: number,
  blockedCount: number,
  skippedCount: number,
  failedCount: number,
  rolledBackCount: number,
  verification: TaskDagAutoMergeVerification
): string {
  return [
    `自动合并: ${mergedCount} 已合并`,
    blockedCount > 0 ? `${blockedCount} 阻塞` : '',
    failedCount > 0 ? `${failedCount} 失败` : '',
    skippedCount > 0 ? `${skippedCount} 跳过` : '',
    rolledBackCount > 0 ? `${rolledBackCount} 已回滚` : '',
    `验收: ${verification.status}`
  ]
    .filter(Boolean)
    .join(' / ')
}

function firstError(
  entries: TaskDagAutoMergeEntry[],
  verification: TaskDagAutoMergeVerification,
  rollback?: TaskDagAutoMergeView['rollback']
): string | undefined {
  return entries.find((entry) => entry.error)?.error ?? verification.error ?? rollback?.error
}

function patchOutputRoot(): string {
  return path.join(tmpdir(), 'caogen-dag-auto-merge-patches')
}

function capOutput(output: string): string {
  const clean = output.trim()
  return clean.length > MAX_VERIFY_OUTPUT_CHARS ? `${clean.slice(0, MAX_VERIFY_OUTPUT_CHARS)}\n[已截断]` : clean
}
