import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import { parseWslHostPath } from '../wsl/binding'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  gitAlternateObjectDirectories,
  isolatedLocalGitEnv,
  unsafeMergeConfigKeys,
  withSafeLocalGitConfig,
  withSafeMergeGitConfig
} from './safe-git'
import { stableValueDigest } from '../task/tool-idempotency'
import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import { hasMeaningfulWorktreeChanges } from './git-worktree-state'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

const GIT_TIMEOUT_MS = 120_000
const MAX_BUFFER = 16 * 1024 * 1024
const MAX_OUTPUT_CHARS = 24_000
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const SUPPORTED_PR_PROVIDERS = new Set<PullRequestProvider>(['github', 'gitlab'])
const TRUSTED_EMPTY_HOOKS_DIR = createTrustedEmptyHooksDir()

export type PullRequestProvider = 'github' | 'gitlab' | 'gitee' | 'unknown'
export type PullRequestTool = 'gh' | 'glab'

export interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

export interface GitStatusFile {
  path: string
  oldPath?: string
  indexStatus: string
  worktreeStatus: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'unknown'
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitStatusResult {
  ok: true
  repoRoot: string
  branch: string
  upstream?: string
  ahead: number
  behind: number
  clean: boolean
  files: GitStatusFile[]
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

export interface GitDiffResult {
  ok: true
  repoRoot: string
  file?: string
  stagedDiff: string
  unstagedDiff: string
  untrackedFiles: string[]
  truncated: boolean
}

export interface GitCommitCheckResult {
  name: string
  command: string
  ok: boolean
  exitCode: number | null
  output: string
}

export interface GitCommitResult {
  ok: true
  repoRoot: string
  branch: string
  sha: string
  checks: GitCommitCheckResult[]
}

export interface GitPushResult {
  ok: true
  repoRoot: string
  remote: string
  branch: string
  upstream: string
  output: string
}

export interface PullRequestRemote {
  remote: string
  url: string
  provider: PullRequestProvider
  owner?: string
  repo?: string
}

export interface GitCreatePrResult {
  ok: true
  repoRoot: string
  provider: PullRequestProvider
  tool: PullRequestTool
  branch: string
  base: string
  url: string
}

export interface GitMergeResult {
  ok: true
  repoRoot: string
  currentBranch: string
  mergedBranch: string
  output: string
}

export interface GitMergeExecutionPlan {
  repoRoot: string
  gitCommonDir: string
  worktreeGitDir: string
  repoRootIdentity: FileSystemIdentity
  gitCommonDirIdentity: FileSystemIdentity
  worktreeGitDirIdentity: FileSystemIdentity
  destinationRef: string
  preHead: string
  sourceRef: string
  sourceSha: string
  sourceWasAncestor: boolean
  mode: 'no_ff_v1'
}

export interface GitFailure {
  ok: false
  error: string
  repoRoot?: string
  details?: string
  conflictFiles?: string[]
  checks?: GitCommitCheckResult[]
}

export type GitStatusOperationResult = GitStatusResult | GitFailure
export type GitDiffOperationResult = GitDiffResult | GitFailure
export type GitCommitOperationResult = GitCommitResult | GitFailure
export type GitPushOperationResult = GitPushResult | GitFailure
export type GitCreatePrOperationResult = GitCreatePrResult | GitFailure
export type GitMergeOperationResult = GitMergeResult | GitFailure

interface BranchInfo {
  branch: string
  upstream?: string
  ahead: number
  behind: number
}

interface NormalizedFilePath {
  absolute: string
  relative: string
}

interface GitCommandOptions {
  allowExitCodes?: number[]
  input?: string
  replaceEnv?: boolean
}

interface MergeRepositoryIdentity {
  ok: true
  gitCommonDir: string
  worktreeGitDir: string
  repoRootIdentity: FileSystemIdentity
  gitCommonDirIdentity: FileSystemIdentity
  worktreeGitDirIdentity: FileSystemIdentity
  env: NodeJS.ProcessEnv
}

export function gitStatus(cwd: string): GitStatusOperationResult {
  const repo = resolveStructuredReadRepo(cwd)
  if (repo.ok === false) return repo
  const readBoundary = structuredReadEnvironment(repo.repoRoot)
  if (readBoundary.ok === false) return readBoundary

  const status = runBoundGit(
    repo.repoRoot,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'],
    readBoundary.env
  )
  if (!status.ok) return failure('读取 Git 状态失败', repo.repoRoot, status.error)

  const files = parsePorcelainStatus(status.stdout)
  const branch = readBranchInfo(repo.repoRoot, readBoundary.env)
  return {
    ok: true,
    repoRoot: repo.repoRoot,
    branch: branch.branch,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    clean: files.length === 0,
    files,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => file.unstaged && !file.untracked).length,
    untracked: files.filter((file) => file.untracked).length,
    conflicted: files.filter((file) => file.conflicted).length
  }
}

export function gitDiff(cwd: string, rawFile?: string): GitDiffOperationResult {
  const repo = resolveStructuredReadRepo(cwd)
  if (repo.ok === false) return repo
  const readBoundary = structuredReadEnvironment(repo.repoRoot)
  if (readBoundary.ok === false) return readBoundary

  let file: NormalizedFilePath | undefined
  if (rawFile) {
    const normalized = normalizeRepoPath(repo.repoRoot, rawFile)
    if (normalized.ok === false) return normalized
    file = { absolute: normalized.absolute, relative: normalized.relative }
  }

  const pathArgs = file?.relative ? ['--', file.relative] : ['--']
  const staged = runBoundGit(
    repo.repoRoot,
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--cached', ...pathArgs],
    readBoundary.env
  )
  if (!staged.ok) return failure('读取 staged diff 失败', repo.repoRoot, staged.error)
  const unstaged = runBoundGit(
    repo.repoRoot,
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', ...pathArgs],
    readBoundary.env
  )
  if (!unstaged.ok) return failure('读取 unstaged diff 失败', repo.repoRoot, unstaged.error)

  const untracked = rawFile
    ? untrackedFiles(repo.repoRoot, readBoundary.env).filter((item) => item === file?.relative)
    : untrackedFiles(repo.repoRoot, readBoundary.env)
  const stagedClip = clip(staged.stdout)
  const unstagedClip = clip(unstaged.stdout)

  return {
    ok: true,
    repoRoot: repo.repoRoot,
    file: file?.relative,
    stagedDiff: stagedClip.text,
    unstagedDiff: unstagedClip.text,
    untrackedFiles: untracked,
    truncated: stagedClip.truncated || unstagedClip.truncated
  }
}

export function gitCommit(cwd: string, message: string): GitCommitOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return failure('提交信息不能为空', repo.repoRoot)

