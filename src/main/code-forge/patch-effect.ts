import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { FileSystemIdentity } from '../../shared/types'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from '../git/safe-git'
import {
  patchSha256,
  WORKTREE_MERGE_EXCLUDE_PATHSPECS,
  type ConflictRisk
} from '../worktreeMerge'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from '../task/effect-reconciliation-result'
import type {
  CodeForgeChangeSummary,
  CodeForgeDeliveryInput,
  CodeForgePatchReport,
  CodeForgeTargetReport
} from './delivery'
import {
  assertCodeForgePatchArtifactTarget,
  codeForgePatchArtifactPath,
  codeForgePatchArtifactRoot,
  MAX_PATCH_ARTIFACT_BYTES,
  observeCodeForgePatchArtifact,
  publishCodeForgePatchArtifact,
  type CodeForgePatchArtifactSeed,
  type CodeForgePatchEffectTarget,
  type PatchArtifactObservation
} from './patch-artifact'
import {
  assertNoExecutableCodeForgeFiltersIn,
  inspectCodeForgeUntrackedFiles,
  type CodeForgeUntrackedFileObservation
} from './source-security'
import { trustedCodeForgeManagedWorktree } from './managed-context-security'
import {
  buildCodeForgePatchText,
  checkCodeForgePatchApplies,
  codeForgeChangedFiles,
  codeForgeDiffStats,
  listCodeForgeUntrackedFiles
} from './patch-source'

export type { CodeForgePatchEffectTarget } from './patch-artifact'

export interface CodeForgePatchExecution {
  target: CodeForgeTargetReport
  changes: CodeForgeChangeSummary
  patch: CodeForgePatchReport
}

interface ResolvedContext {
  target: CodeForgeTargetReport
}

interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

interface FrozenPatchPlan {
  context: ResolvedContext
  source: PatchSourceIdentity
  changes: CodeForgeChangeSummary
  changedPaths: string[]
  patchText: string
  patchSha256: string
  patchBytes: number
  canApply?: boolean
  applyError?: string
  conflictFiles?: string[]
  sourceStateDigest: string
}

interface PatchSourceIdentity {
  repoRoot: string
  repoRootIdentity: FileSystemIdentity
  gitCommonDir: string
  gitCommonDirIdentity: FileSystemIdentity
  worktreePath: string
  worktreeRootIdentity: FileSystemIdentity
  worktreeGitDir: string
  worktreeGitDirIdentity: FileSystemIdentity
  baseSha: string
  headSha: string
}

const MAX_OUTPUT_CHARS = 12_000
const MAX_FILE_LIST = 80
const MAX_GIT_BUFFER = 32 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000
const MAX_EFFECT_CHANGED_PATHS = 5_000
const MAX_EFFECT_CHANGED_PATH_BYTES = 512 * 1024

export function buildCodeForgePatchEffectTarget(
  input: CodeForgeDeliveryInput
): CodeForgePatchEffectTarget {
  assertPatchInput(input)
  const plan = buildFrozenPatchPlan(resolveContext(input))
  const { artifactRoot, artifactRootIdentity } = codeForgePatchArtifactRoot()
  const artifactPath = codeForgePatchArtifactPath(patchArtifactSeed(plan), artifactRoot)
  const artifact = observeCodeForgePatchArtifact(artifactPath)
  if (artifact.state === 'file' && !artifactMatchesPlan(artifact, plan)) {
    throw new Error('内容寻址的 Code Forge patch 路径已存在不匹配内容，拒绝覆盖')
  }
  return {
    kind: 'code_forge_patch',
    targetKind: plan.context.target.kind,
    ...(plan.context.target.sessionId ? { sessionId: plan.context.target.sessionId } : {}),
    repoRoot: plan.source.repoRoot,
    repoRootIdentity: plan.source.repoRootIdentity,
    gitCommonDir: plan.source.gitCommonDir,
    gitCommonDirIdentity: plan.source.gitCommonDirIdentity,
    worktreePath: plan.source.worktreePath,
    worktreeRootIdentity: plan.source.worktreeRootIdentity,
    worktreeGitDir: plan.source.worktreeGitDir,
    worktreeGitDirIdentity: plan.source.worktreeGitDirIdentity,
    ...(plan.context.target.branch ? { branch: plan.context.target.branch } : {}),
    ...(plan.context.target.baseBranch !== undefined ? { baseBranch: plan.context.target.baseBranch } : {}),
    baseSha: plan.source.baseSha,
    headSha: plan.source.headSha,
    changedPaths: plan.changedPaths,
    insertions: plan.changes.insertions,
    deletions: plan.changes.deletions,
    ...(plan.changes.conflictRisk ? { conflictRisk: plan.changes.conflictRisk } : {}),
    ...(plan.canApply !== undefined ? { canApply: plan.canApply } : {}),
    ...(plan.applyError ? { applyError: plan.applyError } : {}),
    ...(plan.conflictFiles ? { conflictFiles: plan.conflictFiles } : {}),
    sourceStateDigest: plan.sourceStateDigest,
    artifactRoot,
    artifactRootIdentity,
    artifactPath,
    artifactPreState: artifact.state,
    ...(artifact.state === 'file'
      ? {
          artifactPreFileIdentity: artifact.identity,
          artifactPreSha256: artifact.sha256,
          artifactPreBytes: artifact.bytes
        }
      : {}),
    patchSha256: plan.patchSha256,
    patchBytes: plan.patchBytes
  }
}

