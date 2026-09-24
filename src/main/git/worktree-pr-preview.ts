import { execFileSyncInExecutionEnvironment as execFileSync } from '../wsl/process'
import { realpathSync, statSync } from 'node:fs'
import { assertTaskExecutionEnvironment } from '../wsl/binding'
import { resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { WorktreePullRequestSnapshot } from '../../shared/worktree-pr-draft-types'
import { inspectManagedWorktreeIdentity, type ManagedWorktreeRecord } from '../managed-worktree-lifecycle'
import { stableValueDigest } from '../task/tool-idempotency'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './safe-git'

const MAX_OUTPUT = 16 * 1024 * 1024
const PREVIEW_CHARS = 240_000
export function inspectWorktreePullRequestSnapshot(meta: SessionMeta, record: ManagedWorktreeRecord, requestedBase?: string): WorktreePullRequestSnapshot {
  assertTaskExecutionEnvironment(meta)
  if (meta.id !== record.sessionId || record.state !== 'active' || !meta.isolated ||
      realpathSync(meta.cwd) !== realpathSync(record.cwd) || meta.workspaceHandoffPending) throw new Error('当前任务与受管 Worktree 归属不一致；请完成交接后重新准备')
  const checked = inspectManagedWorktreeIdentity(record)
  if (!checked.ok) throw new Error('error' in checked ? checked.error : 'Worktree 身份无法核对')
  const cwd = realpathSync(record.worktreePath), repoRoot = realpathSync(record.repoRoot)
  const commonDir = realpathSync(resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim()))
  const headSha = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const branch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
  if (branch !== record.branch) throw new Error('Worktree 分支已变化')
  const remotes = git(cwd, ['remote']).trim().split(/\r?\n/).filter(Boolean)
  const remoteName = remotes.includes('origin') ? 'origin' : remotes[0]
  let remote: WorktreePullRequestSnapshot['remote']
  if (remoteName) {
    const urls = git(cwd, ['remote', 'get-url', '--all', remoteName]).trim().split(/\r?\n/).filter(Boolean)
    const pushUrls = git(cwd, ['remote', 'get-url', '--push', '--all', remoteName]).trim().split(/\r?\n/).filter(Boolean)
    if (urls.length !== 1 || pushUrls.length !== 1) throw new Error('当前准备页需要唯一读取和推送 remote URL')
    const safeUrl = sanitizePrRemoteUrl(urls[0]), safePush = sanitizePrRemoteUrl(pushUrls[0])
    remote = { name: remoteName, ...remoteLabel(safeUrl), urlDigest: stableValueDigest(safeUrl), pushUrlDigest: stableValueDigest(safePush) }
  }
  const branches = git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', ...(remoteName ? [`refs/remotes/${remoteName}`] : [])])
    .split(/\r?\n/).filter(ref => ref && !ref.endsWith('/HEAD')).slice(0, 300).map(ref => ({ ref,
      name: ref.startsWith('refs/heads/') ? ref.slice(11) : ref.slice(`refs/remotes/${remoteName}/`.length),
      source: ref.startsWith('refs/heads/') ? 'local' as const : 'cached_remote' as const }))
  const baseBranch = (requestedBase ?? record.baseBranch ?? '').trim()
  if (baseBranch) assertPrBranch(cwd, baseBranch)
  const baseRef = (branches.find(item => item.name === baseBranch && item.source === 'cached_remote') ??
    branches.find(item => item.name === baseBranch && item.source === 'local'))?.ref
  let baseSha: string | undefined, mergeBaseSha: string | undefined, baseUnavailable: string | undefined
  if (!baseBranch) baseUnavailable = '请选择目标分支'
  else if (baseBranch === branch) baseUnavailable = '目标分支不能与当前分支相同'
  else if (!baseRef) baseUnavailable = '目标分支没有本地引用；可先保存草稿，取得该分支后刷新比较'
  else {
    baseSha = git(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim()
    try { mergeBaseSha = git(cwd, ['merge-base', baseSha, headSha]).trim() }
    catch { baseUnavailable = '当前 HEAD 与目标分支没有可核对的共同基线' }
  }
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])
  const entries = parseDirty(status)
  const dirty = { ...entries, digest: stableValueDigest(status) }
  let diff = '', commitCount = 0, commits: WorktreePullRequestSnapshot['commits'] = [], files: WorktreePullRequestSnapshot['files'] = []
  if (mergeBaseSha && baseSha) {
    const range = `${baseSha}..${headSha}`
    commitCount = Number(git(cwd, ['rev-list', '--count', range]).trim())
    if (!Number.isSafeInteger(commitCount) || commitCount < 0) throw new Error('提交计数无法核对')
    const log = git(cwd, ['log', '--format=%H%x00%s%x00', '--max-count=101', range, '--']).split('\0')
    for (let index = 0; index + 1 < log.length; index += 2) {
      const sha = log[index].trim()
      if (sha) commits.push({ sha, subject: log[index + 1] })
    }
    diff = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', mergeBaseSha, headSha, '--'])
    const numstat = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--numstat', '-z', mergeBaseSha, headSha, '--'])
    files = numstat.split('\0').filter(Boolean).map(line => {
      const split = line.indexOf('\t'), second = line.indexOf('\t', split + 1)
      if (split < 0 || second < 0) throw new Error('差异文件统计格式无法核对')
      return { path: line.slice(second + 1), added: line.slice(0, split) === '-' ? null : Number(line.slice(0, split)),
        removed: line.slice(split + 1, second) === '-' ? null : Number(line.slice(split + 1, second)) }
    })
  }
  const binding = { sessionId: meta.id, sessionCreatedAt: meta.createdAt,
    ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}), ...(meta.goalId ? { goalId: meta.goalId } : {}),
    ...(meta.workItemId ? { workItemId: meta.workItemId } : {}), ...(meta.projectId ? { projectId: meta.projectId } : {}), repoRoot, worktreePath: cwd,
    commonDir, repoIdentity: identity(repoRoot), worktreeIdentity: identity(cwd), commonDirIdentity: identity(commonDir),
    registryDigest: stableValueDigest(record), branch }
  // A concurrent checkout/commit must never mix file statistics from different HEADs.
  if (git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== headSha ||
      git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() !== branch ||
      (baseRef && baseSha && git(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim() !== baseSha) ||
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']) !== status) throw new Error('仓库在读取差异时发生变化，请刷新')
  const diffDigest = stableValueDigest(diff)
  const digest = stableValueDigest({ binding, headSha, managedBaseSha: record.baseSha, baseBranch, baseRef, baseSha, mergeBaseSha,
    remote, commitCount, diffDigest, dirty })
  return { schemaVersion: 1, digest, capturedAt: Date.now(), binding, headSha, managedBaseSha: record.baseSha,
    baseBranch, baseRef, baseSha, mergeBaseSha, baseUnavailable, branches, remote, commits: commits.slice(0, 100), commitCount,
    commitsTruncated: commitCount > 100, diff: diff.slice(0, PREVIEW_CHARS), diffDigest, diffBytes: Buffer.byteLength(diff),
    diffTruncated: diff.length > PREVIEW_CHARS, files: files.slice(0, 500), filesTruncated: files.length > 500, dirty }
}
export function assertPrBranch(cwd: string, value: string): void {
  if (!value || value.length > 255 || value.startsWith('-') || value.startsWith('refs/') || /[\0\r\n]/.test(value)) throw new Error('目标分支名无效')
  git(cwd, ['check-ref-format', '--branch', value])
}
export function sanitizePrRemoteUrl(value: string): string {
  const trimmed = value.trim()
  try { const url = new URL(trimmed); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString() }
  catch { return trimmed.replace(/^[^@\s]+@/, '') }
}
function remoteLabel(value: string): { host?: string; projectPath?: string } {
  try { const url = new URL(value); return { host: url.hostname, projectPath: url.pathname.replace(/^\/+|\.git$|\/+$/g, '') } }
  catch { const match = /^([^:\s/]+):(.+)$/.exec(value); return match ? { host: match[1], projectPath: match[2].replace(/\.git$/, '') } : {} }
}
function identity(path: string) { const stat = statSync(path, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino) } }
function parseDirty(status: string) {
  const result = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, records = status.split('\0')
  for (let index = 0; index < records.length; index++) {
    const line = records[index]; if (!line) continue
    const xy = line.slice(0, 2)
    if (xy === '??') result.untracked++
    else {
      if (xy[0] !== ' ') result.staged++
      if (xy[1] !== ' ') result.unstaged++
      if (xy.includes('U') || xy === 'AA' || xy === 'DD') result.conflicted++
      if (xy.includes('R') || xy.includes('C')) index++
    }
  }
  return result
}
function git(cwd: string, args: string[]): string {
  try { return execFileSync('git', withSafeLocalGitConfig(['-c', 'protocol.allow=never', '-c', 'core.pager=cat', '-C', cwd, ...args]), {
    encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_OUTPUT, windowsHide: true,
    env: { ...isolatedLocalGitEnv(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch { throw new Error(`本地 Git ${args[0]} 无法完成；请检查仓库状态或缩小差异范围`) }
}