  const status = gitStatus(repo.repoRoot)
  if (status.ok === false) return status
  if (status.conflicted > 0) {
    return failure(
      '存在未解决冲突，已阻止提交',
      repo.repoRoot,
      undefined,
      status.files.filter((file) => file.conflicted).map((file) => file.path)
    )
  }

  if (!hasStagedChanges(repo.repoRoot)) {
    return failure('没有已暂存的改动；为避免误提交其他 Agent 改动，git_commit 不会自动 git add', repo.repoRoot)
  }

  const checks: GitCommitCheckResult[] = []
  const commit = runGit(repo.repoRoot, [
    '-c',
    `core.hooksPath=${TRUSTED_EMPTY_HOOKS_DIR}`,
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--no-verify',
    '--no-gpg-sign',
    '-m',
    text
  ])
  if (!commit.ok) return failure('git commit 失败', repo.repoRoot, commit.error, undefined, checks)

  const sha = gitText(repo.repoRoot, ['rev-parse', 'HEAD'])
  if (sha.ok === false) return failure('提交已执行，但读取 HEAD sha 失败', repo.repoRoot, sha.error, undefined, checks)
  return { ok: true, repoRoot: repo.repoRoot, branch: readBranchInfo(repo.repoRoot).branch, sha: sha.text, checks }
}

export function gitPush(cwd: string, rawBranch?: string, approved?: Extract<EffectTarget, { kind: 'git_push' }>): GitPushOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const branch = rawBranch?.trim() || readBranchInfo(repo.repoRoot).branch
  if (!isUsableBranchName(repo.repoRoot, branch)) return failure(`无效或不可推送的分支名: ${branch}`, repo.repoRoot)

  const remote = preferredRemote(repo.repoRoot)
  if (!remote) return failure('未配置 Git remote，无法 push', repo.repoRoot)

  let destination = remote, source = branch
  if (approved) {
    const urls = gitText(repo.repoRoot, ['remote', 'get-url', '--push', '--all', remote])
    const head = gitText(repo.repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
    if (!urls.ok || !head.ok || urls.text.split(/\r?\n/).length !== 1 || approved.repoRoot !== repo.repoRoot ||
        approved.remote !== remote || approved.branch !== branch || approved.ref !== `refs/heads/${branch}` ||
        head.text !== approved.intendedSha || stableValueDigest(safePushUrl(urls.text)) !== approved.pushUrlDigest) return failure('推送目标偏离已确认的草稿或 Effect', repo.repoRoot)
    destination = urls.text; source = approved.intendedSha
  }
  const push = runGit(repo.repoRoot, [
    '-c',
    `core.hooksPath=${TRUSTED_EMPTY_HOOKS_DIR}`,
    '-c',
    'push.gpgSign=false',
    'push',
    '--no-verify',
    ...(approved ? [] : ['-u']),
    '--', destination,
    `${source}:refs/heads/${branch}`
  ])
  const safeOutput = (value?: string) => approved ? (value ?? '').split(destination).join(safePushUrl(destination)) : (value ?? '')
  if (!push.ok) return failure('git push 失败', repo.repoRoot, safeOutput(push.error))

  const upstream = `${remote}/${branch}`
  return {
    ok: true,
    repoRoot: repo.repoRoot,
    remote,
    branch,
    upstream,
    output: clip(safeOutput([push.stdout, push.stderr].filter(Boolean).join('\n'))).text
  }
}

function safePushUrl(value: string): string {
  try { const url = new URL(value.trim()); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString() }
  catch { return value.trim().replace(/^[^@\s]+@/, '') }
}

export function gitCreatePr(
  cwd: string,
  title: string,
  body: string,
  rawBase?: string
): GitCreatePrOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const prTitle = typeof title === 'string' ? title.trim() : ''
  if (!prTitle) return failure('PR 标题不能为空', repo.repoRoot)

  const branch = readBranchInfo(repo.repoRoot).branch
  if (!isUsableBranchName(repo.repoRoot, branch)) return failure(`当前分支不可创建 PR: ${branch}`, repo.repoRoot)

  const remote = detectPullRequestRemote(repo.repoRoot)
  if (!remote) return failure('未检测到可用于创建 PR 的 Git remote', repo.repoRoot)
  if (!SUPPORTED_PR_PROVIDERS.has(remote.provider)) {
    return failure(
      `已识别 ${remote.provider} remote，但当前基础版本只支持 GitHub/GitLab CLI 创建 PR/MR`,
      repo.repoRoot,
      remote.url
    )
  }

  const tool = prToolForProvider(remote.provider)
  if (!tool || !commandExists(tool, repo.repoRoot)) {
    return failure(
      `已识别 ${remote.provider} remote，但当前执行环境未检测到 ${tool ?? '可用'} PR 工具`,
      repo.repoRoot,
      remote.url
    )
  }

  if (!hasRemoteBranch(repo.repoRoot, remote.remote, branch)) {
    return failure(`远端分支 ${remote.remote}/${branch} 不存在；请先显式调用 git_push`, repo.repoRoot)
  }

  const base = rawBase?.trim() || defaultBaseBranch(repo.repoRoot, remote.remote) || 'main'
  if (!isUsableBranchName(repo.repoRoot, base)) return failure(`无效 base 分支: ${base}`, repo.repoRoot)

  const create =
    tool === 'gh'
      ? runCommand('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', prTitle, '--body', body], repo.repoRoot, {
          GH_PROMPT_DISABLED: '1'
        })
      : runCommand(
          'glab',
          ['mr', 'create', '--source-branch', branch, '--target-branch', base, '--title', prTitle, '--description', body, '--yes'],
          repo.repoRoot,
          { GITLAB_HOST: gitlabHostFromUrl(remote.url) ?? '' }
        )

  if (!create.ok) return failure(`${tool} 创建 PR/MR 失败`, repo.repoRoot, create.error)
  const url = extractUrl(create.stdout) ?? extractUrl(create.stderr)
  if (!url) return failure(`${tool} 创建完成但未返回 PR/MR URL`, repo.repoRoot, clip(create.stdout || create.stderr).text)

  return { ok: true, repoRoot: repo.repoRoot, provider: remote.provider, tool, branch, base, url }
}

