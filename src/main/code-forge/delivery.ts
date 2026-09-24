import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { GitCommitCheckResult } from '../git/git-helper'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from '../git/safe-git'
import {
  executeCodeForgePatchEffectTarget,
  type CodeForgePatchEffectTarget
} from './patch-effect'
import type { ConflictRisk } from '../worktreeMerge'
import { MAX_PATCH_ARTIFACT_BYTES } from './patch-artifact'
import {
  assertNoExecutableCodeForgeFiltersIn,
  inspectCodeForgeUntrackedFiles
} from './source-security'
import { trustedCodeForgeManagedWorktree } from './managed-context-security'
import { collectCodeForgeVerification, type CodeForgeVerificationContext } from './verification-evidence'
import type { CodeForgeSourceVersion } from './verification-source'
import {
  buildCodeForgePatchText,
  checkCodeForgePatchApplies,
  codeForgeChangedFiles,
  codeForgeDiffStats,
  listCodeForgeUntrackedFiles
} from './patch-source'

export type CodeForgeDeliveryMode = 'report' | 'patch' | 'commit' | 'pr'
export type CodeForgeDeliveryStatus = 'ready' | 'needs-review' | 'blocked' | 'failed'
export type CodeForgeTargetKind = 'repository' | 'managed-worktree'
export type CodeForgeVerificationStatus = 'passed' | 'failed' | 'skipped'
export type CodeForgeRiskLevel = 'low' | 'medium' | 'high'
export type { CodeForgePatchEffectTarget } from './patch-effect'

export interface CodeForgeWorktreeContext {
  sessionId?: string
  repoRoot?: string
  sourceCwd?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
}

export interface CodeForgeDeliveryInput {
  cwd: string
  mode?: CodeForgeDeliveryMode
  verificationCommand?: string
  verificationCommands?: string[]
  verificationTimeoutMs?: number
  commitMessage?: string
  stageAll?: boolean
  createPatch?: boolean
  prTitle?: string
  prBody?: string
  baseBranch?: string
  repoRoot?: string
  worktreePath?: string
  baseSha?: string
  branch?: string
  worktreeContext?: CodeForgeWorktreeContext
  verificationToolUseIds?: string[]
  /** Main-owned persisted Run and transcript, never accepted from tool arguments. */
  verificationContext?: CodeForgeVerificationContext
}

export interface CodeForgeTargetReport {
  kind: CodeForgeTargetKind
  cwd: string
  repoRoot: string
  worktreePath: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  headSha?: string
  sessionId?: string
}

export interface CodeForgeChangeSummary {
  changedFiles: number
  insertions: number
  deletions: number
  files: string[]
  truncatedFiles: boolean
  conflictRisk?: ConflictRisk
}

export interface CodeForgeVerificationCommandResult {
  toolUseId?: string
  runId?: string
  executionId?: string
  resultEventId?: string
  effectId?: string
  effectEvidenceIds?: string[]
  evidenceDigest?: string
  sourceVersion?: CodeForgeSourceVersion
  reason?: string
  command: string
  cwd: string
  status: CodeForgeVerificationStatus
  exitCode: number | null
  durationMs: number
  output: string
}

export interface CodeForgeVerificationSummary {
  scope?: string
  status: CodeForgeVerificationStatus
  commands: CodeForgeVerificationCommandResult[]
  passed: number
  failed: number
  skipped: number
}

export interface CodeForgePatchReport {
  path: string
  bytes: number
  sha256: string
  canApply?: boolean
  error?: string
  conflictFiles?: string[]
}

export interface CodeForgeCommitReport {
  ok: boolean
  sha?: string
  branch?: string
  message?: string
  checks?: GitCommitCheckResult[]
  error?: string
}

export interface CodeForgePullRequestReport {
  ok: boolean
  created: boolean
  url?: string
  tool?: string
  branch?: string
  base?: string
  pushed?: boolean
  error?: string
}

export interface CodeForgeRiskReport {
  level: CodeForgeRiskLevel
  reasons: string[]
}

export interface CodeForgeDeliveryReport {
  ok: true
  status: CodeForgeDeliveryStatus
  mode: CodeForgeDeliveryMode
  startedAt: number
  completedAt: number
  target: CodeForgeTargetReport
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
  risk: CodeForgeRiskReport
  mergeable: boolean
  summary: string
}

export interface CodeForgeDeliveryFailure {
  ok: false
  status: 'failed'
  mode?: CodeForgeDeliveryMode
  error: string
  summary: string
}

export type CodeForgeDeliveryResult = CodeForgeDeliveryReport | CodeForgeDeliveryFailure

interface ResolvedContext {
  target: CodeForgeTargetReport
  verificationCwd: string
}

interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

const MAX_OUTPUT_CHARS = 12_000
const MAX_FILE_LIST = 80
const MAX_GIT_BUFFER = 32 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000