export function executeCodeForgePatchEffectTarget(
  input: CodeForgeDeliveryInput,
  target: CodeForgePatchEffectTarget | undefined
): CodeForgePatchExecution {
  assertPatchInput(input)
  if (!target) {
    throw new Error('code_forge_delivery mode=patch 缺少冻结的 code_forge_patch EffectTarget，已阻止直接写入')
  }
  const context = resolveContext(input)
  assertPatchTargetMatchesContext(target, context)
  assertCodeForgePatchArtifactTarget(target)
  const existing = observeCodeForgePatchArtifact(target.artifactPath)
  if (existing.state === 'file') {
    if (existing.sha256 !== target.patchSha256 || existing.bytes !== target.patchBytes) {
      throw new Error('Code Forge patch artifact 已存在不匹配内容，拒绝覆盖')
    }
    return executionFromTarget(target)
  }
  const plan = buildFrozenPatchPlan(context)
  if (!patchPlanMatchesTarget(plan, target)) {
    throw new Error('Code Forge patch 执行前仓库/worktree 已偏离冻结输入，已阻止写入')
  }
  publishCodeForgePatchArtifact(target, plan.patchText)
  const published = observeCodeForgePatchArtifact(target.artifactPath)
  if (
    published.state !== 'file' ||
    published.sha256 !== target.patchSha256 ||
    published.bytes !== target.patchBytes
  ) {
    throw new Error('Code Forge patch 原子发布后未满足冻结后置条件')
  }
  return executionFromTarget(target)
}

export function reconcileCodeForgePatchEffectTarget(
  target: CodeForgePatchEffectTarget
): EffectReconciliationResult {
  try {
    assertCodeForgePatchArtifactTarget(target)
    const artifact = observeCodeForgePatchArtifact(target.artifactPath)
    const payload = {
      kind: target.kind,
      artifactPath: target.artifactPath,
      patchSha256: target.patchSha256,
      patchBytes: target.patchBytes,
      artifact
    }
    if (artifact.state === 'file') {
      return artifact.sha256 === target.patchSha256 && artifact.bytes === target.patchBytes
        ? confirmed(payload, 'Code Forge patch artifact 与冻结摘要和大小完全一致')
        : unresolved({ ...payload, reason: 'Code Forge patch artifact 已存在，但内容不匹配冻结目标' })
    }
    let plan: FrozenPatchPlan
    try {
      plan = buildFrozenPatchPlan(contextForPatchTarget(target))
    } catch (error) {
      return unresolved({ ...payload, reason: `Code Forge 冻结源状态无法查询:${errorText(error)}` })
    }
    if (!patchPlanMatchesTarget(plan, target)) {
      return unresolved({
        ...payload,
        observedSourceStateDigest: plan.sourceStateDigest,
        reason: 'patch artifact 缺失，且仓库/worktree 已偏离冻结输入'
      })
    }
    return notApplied(
      { ...payload, observedSourceStateDigest: plan.sourceStateDigest },
      'patch artifact 仍不存在，且仓库/worktree 与冻结输入完全一致'
    )
  } catch (error) {
    return unresolved({ kind: target.kind, reason: errorText(error) })
  }
}