export function gitMerge(
  cwd: string,
  branch: string,
  executionPlan?: GitMergeExecutionPlan
): GitMergeOperationResult {
  const repo = resolveMergeRepo(cwd)
  if (repo.ok === false) return repo

  const target = typeof branch === 'string' ? branch.trim() : ''
  if (!isUsableMergeBranchName(repo.repoRoot, target)) {
    return failure(`无效 merge 分支: ${target}`, repo.repoRoot)
  }
  const identity = mergeRepositoryIdentity(repo.repoRoot)
  if (identity.ok === false) return identity
  if (executionPlan) {
    const planIdentity = validateMergeExecutionIdentity(repo.repoRoot, identity, executionPlan)
    if (planIdentity.ok === false) return planIdentity
  }
  const unsafeConfig = mergeUnsafeConfig(repo.repoRoot, identity.env)
  if (unsafeConfig.ok === false) return unsafeConfig
  if (unsafeConfig.keys.length > 0) {
    return failure(
      `仓库包含命令型 merge/filter 配置，已阻止 merge: ${unsafeConfig.keys.join(', ')}`,
      repo.repoRoot
    )
  }
  if (existsSync(join(identity.gitCommonDir, 'info', 'grafts'))) {
    return failure('仓库启用了 legacy grafts，无法可靠固定 merge 父节点', repo.repoRoot)
  }
  const operationState = mergeOperationState(identity.worktreeGitDir)
  if (operationState.length > 0) {
    return failure(`仓库存在未完成的 Git 操作: ${operationState.join(', ')}`, repo.repoRoot)
  }
  const currentRef = isolatedGitText(repo.repoRoot, ['symbolic-ref', '--quiet', 'HEAD'], identity.env)
  const preHead = isolatedGitText(repo.repoRoot, ['rev-parse', 'HEAD'], identity.env)
  if (!currentRef.ok || !preHead.ok || !currentRef.text.startsWith('refs/heads/')) {
    const details = 'error' in currentRef
      ? currentRef.error
      : 'error' in preHead
        ? preHead.error
        : `HEAD=${currentRef.text}`
    return failure('git_merge 只支持当前本地分支', repo.repoRoot, details)
  }
  const current = currentRef.text.replace(/^refs\/heads\//, '')
  let sourceSha: string
  let sourceWasAncestor: boolean | undefined
  if (executionPlan) {
    if (executionPlan.mode !== 'no_ff_v1') return failure('不支持的 git_merge execution plan', repo.repoRoot)
    if (
      executionPlan.destinationRef !== currentRef.text ||
      executionPlan.preHead !== preHead.text
    ) {
      return failure('目标分支已偏离审批时状态，已阻止 merge', repo.repoRoot)
    }
    if (executionPlan.sourceRef === currentRef.text) return failure('不能把当前分支 merge 到自身', repo.repoRoot)
    if (!mergeInputMatchesSourceRef(target, executionPlan.sourceRef)) {
      return failure('merge 来源与审批时 source ref 不一致，已阻止 merge', repo.repoRoot)
    }
    sourceSha = executionPlan.sourceSha
    const frozenSource = isolatedGitText(repo.repoRoot, ['rev-parse', '--verify', `${sourceSha}^{commit}`], identity.env)
    if (!frozenSource.ok || frozenSource.text !== sourceSha) {
      return failure('审批时冻结的 merge source SHA 已不可读取', repo.repoRoot)
    }
    sourceWasAncestor = executionPlan.sourceWasAncestor
  } else {
    const source = resolveMergeSource(repo.repoRoot, target, identity.env)
    if (source.ok === false) return source
    if (source.ref === currentRef.text) return failure('不能把当前分支 merge 到自身', repo.repoRoot)
    sourceSha = source.sha
  }
  const attributePolicy = safeMergeAttributePolicy(repo.repoRoot, preHead.text, sourceSha, identity.env)
  if (attributePolicy.ok === false) return attributePolicy
  const status = safeMergeWorktreeState(repo.repoRoot, identity.env)
  if (status.ok === false) return status
  if (!status.clean) {
    return failure(
      `工作区不干净，已阻止 merge；请先提交、暂存处理或清理当前改动: ${status.reason}`,
      repo.repoRoot
    )
  }
  const ancestor = runBoundGit(
    repo.repoRoot,
    ['merge-base', '--is-ancestor', sourceSha, preHead.text],
    identity.env,
    { allowExitCodes: [0, 1] }
  )
  if (!ancestor.ok) return failure('无法确认 merge 来源谱系', repo.repoRoot, ancestor.error)
  if (sourceWasAncestor !== undefined && sourceWasAncestor !== (ancestor.status === 0)) {
    return failure('merge 来源谱系已偏离审批时状态，已阻止 merge', repo.repoRoot)
  }
  if (ancestor.status === 0) {
    return {
      ok: true,
      repoRoot: repo.repoRoot,
      currentBranch: current,
      mergedBranch: target,
      output: `Already up to date: ${sourceSha}`
    }
  }
  const mergeEnv = { ...identity.env, GIT_ATTR_SOURCE: preHead.text }
  const preflight = isolatedMergeTreePreflight(
    repo.repoRoot,
    identity.gitCommonDir,
    preHead.text,
    sourceSha,
    mergeEnv
  )
  if (preflight.ok === false) return preflight
  if (preflight.conflicted) {
    return failure(
      `merge 会产生冲突，已阻止实际合并: ${target}`,
      repo.repoRoot,
      preflight.details,
      preflight.conflictFiles
    )
  }
  const finalRef = isolatedGitText(repo.repoRoot, ['symbolic-ref', '--quiet', 'HEAD'], identity.env)
  const finalHead = isolatedGitText(repo.repoRoot, ['rev-parse', 'HEAD'], identity.env)
  const finalStatus = safeMergeWorktreeState(repo.repoRoot, identity.env)
  if (
    !finalRef.ok ||
    !finalHead.ok ||
    finalStatus.ok === false ||
    finalRef.text !== currentRef.text ||
    finalHead.text !== preHead.text ||
    !finalStatus.clean
  ) {
    return failure('merge 预检后目标分支或工作区已漂移，已阻止实际合并', repo.repoRoot)
  }
  if (executionPlan) {
    const finalIdentity = mergeRepositoryIdentity(repo.repoRoot)
    if (finalIdentity.ok === false) return finalIdentity
    const planIdentity = validateMergeExecutionIdentity(repo.repoRoot, finalIdentity, executionPlan)
    if (planIdentity.ok === false) return planIdentity
  }
  const commitEnvResult = mergeCommitEnv(
    repo.repoRoot,
    identity.gitCommonDir,
    identity.worktreeGitDir,
    mergeEnv
  )
  if (commitEnvResult.ok === false) return commitEnvResult
  const commitEnv = commitEnvResult.env

  const merge = runMergeWithCas(
    repo.repoRoot,
    current,
    currentRef.text,
    preHead.text,
    sourceSha,
    preflight.expectedTree,
    commitEnv
  )
  if (!merge.ok) {
    const conflictFiles = safeUnmergedFiles(repo.repoRoot, identity.env)
    const cleanup = restoreFailedMerge(repo.repoRoot, identity.worktreeGitDir, preHead.text, commitEnv)
    const output = clip([merge.error, merge.stdout, merge.stderr, cleanup.details].filter(Boolean).join('\n')).text
    return failure(
      conflictFiles.length > 0 ? `merge 会产生冲突，已中止并恢复: ${target}` : 'git merge 失败',
      repo.repoRoot,
      output,
      conflictFiles
    )
  }
  const observedCommit = isolatedGitText(repo.repoRoot, ['rev-list', '--parents', '-n', '1', 'HEAD'], identity.env)
  const observedTree = isolatedGitText(repo.repoRoot, ['rev-parse', 'HEAD^{tree}'], identity.env)
  const commitParts = observedCommit.ok ? observedCommit.text.split(/\s+/) : []
  if (
    commitParts.length !== 3 ||
    commitParts[1] !== preHead.text ||
    commitParts[2] !== sourceSha ||
    !observedTree.ok ||
    observedTree.text !== preflight.expectedTree
  ) {
    return failure('git merge 已返回成功，但 exact parents/tree 后置条件不匹配', repo.repoRoot)
  }

  return {
    ok: true,
    repoRoot: repo.repoRoot,
    currentBranch: current,
    mergedBranch: target,
    output: clip([merge.stdout, merge.stderr].filter(Boolean).join('\n')).text
  }
}

export function detectPullRequestRemote(cwd: string): PullRequestRemote | null {
  const remote = preferredRemote(cwd)
  if (!remote) return null
  const url = remoteUrl(cwd, remote)
  if (!url) return null
  const parsed = parseRemoteUrl(url)
  return { remote, url, provider: parsed.provider, owner: parsed.owner, repo: parsed.repo }
}

export function detectProviderFromRemoteUrl(url: string): PullRequestProvider {
  return parseRemoteUrl(url).provider
}

function resolveRepo(cwd: string): { ok: true; repoRoot: string } | GitFailure {
  if (typeof cwd !== 'string' || !cwd.trim()) return failure('cwd 不能为空')
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return failure('当前目录不是 Git 工作区', undefined, result.error)
  return { ok: true, repoRoot: resolve(result.stdout.trim()) }
}

function resolveStructuredReadRepo(cwd: string): { ok: true; repoRoot: string } | GitFailure {
  if (typeof cwd !== 'string' || !cwd.trim()) return failure('cwd 不能为空')
  const result = runIsolatedGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return failure('当前目录不是 Git 工作区', undefined, result.error)
  try {
    return { ok: true, repoRoot: realpathSync(resolve(result.stdout.trim())) }
  } catch (error) {
    return failure('Git 工作区身份无法确认', undefined, error instanceof Error ? error.message : String(error))
  }
}

function structuredReadEnvironment(repoRoot: string): { ok: true; env: NodeJS.ProcessEnv } | GitFailure {
  const env = isolatedLocalGitEnv(process.env)
  const config = runBoundGit(repoRoot, ['config', '--includes', '-z', '--list'], env)
  if (!config.ok) return failure('无法检查结构化 Git 读取配置', repoRoot, config.error)
  const unsafeFilters = unsafeMergeConfigKeys(config.stdout).filter((key) =>
    /^filter\..+\.(?:clean|smudge|process)$/i.test(key)
  )
  if (unsafeFilters.length > 0) {
    return failure(
      `仓库配置了可执行 Git filter，已阻止结构化读取: ${unsafeFilters.join(', ')}`,
      repoRoot
    )
  }
  return { ok: true, env }
}

function resolveMergeRepo(cwd: string): { ok: true; repoRoot: string } | GitFailure {
  if (typeof cwd !== 'string' || !cwd.trim()) return failure('cwd 不能为空')
  const result = runIsolatedGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return failure('当前目录不是 Git 工作区', undefined, result.error)
  try {
    return { ok: true, repoRoot: realpathSync(resolve(result.stdout.trim())) }
  } catch (error) {
    return failure('Git 工作区身份无法确认', undefined, error instanceof Error ? error.message : String(error))
  }
}

function isolatedGitText(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): { ok: true; text: string } | { ok: false; error: string } {
  const result = env ? runBoundGit(cwd, args, env) : runIsolatedGit(cwd, args)
  if (!result.ok) return { ok: false, error: result.error ?? `git ${args.join(' ')} 失败` }
  const text = result.stdout.trim()
  return text ? { ok: true, text } : { ok: false, error: `git ${args[0]} 未返回结果` }
}

function isUsableMergeBranchName(repoRoot: string, branch: string): boolean {
  if (!branch || branch === 'HEAD' || branch.includes('\0') || /\s/.test(branch)) return false
  const result = runIsolatedGit(repoRoot, ['check-ref-format', '--branch', branch])
  return result.ok
}

function resolveMergeSource(
  repoRoot: string,
  branch: string,
  env?: NodeJS.ProcessEnv
): { ok: true; ref: string; sha: string } | GitFailure {
  const sourceRef = isolatedGitText(repoRoot, ['rev-parse', '--symbolic-full-name', branch], env)
  if (!sourceRef.ok || !/^refs\/(?:heads|remotes)\//.test(sourceRef.text)) {
    return failure(
      `merge 来源必须唯一解析为本地或远端分支: ${branch}`,
      repoRoot,
      'error' in sourceRef ? sourceRef.error : sourceRef.text
    )
  }
  if (sourceRef.text.includes('\n')) {
    return failure(`merge 来源存在歧义: ${branch}`, repoRoot)
  }
  const sourceSha = isolatedGitText(repoRoot, ['rev-parse', '--verify', `${sourceRef.text}^{commit}`], env)
  if (!sourceSha.ok || !/^[0-9a-f]{40,64}$/i.test(sourceSha.text)) {
    return failure(
      `merge 来源不是可解析 commit: ${branch}`,
      repoRoot,
      'error' in sourceSha ? sourceSha.error : sourceSha.text
    )
  }
  return { ok: true, ref: sourceRef.text, sha: sourceSha.text }
}

function mergeInputMatchesSourceRef(input: string, sourceRef: string): boolean {
  if (input === sourceRef) return true
  if (sourceRef.startsWith('refs/heads/')) return input === sourceRef.slice('refs/heads/'.length)
  if (sourceRef.startsWith('refs/remotes/')) return input === sourceRef.slice('refs/remotes/'.length)
  return false
}

function safeMergeAttributePolicy(
  repoRoot: string,
  preHead: string,
  sourceSha: string,
  env: NodeJS.ProcessEnv
): { ok: true } | GitFailure {
  const prePaths = runBoundGit(repoRoot, ['ls-tree', '-r', '-z', '--name-only', preHead], env)
  const sourcePaths = runBoundGit(repoRoot, ['ls-tree', '-r', '-z', '--name-only', sourceSha], env)
  if (!prePaths.ok) return failure('无法枚举 merge 属性路径', repoRoot, prePaths.error)
  if (!sourcePaths.ok) return failure('无法枚举 merge 属性路径', repoRoot, sourcePaths.error)
  const paths = [...new Set([...prePaths.stdout.split('\0'), ...sourcePaths.stdout.split('\0')].filter(Boolean))]
  if (paths.length === 0) return { ok: true }
  const input = `${paths.join('\0')}\0`
  if (Buffer.byteLength(input, 'utf8') > MAX_BUFFER) {
    return failure('merge 属性检查输入超过安全上限', repoRoot)
  }
  const attributes = runBoundGit(
    repoRoot,
    ['check-attr', '--source', preHead, '-z', '--stdin', 'merge', 'filter'],
    env,
    { input }
  )
  if (!attributes.ok) return failure('无法检查 merge/filter 属性', repoRoot, attributes.error)
  const records = attributes.stdout.split('\0')
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
  return unsafe.size > 0
    ? failure(
        `仓库使用命令可扩展的 merge/filter 属性，当前安全模式不支持: ${[...unsafe].sort().join(', ')}`,
        repoRoot
      )
    : { ok: true }
}

function mergeUnsafeConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv
): { ok: true; keys: string[] } | GitFailure {
  const result = runBoundGit(repoRoot, ['config', '--includes', '-z', '--list'], env)
  if (!result.ok) return failure('无法检查 merge 安全配置', repoRoot, result.error)
  return { ok: true, keys: unsafeMergeConfigKeys(result.stdout) }
}

