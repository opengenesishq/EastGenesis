import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import { assertManagedWorktreeExecutionPath } from './wsl-worktree-path'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  EffectTarget,
  FileSystemIdentity,
  ManagedWorktreeProjectionRecord
} from '../../shared/types'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from '../task/effect-reconciliation-result'
import { stableValueDigest } from '../task/tool-idempotency'
import { inspectManagedWorktreeRegistryProjection } from '../managed-worktree-lifecycle'
import { isolatedLocalGitEnv, unsafeMergeConfigKeys, withSafeLocalGitConfig } from './safe-git'
import {
  assertExactManagedWorktreeInput,
  parseManagedWorktreePlanInput,
  requiredManagedWorktreeBoolean
} from './managed-worktree-effect-input'

const GIT_TIMEOUT_MS = 120_000
const MAX_GIT_OUTPUT = 16 * 1024 * 1024
const CREATE_INPUT_KEYS = [
  'baseBranch',
  'baseSha',
  'branch',
  'registryRecord',
  'sessionId',
  'sourceCwd',
  'worktreePath'
] as const
const REMOVE_INPUT_KEYS = [...CREATE_INPUT_KEYS, 'deleteBranch', 'force'] as const
const GIT_OPERATION_MARKERS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'BISECT_START',
  'rebase-apply',
  'rebase-merge',
  'sequencer'
] as const

export type ManagedWorktreeCreateTarget = Extract<EffectTarget, { kind: 'git_worktree_create' }>
export type ManagedWorktreeRemoveTarget = Extract<EffectTarget, { kind: 'git_worktree_remove' }>
export type ManagedWorktreeLifecycleTarget = ManagedWorktreeCreateTarget | ManagedWorktreeRemoveTarget
export type ManagedWorktreeLifecycleExecutionResult = { ok: true } | { ok: false; error: string }

interface SourceState {
  sourceCwd: string
  sourceCwdIdentity: FileSystemIdentity
  repoRoot: string
  repoRootIdentity: FileSystemIdentity
  gitCommonDir: string
  gitCommonDirIdentity: FileSystemIdentity
  sourceWorktreeGitDir: string
  sourceWorktreeGitDirIdentity: FileSystemIdentity
  sourceHead: string
  sourceHeadRef: string | null
  sourcePrefix: string
}

interface WorktreeEntry {
  path: string
  head?: string
  branch?: string
  detached: boolean
  locked?: string
  prunable?: string
}

interface PathState {
  state: 'absent' | 'directory' | 'other'
  identity?: FileSystemIdentity
}

interface RemoveObservation {
  sourceMatches: boolean
  path: PathState
  gitDir: PathState
  entry?: WorktreeEntry
  branchSha?: string
  headSha?: string
  branchRef?: string | null
  worktreeRootIdentity?: FileSystemIdentity
  worktreeGitDirIdentity?: FileSystemIdentity
  statusDigest?: string
  operationStateDigest?: string
  preStateDigest?: string
}