function assertPatchInput(input: CodeForgeDeliveryInput): void {
  if (input.mode !== 'patch') throw new Error('Code Forge patch Effect 只接受 mode=patch')
  if (input.verificationCommand !== undefined || input.verificationCommands !== undefined) {
    throw new Error('Code Forge patch 不接受内嵌 verification command')
  }
  if (input.createPatch === true) {
    throw new Error('code_forge_delivery createPatch=true 已停用；请显式使用 mode=patch')
  }
}

function resolveContext(input: CodeForgeDeliveryInput): ResolvedContext {
  const metadata = input.worktreeContext
  const repoRootArg = cleanString(input.repoRoot) ?? cleanString(metadata?.repoRoot)
  const worktreePathArg = cleanString(input.worktreePath) ?? cleanString(metadata?.worktreePath)
  const baseSha = cleanString(input.baseSha) ?? cleanString(metadata?.baseSha)
  const managedRecord = trustedCodeForgeManagedWorktree({
    ...metadata,
    repoRoot: repoRootArg,
    worktreePath: worktreePathArg,
    baseSha,
    branch: cleanString(input.branch) ?? metadata?.branch,
    baseBranch: cleanString(input.baseBranch) ?? metadata?.baseBranch
  })
  const cwd = normalizeExistingDirectory(input.cwd, 'cwd')
  const cwdRoot = repoRootFor(cwd)
  if (managedRecord) {
    const repoRoot = repoRootFor(normalizeExistingDirectory(managedRecord.repoRoot, 'repoRoot'))
    const worktreePath = repoRootFor(normalizeExistingDirectory(managedRecord.worktreePath, 'worktreePath'))
    if (gitCommonDirFor(repoRoot) !== gitCommonDirFor(worktreePath)) {
      throw new Error('repoRoot 与 worktreePath 不属于同一个 Git common directory')
    }
    const normalizedBaseSha = revParseCommit(worktreePath, managedRecord.baseSha)
    return {
      target: {
        kind: 'managed-worktree',
        cwd: pathInside(cwd, worktreePath) ? cwd : worktreePath,
        repoRoot,
        worktreePath,
        branch: managedRecord.branch,
        baseBranch: managedRecord.baseBranch,
        baseSha: normalizedBaseSha,
        headSha: requireHead(worktreePath),
        sessionId: managedRecord.sessionId
      }
    }
  }
  return {
    target: {
      kind: 'repository',
      cwd: cwdRoot,
      repoRoot: cwdRoot,
      worktreePath: cwdRoot,
      branch: cleanString(input.branch) ?? currentBranch(cwdRoot),
      headSha: requireHead(cwdRoot),
      sessionId: cleanString(metadata?.sessionId)
    }
  }
}

function buildFrozenPatchPlan(context: ResolvedContext): FrozenPatchPlan {
  const first = buildPatchPlanOnce(context)
  const second = buildPatchPlanOnce(context)
  if (first.sourceStateDigest !== second.sourceStateDigest) {
    throw new Error('生成 Code Forge EffectTarget 期间仓库/worktree 状态发生变化，请重试')
  }
  return second
}

