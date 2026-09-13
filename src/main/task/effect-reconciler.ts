import { officeRevisionReplayDigest, type OfficeRevisionReplayTarget } from '../office-revision/replay'
import { createHash } from 'node:crypto'
import { constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { EffectRecord, EffectTarget, FileSystemIdentity } from '../../shared/types'
import { reconcileMcpEffectTarget } from '../mcp/mcp-effect'
import { reconcileWebhookMessageEffectTarget } from '../notification/notification-effect'
import { isOfficeOutputTarget, reconcileOfficeOutputTarget, type OfficeArtifactReplayTarget } from '../office-revision/reconciliation'
import { reconcileGuiPostconditionEffectTarget } from '../gui/gui-effect'
import {
  gitAlternateObjectDirectories,
  isolatedLocalGitEnv,
  isolatedRemoteGitEnv,
  unsafeMergeConfigKeys,
  withSafeLocalGitConfig,
  withSafeMergeGitConfig,
  withSafeRemoteGitConfig
} from '../git/safe-git'
import {
  planExactFileEdit,
  planSearchReplace,
  searchReplacementArgs,
  type SearchReplacePlan
} from '../agent/tools/search-replace'
import { resolveWritableProjectPathSync } from '../utils/safe-project-path'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from './effect-reconciliation-result'
import {
  reconcileIssueCreate,
  reconcilePullRequestCreate,
  reconcileWorktreePatchApply,
  type OperationEffectReconcilerContext
} from './operation-effect-reconciler'
import { buildEffectTarget, type EffectTargetBuilderContext } from './effect-target-builder'
import {
  reconcileFileContentObservation,
  type FileContentObservation
} from './file-effect-reconciliation'
import { effectRecordIntegrityMatches } from './effect-record-integrity'
import { reconcileLocalEffectTarget } from './effect-reconciler-local-targets'
import { normalizeToolName, stableValueDigest } from './tool-idempotency'
import { reconcileProjectPortableExportEffectTarget } from '../project-export-effect-target'
import { reconcileProjectPortableImportEffectTarget } from '../project-import-effect-target'
import { reconcileProjectPermanentDeletionEffectTarget } from '../project-deletion-effect-target'
import { reconcileProviderProfileOperationTarget } from '../provider/provider-profile-operation-target'
import { reconcileMediaJobOperationTarget } from '../media/media-job-effect-target'
const GIT_LOCAL_TIMEOUT_MS = 15_000
const GIT_SCAN_TIMEOUT_MS = 30_000
const GIT_REMOTE_TIMEOUT_MS = 30_000
const MAX_GIT_OUTPUT = 8 * 1024 * 1024
const GIT_CANDIDATE_CONCURRENCY = 4
const MAX_GIT_COMMIT_CANDIDATES = 64
const GIT_COMMIT_RECONCILIATION_BUDGET_MS = 30_000
const MAX_GIT_MERGE_CANDIDATES = 64
const MAX_FILE_RECONCILIATION_BYTES = 64 * 1024 * 1024
export { EFFECT_RECONCILER_VERSION } from './effect-reconciliation-result'
export type { EffectReconciliationResult } from './effect-reconciliation-result'
interface GitRunResult {
  ok: boolean
  status: number | null
  stdout: string
  error: string
}
export interface EffectDescriptor {
  target: EffectTarget
  targetDigest: string
  intentDigest: string
  inputDigest: string
  reconcilability: EffectRecord['reconcilability']
}

/** Stable external resource identity used only to suppress confirmed failover replays. */
export function effectReplayTargetDigest(target: EffectTarget | OfficeArtifactReplayTarget | OfficeRevisionReplayTarget): string {
  if (target.kind === 'office_artifact_revision') return officeRevisionReplayDigest(target)
  if (target.kind === 'office_artifact') {
    return stableValueDigest({
      kind: target.kind,
      rootIdentity: target.rootIdentity,
      relativePath: target.relativePath
    })
  }
  return stableValueDigest(target)
}
export interface EffectFileObservationOptions {
  beforeRead?: (filePath: string) => Promise<void> | void
}
const operationEffectReconcilerContext: OperationEffectReconcilerContext = {
  resolveRepoRoot,
  resolveGitDirectory,
  gitText,
  gitLines,
  gitRun,
  readFileObservation: (filePath, maxHashBytes) => observeFile(filePath, maxHashBytes, {}),
  fileSystemIdentity,
  sameFileSystemIdentity,
  sanitizeRemoteUrl,
  sha256,
  confirmed,
  notApplied,
  unresolved
}

const effectTargetBuilderContext: EffectTargetBuilderContext = {
  fileWriteTarget,
  searchReplaceTarget,
  exactFileEditTarget,
  gitCommitTarget,
  gitMergeTarget,
  gitPushTarget
}

export async function buildEffectDescriptor(input: {
  sessionId?: string
  toolName: string
  toolInput: Record<string, unknown>
  cwd: string
}, observationOptions: EffectFileObservationOptions = {}): Promise<EffectDescriptor> {
  const { toolName, target } = await buildEffectTarget(
    input,
    observationOptions,
    effectTargetBuilderContext,
    operationEffectReconcilerContext
  )
  const inputDigest = stableValueDigest(input.toolInput)
  const targetDigest = stableValueDigest(target)
  return {
    target,
    targetDigest,
    inputDigest,
    intentDigest: stableValueDigest({ toolName, targetDigest, inputDigest }),
    reconcilability:
      target.kind === 'unsupported' || target.kind === 'webhook_message_send'
        ? 'opaque'
        : 'queryable'
  }
}

export async function reconcileEffect(
  effect: EffectRecord,
  observationOptions: EffectFileObservationOptions = {},
  rootDir?: string
): Promise<EffectReconciliationResult> {
  try {
    if (!effectRecordIntegrityMatches(effect)) {
      return unresolved({ kind: 'integrity_error', reason: 'EffectRecord 摘要校验失败，禁止读取或重放目标' })
    }
    if (effect.target.kind === 'file_content') return await reconcileFileContent(effect.target, observationOptions)
    if (effect.target.kind === 'gui_postcondition') return await reconcileGuiPostconditionEffectTarget(effect.target)
    if (effect.target.kind === 'git_commit') return await reconcileGitCommit(effect.target)
    if (effect.target.kind === 'git_merge') return await reconcileGitMerge(effect.target)
    if (effect.target.kind === 'git_push') return await reconcileGitPush(effect.target)
    if (effect.target.kind === 'worktree_patch_apply') {
      return await reconcileWorktreePatchApply(effect.target, operationEffectReconcilerContext)
    }
    const localResult = reconcileLocalEffectTarget(effect.target)
    if (localResult) return localResult
    if (effect.target.kind === 'pull_request_create') {
      return await reconcilePullRequestCreate(effect.target, operationEffectReconcilerContext)
    }
    if (effect.target.kind === 'issue_create') {
      return await reconcileIssueCreate(effect.target, operationEffectReconcilerContext)
    }
    if (effect.target.kind === 'mcp_tool_call') return await reconcileMcpEffectTarget(effect.target)
    if (effect.target.kind === 'webhook_message_send') return reconcileWebhookMessageEffectTarget(effect.target)
    if (isOfficeOutputTarget(effect.target)) return reconcileOfficeOutputTarget(effect.target, rootDir)
    if (effect.target.kind === 'project_portable_export') {
      return await reconcileProjectPortableExportEffectTarget(effect.target, rootDir)
    }
    if (effect.target.kind === 'project_portable_import') {
      return await reconcileProjectPortableImportEffectTarget(effect.target, rootDir)
    }
    if (effect.target.kind === 'project_permanent_deletion') {
      return await reconcileProjectPermanentDeletionEffectTarget(effect.target, rootDir)
    }
    if (effect.target.kind === 'provider_profile_operation') {
      return await reconcileProviderProfileOperationTarget(effect.target, rootDir)
    }
    if (effect.target.kind === 'media_job_operation') {
      return await reconcileMediaJobOperationTarget(effect.target, rootDir)
    }
    if (effect.target.kind === 'unsupported') {
      return unresolved({
        kind: 'unsupported',
        toolName: effect.target.toolName,
        reason: '该副作用没有注册只读查询器，禁止自动重放'
      })
    }
    return unresolved({ kind: 'unknown_effect_target', reason: 'EffectTarget 类型无法识别，禁止自动重放' })
  } catch (error) {
    return unresolved({
      kind: effect.target.kind,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
}

async function fileWriteTarget(
  cwd: string,
  toolInput: Record<string, unknown>,
  observationOptions: EffectFileObservationOptions
): Promise<EffectTarget> {
  const rawPath = stringValue(toolInput.path ?? toolInput.file_path)
  const content = String(toolInput.content ?? '')
  const resolved = resolveWritableProjectPathSync(cwd, rawPath)
  let preState: 'absent' | 'file' = 'absent'
  let preFileIdentity: FileSystemIdentity | undefined
  let preSha256: string | undefined
  let preBytes: number | undefined
  const observation = await observeFile(resolved.fullPath, MAX_FILE_RECONCILIATION_BYTES, observationOptions)
  if (observation.state === 'file') {
    if (typeof observation.sha256 !== 'string') {
      throw new Error(`write_file 目标超过自动保护上限 ${MAX_FILE_RECONCILIATION_BYTES} bytes`)
    }
    preState = 'file'
    preFileIdentity = observation.identity
    preBytes = observation.bytes
    preSha256 = observation.sha256
  }
  const expected = Buffer.from(content, 'utf8')
  assertExpectedFileSize(expected, 'write_file')
  return {
    kind: 'file_content',
    rootPath: resolved.root,
    rootIdentity: fileSystemIdentity(resolved.root),
    relativePath: resolved.relativePath,
    preState,
    preFileIdentity,
    preSha256,
    preBytes,
    expectedSha256: sha256(expected),
    expectedBytes: expected.byteLength
  }
}

async function searchReplaceTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const plan = await planSearchReplace(cwd, {
    file_path: stringValue(toolInput.file_path ?? toolInput.path),
    replacements: searchReplacementArgs(toolInput.replacements),
    dry_run: false
  })
  if (plan.ok === false) throw new Error(`无法冻结 search_replace 目标:${plan.error}`)
  return fileContentTarget(plan)
}

async function exactFileEditTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const plan = await planExactFileEdit(cwd, {
    file_path: stringValue(toolInput.file_path ?? toolInput.path),
    old_string: String(toolInput.old_string ?? ''),
    new_string: String(toolInput.new_string ?? ''),
    replace_all: toolInput.replace_all === true
  })
  if (plan.ok === false) throw new Error(`无法冻结 edit_file 目标:${plan.error}`)
  return fileContentTarget(plan)
}

function fileContentTarget(plan: SearchReplacePlan): EffectTarget {
  const expected = Buffer.from(plan.writeContent, 'utf8')
  assertExpectedFileSize(expected, 'file edit')
  return {
    kind: 'file_content',
    rootPath: plan.rootPath,
    rootIdentity: plan.rootIdentity,
    relativePath: plan.relativePath,
    preState: 'file',
    preFileIdentity: plan.fileIdentity,
    preSha256: plan.originalSha256,
    preBytes: plan.originalBytes,
    expectedSha256: sha256(expected),
    expectedBytes: expected.byteLength
  }
}

function assertExpectedFileSize(expected: Buffer, toolName: string): void {
  if (expected.byteLength > MAX_FILE_RECONCILIATION_BYTES) {
    throw new Error(`${toolName} 预期内容超过自动保护上限 ${MAX_FILE_RECONCILIATION_BYTES} bytes`)
  }
}

async function gitCommitTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const repoRoot = await resolveRepoRoot(cwd)
  const branch = await gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const preHead = await gitText(repoRoot, ['rev-parse', 'HEAD'])
  const stagedDiff = await gitTextAllowEmpty(repoRoot, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames'
  ])
  if (!stagedDiff) {
    throw new Error('没有已暂存的改动；git_commit 已在建立效果 lease 前停止')
  }
  const stagedDiffDigest = stableValueDigest(stagedDiff)
  const message = stringValue(toolInput.message)
  return {
    kind: 'git_commit',
    repoRoot,
    branch,
    preHead,
    stagedDiffDigest,
    messageDigest: stableValueDigest(message.trim())
  }
}