export function buildManagedWorktreeCreateTarget(
  cwd: string,
  toolInput: Record<string, unknown>
): ManagedWorktreeCreateTarget {
  assertExactManagedWorktreeInput(toolInput, CREATE_INPUT_KEYS)
  const common = parseManagedWorktreePlanInput(toolInput)
  const source = observeSource(cwd, common.sourceCwd)
  assertManagedWorktreeExecutionPath(source.repoRoot, source.gitCommonDir, common.worktreePath, common.sessionId)
  assertNoExecutableCheckoutConfig(source.repoRoot)
  if (source.sourceHead !== common.baseSha || shortBranch(source.sourceHeadRef) !== common.baseBranch) {
    throw new Error('managed worktree create 的 baseSha/baseBranch 与当前 source HEAD/ref 不一致')
  }
  assertBranchName(source.repoRoot, common.branch)
  const branchRef = `refs/heads/${common.branch}`
  if (readRef(source.repoRoot, branchRef)) throw new Error(`managed worktree 分支已存在:${common.branch}`)
  const plannedPath = planAbsentWorktreePath(common.worktreePath)
  if (findWorktreeEntry(source.repoRoot, plannedPath.worktreePath)) {
    throw new Error('目标 worktreePath 已存在 Git worktree 注册记录')
  }
  const worktreeCwd = resolve(plannedPath.worktreePath, source.sourcePrefix)
  assertRegistryRecordMatchesTarget(common.registryRecord, source, worktreeCwd, common, 'active')
  return {
    kind: 'git_worktree_create',
    sessionId: common.sessionId,
    sourceCwd: source.sourceCwd,
    sourceCwdIdentity: source.sourceCwdIdentity,
    repoRoot: source.repoRoot,
    repoRootIdentity: source.repoRootIdentity,
    gitCommonDir: source.gitCommonDir,
    gitCommonDirIdentity: source.gitCommonDirIdentity,
    sourceWorktreeGitDir: source.sourceWorktreeGitDir,
    sourceWorktreeGitDirIdentity: source.sourceWorktreeGitDirIdentity,
    worktreePath: plannedPath.worktreePath,
    worktreeCwd,
    sourcePrefix: source.sourcePrefix,
    worktreeParentPath: plannedPath.parentPath,
    worktreeParentPreState: plannedPath.parentState.state as 'absent' | 'directory',
    ...(plannedPath.parentState.identity ? { worktreeParentPreIdentity: plannedPath.parentState.identity } : {}),
    worktreeParentAnchorPath: plannedPath.anchorPath,
    worktreeParentAnchorIdentity: plannedPath.anchorIdentity,
    branch: common.branch,
    branchRef,
    baseSha: common.baseSha,
    baseBranch: common.baseBranch,
    sourceHeadRef: source.sourceHeadRef,
    registryRecord: common.registryRecord
  }
}

export function buildManagedWorktreeRemoveTarget(
  cwd: string,
  toolInput: Record<string, unknown>
): ManagedWorktreeRemoveTarget {
  assertExactManagedWorktreeInput(toolInput, REMOVE_INPUT_KEYS)
  const common = parseManagedWorktreePlanInput(toolInput)
  const force = requiredManagedWorktreeBoolean(toolInput.force, 'force')
  const deleteBranch = requiredManagedWorktreeBoolean(toolInput.deleteBranch, 'deleteBranch')
  const source = observeSource(cwd, common.sourceCwd)
  assertNoExecutableCheckoutConfig(source.repoRoot)
  assertBranchName(source.repoRoot, common.branch)
  const worktreePath = requireExistingDirectory(common.worktreePath, 'worktreePath')
  const details = observeExistingWorktree(source, worktreePath, common.branch)
  if (!force && details.statusText.length > 0) {
    throw new Error('managed worktree 有未提交改动；force=false 已在建立 effect 前停止')
  }
  if (details.entry.locked !== undefined) throw new Error('locked managed worktree 不允许自动移除')
  if (deleteBranch && !force) assertBranchDeletionIsSafe(source, details.branchSha)
  const worktreeCwd = resolve(worktreePath, source.sourcePrefix)
  assertRegistryRecordMatchesTarget(common.registryRecord, source, worktreeCwd, common, 'removed')
  const state = removePreStatePayload({
    sourceHead: source.sourceHead,
    sourceHeadRef: source.sourceHeadRef,
    entry: details.entry,
    branchSha: details.branchSha,
    headSha: details.headSha,
    branchRef: details.branchRef,
    worktreeRootIdentity: details.worktreeRootIdentity,
    worktreeGitDirIdentity: details.worktreeGitDirIdentity,
    statusDigest: details.statusDigest,
    operationStateDigest: details.operationStateDigest,
    force,
    deleteBranch
  })
  return {
    kind: 'git_worktree_remove',
    sessionId: common.sessionId,
    sourceCwd: source.sourceCwd,
    sourceCwdIdentity: source.sourceCwdIdentity,
    repoRoot: source.repoRoot,
    repoRootIdentity: source.repoRootIdentity,
    gitCommonDir: source.gitCommonDir,
    gitCommonDirIdentity: source.gitCommonDirIdentity,
    sourceWorktreeGitDir: source.sourceWorktreeGitDir,
    sourceWorktreeGitDirIdentity: source.sourceWorktreeGitDirIdentity,
    sourceHead: source.sourceHead,
    sourceHeadRef: source.sourceHeadRef,
    worktreePath,
    worktreeCwd,
    sourcePrefix: source.sourcePrefix,
    worktreeRootIdentity: details.worktreeRootIdentity,
    worktreeGitDir: details.worktreeGitDir,
    worktreeGitDirIdentity: details.worktreeGitDirIdentity,
    branch: common.branch,
    branchRef: details.branchRef,
    branchSha: details.branchSha,
    headSha: details.headSha,
    baseSha: common.baseSha,
    baseBranch: common.baseBranch,
    worktreeStatusDigest: details.statusDigest,
    worktreeOperationStateDigest: details.operationStateDigest,
    preStateDigest: stableValueDigest(state),
    force,
    deleteBranch,
    registryRecord: common.registryRecord
  }
}