function buildPatchPlanOnce(context: ResolvedContext): FrozenPatchPlan {
  if (context.target.kind === 'managed-worktree') trustedCodeForgeManagedWorktree(context.target)
  assertNoExecutableCodeForgeFiltersIn([context.target.worktreePath, context.target.repoRoot])
  const managed = context.target.kind === 'managed-worktree'
  const pathspecArgs = managed ? managedPathspecArgs() : ['--']
  const untracked = inspectCodeForgeUntrackedFiles(
    context.target.worktreePath,
    listCodeForgeUntrackedFiles(context.target.worktreePath, pathspecArgs),
    MAX_PATCH_ARTIFACT_BYTES
  )
  const source = patchSourceIdentity(context)
  let changes = summarizeChanges(context, untracked)
  const changedPaths = codeForgeChangedFiles(
    context.target.worktreePath,
    managed ? source.baseSha : 'HEAD',
    pathspecArgs,
    untracked
  )
  assertEffectChangedPaths(changedPaths)
  const patchText = buildCodeForgePatchText(
    context.target.worktreePath,
    managed ? source.baseSha : 'HEAD',
    pathspecArgs,
    untracked
  )
  const digest = patchSha256(patchText)
  const bytes = Buffer.byteLength(patchText, 'utf8')
  if (bytes > MAX_PATCH_ARTIFACT_BYTES) {
    throw new Error(`Code Forge patch 超过 ${MAX_PATCH_ARTIFACT_BYTES} 字节上限`)
  }
  let canApply: boolean | undefined
  let applyError: string | undefined
  let conflictFiles: string[] | undefined
  if (managed) {
    const check = checkCodeForgePatchApplies(context.target.repoRoot, patchText)
    canApply = check.canApply
    changes = {
      ...changes,
      conflictRisk: check.state === 'failed' ? 'unknown' : check.canApply ? 'low' : 'medium'
    }
    if ('error' in check) applyError = check.error
  }
  const sourceStateDigest = digestValue({
    source,
    changedPaths,
    changedFiles: changes.changedFiles,
    insertions: changes.insertions,
    deletions: changes.deletions,
    conflictRisk: changes.conflictRisk,
    patchSha256: digest,
    patchBytes: bytes,
    canApply,
    applyError,
    conflictFiles
  })
  return {
    context,
    source,
    changes,
    changedPaths,
    patchText,
    patchSha256: digest,
    patchBytes: bytes,
    canApply,
    applyError,
    conflictFiles,
    sourceStateDigest
  }
}

function summarizeChanges(
  context: ResolvedContext,
  untracked: readonly CodeForgeUntrackedFileObservation[]
): CodeForgeChangeSummary {
  if (context.target.kind === 'managed-worktree') {
    const baseSha = requiredText(context.target.baseSha, 'baseSha')
    const stats = codeForgeDiffStats(context.target.worktreePath, baseSha, managedPathspecArgs(), untracked)
    const files = codeForgeChangedFiles(context.target.worktreePath, baseSha, managedPathspecArgs(), untracked)
    return {
      changedFiles: files.length,
      insertions: stats.insertions,
      deletions: stats.deletions,
      files: files.slice(0, MAX_FILE_LIST),
      truncatedFiles: files.length > MAX_FILE_LIST
    }
  }
  const stats = codeForgeDiffStats(context.target.repoRoot, 'HEAD', ['--'], untracked)
  const files = codeForgeChangedFiles(context.target.repoRoot, 'HEAD', ['--'], untracked)
  return {
    changedFiles: files.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
    files: files.slice(0, MAX_FILE_LIST),
    truncatedFiles: files.length > MAX_FILE_LIST
  }
}

function executionFromTarget(target: CodeForgePatchEffectTarget): CodeForgePatchExecution {
  return {
    target: {
      kind: target.targetKind,
      cwd: target.worktreePath,
      repoRoot: target.repoRoot,
      worktreePath: target.worktreePath,
      ...(target.branch ? { branch: target.branch } : {}),
      ...(target.baseBranch !== undefined ? { baseBranch: target.baseBranch } : {}),
      ...(target.targetKind === 'managed-worktree' ? { baseSha: target.baseSha } : {}),
      headSha: target.headSha,
      ...(target.sessionId ? { sessionId: target.sessionId } : {})
    },
    changes: changeSummaryFromTarget(target),
    patch: {
      path: target.artifactPath,
      bytes: target.patchBytes,
      sha256: target.patchSha256,
      ...(target.canApply !== undefined ? { canApply: target.canApply } : {}),
      ...(target.applyError ? { error: target.applyError } : {}),
      ...(target.conflictFiles ? { conflictFiles: target.conflictFiles } : {})
    }
  }
}

function changeSummaryFromTarget(target: CodeForgePatchEffectTarget): CodeForgeChangeSummary {
  return {
    changedFiles: target.changedPaths.length,
    insertions: target.insertions,
    deletions: target.deletions,
    files: target.changedPaths.slice(0, MAX_FILE_LIST),
    truncatedFiles: target.changedPaths.length > MAX_FILE_LIST,
    ...(target.conflictRisk ? { conflictRisk: target.conflictRisk } : {})
  }
}