async function gitMergeTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const repoRoot = await resolveRepoRoot(cwd)
  const gitCommonDir = await resolveGitDirectory(repoRoot, ['rev-parse', '--git-common-dir'])
  const worktreeGitDir = await resolveGitDirectory(repoRoot, ['rev-parse', '--git-dir'])
  assertNoGitOperationInProgress(worktreeGitDir)
  if (existsSync(join(gitCommonDir, 'info', 'grafts'))) {
    throw new Error('仓库启用了 legacy grafts，无法可靠固定 merge 父节点')
  }
  const unsafeConfig = await gitMergeUnsafeConfig(repoRoot)
  if (unsafeConfig.length > 0) {
    throw new Error(`仓库包含命令型 merge/filter 配置，已阻止 merge:${unsafeConfig.join(', ')}`)
  }
  const clean = await gitWorktreeClean(repoRoot)
  if (!clean.clean) {
    throw new Error(`工作区不干净，git_merge 已在建立效果 lease 前停止:${clean.reason}`)
  }

  const destinationRef = await gitText(repoRoot, ['symbolic-ref', '--quiet', 'HEAD'])
  if (!destinationRef.startsWith('refs/heads/')) throw new Error('git_merge 只支持当前本地分支')
  const preHead = await gitText(repoRoot, ['rev-parse', 'HEAD'])
  const preTree = await gitText(repoRoot, ['rev-parse', 'HEAD^{tree}'])
  const source = stringValue(toolInput.branch)
  const sourceNameCheck = await gitRun(repoRoot, ['check-ref-format', '--branch', source], [0, 1])
  if (!sourceNameCheck.ok || sourceNameCheck.status !== 0) throw new Error(`无效 merge 分支:${source}`)
  const sourceRefs = await gitLines(repoRoot, ['rev-parse', '--symbolic-full-name', source])
  if (sourceRefs.length !== 1 || !/^refs\/(?:heads|remotes)\//.test(sourceRefs[0])) {
    throw new Error(`merge 来源必须唯一解析为本地或远端分支:${source}`)
  }
  const sourceRef = sourceRefs[0]
  if (sourceRef === destinationRef) throw new Error('不能把当前分支 merge 到自身')
  const sourceSha = await gitText(repoRoot, ['rev-parse', '--verify', `${sourceRef}^{commit}`])
  await assertSafeMergeAttributes(repoRoot, preHead, sourceSha)
  const ancestor = await gitRun(repoRoot, ['merge-base', '--is-ancestor', sourceSha, preHead], [0, 1])
  if (!ancestor.ok) throw new Error(ancestor.error)
  return {
    kind: 'git_merge',
    repoRoot,
    gitCommonDir,
    worktreeGitDir,
    repoRootIdentity: fileSystemIdentity(repoRoot),
    gitCommonDirIdentity: fileSystemIdentity(gitCommonDir),
    worktreeGitDirIdentity: fileSystemIdentity(worktreeGitDir),
    destinationRef,
    preHead,
    preTree,
    sourceRef,
    sourceSha,
    sourceWasAncestor: ancestor.status === 0,
    mode: 'no_ff_v1'
  }
}