export function executeManagedWorktreeCreateTarget(
  target: ManagedWorktreeCreateTarget
): ManagedWorktreeLifecycleExecutionResult {
  try {
    assertManagedWorktreeExecutionPath(target.repoRoot, target.gitCommonDir, target.worktreePath, target.sessionId)
    requireNotApplied(reconcileManagedWorktreeCreateTarget(target), 'create')
    mkdirSync(target.worktreeParentPath, { recursive: true })
    assertCreatedParentIsSafe(target)
    withIsolatedHooks((hooksPath) => {
      runGitMutation(target.repoRoot, [
        'worktree', 'add', '--no-track', '-b', target.branch, target.worktreePath, target.baseSha
      ], hooksPath)
    })
    mkdirSync(target.worktreeCwd, { recursive: true })
    const result = reconcileManagedWorktreeCreateTarget(target)
    if (result.kind !== 'confirmed') throw new Error(`create 后置条件未收敛:${result.reason}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function executeManagedWorktreeRemoveTarget(
  target: ManagedWorktreeRemoveTarget
): ManagedWorktreeLifecycleExecutionResult {
  try {
    requireNotApplied(reconcileManagedWorktreeRemoveTarget(target), 'remove')
    assertNoExecutableCheckoutConfig(target.repoRoot)
    if (target.deleteBranch && !target.force) assertBranchDeletionIsSafe(target, target.branchSha)
    withIsolatedHooks((hooksPath) => {
      runGitMutation(target.repoRoot, [
        'worktree', 'remove', ...(target.force ? ['--force'] : []), target.worktreePath
      ], hooksPath)
      if (target.deleteBranch) {
        runGitMutation(
          target.repoRoot,
          ['update-ref', '-d', target.branchRef, target.branchSha],
          hooksPath
        )
      }
    })
    const result = reconcileManagedWorktreeRemoveTarget(target)
    if (result.kind !== 'confirmed') throw new Error(`remove 后置条件未收敛:${result.reason}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function reconcileManagedWorktreeLifecycleTarget(
  target: ManagedWorktreeLifecycleTarget
): EffectReconciliationResult {
  const gitState = reconcileManagedWorktreeGitTarget(target)
  const registryState = inspectManagedWorktreeRegistryProjection(target)
  const payload = { kind: target.kind, gitState, registryState }
  if (gitState.kind === 'confirmed' && registryState.kind === 'confirmed') {
    return confirmed(payload, 'managed worktree Git 状态与 registry projection 均满足冻结后置条件')
  }
  if (gitState.kind === 'not_applied' && registryState.kind === 'not_applied') {
    return notApplied(payload, 'managed worktree Git 状态与 registry projection 均保持执行前状态')
  }
  return unresolved({ ...payload, reason: 'managed worktree Git 状态与 registry projection 尚未共同收敛' })
}

export function reconcileManagedWorktreeGitTarget(
  target: ManagedWorktreeLifecycleTarget
): EffectReconciliationResult {
  return target.kind === 'git_worktree_create'
    ? reconcileManagedWorktreeCreateTarget(target)
    : reconcileManagedWorktreeRemoveTarget(target)
}

export function reconcileManagedWorktreeCreateTarget(
  target: ManagedWorktreeCreateTarget
): EffectReconciliationResult {
  try {
    const source = sourceMatchesCreateTarget(target)
    const parent = pathState(target.worktreeParentPath)
    const path = pathState(target.worktreePath)
    const cwd = pathState(target.worktreeCwd)
    const entry = findWorktreeEntry(target.repoRoot, target.worktreePath)
    const branchSha = readRef(target.repoRoot, target.branchRef)
    const payload = { kind: target.kind, source, parent, path, cwd, entry, branchSha }
    if (!source.identityMatches || !source.anchorMatches) {
      return unresolved({ ...payload, reason: 'managed worktree create 的 repo/common-dir/source identity 已变化' })
    }
    if (isCreateParentReady(target, parent) && isCreateConfirmed(target, path, cwd, entry, branchSha)) {
      return confirmed(payload, 'managed worktree path/ref/HEAD 与冻结后置条件完全一致')
    }
    if (isCreateNotApplied(target, source, parent, path, entry, branchSha)) {
      return notApplied(payload, 'managed worktree path、分支和父目录均保持冻结执行前状态')
    }
    return unresolved({ ...payload, reason: 'managed worktree create 处于部分完成或漂移状态' })
  } catch (error) {
    return unresolved({ kind: target.kind, reason: errorMessage(error) })
  }
}

export function reconcileManagedWorktreeRemoveTarget(
  target: ManagedWorktreeRemoveTarget
): EffectReconciliationResult {
  try {
    const observation = observeRemoveTarget(target)
    const payload = { kind: target.kind, ...observation }
    if (!observation.sourceMatches) {
      return unresolved({ ...payload, reason: 'managed worktree remove 的 repo/common-dir/source identity 已变化' })
    }
    if (isRemoveConfirmed(target, observation)) {
      return confirmed(payload, 'managed worktree 注册、目录与分支均满足冻结删除后置条件')
    }
    if (observation.preStateDigest === target.preStateDigest) {
      return notApplied(payload, 'managed worktree remove 的完整 pre-state digest 保持不变')
    }
    return unresolved({ ...payload, reason: 'managed worktree remove 处于部分完成或漂移状态' })
  } catch (error) {
    return unresolved({ kind: target.kind, reason: errorMessage(error) })
  }
}

function observeSource(cwd: string, declaredSourceCwd: string): SourceState {
  const sourceCwd = requireExistingDirectory(declaredSourceCwd, 'sourceCwd')
  if (requireExistingDirectory(cwd, 'cwd') !== sourceCwd) {
    throw new Error('Gateway cwd 与 toolInput.sourceCwd 不是同一目录')
  }
  const repoRoot = resolveGitPath(sourceCwd, ['rev-parse', '--show-toplevel'])
  const gitCommonDir = resolveGitPath(repoRoot, ['rev-parse', '--git-common-dir'])
  const sourceWorktreeGitDir = resolveGitPath(repoRoot, ['rev-parse', '--git-dir'])
  const sourcePrefix = relative(repoRoot, sourceCwd)
  if (sourcePrefix === '..' || sourcePrefix.startsWith(`..${sep}`) || isAbsolute(sourcePrefix)) {
    throw new Error('sourceCwd 不在 source worktree 根目录内')
  }
  return {
    sourceCwd,
    sourceCwdIdentity: fileSystemIdentity(sourceCwd),
    repoRoot,
    repoRootIdentity: fileSystemIdentity(repoRoot),
    gitCommonDir,
    gitCommonDirIdentity: fileSystemIdentity(gitCommonDir),
    sourceWorktreeGitDir,
    sourceWorktreeGitDirIdentity: fileSystemIdentity(sourceWorktreeGitDir),
    sourceHead: gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    sourceHeadRef: symbolicHead(repoRoot),
    sourcePrefix
  }
}

function observeExistingWorktree(source: SourceState, worktreePath: string, branch: string) {
  const entry = findWorktreeEntry(source.repoRoot, worktreePath)
  if (!entry) throw new Error('目标路径没有 Git worktree 注册记录')
  const root = resolveGitPath(worktreePath, ['rev-parse', '--show-toplevel'])
  if (root !== worktreePath) throw new Error('目标路径不是 worktree 根目录')
  const commonDir = resolveGitPath(worktreePath, ['rev-parse', '--git-common-dir'])
  if (commonDir !== source.gitCommonDir) throw new Error('目标 worktree 不属于冻结的 git common-dir')
  const worktreeGitDir = resolveGitPath(worktreePath, ['rev-parse', '--git-dir'])
  const branchRef = symbolicHead(worktreePath)
  const expectedBranchRef = `refs/heads/${branch}`
  if (branchRef !== expectedBranchRef || entry.branch !== expectedBranchRef) {
    throw new Error('目标 worktree 当前分支与 managed record 不一致')
  }
  const headSha = gitText(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const branchSha = readRef(source.repoRoot, expectedBranchRef)
  if (!branchSha || branchSha !== headSha || entry.head !== headSha) {
    throw new Error('目标 worktree HEAD、branch ref 与 worktree registry 不一致')
  }
  const statusText = gitTextAllowEmpty(worktreePath, [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all'
  ])
  return {
    entry,
    branchRef,
    branchSha,
    headSha,
    worktreeGitDir,
    worktreeRootIdentity: fileSystemIdentity(worktreePath),
    worktreeGitDirIdentity: fileSystemIdentity(worktreeGitDir),
    statusText,
    statusDigest: stableValueDigest(statusText),
    operationStateDigest: gitOperationStateDigest(worktreeGitDir)
  }
}

function sourceMatchesCreateTarget(target: ManagedWorktreeCreateTarget) {
  const current = observeSource(target.sourceCwd, target.sourceCwd)
  return {
    identityMatches: sourceIdentityMatches(target, current),
    anchorMatches: sameIdentity(target.worktreeParentAnchorIdentity, fileSystemIdentity(target.worktreeParentAnchorPath)),
    preHeadMatches: current.sourceHead === target.baseSha && current.sourceHeadRef === target.sourceHeadRef
  }
}

function observeRemoveTarget(target: ManagedWorktreeRemoveTarget): RemoveObservation {
  const source = observeSource(target.sourceCwd, target.sourceCwd)
  const sourceMatches = sourceIdentityMatches(target, source)
  const path = pathState(target.worktreePath)
  const gitDir = pathState(target.worktreeGitDir)
  const entry = findWorktreeEntry(target.repoRoot, target.worktreePath)
  const branchSha = readRef(target.repoRoot, target.branchRef)
  const observation: RemoveObservation = { sourceMatches, path, gitDir, entry, branchSha }
  if (path.state !== 'directory') return observation
  try {
    const details = observeExistingWorktree(source, target.worktreePath, target.branch)
    const state = removePreStatePayload({
      sourceHead: source.sourceHead,
      sourceHeadRef: source.sourceHeadRef,
      entry: details.entry,
      branchSha: details.branchSha,
      headSha: details.headSha,
      branchRef: details.branchRef,
      worktreeRootIdentity: details.worktreeRootIdentity,
      worktreeGitDirIdentity: details.worktreeGitDirIdentity,
      statusDigest: details.statusDigest,
      operationStateDigest: details.operationStateDigest,
      force: target.force,
      deleteBranch: target.deleteBranch
    })
    return {
      ...observation,
      headSha: details.headSha,
      branchRef: details.branchRef,
      worktreeRootIdentity: details.worktreeRootIdentity,
      worktreeGitDirIdentity: details.worktreeGitDirIdentity,
      statusDigest: details.statusDigest,
      operationStateDigest: details.operationStateDigest,
      preStateDigest: stableValueDigest(state)
    }
  } catch {
    return observation
  }
}

function isCreateConfirmed(
  target: ManagedWorktreeCreateTarget,
  path: PathState,
  cwd: PathState,
  entry: WorktreeEntry | undefined,
  branchSha: string | undefined
): boolean {
  if (path.state !== 'directory' || cwd.state !== 'directory' || !entry) return false
  if (entry.path !== target.worktreePath || entry.head !== target.baseSha || entry.branch !== target.branchRef) return false
  if (entry.locked !== undefined || entry.prunable !== undefined || branchSha !== target.baseSha) return false
  try {
    const root = resolveGitPath(target.worktreePath, ['rev-parse', '--show-toplevel'])
    const common = resolveGitPath(target.worktreePath, ['rev-parse', '--git-common-dir'])
    const head = gitText(target.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])
    return root === target.worktreePath && common === target.gitCommonDir && head === target.baseSha && symbolicHead(root) === target.branchRef
  } catch {
    return false
  }
}

function isCreateParentReady(target: ManagedWorktreeCreateTarget, parent: PathState): boolean {
  if (parent.state !== 'directory') return false
  if (!directoryChainIsSafe(target.worktreeParentAnchorPath, target.worktreeParentPath)) return false
  return target.worktreeParentPreState === 'absent' || sameIdentity(parent.identity, target.worktreeParentPreIdentity)
}

function isCreateNotApplied(
  target: ManagedWorktreeCreateTarget,
  source: ReturnType<typeof sourceMatchesCreateTarget>,
  parent: PathState,
  path: PathState,
  entry: WorktreeEntry | undefined,
  branchSha: string | undefined
): boolean {
  if (!source.preHeadMatches || path.state !== 'absent' || entry || branchSha) return false
  if (target.worktreeParentPreState === 'absent') {
    return parent.state === 'absent'
      && missingDirectoryChainUnchanged(target.worktreeParentAnchorPath, target.worktreeParentPath)
  }
  return parent.state === 'directory' && sameIdentity(parent.identity, target.worktreeParentPreIdentity)
}

function isRemoveConfirmed(target: ManagedWorktreeRemoveTarget, observed: RemoveObservation): boolean {
  if (observed.path.state !== 'absent' || observed.gitDir.state !== 'absent' || observed.entry) return false
  return target.deleteBranch ? observed.branchSha === undefined : observed.branchSha === target.branchSha
}

function sourceIdentityMatches(
  target: ManagedWorktreeLifecycleTarget,
  source: SourceState
): boolean {
  return [
    target.sourceCwd === source.sourceCwd,
    target.repoRoot === source.repoRoot,
    target.gitCommonDir === source.gitCommonDir,
    target.sourceWorktreeGitDir === source.sourceWorktreeGitDir,
    sameIdentity(target.sourceCwdIdentity, source.sourceCwdIdentity),
    sameIdentity(target.repoRootIdentity, source.repoRootIdentity),
    sameIdentity(target.gitCommonDirIdentity, source.gitCommonDirIdentity),
    sameIdentity(target.sourceWorktreeGitDirIdentity, source.sourceWorktreeGitDirIdentity)
  ].every(Boolean)
}

function removePreStatePayload(value: Record<string, unknown>): Record<string, unknown> {
  return value
}

function planAbsentWorktreePath(rawPath: string) {
  if (!isAbsolute(rawPath) || rawPath.includes('\0')) throw new Error('worktreePath 必须是不含 NUL 的绝对路径')
  const requested = resolve(rawPath)
  if (pathState(requested).state !== 'absent') throw new Error('目标 worktreePath 必须不存在')
  let cursor = requested
  const missing: string[] = []
  while (pathState(cursor).state === 'absent') {
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error('无法找到 worktreePath 的既存父目录 anchor')
    missing.unshift(basename(cursor))
    cursor = parent
  }
  const anchorState = pathState(cursor)
  if (anchorState.state !== 'directory' || !anchorState.identity) throw new Error('worktreePath 既存父级不是普通目录')
  const anchorPath = realpathSync(cursor)
  const worktreePath = resolve(anchorPath, ...missing)
  const parentPath = dirname(worktreePath)
  const parentState = pathState(parentPath)
  if (parentState.state === 'other') throw new Error('worktreePath 父目录不是普通目录')
  return { worktreePath, parentPath, parentState, anchorPath, anchorIdentity: fileSystemIdentity(anchorPath) }
}

function assertCreatedParentIsSafe(target: ManagedWorktreeCreateTarget): void {
  if (!sameIdentity(fileSystemIdentity(target.worktreeParentAnchorPath), target.worktreeParentAnchorIdentity)) {
    throw new Error('worktree parent anchor identity 在 mkdir 期间发生变化')
  }
  const parent = pathState(target.worktreeParentPath)
  if (parent.state !== 'directory') throw new Error('worktree parent 未创建为普通目录')
  if (!directoryChainIsSafe(target.worktreeParentAnchorPath, target.worktreeParentPath)) {
    throw new Error('worktree parent 路径链包含 symlink 或非目录组件')
  }
  if (pathState(target.worktreePath).state !== 'absent') throw new Error('worktreePath 在执行前已被占用')
  if (findWorktreeEntry(target.repoRoot, target.worktreePath) || readRef(target.repoRoot, target.branchRef)) {
    throw new Error('worktree 注册或 branch ref 在执行前已变化')
  }
  const source = sourceMatchesCreateTarget(target)
  if (!source.identityMatches || !source.anchorMatches || !source.preHeadMatches) {
    throw new Error('managed worktree create CAS 在执行前失效')
  }
  assertNoExecutableCheckoutConfig(target.repoRoot)
}

function directoryChainIsSafe(anchorPath: string, directoryPath: string): boolean {
  const suffix = relative(anchorPath, directoryPath)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return false
  let cursor = anchorPath
  try {
    for (const component of suffix.split(sep).filter(Boolean)) {
      cursor = join(cursor, component)
      if (pathState(cursor).state !== 'directory') return false
    }
    return true
  } catch {
    return false
  }
}

function missingDirectoryChainUnchanged(anchorPath: string, directoryPath: string): boolean {
  const suffix = relative(anchorPath, directoryPath)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return false
  const firstMissingPath = join(anchorPath, suffix.split(sep)[0])
  return pathState(firstMissingPath).state === 'absent'
}

function assertBranchDeletionIsSafe(source: Pick<SourceState, 'repoRoot' | 'sourceHead'>, branchSha: string): void {
  const result = runGit(source.repoRoot, ['merge-base', '--is-ancestor', branchSha, source.sourceHead], [0, 1])
  if (result.status !== 0) throw new Error('force=false 时只允许删除已合入 source HEAD 的 managed branch')
}

function assertBranchName(repoRoot: string, branch: string): void {
  runGit(repoRoot, ['check-ref-format', '--branch', branch], [0])
}

function assertNoExecutableCheckoutConfig(repoRoot: string): void {
  const config = gitTextAllowEmpty(repoRoot, ['config', '--includes', '-z', '--list'])
  const filters = unsafeMergeConfigKeys(config).filter((key) => /^filter\..+\.(?:clean|smudge|process)$/i.test(key))
  if (filters.length > 0) throw new Error(`仓库配置了可执行 Git filter，已阻止 worktree lifecycle:${filters.join(', ')}`)
}

function findWorktreeEntry(repoRoot: string, worktreePath: string): WorktreeEntry | undefined {
  const matches = worktreeEntries(repoRoot).filter((entry) => comparablePath(entry.path) === comparablePath(worktreePath))
  if (matches.length > 1) throw new Error('Git worktree registry 对目标路径存在重复记录')
  return matches[0]
}

function worktreeEntries(repoRoot: string): WorktreeEntry[] {
  const fields = gitTextAllowEmpty(repoRoot, ['worktree', 'list', '--porcelain', '-z']).split('\0')
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  for (const field of fields) {
    if (!field) {
      if (current) entries.push(current)
      current = undefined
    } else if (field.startsWith('worktree ')) {
      current = { path: comparablePath(field.slice(9)), detached: false }
    } else if (current) {
      applyWorktreeField(current, field)
    }
  }
  if (current) entries.push(current)
  return entries
}

function applyWorktreeField(entry: WorktreeEntry, field: string): void {
  if (field.startsWith('HEAD ')) entry.head = field.slice(5)
  else if (field.startsWith('branch ')) entry.branch = field.slice(7)
  else if (field === 'detached') entry.detached = true
  else if (field === 'locked' || field.startsWith('locked ')) entry.locked = field.slice(6).trim()
  else if (field === 'prunable' || field.startsWith('prunable ')) entry.prunable = field.slice(8).trim()
}

function resolveGitPath(cwd: string, args: string[]): string {
  const raw = gitText(cwd, args)
  return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw))
}

function symbolicHead(cwd: string): string | null {
  const result = runGit(cwd, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1])
  return result.status === 0 ? result.stdout.trim() : null
}