function patchPlanMatchesTarget(plan: FrozenPatchPlan, target: CodeForgePatchEffectTarget): boolean {
  const source = plan.source
  return [
    target.targetKind === plan.context.target.kind,
    target.sessionId === plan.context.target.sessionId,
    target.repoRoot === source.repoRoot,
    sameIdentity(target.repoRootIdentity, source.repoRootIdentity),
    target.gitCommonDir === source.gitCommonDir,
    sameIdentity(target.gitCommonDirIdentity, source.gitCommonDirIdentity),
    target.worktreePath === source.worktreePath,
    sameIdentity(target.worktreeRootIdentity, source.worktreeRootIdentity),
    target.worktreeGitDir === source.worktreeGitDir,
    sameIdentity(target.worktreeGitDirIdentity, source.worktreeGitDirIdentity),
    target.branch === plan.context.target.branch,
    target.baseBranch === plan.context.target.baseBranch,
    target.baseSha === source.baseSha,
    target.headSha === source.headSha,
    sameStrings(target.changedPaths, plan.changedPaths),
    target.insertions === plan.changes.insertions,
    target.deletions === plan.changes.deletions,
    target.conflictRisk === plan.changes.conflictRisk,
    target.canApply === plan.canApply,
    target.applyError === plan.applyError,
    sameOptionalStrings(target.conflictFiles, plan.conflictFiles),
    target.sourceStateDigest === plan.sourceStateDigest,
    target.patchSha256 === plan.patchSha256,
    target.patchBytes === plan.patchBytes
  ].every(Boolean)
}

function assertPatchTargetMatchesContext(target: CodeForgePatchEffectTarget, context: ResolvedContext): void {
  if (
    target.targetKind !== context.target.kind ||
    target.repoRoot !== context.target.repoRoot ||
    target.worktreePath !== context.target.worktreePath ||
    target.sessionId !== context.target.sessionId ||
    (context.target.kind === 'managed-worktree' && target.baseSha !== context.target.baseSha)
  ) {
    throw new Error('code_forge_patch EffectTarget 与当前工具上下文不一致')
  }
}

function patchSourceIdentity(context: ResolvedContext): PatchSourceIdentity {
  const repoRoot = realpathSync(context.target.repoRoot)
  const worktreePath = realpathSync(context.target.worktreePath)
  const gitCommonDir = gitCommonDirFor(worktreePath)
  if (gitCommonDirFor(repoRoot) !== gitCommonDir) throw new Error('Code Forge repo/worktree Git identity 不一致')
  const worktreeGitDir = worktreeGitDirFor(worktreePath)
  const headSha = requireHead(worktreePath)
  const baseSha = context.target.kind === 'managed-worktree'
    ? revParseCommit(worktreePath, requiredText(context.target.baseSha, 'baseSha'))
    : headSha
  return {
    repoRoot,
    repoRootIdentity: fileSystemIdentity(repoRoot),
    gitCommonDir,
    gitCommonDirIdentity: fileSystemIdentity(gitCommonDir),
    worktreePath,
    worktreeRootIdentity: fileSystemIdentity(worktreePath),
    worktreeGitDir,
    worktreeGitDirIdentity: fileSystemIdentity(worktreeGitDir),
    baseSha,
    headSha
  }
}

function contextForPatchTarget(target: CodeForgePatchEffectTarget): ResolvedContext {
  return {
    target: {
      kind: target.targetKind,
      cwd: target.worktreePath,
      repoRoot: target.repoRoot,
      worktreePath: target.worktreePath,
      ...(target.branch ? { branch: target.branch } : {}),
      ...(target.baseBranch !== undefined ? { baseBranch: target.baseBranch } : {}),
      ...(target.targetKind === 'managed-worktree' ? { baseSha: target.baseSha } : {}),
      headSha: target.headSha,
      ...(target.sessionId ? { sessionId: target.sessionId } : {})
    }
  }
}

function managedPathspecArgs(): string[] {
  return ['--', '.', ...WORKTREE_MERGE_EXCLUDE_PATHSPECS]
}