async function gitPushTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget> {
  const repoRoot = await resolveRepoRoot(cwd)
  const requestedBranch = optionalString(toolInput.branch)
  const branch = requestedBranch ?? await gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const remoteText = await gitText(repoRoot, ['remote'])
  const remotes = remoteText
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) throw new Error('未配置 Git remote，无法建立 push 效果记录')
  const pushUrls = await gitLines(repoRoot, ['remote', 'get-url', '--push', '--all', remote])
  if (pushUrls.length !== 1) throw new Error('Git push 自动对账只支持唯一 push URL')
  const pushUrl = pushUrls[0]
  const intendedSha = await gitText(repoRoot, ['rev-parse', branch])
  const ref = `refs/heads/${branch}`
  return {
    kind: 'git_push',
    repoRoot,
    remote,
    pushUrlDigest: stableValueDigest(sanitizeRemoteUrl(pushUrl)),
    branch,
    ref,
    intendedSha
  }
}

async function reconcileFileContent(
  target: Extract<EffectTarget, { kind: 'file_content' }>,
  observationOptions: EffectFileObservationOptions
): Promise<EffectReconciliationResult> {
  const resolved = resolveWritableProjectPathSync(target.rootPath, target.relativePath)
  if (realpathSync(resolved.root) !== realpathSync(target.rootPath)) {
    return unresolved({ kind: target.kind, reason: '项目根目录身份已变化' })
  }
  if (target.rootIdentity && !sameFileSystemIdentity(target.rootIdentity, fileSystemIdentity(resolved.root))) {
    return unresolved({ kind: target.kind, reason: '项目根目录设备或 inode 已变化' })
  }
  const observation = await observeFile(
    resolved.fullPath,
    MAX_FILE_RECONCILIATION_BYTES,
    observationOptions
  )
  return reconcileFileContentObservation(
    target,
    observation as FileContentObservation,
    MAX_FILE_RECONCILIATION_BYTES
  )
}