function mergeRepositoryIdentity(
  repoRoot: string
): MergeRepositoryIdentity | GitFailure {
  const common = isolatedGitText(repoRoot, ['rev-parse', '--git-common-dir'])
  const worktree = isolatedGitText(repoRoot, ['rev-parse', '--git-dir'])
  if (!common.ok || !worktree.ok) {
    const details = 'error' in common ? common.error : 'error' in worktree ? worktree.error : 'unknown'
    return failure('无法确认 Git 元数据目录身份', repoRoot, details)
  }
  try {
    const gitCommonDir = realpathSync(isAbsolute(common.text) ? common.text : resolve(repoRoot, common.text))
    const worktreeGitDir = realpathSync(isAbsolute(worktree.text) ? worktree.text : resolve(repoRoot, worktree.text))
    return {
      gitCommonDir,
      worktreeGitDir,
      repoRootIdentity: fileSystemIdentity(repoRoot),
      gitCommonDirIdentity: fileSystemIdentity(gitCommonDir),
      worktreeGitDirIdentity: fileSystemIdentity(worktreeGitDir),
      env: mergeExecutionEnv(repoRoot, gitCommonDir, worktreeGitDir),
      ok: true
    }
  } catch (error) {
    return failure('Git 元数据目录身份无法确认', repoRoot, error instanceof Error ? error.message : String(error))
  }
}

