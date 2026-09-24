import { execFileSyncInExecutionEnvironment as execFileSync } from './wsl/process'
import type { GitCommitResult, GitFileStatus, GitOperationResult, GitStatus } from '../shared/types'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './git/safe-git'

const GIT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 2 * 1024 * 1024

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', withSafeLocalGitConfig(args), {
    cwd,
    encoding: 'utf8',
    env: isolatedLocalGitEnv(process.env),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { stderr?: Buffer | string; message?: string }
    if (record.stderr) {
      const stderr = Buffer.isBuffer(record.stderr) ? record.stderr.toString('utf8') : record.stderr
      const trimmed = stderr.trim()
      if (trimmed) return trimmed
    }
    if (record.message) return record.message
  }
  return String(error)
}

function safePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  return paths
    .filter((path): path is string => typeof path === 'string')
    .map((path) => path.trim())
    .filter((path) => path.length > 0 && !path.includes('\0'))
}

export function currentBranch(cwd: string): string {
  // symbolic-ref 在"未出生 HEAD"(全新仓库尚无提交)时仍能返回分支名,
  // 而 rev-parse --abbrev-ref HEAD 此时会 fatal 报错、导致分支徽章空白。
  try {
    const viaSymbolic = runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).trim()
    if (viaSymbolic) return viaSymbolic
  } catch {
    // 分离头指针(detached HEAD)没有符号引用,回退到下面的短 SHA
  }
  try {
    return runGit(cwd, ['rev-parse', '--short', 'HEAD']).trim()
  } catch {
    return ''
  }
}

function statusKind(indexStatus: string, worktreeStatus: string): GitFileStatus['kind'] {
  const code = `${indexStatus}${worktreeStatus}`
  if (code.includes('?')) return 'untracked'
  if (code.includes('R')) return 'renamed'
  if (code.includes('C')) return 'copied'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('M')) return 'modified'
  return 'unknown'
}

function parseStatus(output: string): GitFileStatus[] {
  const records = output.split('\0').filter(Boolean)
  const files: GitFileStatus[] = []

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record.length < 4) continue
    const indexStatus = record[0]
    const worktreeStatus = record[1]
    const path = record.slice(3)
    let oldPath: string | undefined
    if (indexStatus === 'R' || indexStatus === 'C') {
      oldPath = records[i + 1]
      i += 1
    }
    const staged = indexStatus !== ' ' && indexStatus !== '?'
    const unstaged = worktreeStatus !== ' '
    const untracked = indexStatus === '?' && worktreeStatus === '?'
    files.push({
      path,
      oldPath,
      indexStatus,
      worktreeStatus,
      staged,
      unstaged,
      untracked,
      kind: statusKind(indexStatus, worktreeStatus)
    })
  }

  return files
}

export function gitStatus(cwd: string): GitStatus {
  try {
    const output = runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const files = parseStatus(output)
    return {
      ok: true,
      cwd,
      branch: currentBranch(cwd),
      files,
      staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => file.unstaged && !file.untracked).length,
      untracked: files.filter((file) => file.untracked).length
    }
  } catch (error) {
    return { ok: false, cwd, branch: '', files: [], staged: 0, unstaged: 0, untracked: 0, error: errorMessage(error) }
  }
}

export function stageFiles(cwd: string, paths: unknown): GitOperationResult {
  const safe = safePaths(paths)
  if (safe.length === 0) return { ok: false, error: '没有可暂存的文件' }
  try {
    runGit(cwd, ['add', '--', ...safe])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function stageAll(cwd: string): GitOperationResult {
  try {
    runGit(cwd, ['add', '-A', '--', '.'])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function unstageFiles(cwd: string, paths: unknown): GitOperationResult {
  const safe = safePaths(paths)
  if (safe.length === 0) return { ok: false, error: '没有可取消暂存的文件' }
  try {
    runGit(cwd, ['restore', '--staged', '--', ...safe])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function hasStagedChanges(cwd: string): boolean {
  try {
    runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--quiet', '--exit-code'])
    return false
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) return true
    throw error
  }
}

export function commit(cwd: string, message: unknown): GitCommitResult {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return { ok: false, error: '提交信息不能为空' }

  try {
    if (!hasStagedChanges(cwd)) return { ok: false, error: '没有已暂存的改动' }
    runGit(cwd, ['commit', '-m', text])
    const sha = runGit(cwd, ['rev-parse', 'HEAD']).trim()
    return { ok: true, sha }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