async function reconcileGitCommit(
  target: Extract<EffectTarget, { kind: 'git_commit' }>
): Promise<EffectReconciliationResult> {
  const deadline = Date.now() + GIT_COMMIT_RECONCILIATION_BUDGET_MS
  const currentRoot = await resolveRepoRoot(target.repoRoot)
  if (realpathSync(currentRoot) !== realpathSync(target.repoRoot)) {
    return unresolved({ kind: target.kind, reason: 'Git 仓库身份已变化' })
  }
  const revList = await gitRun(
    target.repoRoot,
    ['rev-list', '--all', '--reflog', '--parents'],
    [0],
    GIT_SCAN_TIMEOUT_MS
  )
  if (!revList.ok) return unresolved({ kind: target.kind, reason: revList.error })
  const candidateShas: string[] = []
  for (const line of revList.stdout.split(/\r?\n/)) {
    const [sha, ...parents] = line.trim().split(/\s+/)
    if (!sha || parents[0] !== target.preHead) continue
    candidateShas.push(sha)
  }
  const uniqueCandidateShas = [...new Set(candidateShas)]
  if (uniqueCandidateShas.length > MAX_GIT_COMMIT_CANDIDATES) {
    return unresolved({
      kind: target.kind,
      candidateCount: uniqueCandidateShas.length,
      candidateLimit: MAX_GIT_COMMIT_CANDIDATES,
      reason: '匹配 preHead 的 commit 候选过多，已停止自动对账'
    })
  }
  const inspected = await mapWithConcurrency(
    uniqueCandidateShas,
    GIT_CANDIDATE_CONCURRENCY,
    async (sha): Promise<{ sha?: string; error?: string }> => {
      try {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) return { error: 'commit 对账总预算已耗尽' }
        const timeoutMs = Math.max(1, Math.min(GIT_LOCAL_TIMEOUT_MS, remainingMs))
        const [stagedDiff, message, reachable] = await Promise.all([
          gitTextAllowEmpty(target.repoRoot, [
            'diff-tree',
            '--binary',
            '--full-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--no-commit-id',
            '-p',
            target.preHead,
            sha
          ], timeoutMs),
          gitText(target.repoRoot, ['show', '-s', '--format=%B', sha], timeoutMs),
          gitRun(
            target.repoRoot,
            ['merge-base', '--is-ancestor', sha, `refs/heads/${target.branch}`],
            [0, 1],
            timeoutMs
          )
        ])
        if (!reachable.ok) return { error: reachable.error }
        if (stableValueDigest(stagedDiff) !== target.stagedDiffDigest) return {}
        if (stableValueDigest(message.trim()) !== target.messageDigest) return {}
        return reachable.status === 0 ? { sha } : {}
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  const inspectionError = inspected.find((item) => item.error)?.error
  if (inspectionError) {
    return unresolved({ kind: target.kind, reason: `候选 commit 查询失败: ${inspectionError}` })
  }
  const candidates = inspected.flatMap((item) => item.sha ? [item.sha] : [])
  const payload = {
    kind: target.kind,
    branch: target.branch,
    preHead: target.preHead,
    stagedDiffDigest: target.stagedDiffDigest,
    candidates: [...new Set(candidates)].sort()
  }
  if (payload.candidates.length === 1) return confirmed(payload, '找到唯一且仍可从原分支到达的匹配 commit')
  return unresolved({
    ...payload,
    reason: payload.candidates.length === 0 ? '未找到唯一可确认的 commit' : '找到多个匹配 commit，禁止自动选择'
  })
}

async function reconcileGitMerge(
  target: Extract<EffectTarget, { kind: 'git_merge' }>
): Promise<EffectReconciliationResult> {
  const currentRoot = await resolveRepoRoot(target.repoRoot)
  if (realpathSync(currentRoot) !== realpathSync(target.repoRoot)) {
    return unresolved({ kind: target.kind, reason: 'Git 仓库工作树身份已变化' })
  }
  const currentCommonDir = await resolveGitDirectory(currentRoot, ['rev-parse', '--git-common-dir'])
  const currentWorktreeGitDir = await resolveGitDirectory(currentRoot, ['rev-parse', '--git-dir'])
  if (
    realpathSync(currentCommonDir) !== realpathSync(target.gitCommonDir) ||
    realpathSync(currentWorktreeGitDir) !== realpathSync(target.worktreeGitDir)
  ) {
    return unresolved({ kind: target.kind, reason: 'Git common dir 或 worktree git dir 身份已变化' })
  }
  if (
    !sameFileSystemIdentity(fileSystemIdentity(currentRoot), target.repoRootIdentity) ||
    !sameFileSystemIdentity(fileSystemIdentity(currentCommonDir), target.gitCommonDirIdentity) ||
    !sameFileSystemIdentity(fileSystemIdentity(currentWorktreeGitDir), target.worktreeGitDirIdentity)
  ) {
    return unresolved({ kind: target.kind, reason: 'Git 仓库或元数据目录的文件系统身份已变化' })
  }
  if (existsSync(join(currentCommonDir, 'info', 'grafts'))) {
    return unresolved({ kind: target.kind, reason: '仓库出现 legacy grafts，无法可靠验证 merge 父节点' })
  }
  const currentUnsafeConfig = await gitMergeUnsafeConfig(currentRoot)
  if (currentUnsafeConfig.length > 0) {
    return unresolved({
      kind: target.kind,
      unsafeConfig: currentUnsafeConfig,
      reason: '仓库当前包含命令型 merge/filter 配置'
    })
  }

  const destination = await gitRun(currentRoot, ['rev-parse', '--verify', target.destinationRef], [0, 1])
  if (!destination.ok || destination.status !== 0 || !destination.stdout.trim()) {
    return unresolved({ kind: target.kind, destinationRef: target.destinationRef, reason: '目标分支 ref 不存在' })
  }
  const destinationSha = destination.stdout.trim()
  const basePayload = {
    kind: target.kind,
    destinationRef: target.destinationRef,
    destinationSha,
    preHead: target.preHead,
    sourceSha: target.sourceSha,
    mode: target.mode
  }
  const operationState = gitOperationState(currentWorktreeGitDir)
  if (operationState.length > 0) {
    return unresolved({ ...basePayload, operationState, reason: '仓库存在未完成的 Git 操作状态' })
  }

  if (target.sourceWasAncestor) {
    const [preHeadReachable, sourceReachable] = await Promise.all([
      gitRun(currentRoot, ['merge-base', '--is-ancestor', target.preHead, destinationSha], [0, 1]),
      gitRun(currentRoot, ['merge-base', '--is-ancestor', target.sourceSha, destinationSha], [0, 1])
    ])
    if (!preHeadReachable.ok || !sourceReachable.ok) {
      return unresolved({ ...basePayload, reason: preHeadReachable.error || sourceReachable.error })
    }
    if (preHeadReachable.status === 0 && sourceReachable.status === 0) {
      return confirmed(basePayload, 'merge 来源在执行前已是目标分支祖先，no-op 后置条件仍成立')
    }
    return unresolved({ ...basePayload, reason: 'already-merged no-op 的目标分支谱系已漂移' })
  }

  if (destinationSha === target.preHead) {
    const currentDestinationRef = await gitRun(currentRoot, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1])
    if (
      !currentDestinationRef.ok ||
      currentDestinationRef.status !== 0 ||
      currentDestinationRef.stdout.trim() !== target.destinationRef
    ) {
      return unresolved({ ...basePayload, reason: '原 worktree 已不再绑定目标分支，无法证明 merge 未发生' })
    }
    const currentTree = await gitText(currentRoot, ['rev-parse', 'HEAD^{tree}'])
    if (currentTree !== target.preTree) {
      return unresolved({ ...basePayload, currentTree, reason: 'HEAD tree 已偏离执行前状态' })
    }
    const clean = await gitWorktreeClean(currentRoot)
    if (!clean.clean) {
      return unresolved({ ...basePayload, worktreeReason: clean.reason, reason: 'index 或 worktree 已偏离执行前干净状态' })
    }
    return notApplied(basePayload, '目标分支、index 与 worktree 仍是执行前状态，已证明 merge 未发生')
  }

  try {
    await assertSafeMergeAttributes(currentRoot, target.preHead, target.sourceSha)
  } catch (error) {
    return unresolved({
      ...basePayload,
      reason: `merge 属性安全策略无法重建:${error instanceof Error ? error.message : String(error)}`
    })
  }

  const expectedTreeProbe = await expectedGitMergeTree(target)
  if (!expectedTreeProbe.ok) {
    return unresolved({
      ...basePayload,
      reason: 'reason' in expectedTreeProbe ? expectedTreeProbe.reason : '无法计算 expected merge tree'
    })
  }
  const expectedTree = expectedTreeProbe.tree

  const revList = await gitRun(
    currentRoot,
    ['rev-list', '--parents', target.destinationRef],
    [0],
    GIT_SCAN_TIMEOUT_MS
  )
  if (!revList.ok) return unresolved({ ...basePayload, reason: revList.error })
  const reportedCandidates = new Set<string>()
  for (const line of revList.stdout.split(/\r?\n/)) {
    const [sha, ...parents] = line.trim().split(/\s+/)
    if (
      sha &&
      parents.length === 2 &&
      parents[0] === target.preHead &&
      parents[1] === target.sourceSha
    ) {
      reportedCandidates.add(sha)
    }
  }
  if (reportedCandidates.size > MAX_GIT_MERGE_CANDIDATES) {
    return unresolved({
      ...basePayload,
      candidateCount: reportedCandidates.size,
      candidateLimit: MAX_GIT_MERGE_CANDIDATES,
      reason: '匹配 merge 父节点的候选过多，已停止自动对账'
    })
  }
  const inspected = await mapWithConcurrency(
    [...reportedCandidates],
    GIT_CANDIDATE_CONCURRENCY,
    async (sha): Promise<{ sha?: string; tree?: string; error?: string }> => {
      try {
        const commit = await rawCommitDetails(currentRoot, sha)
        return commit.parents.length === 2 && commit.parents[0] === target.preHead && commit.parents[1] === target.sourceSha
          ? { sha, tree: commit.tree }
          : {}
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  const inspectionError = inspected.find((item) => item.error)?.error
  if (inspectionError) return unresolved({ ...basePayload, reason: `merge 候选查询失败:${inspectionError}` })
  const parentCandidates = inspected.flatMap((item) => item.sha ? [item.sha] : [])
  const candidates = inspected.flatMap((item) => item.sha && item.tree === expectedTree ? [item.sha] : [])
  const uniqueCandidates = [...new Set(candidates)].sort()
  if (uniqueCandidates.length === 1) {
    return confirmed(
      { ...basePayload, expectedTree, candidates: uniqueCandidates },
      '找到唯一且仍可从目标分支到达的 exact-parent/exact-tree merge commit'
    )
  }
  if (uniqueCandidates.length > 1) {
    return unresolved({ ...basePayload, expectedTree, candidates: uniqueCandidates, reason: '找到多个 exact-parent/exact-tree merge commit，禁止自动选择' })
  }
  if (parentCandidates.length > 0) {
    return unresolved({
      ...basePayload,
      expectedTree,
      parentCandidates: [...new Set(parentCandidates)].sort(),
      reason: 'merge commit 父节点匹配，但 tree 与安全预检结果不一致'
    })
  }
  return unresolved({ ...basePayload, candidates: [], reason: '目标分支已漂移且未找到可确认的 merge commit' })
}

async function reconcileGitPush(
  target: Extract<EffectTarget, { kind: 'git_push' }>
): Promise<EffectReconciliationResult> {
  const currentPushUrls = await gitLines(target.repoRoot, ['remote', 'get-url', '--push', '--all', target.remote])
  if (currentPushUrls.length !== 1) {
    return unresolved({ kind: target.kind, remote: target.remote, reason: 'Git remote 当前存在多个 push URL' })
  }
  const currentPushUrl = currentPushUrls[0]
  const currentUrlDigest = stableValueDigest(sanitizeRemoteUrl(currentPushUrl))
  if (currentUrlDigest !== target.pushUrlDigest) {
    return unresolved({ kind: target.kind, remote: target.remote, reason: 'push URL 身份已变化' })
  }
  let probeUrl: string
  try {
    probeUrl = normalizeRemoteProbeUrl(target.repoRoot, currentPushUrl)
  } catch (error) {
    return unresolved({
      kind: target.kind,
      remote: target.remote,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
  const probe = await gitRemoteRun(
    ['ls-remote', '--heads', probeUrl, target.ref],
    [0, 2],
    GIT_REMOTE_TIMEOUT_MS
  )
  if (!probe.ok && probe.status !== 2) {
    return unresolved({ kind: target.kind, remote: target.remote, ref: target.ref, reason: probe.error })
  }
  const observedSha = parseRemoteSha(probe.stdout, target.ref)
  const payload = { kind: target.kind, remote: target.remote, ref: target.ref, observedSha }
  if (observedSha === target.intendedSha) return confirmed(payload, '远端 ref 与预期 SHA 完全一致')
  return unresolved({
    ...payload,
    reason: observedSha ? '远端 ref 已指向其他 SHA' : '远端 ref 不存在或无法确认'
  })
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const root = await gitText(cwd, ['rev-parse', '--show-toplevel'])
  return realpathSync(root)
}

async function resolveGitDirectory(repoRoot: string, args: string[]): Promise<string> {
  const raw = await gitText(repoRoot, args)
  return realpathSync(isAbsolute(raw) ? raw : resolve(repoRoot, raw))
}

function fileSystemIdentity(path: string): FileSystemIdentity {
  const stats = statSync(path, { bigint: true })
  return { device: stats.dev.toString(), inode: stats.ino.toString() }
}

function sameFileSystemIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

async function gitMergeUnsafeConfig(repoRoot: string): Promise<string[]> {
  const result = await gitRun(repoRoot, ['config', '--includes', '-z', '--list'])
  if (!result.ok) throw new Error(result.error)
  return unsafeMergeConfigKeys(result.stdout)
}

async function assertSafeMergeAttributes(
  repoRoot: string,
  preHead: string,
  sourceSha: string
): Promise<void> {
  const [prePaths, sourcePaths] = await Promise.all([
    gitRun(repoRoot, ['ls-tree', '-r', '-z', '--name-only', preHead]),
    gitRun(repoRoot, ['ls-tree', '-r', '-z', '--name-only', sourceSha])
  ])
  if (!prePaths.ok) throw new Error(prePaths.error)
  if (!sourcePaths.ok) throw new Error(sourcePaths.error)
  const paths = [...new Set([...prePaths.stdout.split('\0'), ...sourcePaths.stdout.split('\0')].filter(Boolean))]
  if (paths.length === 0) return
  const input = `${paths.join('\0')}\0`
  if (Buffer.byteLength(input, 'utf8') > MAX_GIT_OUTPUT) {
    throw new Error('merge 属性检查输入超过安全上限')
  }
  const attributes = await gitRun(
    repoRoot,
    ['check-attr', '--source', preHead, '-z', '--stdin', 'merge', 'filter'],
    [0],
    GIT_SCAN_TIMEOUT_MS,
    input
  )
  if (!attributes.ok) throw new Error(attributes.error)
  const unsafe = unsafeMergeAttributes(attributes.stdout)
  if (unsafe.length > 0) {
    throw new Error(`仓库使用命令可扩展的 merge/filter 属性，当前安全模式不支持:${unsafe.join(', ')}`)
  }
}

function unsafeMergeAttributes(output: string): string[] {
  const records = output.split('\0')
  const unsafe = new Set<string>()
  for (let index = 0; index + 2 < records.length; index += 3) {
    const path = records[index]
    const attribute = records[index + 1]
    const value = records[index + 2]
    if (!path || !attribute) continue
    if (attribute === 'merge' && !['unspecified', 'set', 'unset'].includes(value)) {
      unsafe.add(`${path}:merge=${value}`)
    }
    if (attribute === 'filter' && !['unspecified', 'unset'].includes(value)) {
      unsafe.add(`${path}:filter=${value}`)
    }
  }
  return [...unsafe].sort()
}

async function gitWorktreeClean(repoRoot: string): Promise<{ clean: boolean; reason: string }> {
  const [staged, worktree, untracked, unmerged, hiddenIndex] = await Promise.all([
    gitRun(repoRoot, ['diff-index', '--cached', '--quiet', 'HEAD', '--'], [0, 1]),
    gitRun(
      repoRoot,
      ['diff-files', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--'],
      [0, 1]
    ),
    gitRun(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.']),
    gitRun(repoRoot, ['ls-files', '--unmerged', '-z']),
    gitRun(repoRoot, ['ls-files', '-v', '-z', '--full-name'])
  ])
  for (const probe of [staged, worktree, untracked, unmerged, hiddenIndex]) {
    if (!probe.ok) throw new Error(probe.error)
  }
  const hiddenIndexPaths = indexVisibilityFlagPaths(hiddenIndex.stdout)
  const reasons: string[] = []
  if (staged.status === 1) reasons.push('staged changes')
  if (worktree.status === 1) reasons.push('worktree changes')
  if (untracked.stdout.length > 0) reasons.push('untracked files')
  if (unmerged.stdout.length > 0) reasons.push('unmerged index entries')
  if (hiddenIndexPaths.length > 0) {
    reasons.push(`assume-unchanged paths:${hiddenIndexPaths.slice(0, 8).join(', ')}`)
  }
  return { clean: reasons.length === 0, reason: reasons.join(', ') || 'clean' }
}

function indexVisibilityFlagPaths(output: string): string[] {
  const paths: string[] = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const tag = record[0]
    if (tag >= 'a' && tag <= 'z') paths.push(record.slice(2))
  }
  return paths.sort()
}

function assertNoGitOperationInProgress(worktreeGitDir: string): void {
  const state = gitOperationState(worktreeGitDir)
  if (state.length > 0) throw new Error(`仓库存在未完成的 Git 操作:${state.join(', ')}`)
}

function gitOperationState(worktreeGitDir: string): string[] {
  return [
    'MERGE_HEAD',
    'AUTO_MERGE',
    'MERGE_MSG',
    'MERGE_MODE',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'BISECT_START',
    'rebase-apply',
    'rebase-merge',
    'sequencer'
  ].filter((entry) => existsSync(join(worktreeGitDir, entry)))
}

async function rawCommitDetails(
  repoRoot: string,
  sha: string
): Promise<{ tree: string; parents: string[] }> {
  const raw = await gitText(repoRoot, ['cat-file', 'commit', sha])
  const parents: string[] = []
  let tree = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line) break
    if (line.startsWith('tree ')) tree = line.slice('tree '.length).trim()
    if (line.startsWith('parent ')) parents.push(line.slice('parent '.length).trim())
  }
  if (!tree) throw new Error(`commit ${sha} 缺少 tree header`)
  return { tree, parents }
}

async function expectedGitMergeTree(
  target: Extract<EffectTarget, { kind: 'git_merge' }>
): Promise<{ ok: true; tree: string } | { ok: false; reason: string }> {
  let objectDir: string
  try {
    objectDir = mkdtempSync(join(tmpdir(), 'caogen-reconcile-merge-tree-'))
  } catch (error) {
    return { ok: false, reason: `无法创建隔离 merge 对账目录:${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const env = isolatedLocalGitEnv(process.env)
    env.GIT_OBJECT_DIRECTORY = objectDir
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = gitAlternateObjectDirectories([join(target.gitCommonDir, 'objects')])
    env.GIT_ATTR_SOURCE = target.preHead
    const args = [
      '-C',
      target.repoRoot,
      'merge-tree',
      '--write-tree',
      '--messages',
      '--name-only',
      '-z',
      '-X',
      'find-renames=50%',
      target.preHead,
      target.sourceSha
    ]
    const result = await gitConfiguredRun(
      args,
      withSafeMergeGitConfig(args, objectDir),
      env,
      [0, 1],
      GIT_SCAN_TIMEOUT_MS
    )
    if (!result.ok) return { ok: false, reason: result.error }
    if (result.status === 1) return { ok: false, reason: '冻结的 merge 输入当前仍产生冲突' }
    const tree = result.stdout.split('\0')[0]?.trim()
    if (!tree || !/^[0-9a-f]{40,64}$/i.test(tree)) {
      return { ok: false, reason: '隔离 merge 对账未返回 expected tree' }
    }
    return { ok: true, tree }
  } finally {
    rmSync(objectDir, { recursive: true, force: true })
  }
}

function parseRemoteSha(output: string, ref: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const [sha, remoteRef] = line.trim().split(/\s+/)
    if (sha && remoteRef === ref) return sha
  }
  return undefined
}

async function gitText(cwd: string, args: string[], timeoutMs = GIT_LOCAL_TIMEOUT_MS): Promise<string> {
  const result = await gitRun(cwd, args, [0], timeoutMs)
  if (!result.ok) throw new Error(result.error)
  const text = result.stdout.trim()
  if (!text) throw new Error(`git ${args[0]} 未返回结果`)
  return text
}

async function gitTextAllowEmpty(
  cwd: string,
  args: string[],
  timeoutMs = GIT_LOCAL_TIMEOUT_MS
): Promise<string> {
  const result = await gitRun(cwd, args, [0], timeoutMs)
  if (!result.ok) throw new Error(result.error)
  return result.stdout
}

async function gitLines(cwd: string, args: string[], timeoutMs = GIT_LOCAL_TIMEOUT_MS): Promise<string[]> {
  const result = await gitRun(cwd, args, [0], timeoutMs)
  if (!result.ok) throw new Error(result.error)
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function gitRun(
  cwd: string,
  args: string[],
  allowStatuses: number[] = [0],
  timeoutMs = GIT_LOCAL_TIMEOUT_MS,
  input?: string
): Promise<GitRunResult> {
  return new Promise((resolveResult) => {
    const child = execFile('git', withSafeLocalGitConfig(['-C', cwd, ...args]), {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      env: isolatedLocalGitEnv(process.env)
    }, (error, stdoutValue, stderrValue) => {
      resolveResult(gitRunResult(args, allowStatuses, timeoutMs, error, stdoutValue, stderrValue))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function gitConfiguredRun(
  argsForError: string[],
  commandArgs: string[],
  env: NodeJS.ProcessEnv,
  allowStatuses: number[] = [0],
  timeoutMs = GIT_LOCAL_TIMEOUT_MS
): Promise<GitRunResult> {
  return new Promise((resolveResult) => {
    execFile('git', commandArgs, {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      env
    }, (error, stdoutValue, stderrValue) => {
      resolveResult(gitRunResult(argsForError, allowStatuses, timeoutMs, error, stdoutValue, stderrValue))
    })
  })
}

function gitRemoteRun(
  args: string[],
  allowStatuses: number[] = [0],
  timeoutMs = GIT_REMOTE_TIMEOUT_MS
): Promise<GitRunResult> {
  let isolatedCwd: string
  try {
    isolatedCwd = mkdtempSync(join(tmpdir(), 'caogen-git-probe-'))
  } catch (error) {
    return Promise.resolve({
      ok: false,
      status: null,
      stdout: '',
      error: `无法创建隔离的 Git 远端探针目录:${error instanceof Error ? error.message : String(error)}`
    })
  }
  return new Promise((resolveResult) => {
    const env = isolatedRemoteGitEnv(process.env)
    env.GIT_CEILING_DIRECTORIES = isolatedCwd
    env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '0'
    execFile('git', withSafeRemoteGitConfig(args), {
      cwd: isolatedCwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      env
    }, (error, stdoutValue, stderrValue) => {
      try {
        resolveResult(gitRunResult(args, allowStatuses, timeoutMs, error, stdoutValue, stderrValue))
      } finally {
        rmSync(isolatedCwd, { recursive: true, force: true })
      }
    })
  })
}

function gitRunResult(
  args: string[],
  allowStatuses: number[],
  timeoutMs: number,
  error: Error | null,
  stdoutValue: string | Buffer,
  stderrValue: string | Buffer
): GitRunResult {
  const failure = error as (Error & {
    code?: string | number
    killed?: boolean
    signal?: string
  }) | null
  const stdout = String(stdoutValue ?? '')
  const stderr = String(stderrValue ?? '')
  const status = failure
    ? typeof failure.code === 'number'
      ? failure.code
      : null
    : 0
  const timedOut = !!failure && (
    failure.code === 'ETIMEDOUT' ||
    (failure.killed === true && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  )
  const ok = status !== null && allowStatuses.includes(status)
  return {
    ok,
    status,
    stdout,
    error: timedOut
      ? `git ${args[0]} timed out after ${timeoutMs}ms`
      : redactGitError(stderr.trim() || failure?.message || stdout.trim() || `git ${args[0]} failed`)
  }
}

function normalizeRemoteProbeUrl(repoRoot: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Git push URL 为空，已停止自动对账')
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(trimmed)) {
    throw new Error('Git remote helper 协议可能执行外部命令，已停止自动对账')
  }
  if (isAbsolute(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    if (!new Set(['file:', 'git:', 'http:', 'https:', 'ssh:']).has(url.protocol)) {
      throw new Error(`Git push URL 协议 ${url.protocol} 不允许自动对账`)
    }
    return trimmed
  } catch (error) {
    if (error instanceof Error && error.message.includes('不允许自动对账')) throw error
  }
  if (/^(?:[^@\s/:]+@)?[^:\s/]+:.+$/.test(trimmed)) return trimmed
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
    throw new Error('Git push URL 使用未知协议，已停止自动对账')
  }
  return resolve(repoRoot, trimmed)
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(items[index])
      }
    }
  )
  await Promise.all(workers)
  return results
}

function sanitizeRemoteUrl(value: string): string {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return trimmed.replace(/^[^@\s]+@/, '')
  }
}

function redactGitError(value: string): string {
  return value
    .replace(/\b(?:https?|ssh|git|file):\/\/[^\s'"<>]+/gi, (match) => sanitizeRemoteUrl(match))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b[^\s'"<>@]+@([A-Za-z0-9.-]+(?::[^\s'"<>]+)?)/g, '$1')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

type ObservedFile =
  | { state: 'absent' }
  | {
      state: 'file'
      identity: FileSystemIdentity
      bytes: number
      sha256?: string
    }

async function observeFile(
  filePath: string,
  maxHashBytes: number,
  options: EffectFileObservationOptions
): Promise<ObservedFile> {
  const openFlags = safeReadFlags()
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, openFlags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('write_file 目标已存在但不是普通文件')
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('文件大小超过可安全记录范围')
    }
    await options.beforeRead?.(filePath)
    let digest: string | undefined
    if (before.size <= BigInt(maxHashBytes)) {
      const content = await handle.readFile()
      if (BigInt(content.byteLength) !== before.size) {
        throw new Error('文件观察期间读取长度发生变化')
      }
      digest = sha256(content)
    }
    const after = await handle.stat({ bigint: true })
    const current = await lstat(filePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (
      !current ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs
    ) {
      throw new Error('文件观察期间目标路径或内容发生变化')
    }
    return {
      state: 'file',
      identity: { device: before.dev.toString(), inode: before.ino.toString() },
      bytes: Number(before.size),
      sha256: digest
    }
  } finally {
    await handle.close()
  }
}

function safeReadFlags(): number {
  let flags = constants.O_RDONLY
  if (process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW
  if (process.platform !== 'win32' && typeof constants.O_NONBLOCK === 'number') flags |= constants.O_NONBLOCK
  return flags
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('效果描述缺少必需字符串参数')
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