function fileSystemIdentity(path: string): FileSystemIdentity {
  const stats = statSync(path, { bigint: true })
  return { device: stats.dev.toString(), inode: stats.ino.toString() }
}

function sameFileSystemIdentity(left: FileSystemIdentity, right?: FileSystemIdentity): boolean {
  return Boolean(right) && left.device === right?.device && left.inode === right?.inode
}

function validateMergeExecutionIdentity(
  repoRoot: string,
  identity: MergeRepositoryIdentity,
  executionPlan: GitMergeExecutionPlan
): { ok: true } | GitFailure {
  if (
    repoRoot !== executionPlan.repoRoot ||
    identity.gitCommonDir !== executionPlan.gitCommonDir ||
    identity.worktreeGitDir !== executionPlan.worktreeGitDir ||
    !sameFileSystemIdentity(identity.repoRootIdentity, executionPlan.repoRootIdentity) ||
    !sameFileSystemIdentity(identity.gitCommonDirIdentity, executionPlan.gitCommonDirIdentity) ||
    !sameFileSystemIdentity(identity.worktreeGitDirIdentity, executionPlan.worktreeGitDirIdentity)
  ) {
    return failure('Git 仓库或元数据目录身份已偏离审批时状态，已阻止 merge', repoRoot)
  }
  return { ok: true }
}

function mergeExecutionEnv(
  repoRoot: string,
  gitCommonDir: string,
  worktreeGitDir: string
): NodeJS.ProcessEnv {
  const env = isolatedLocalGitEnv(process.env)
  env.GIT_COMMON_DIR = gitCommonDir
  env.GIT_DIR = worktreeGitDir
  env.GIT_WORK_TREE = repoRoot
  return env
}

function mergeCommitEnv(
  repoRoot: string,
  gitCommonDir: string,
  worktreeGitDir: string,
  baseEnv: NodeJS.ProcessEnv
): { ok: true; env: NodeJS.ProcessEnv } | GitFailure {
  const identityEnv = isolatedLocalGitEnv(process.env)
  delete identityEnv.GIT_CONFIG_GLOBAL
  identityEnv.GIT_COMMON_DIR = gitCommonDir
  identityEnv.GIT_DIR = worktreeGitDir
  identityEnv.GIT_WORK_TREE = repoRoot
  const configuredName = isolatedGitText(repoRoot, ['config', '--get', 'user.name'], identityEnv)
  const configuredEmail = isolatedGitText(repoRoot, ['config', '--get', 'user.email'], identityEnv)
  if (!configuredName.ok || !configuredEmail.ok) {
    return failure('git_merge 需要显式配置 Git user.name 和 user.email，禁止使用系统自动推断身份', repoRoot)
  }
  const env = { ...baseEnv }
  env.GIT_AUTHOR_NAME = configuredName.text
  env.GIT_COMMITTER_NAME = configuredName.text
  env.GIT_AUTHOR_EMAIL = configuredEmail.text
  env.GIT_COMMITTER_EMAIL = configuredEmail.text
  return { ok: true, env }
}