export function runCodeForgeDelivery(
  input: CodeForgeDeliveryInput,
  effectTarget?: CodeForgePatchEffectTarget
): CodeForgeDeliveryResult {
  const startedAt = Date.now()
  const mode = normalizeMode(input.mode)
  try {
    assertSupportedDeliveryRequest(input, mode)
    const patchExecution = mode === 'patch'
      ? executeCodeForgePatchEffectTarget(input, effectTarget)
      : undefined
    const context = patchExecution ? undefined : resolveContext(input)
    const target = patchExecution?.target ?? context?.target
    if (!target) throw new Error('Code Forge 无法解析交付目标')
    const changes = patchExecution?.changes ?? summarizeChanges(context as ResolvedContext)
    const verification = collectCodeForgeVerification(input.verificationToolUseIds, input.cwd, target.sessionId, input.verificationContext)
    const patch = patchExecution?.patch
    const risk = assessRisk({ changes, verification, patch })
    const status = deliveryStatus({ changes, verification, patch })
    const mergeable = isMergeable({ changes, verification, patch })
    return {
      ok: true,
      status,
      mode,
      startedAt,
      completedAt: Date.now(),
      target,
      changes,
      verification,
      ...(patch ? { patch } : {}),
      risk,
      mergeable,
      summary: buildSummary(status, mode, changes, verification, patch, undefined, undefined, risk)
    }
  } catch (err) {
    const error = errorText(err)
    return {
      ok: false,
      status: 'failed',
      mode,
      error,
      summary: `Code Forge 交付失败:${error}`
    }
  }
}

export function formatCodeForgeDeliveryReport(result: CodeForgeDeliveryResult): string {
  return JSON.stringify(result, null, 2)
}

function normalizeMode(value: unknown): CodeForgeDeliveryMode {
  return value === 'patch' || value === 'commit' || value === 'pr' || value === 'report'
    ? value
    : 'report'
}