function readRef(repoRoot: string, ref: string): string | undefined {
  const result = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref], [0, 1])
  return result.status === 0 ? result.stdout.trim() : undefined
}

function shortBranch(ref: string | null): string | null {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
}

function gitOperationStateDigest(worktreeGitDir: string): string {
  const present = GIT_OPERATION_MARKERS.filter((name) => pathState(join(worktreeGitDir, name)).state !== 'absent')
  return stableValueDigest(present)
}

function pathState(filePath: string): PathState {
  try {
    const stat = lstatSync(filePath, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'other' }
    return { state: 'directory', identity: { device: stat.dev.toString(), inode: stat.ino.toString() } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    throw error
  }
}

function requireExistingDirectory(value: string, name: string): string {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error(`${name} 必须是不含 NUL 的绝对路径`)
  const state = pathState(resolve(value))
  if (state.state !== 'directory') throw new Error(`${name} 必须是既存普通目录`)
  return realpathSync(resolve(value))
}

function comparablePath(value: string): string {
  try {
    return realpathSync(resolve(value))
  } catch {
    return resolve(value)
  }
}

function fileSystemIdentity(filePath: string): FileSystemIdentity {
  const stat = statSync(filePath, { bigint: true })
  return { device: stat.dev.toString(), inode: stat.ino.toString() }
}

function sameIdentity(left?: FileSystemIdentity, right?: FileSystemIdentity): boolean {
  return !!left && !!right && left.device === right.device && left.inode === right.inode
}

function withIsolatedHooks(task: (hooksPath: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'caogen-worktree-hooks-'))
  try {
    task(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runGitMutation(cwd: string, args: string[], hooksPath: string): void {
  runGit(cwd, args, [0], hooksPath)
}

function runGit(cwd: string, args: string[], allowedStatuses: number[], hooksPath?: string) {
  const config = [
    '-c', 'core.preloadIndex=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'maintenance.autoDetach=false',
    '-c', 'submodule.recurse=false',
    '-c', 'protocol.allow=never',
    ...(hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : []),
    '-C', cwd,
    ...args
  ]
  const result = spawnSync('git', withSafeLocalGitConfig(config), {
    encoding: 'utf8',
    env: isolatedLocalGitEnv(process.env),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const status = result.status ?? -1
  if (result.error || !allowedStatuses.includes(status)) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit ${status}`
    throw new Error(`git ${args[0]} failed: ${detail}`)
  }
  return { status, stdout: result.stdout ?? '' }
}

function gitText(cwd: string, args: string[]): string {
  const text = runGit(cwd, args, [0]).stdout.trim()
  if (!text) throw new Error(`git ${args[0]} 未返回结果`)
  return text
}

function gitTextAllowEmpty(cwd: string, args: string[]): string {
  return runGit(cwd, args, [0]).stdout
}

function assertRegistryRecordMatchesTarget(
  record: Readonly<ManagedWorktreeProjectionRecord>,
  source: SourceState,
  worktreeCwd: string,
  common: { worktreePath: string },
  state: ManagedWorktreeProjectionRecord['state']
): void {
  if (
    record.repoRoot !== source.repoRoot ||
    comparablePath(record.sourceCwd) !== source.sourceCwd ||
    record.worktreePath !== common.worktreePath ||
    comparablePath(record.cwd) !== worktreeCwd ||
    record.state !== state
  ) {
    throw new Error('registryRecord 与观测到的 repo/source/worktree 目标不一致')
  }
}

function requireNotApplied(result: EffectReconciliationResult, operation: string): void {
  if (result.kind !== 'not_applied') throw new Error(`${operation} 执行前 Target/CAS 不再匹配:${result.reason}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