function safeMergeWorktreeState(
  repoRoot: string,
  env: NodeJS.ProcessEnv
): { ok: true; clean: boolean; reason: string } | GitFailure {
  const staged = runBoundGit(repoRoot, ['diff-index', '--cached', '--quiet', 'HEAD', '--'], env, {
    allowExitCodes: [0, 1]
  })
  const worktree = runBoundGit(
    repoRoot,
    ['status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=dirty', '--'],
    env
  )
  const untracked = runBoundGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'], env)
  const unmerged = runBoundGit(repoRoot, ['ls-files', '--unmerged', '-z'], env)
  const hiddenIndex = runBoundGit(repoRoot, ['ls-files', '-v', '-z', '--full-name'], env)
  for (const probe of [staged, worktree, untracked, unmerged, hiddenIndex]) {
    if (!probe.ok) return failure('无法确认 merge 前工作区状态', repoRoot, probe.error)
  }
  const hiddenIndexPaths = indexVisibilityFlagPaths(hiddenIndex.stdout)
  const reasons: string[] = []
  if (staged.status === 1) reasons.push('staged changes')
  if (hasMeaningfulWorktreeChanges(worktree.stdout)) reasons.push('worktree changes')
  if (!worktree.ok || !untracked.ok) return failure('无法确认 merge 前工作区状态', repoRoot, worktree.error || untracked.error)
  if (unmerged.stdout.length > 0) reasons.push('unmerged index entries')
  if (hiddenIndexPaths.length > 0) {
    reasons.push(`assume-unchanged paths: ${hiddenIndexPaths.slice(0, 8).join(', ')}`)
  }
  return { ok: true, clean: reasons.length === 0, reason: reasons.join(', ') || 'clean' }
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

function safeUnmergedFiles(repoRoot: string, env: NodeJS.ProcessEnv): string[] {
  const result = runBoundGit(repoRoot, ['ls-files', '--unmerged', '-z'], env)
  if (!result.ok) return []
  const files = new Set<string>()
  for (const record of result.stdout.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab >= 0 && record.slice(tab + 1)) files.add(record.slice(tab + 1))
  }
  return [...files].sort()
}

function runMergeWithCas(
  repoRoot: string,
  currentBranch: string,
  destinationRef: string,
  preHead: string,
  sourceSha: string,
  expectedTree: string,
  baseEnv: NodeJS.ProcessEnv
): GitRunResult {
  const hooksDir = mkdtempSync(join(tmpdir(), `caogen-merge-hooks-${process.pid}-`))
  try {
    const hookPath = join(hooksDir, 'reference-transaction')
    writeFileSync(
      hookPath,
      [
        '#!/bin/sh',
        '[ "$1" = "prepared" ] || exit 0',
        'while read old_value new_value ref_name',
        'do',
        '  if [ "$ref_name" = "$CAOGEN_EXPECTED_REF" ]',
        '  then',
        '    if [ "$old_value" != "$CAOGEN_EXPECTED_HEAD" ]',
        '    then',
        '      echo "destination ref changed after approval" >&2',
        '      exit 1',
        '    fi',
        '    commit_payload=$(git cat-file commit "$new_value") || {',
        '      echo "destination merge commit cannot be inspected" >&2',
        '      exit 1',
        '    }',
        '    tree_value=',
        '    parent_count=0',
        '    parent_one=',
        '    parent_two=',
        '    while IFS=" " read -r header value remainder',
        '    do',
        '      [ -n "$header" ] || break',
        '      case "$header" in',
        '        tree) tree_value="$value" ;;',
        '        parent)',
        '          parent_count=$((parent_count + 1))',
        '          [ "$parent_count" -ne 1 ] || parent_one="$value"',
        '          [ "$parent_count" -ne 2 ] || parent_two="$value"',
        '          ;;',
        '      esac',
        '    done <<CAOGEN_COMMIT',
        '$commit_payload',
        'CAOGEN_COMMIT',
        '    if [ "$parent_count" -ne 2 ] ||',
        '       [ "$parent_one" != "$CAOGEN_EXPECTED_HEAD" ] ||',
        '       [ "$parent_two" != "$CAOGEN_EXPECTED_SOURCE" ] ||',
        '       [ "$tree_value" != "$CAOGEN_EXPECTED_TREE" ]',
        '    then',
        '      echo "destination merge commit does not match approved parents/tree" >&2',
        '      exit 1',
        '    fi',
        '  fi',
        'done',
        'exit 0',
        ''
      ].join('\n'),
      { encoding: 'utf8', mode: 0o700 }
    )
    chmodSync(hookPath, 0o700)
    return runSafeMergeGit(
      repoRoot,
      [
        '-c',
        `branch.${currentBranch}.mergeOptions=`,
        'merge',
        '--no-verify',
        '--no-gpg-sign',
        '--no-ff',
        '--no-edit',
        '-X',
        'find-renames=50%',
        '--',
        sourceSha
      ],
      {
        ...baseEnv,
        CAOGEN_EXPECTED_REF: destinationRef,
        CAOGEN_EXPECTED_HEAD: preHead,
        CAOGEN_EXPECTED_SOURCE: sourceSha,
        CAOGEN_EXPECTED_TREE: expectedTree
      },
      {},
      hooksDir
    )
  } finally {
    rmSync(hooksDir, { recursive: true, force: true })
  }
}

function isolatedMergeTreePreflight(
  repoRoot: string,
  gitCommonDir: string,
  preHead: string,
  sourceSha: string,
  baseEnv: NodeJS.ProcessEnv
): { ok: true; conflicted: boolean; conflictFiles: string[]; expectedTree: string; details: string } | GitFailure {
  let objectDir: string
  try {
    objectDir = mkdtempSync(join(tmpdir(), 'caogen-merge-tree-objects-'))
  } catch (error) {
    return failure('无法创建隔离的 merge 预检对象目录', repoRoot, error instanceof Error ? error.message : String(error))
  }
  try {
    const env = {
      ...baseEnv,
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: gitAlternateObjectDirectories([join(gitCommonDir, 'objects')])
    }
    const result = runSafeMergeGit(
      repoRoot,
      [
        'merge-tree',
        '--write-tree',
        '--messages',
        '--name-only',
        '-z',
        '-X',
        'find-renames=50%',
        preHead,
        sourceSha
      ],
      env,
      { allowExitCodes: [0, 1] }
    )
    if (!result.ok) return failure('隔离 merge 冲突预检无法执行', repoRoot, result.error)
    const records = result.stdout.split('\0')
    const expectedTree = records[0]?.trim()
    if (!expectedTree || !/^[0-9a-f]{40,64}$/i.test(expectedTree)) {
      return failure('隔离 merge 冲突预检未返回 expected tree', repoRoot)
    }
    const separator = records.indexOf('', 1)
    const conflictFiles = result.status === 1
      ? records.slice(1, separator >= 0 ? separator : records.length).filter(Boolean).sort()
      : []
    const collisions = ignoredMergeCollisions(repoRoot, preHead, expectedTree, env)
    if (collisions.ok === false) return collisions
    if (collisions.paths.length > 0) {
      return failure(
        `merge 新增路径受 ignore 规则覆盖或已存在本地冲突，已阻止实际合并: ${collisions.paths.join(', ')}`,
        repoRoot
      )
    }
    return {
      ok: true,
      conflicted: result.status === 1,
      conflictFiles,
      expectedTree,
      details: clip([result.stdout.replace(/\0/g, '\n'), result.stderr].filter(Boolean).join('\n')).text
    }
  } finally {
    rmSync(objectDir, { recursive: true, force: true })
  }
}

