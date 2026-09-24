import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from '../git/safe-git'
import { MAX_PATCH_ARTIFACT_BYTES } from './patch-artifact'
import {
  assertNoExecutableCodeForgeFilters,
  assertCodeForgeUntrackedFileUnchanged,
  type CodeForgeUntrackedFileObservation
} from './source-security'

export interface CodeForgeDiffStats {
  insertions: number
  deletions: number
}

export type CodeForgePatchApplyCheck =
  | { state: 'applies'; canApply: true }
  | { state: 'conflict'; canApply: false; error: string }
  | { state: 'failed'; canApply: false; error: string }

interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

const MAX_OUTPUT_CHARS = 12_000
const MAX_GIT_BUFFER = 32 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000
const GIT_DEV_NULL = '/dev/null'

export function listCodeForgeUntrackedFiles(cwd: string, pathspecArgs: readonly string[]): string[] {
  const result = runGit(cwd, [
    'ls-files', '--others', '--exclude-standard', '-z', '--full-name', ...pathspecArgs
  ])
  if (!result.ok) throw new Error(result.error ?? 'git ls-files --others 失败')
  return result.stdout.split('\0').filter(Boolean)
}

export function codeForgeDiffStats(
  cwd: string,
  baseSha: string,
  pathspecArgs: readonly string[],
  untracked: readonly CodeForgeUntrackedFileObservation[]
): CodeForgeDiffStats {
  assertNoExecutableCodeForgeFilters(cwd)
  let insertions = 0
  let deletions = 0
  const numstat = runGit(
    cwd,
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--numstat', baseSha, ...pathspecArgs],
    { allowExitCodes: [0, 1] }
  )
  if (!numstat.ok) throw new Error(numstat.error ?? 'git diff --numstat 失败')
  for (const line of numstat.stdout.split(/\r?\n/)) {
    const [added, removed] = line.split('\t')
    if (/^\d+$/.test(added)) insertions += Number(added)
    if (/^\d+$/.test(removed)) deletions += Number(removed)
  }
  for (const file of untracked) insertions += file.lines
  return { insertions, deletions }
}

export function codeForgeChangedFiles(
  cwd: string,
  baseSha: string,
  pathspecArgs: readonly string[],
  untracked: readonly CodeForgeUntrackedFileObservation[]
): string[] {
  assertNoExecutableCodeForgeFilters(cwd)
  const files = new Set<string>()
  const tracked = runGit(
    cwd,
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--name-only', '-z', baseSha, ...pathspecArgs],
    { allowExitCodes: [0, 1] }
  )
  if (!tracked.ok) throw new Error(tracked.error ?? 'git diff --name-only 失败')
  for (const item of tracked.stdout.split('\0').filter(Boolean)) files.add(item)
  for (const item of untracked) files.add(item.path)
  return [...files].sort()
}

export function buildCodeForgePatchText(
  cwd: string,
  baseSha: string,
  pathspecArgs: readonly string[],
  untracked: readonly CodeForgeUntrackedFileObservation[]
): string {
  assertNoExecutableCodeForgeFilters(cwd)
  const chunks: string[] = []
  let aggregateBytes = 0
  const append = (chunk: string): void => {
    if (!chunk) return
    aggregateBytes += (chunks.length > 0 ? 1 : 0) + Buffer.byteLength(chunk, 'utf8')
    if (aggregateBytes + 1 > MAX_PATCH_ARTIFACT_BYTES) throw patchLimitError()
    chunks.push(chunk)
  }
  const tracked = runGit(
    cwd,
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--binary', '--full-index', baseSha, ...pathspecArgs],
    { allowExitCodes: [0, 1] }
  )
  if (!tracked.ok) throw new Error(tracked.error ?? 'git diff 失败')
  append(tracked.stdout)
  for (const file of untracked) {
    assertCodeForgeUntrackedFileUnchanged(cwd, file, MAX_PATCH_ARTIFACT_BYTES)
    const diff = runGit(
      cwd,
      ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--binary', '--full-index', '--', GIT_DEV_NULL, file.path],
      { allowExitCodes: [0, 1] }
    )
    if (!diff.ok) throw new Error(diff.error ?? `无法生成未跟踪文件 patch:${file.path}`)
    append(diff.stdout)
  }
  const patchText = ensureTrailingNewline(chunks.join('\n'))
  if (Buffer.byteLength(patchText, 'utf8') > MAX_PATCH_ARTIFACT_BYTES) throw patchLimitError()
  return patchText
}

export function checkCodeForgePatchApplies(repoRoot: string, patchText: string): CodeForgePatchApplyCheck {
  if (!patchText.trim()) return { state: 'applies', canApply: true }
  assertNoExecutableCodeForgeFilters(repoRoot)
  const result = runGit(
    repoRoot,
    ['apply', '--check', '--whitespace=nowarn', '-'],
    { input: patchText, allowExitCodes: [0, 1] }
  )
  if (!result.ok || result.status === null) {
    return { state: 'failed', canApply: false, error: result.error ?? 'git apply --check 无法执行' }
  }
  if (result.status === 0) return { state: 'applies', canApply: true }
  const error = result.stderr.trim() || result.stdout.trim() || 'git apply --check failed'
  return { state: 'conflict', canApply: false, error }
}

function runGit(
  cwd: string,
  args: string[],
  options: { allowExitCodes?: number[]; input?: string } = {}
): GitRunResult {
  const allowed = options.allowExitCodes ?? [0]
  const result = spawnSync('git', withSafeLocalGitConfig(args), {
    cwd,
    env: isolatedLocalGitEnv(process.env),
    input: options.input,
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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

function patchLimitError(): Error {
  return new Error(`Code Forge patch 超过 ${MAX_PATCH_ARTIFACT_BYTES} 字节上限`)
}

function ensureTrailingNewline(text: string): string {
  return text && !text.endsWith('\n') ? `${text}\n` : text
}