function patchArtifactSeed(plan: FrozenPatchPlan): CodeForgePatchArtifactSeed {
  return {
    repoRoot: plan.source.repoRoot,
    worktreePath: plan.source.worktreePath,
    baseSha: plan.source.baseSha,
    headSha: plan.source.headSha,
    patchSha256: plan.patchSha256,
    patchBytes: plan.patchBytes
  }
}

function artifactMatchesPlan(artifact: PatchArtifactObservation, plan: FrozenPatchPlan): boolean {
  return artifact.state === 'file' && artifact.sha256 === plan.patchSha256 && artifact.bytes === plan.patchBytes
}

function assertEffectChangedPaths(paths: string[]): void {
  if (paths.length > MAX_EFFECT_CHANGED_PATHS) {
    throw new Error(`Code Forge patch 文件目标超过 ${MAX_EFFECT_CHANGED_PATHS} 条上限`)
  }
  const bytes = paths.reduce((total, item) => total + Buffer.byteLength(item, 'utf8') + 1, 0)
  if (bytes > MAX_EFFECT_CHANGED_PATH_BYTES) throw new Error('Code Forge patch 文件目标列表过大')
}

function normalizeExistingDirectory(value: string, label: string): string {
  const text = cleanString(value)
  if (!text) throw new Error(`${label} 不能为空`)
  if (text.includes('\0')) throw new Error(`${label} 包含非法字符`)
  const resolved = path.resolve(text)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`${label} 不是目录: ${resolved}`)
  return realpathSync(resolved)
}

function repoRootFor(cwd: string): string {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) throw new Error(result.error ?? '当前目录不是 Git 工作区')
  return realpathSync(path.resolve(cwd, result.stdout.trim()))
}

function gitCommonDirFor(cwd: string): string {
  const result = runGit(cwd, ['rev-parse', '--git-common-dir'])
  if (!result.ok) throw new Error(result.error ?? '无法解析 Git common directory')
  return realpathSync(path.resolve(cwd, result.stdout.trim()))
}

function worktreeGitDirFor(cwd: string): string {
  const result = runGit(cwd, ['rev-parse', '--git-dir'])
  if (!result.ok) throw new Error(result.error ?? '无法解析 Git worktree directory')
  return realpathSync(path.resolve(cwd, result.stdout.trim()))
}

function currentBranch(cwd: string): string | undefined {
  const branch = runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (branch.ok && branch.stdout.trim()) return branch.stdout.trim()
  const sha = runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  return sha.ok ? sha.stdout.trim() : undefined
}

function revParseHead(cwd: string): string | undefined {
  const result = runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  return result.ok ? result.stdout.trim() : undefined
}

function revParseCommit(cwd: string, value: string): string {
  const result = runGit(cwd, ['rev-parse', '--verify', `${value}^{commit}`])
  if (!result.ok || !result.stdout.trim()) throw new Error(result.error ?? `无法解析 commit:${value}`)
  return result.stdout.trim()
}

function requireHead(cwd: string): string {
  const head = revParseHead(cwd)
  if (!head) throw new Error('Code Forge patch 需要已有 HEAD commit')
  return head
}

function pathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function runGit(
  cwd: string,
  args: string[],
  options: { allowExitCodes?: number[] } = {}
): GitRunResult {
  const allowed = options.allowExitCodes ?? [0]
  const result = spawnSync('git', withSafeLocalGitConfig(args), {
    cwd,
    env: isolatedLocalGitEnv(process.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const status = result.status
  if (result.error) return { ok: false, stdout, stderr, status, error: result.error.message }
  if (status === null || !allowed.includes(status)) {
    const output = (stderr.trim() || stdout.trim()).slice(0, MAX_OUTPUT_CHARS)
    const code = status === null ? 'timeout' : String(status)
    return {
      ok: false,
      stdout,
      stderr,
      status,
      error: output ? `git ${args.join(' ')} failed (${code}): ${output}` : `git ${args.join(' ')} failed (${code})`
    }
  }
  return { ok: true, stdout, stderr, status }
}

function fileSystemIdentity(filePath: string): FileSystemIdentity {
  const info = statSync(filePath)
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameOptionalStrings(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) return left === right
  return sameStrings(left, right)
}

function requiredText(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} 不能为空`)
  return value
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function ensureTrailingNewline(text: string): string {
  if (!text) return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

function digestValue(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