function ignoredMergeCollisions(
  repoRoot: string,
  preHead: string,
  expectedTree: string,
  mergeEnv: NodeJS.ProcessEnv
): { ok: true; paths: string[] } | GitFailure {
  const added = runSafeMergeGit(
    repoRoot,
    ['diff-tree', '-r', '--no-renames', '--name-only', '--diff-filter=A', '-z', preHead, expectedTree],
    mergeEnv
  )
  if (!added.ok) return failure('无法检查 merge 新增路径', repoRoot, added.error)
  const addedPaths = added.stdout.split('\0').filter(Boolean)
  if (addedPaths.length === 0) return { ok: true, paths: [] }
  const input = `${addedPaths.join('\0')}\0`
  if (Buffer.byteLength(input, 'utf8') > MAX_BUFFER) {
    return failure('merge 新增路径检查输入超过安全上限', repoRoot)
  }
  const ignored = runSafeMergeGit(
    repoRoot,
    ['check-ignore', '--no-index', '-z', '--stdin'],
    mergeEnv,
    { allowExitCodes: [0, 1], input }
  )
  if (!ignored.ok) return failure('无法检查 merge 新增路径的 ignore 规则', repoRoot, ignored.error)
  const collisions = new Set(ignored.stdout.split('\0').filter(Boolean))
  try {
    for (const addedPath of addedPaths) {
      if (mergeAddedPathAlreadyExists(repoRoot, addedPath)) collisions.add(addedPath)
    }
  } catch (error) {
    return failure(
      '无法检查 merge 新增路径的本地文件系统冲突',
      repoRoot,
      error instanceof Error ? error.message : String(error)
    )
  }
  return { ok: true, paths: [...collisions].sort() }
}

function mergeAddedPathAlreadyExists(repoRoot: string, repoPath: string): boolean {
  const segments = repoPath.split('/')
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`非法 merge tree 路径: ${repoPath}`)
  }
  let currentPath = repoRoot
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = join(currentPath, segments[index])
    try {
      const stats = lstatSync(currentPath)
      if (index === segments.length - 1 || !stats.isDirectory()) return true
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'ENOENT') return false
      if (code === 'ENOTDIR' || code === 'ELOOP') return true
      throw error
    }
  }
  return false
}

function restoreFailedMerge(
  repoRoot: string,
  worktreeGitDir: string,
  preHead: string,
  env: NodeJS.ProcessEnv
): { restored: boolean; details: string } {
  const details: string[] = []
  if (mergeOperationState(worktreeGitDir).includes('MERGE_HEAD')) {
    const abort = runSafeMergeGit(repoRoot, ['merge', '--abort'], env)
    if (!abort.ok) details.push(`git merge --abort failed: ${abort.error}`)
  }
  const head = isolatedGitText(repoRoot, ['rev-parse', 'HEAD'], env)
  const state = safeMergeWorktreeState(repoRoot, env)
  const operationState = mergeOperationState(worktreeGitDir)
  const restored =
    head.ok &&
    head.text === preHead &&
    state.ok &&
    state.clean &&
    operationState.length === 0
  if (!restored) {
    details.push(
      `merge cleanup incomplete: head=${'error' in head ? head.error : head.text}; ` +
      `worktree=${'error' in state ? state.error : state.reason}; state=${operationState.join(', ') || 'none'}`
    )
  }
  return { restored, details: details.join('\n') }
}