function assertSupportedDeliveryRequest(
  input: CodeForgeDeliveryInput,
  mode: CodeForgeDeliveryMode
): void {
  if (input.verificationToolUseIds !== undefined && (!Array.isArray(input.verificationToolUseIds) || input.verificationToolUseIds.length > 20 ||
      new Set(input.verificationToolUseIds).size !== input.verificationToolUseIds.length || input.verificationToolUseIds.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new Error('verificationToolUseIds 须为至多 20 个不重复的真实工具调用 ID')
  }
  if (mode === 'commit' || mode === 'pr') {
    throw new Error(
      `code_forge_delivery mode=${mode} 已停用；请先生成 report/patch，再使用独立 Git 工具完成暂存、提交、推送或 PR`
    )
  }
  if (input.verificationCommand !== undefined || input.verificationCommands !== undefined) {
    throw new Error(
      'code_forge_delivery 不再接受 verificationCommand/verificationCommands；请先显式调用 bash 完成验证，再生成 report/patch'
    )
  }
  if (input.createPatch === true) {
    throw new Error('code_forge_delivery createPatch=true 已停用；请显式使用 mode=patch，以建立可查询 Effect')
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
    const verificationCwd = pathInside(cwd, worktreePath) ? cwd : worktreePath
    return {
      target: {
        kind: 'managed-worktree',
        cwd: verificationCwd,
        repoRoot,
        worktreePath,
        branch: managedRecord.branch,
        baseBranch: managedRecord.baseBranch,
        baseSha: managedRecord.baseSha,
        headSha: revParseHead(worktreePath),
        sessionId: managedRecord.sessionId
      },
      verificationCwd
    }
  }

  return {
    target: {
      kind: 'repository',
      cwd: cwdRoot,
      repoRoot: cwdRoot,
      worktreePath: cwdRoot,
      branch: cleanString(input.branch) ?? currentBranch(cwdRoot),
      headSha: revParseHead(cwdRoot),
      sessionId: cleanString(metadata?.sessionId)
    },
    verificationCwd: cwd
  }
}

function summarizeChanges(context: ResolvedContext): CodeForgeChangeSummary {
  if (context.target.kind === 'managed-worktree') trustedCodeForgeManagedWorktree(context.target)
  const sourceRoot = context.target.worktreePath
  assertNoExecutableCodeForgeFiltersIn([sourceRoot, context.target.repoRoot])
  const untracked = inspectCodeForgeUntrackedFiles(
    sourceRoot,
    listCodeForgeUntrackedFiles(sourceRoot, ['--', '.']),
    MAX_PATCH_ARTIFACT_BYTES
  )
  if (context.target.kind === 'managed-worktree') {
    const baseSha = context.target.baseSha
    if (!baseSha) throw new Error('managed worktree 缺少 baseSha')
    const stats = codeForgeDiffStats(context.target.worktreePath, baseSha, ['--'], untracked)
    const files = codeForgeChangedFiles(context.target.worktreePath, baseSha, ['--'], untracked)
    const patchText = buildCodeForgePatchText(context.target.worktreePath, baseSha, ['--'], untracked)
    const applyCheck = checkCodeForgePatchApplies(context.target.repoRoot, patchText)
    return {
      changedFiles: files.length,
      insertions: stats.insertions,
      deletions: stats.deletions,
      files: files.slice(0, MAX_FILE_LIST),
      truncatedFiles: files.length > MAX_FILE_LIST,
      conflictRisk: applyCheck.state === 'failed' ? 'unknown' : applyCheck.canApply ? 'low' : 'medium'
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

function assessRisk(input: {
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
}): CodeForgeRiskReport {
  const reasons: string[] = []
  let level: CodeForgeRiskLevel = 'low'
  if (input.changes.changedFiles === 0) {
    level = maxRisk(level, 'medium')
    reasons.push('没有检测到可交付变更')
  }
  if (input.verification.status === 'skipped') {
    level = maxRisk(level, 'medium')
    reasons.push('尚无与当前源码版本一致的完整验证证据；请查看每条命令的核对原因')
  }
  if (input.verification.status === 'failed') {
    level = maxRisk(level, 'high')
    reasons.push('验证失败')
  }
  if (input.changes.conflictRisk === 'medium' || input.patch?.canApply === false) {
    level = maxRisk(level, 'high')
    reasons.push('patch 无法干净应用或存在冲突风险')
  }
  if (input.commit?.ok === false) {
    level = maxRisk(level, 'high')
    reasons.push('commit 未完成')
  }
  if (input.pullRequest?.ok === false) {
    level = maxRisk(level, 'high')
    reasons.push('PR 未创建')
  } else if (input.pullRequest && !input.pullRequest.created) {
    level = maxRisk(level, 'medium')
    reasons.push('PR 工具不可用或被跳过')
  }
  if (reasons.length === 0) reasons.push('验证通过且未发现冲突风险')
  return { level, reasons }
}

function deliveryStatus(input: {
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
}): CodeForgeDeliveryStatus {
  if (input.verification.status === 'failed') return 'failed'
  if (input.commit?.ok === false) return 'failed'
  if (input.patch?.canApply === false) return 'blocked'
  if (input.pullRequest?.ok === false) return 'blocked'
  if (input.changes.changedFiles === 0 || input.verification.status !== 'passed') return 'needs-review'
  return 'ready'
}

function isMergeable(input: {
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
}): boolean {
  return (
    input.changes.changedFiles > 0 &&
    input.verification.status === 'passed' &&
    input.patch?.canApply !== false &&
    input.commit?.ok !== false &&
    input.pullRequest?.ok !== false
  )
}

function buildSummary(
  status: CodeForgeDeliveryStatus,
  mode: CodeForgeDeliveryMode,
  changes: CodeForgeChangeSummary,
  verification: CodeForgeVerificationSummary,
  patch: CodeForgePatchReport | undefined,
  commit: CodeForgeCommitReport | undefined,
  pullRequest: CodeForgePullRequestReport | undefined,
  risk: CodeForgeRiskReport
): string {
  const parts = [
    `Code Forge ${status}`,
    `${changes.changedFiles} files (+${changes.insertions}/-${changes.deletions})`,
    `verification=${verification.status}`,
    `mode=${mode}`,
    patch ? `patch=${patch.path}` : '',
    commit?.sha ? `commit=${commit.sha.slice(0, 12)}` : '',
    pullRequest?.url ? `pr=${pullRequest.url}` : '',
    `risk=${risk.level}`
  ].filter(Boolean)
  return parts.join(' | ')
}

function normalizeExistingDirectory(value: string, label: string): string {
  const text = cleanString(value)
  if (!text) throw new Error(`${label} 不能为空`)
  if (text.includes('\0')) throw new Error(`${label} 包含非法字符`)
  const resolved = path.resolve(text)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${label} 不是目录: ${resolved}`)
  }
  return realpathSync(resolved)
}

function repoRootFor(cwd: string): string {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) throw new Error(result.error ?? '当前目录不是 Git 工作区')
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
    return { ok: false, stdout, stderr, status, error: gitError(args, status, stdout, stderr) }
  }
  return { ok: true, stdout, stderr, status }
}

function gitError(args: string[], status: number | null, stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).slice(0, MAX_OUTPUT_CHARS)
  const code = status === null ? 'timeout' : String(status)
  return output ? `git ${args.join(' ')} failed (${code}): ${output}` : `git ${args.join(' ')} failed (${code})`
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function maxRisk(left: CodeForgeRiskLevel, right: CodeForgeRiskLevel): CodeForgeRiskLevel {
  const order: CodeForgeRiskLevel[] = ['low', 'medium', 'high']
  return order.indexOf(left) >= order.indexOf(right) ? left : right
}