function mergeOperationState(worktreeGitDir: string): string[] {
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

function createTrustedEmptyHooksDir(): string {
  const dir = join(tmpdir(), `caogen-empty-git-hooks-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function runGit(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {}
): GitRunResult {
  return runCommand('git', withSafeLocalGitConfig(args), cwd, undefined, options)
}

function runIsolatedGit(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {}
): GitRunResult {
  return runCommand(
    'git',
    withSafeLocalGitConfig(args),
    cwd,
    isolatedLocalGitEnv(process.env),
    { ...options, replaceEnv: true }
  )
}

function runBoundGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: GitCommandOptions = {}
): GitRunResult {
  return runCommand(
    'git',
    withSafeLocalGitConfig(args),
    cwd,
    env,
    { ...options, replaceEnv: true }
  )
}

function runSafeMergeGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: GitCommandOptions = {},
  hooksPath = TRUSTED_EMPTY_HOOKS_DIR
): GitRunResult {
  return runCommand(
    'git',
    withSafeMergeGitConfig(args, hooksPath),
    cwd,
    env,
    { ...options, replaceEnv: true }
  )
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
  options: GitCommandOptions = {}
): GitRunResult {
  const allowed = options.allowExitCodes ?? [0]
  const env = options.replaceEnv
    ? { ...(extraEnv ?? {}) }
    : buildMinimalSubprocessEnv(extraEnv ?? {})
  const result = spawnSync(command, args, {
    cwd,
    input: options.input,
    encoding: 'utf8',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const status = result.status

  if (result.error) {
    return { ok: false, stdout, stderr, status, error: result.error.message }
  }
  if (status === null || !allowed.includes(status)) {
    return { ok: false, stdout, stderr, status, error: commandError(command, args, status, stdout, stderr) }
  }
  return { ok: true, stdout, stderr, status }
}

function gitText(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): { ok: true; text: string } | { ok: false; error: string } {
  const result = env ? runBoundGit(cwd, args, env) : runGit(cwd, args)
  if (!result.ok) return { ok: false, error: result.error ?? `git ${args.join(' ')} 失败` }
  return { ok: true, text: result.stdout.trim() }
}

function commandError(command: string, args: string[], status: number | null, stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).slice(0, MAX_OUTPUT_CHARS)
  const code = status === null ? 'timeout' : String(status)
  return output ? `${command} ${args.join(' ')} failed (${code}): ${output}` : `${command} ${args.join(' ')} failed (${code})`
}

function readBranchInfo(repoRoot: string, env?: NodeJS.ProcessEnv): BranchInfo {
  const branch = gitText(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], env)
  const fallback = gitText(repoRoot, ['rev-parse', '--short', 'HEAD'], env)
  const upstream = gitText(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], env)
  const counts = upstream.ok
    ? gitText(repoRoot, ['rev-list', '--left-right', '--count', `${upstream.text}...HEAD`], env)
    : undefined
  const [behindRaw, aheadRaw] = counts?.ok ? counts.text.split(/\s+/) : ['0', '0']
  return {
    branch: branch.ok && branch.text ? branch.text : fallback.ok ? fallback.text : '',
    upstream: upstream.ok ? upstream.text : undefined,
    ahead: Number(aheadRaw) || 0,
    behind: Number(behindRaw) || 0
  }
}

function parsePorcelainStatus(output: string): GitStatusFile[] {
  const records = output.split('\0').filter(Boolean)
  const files: GitStatusFile[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    let oldPath: string | undefined
    if (indexStatus === 'R' || indexStatus === 'C') {
      oldPath = records[index + 1]
      index += 1
    }
    const code = `${indexStatus}${worktreeStatus}`
    const conflicted = CONFLICT_CODES.has(code) || indexStatus === 'U' || worktreeStatus === 'U'
    const untracked = code === '??'
    files.push({
      path,
      oldPath,
      indexStatus,
      worktreeStatus,
      kind: statusKind(indexStatus, worktreeStatus, conflicted),
      staged: !conflicted && indexStatus !== ' ' && indexStatus !== '?',
      unstaged: !conflicted && worktreeStatus !== ' ',
      untracked,
      conflicted
    })
  }
  return files
}

function statusKind(
  indexStatus: string,
  worktreeStatus: string,
  conflicted: boolean
): GitStatusFile['kind'] {
  if (conflicted) return 'conflicted'
  const code = `${indexStatus}${worktreeStatus}`
  if (code.includes('?')) return 'untracked'
  if (code.includes('R')) return 'renamed'
  if (code.includes('C')) return 'copied'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('M')) return 'modified'
  return 'unknown'
}

function normalizeRepoPath(repoRoot: string, rawPath: string): ({ ok: true } & NormalizedFilePath) | GitFailure {
  const raw = rawPath.trim()
  if (!raw || raw.includes('\0')) return failure('file 参数不能为空或包含非法字符', repoRoot)
  const target = isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw)
  const rel = relative(repoRoot, target).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return failure(`file 超出 Git 仓库范围: ${rawPath}`, repoRoot)
  }
  return { ok: true, absolute: target, relative: rel }
}

function untrackedFiles(repoRoot: string, env?: NodeJS.ProcessEnv): string[] {
  const result = env
    ? runBoundGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'], env)
    : runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'])
  if (!result.ok) return []
  return result.stdout.split('\0').filter(Boolean)
}

function hasStagedChanges(repoRoot: string): boolean {
  const result = runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--quiet', '--exit-code'], {
    allowExitCodes: [0, 1]
  })
  return result.status === 1
}

function preferredRemote(repoRoot: string): string | null {
  const remotes = runGit(repoRoot, ['remote'])
  if (!remotes.ok) return null
  const names = remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (names.includes('origin')) return 'origin'
  return names[0] ?? null
}

function remoteUrl(repoRoot: string, remote: string): string | null {
  const result = gitText(repoRoot, ['remote', 'get-url', remote])
  return result.ok ? result.text : null
}

function parseRemoteUrl(url: string): { provider: PullRequestProvider; owner?: string; repo?: string } {
  const normalized = url.trim()
  const host = remoteHost(normalized)
  const pathParts = remotePath(normalized).replace(/\.git$/i, '').split('/').filter(Boolean)
  const provider = providerFromHost(host)
  return {
    provider,
    owner: pathParts.length >= 2 ? pathParts[pathParts.length - 2] : undefined,
    repo: pathParts.length >= 1 ? pathParts[pathParts.length - 1] : undefined
  }
}

function remoteHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    const scp = /^[^@]+@([^:]+):/.exec(url)
    if (scp) return scp[1].toLowerCase()
    return ''
  }
}

function remotePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    const scp = /^[^@]+@[^:]+:(.+)$/.exec(url)
    if (scp) return scp[1]
    const slash = url.indexOf('/')
    return slash >= 0 ? url.slice(slash) : ''
  }
}

function providerFromHost(host: string): PullRequestProvider {
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab'
  if (host === 'gitee.com' || host.endsWith('.gitee.com')) return 'gitee'
  return 'unknown'
}

function prToolForProvider(provider: PullRequestProvider): PullRequestTool | null {
  if (provider === 'github') return 'gh'
  if (provider === 'gitlab') return 'glab'
  return null
}

function commandExists(command: string, cwd: string): boolean {
  if (parseWslHostPath(cwd)) {
    try {
      return spawnSync(command, ['--version'], { cwd, env: buildMinimalSubprocessEnv(), stdio: 'ignore', timeout: GIT_TIMEOUT_MS }).status === 0
    } catch { return false }
  }
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(probe, [command], {
    env: buildMinimalSubprocessEnv(),
    stdio: 'ignore',
    timeout: GIT_TIMEOUT_MS
  })
  return result.status === 0
}

function hasRemoteBranch(repoRoot: string, remote: string, branch: string): boolean {
  const result = runGit(repoRoot, ['ls-remote', '--exit-code', '--heads', remote, branch], { allowExitCodes: [0, 2] })
  return result.status === 0
}

function defaultBaseBranch(repoRoot: string, remote: string): string | null {
  const ref = gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  if (ref.ok) {
    const prefix = `${remote}/`
    return ref.text.startsWith(prefix) ? ref.text.slice(prefix.length) : ref.text
  }
  for (const candidate of ['main', 'master', 'develop']) {
    if (hasRemoteBranch(repoRoot, remote, candidate)) return candidate
  }
  return null
}

function isUsableBranchName(repoRoot: string, branch: string): boolean {
  if (!branch || branch === 'HEAD' || branch.includes('\0') || /\s/.test(branch)) return false
  const result = runGit(repoRoot, ['check-ref-format', '--branch', branch])
  return result.ok
}

function gitlabHostFromUrl(url: string): string | null {
  const host = remoteHost(url)
  return host && host !== 'gitlab.com' ? host : null
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/\S+/i.exec(text)
  return match ? match[0].replace(/[),.;]+$/, '') : null
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[已截断，共 ${text.length} 字符]`, truncated: true }
}

function failure(
  error: string,
  repoRoot?: string,
  details?: string,
  conflictFiles?: string[],
  checks?: GitCommitCheckResult[]
): GitFailure {
  const result: GitFailure = { ok: false, error }
  if (repoRoot) result.repoRoot = repoRoot
  if (details) result.details = details
  if (conflictFiles && conflictFiles.length > 0) result.conflictFiles = conflictFiles
  if (checks) result.checks = checks
  return result
}

// 保留给后续扩展：PR/merge 前可用它判断路径是否仍存在于仓库内。
export function pathExistsInsideRepo(repoRoot: string, rawPath: string): boolean {
  const normalized = normalizeRepoPath(repoRoot, rawPath)
  if (normalized.ok === false) return false
  const parent = dirname(normalized.absolute)
  return existsSync(normalized.absolute) || (existsSync(parent) && statSync(parent).isDirectory())
}
