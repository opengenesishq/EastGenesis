import { createHash } from 'node:crypto'
import { parseWslHostPath } from './wsl/binding'
import { execFileSyncInExecutionEnvironment as execFileSync, spawnSyncInExecutionEnvironment as spawnSync } from './wsl/process'
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './git/safe-git'
import { buildMinimalSubprocessEnv } from './security/subprocess-environment'
import { writeDurableFileSync } from './durable-file'
import {
  WorktreeMergeReceiptFormatError,
  type ApplySquashPatchSuccess,
  type ApplySquashPatchResult,
  type CanFastApplyPatchResult,
  type ConflictRisk,
  type CreatePullRequestOptions,
  type CreatePullRequestResult,
  type CreateSquashPatchSuccess,
  type CreateSquashPatchResult,
  type InspectMergeSuccess,
  type InspectMergeResult,
  type PullRequestTool,
  type WorktreeConflictFileContent,
  type WorktreeConflictFilesResult,
  type WorktreeMergeFailure,
  type WorktreeMergeReceipt
} from './worktreeMergeTypes'

export { WorktreeMergeReceiptFormatError } from './worktreeMergeTypes'
export type {
  ApplySquashPatchSuccess,
  ApplySquashPatchResult,
  CanFastApplyPatchResult,
  ConflictRisk,
  CreatePullRequestOptions,
  CreatePullRequestResult,
  CreateSquashPatchSuccess,
  CreateSquashPatchResult,
  InspectMergeSuccess,
  InspectMergeResult,
  PullRequestTool,
  WorktreeConflictFileContent,
  WorktreeConflictFilesResult,
  WorktreeMergeFailure,
  WorktreeMergeReceipt
} from './worktreeMergeTypes'

const GIT_TIMEOUT_MS = 120_000
const MAX_GIT_BUFFER = 100 * 1024 * 1024
// Git for Windows 不能识别 Node 的 os.devNull("\\\\.\\nul"),这里使用 Git 跨平台识别的空设备路径。
const GIT_DEV_NULL = '/dev/null'
export const WORKTREE_MERGE_EXCLUDE_PATHSPECS = [
  ':(exclude).caogen/audit.log',
  ':(exclude).caogen/tmp/**',
  ':(exclude).caogen/index.db',
  ':(exclude).caogen/index.db-*'
] as const

// 冲突文件上限与单文件内容上限(需求约定:20 个文件、200KB/文件)。
const MAX_CONFLICT_FILES = 20
const MAX_CONFLICT_FILE_BYTES = 200 * 1024
// 回执文件只保留最近 N 条,避免无限增长。
const MAX_MERGE_RECEIPTS = 200
const MERGE_RECEIPT_SCHEMA_VERSION = 1 as const
const MERGE_RECEIPT_FORMAT = 'caogen.worktree-merge-receipts.v1' as const

// 拒绝直接向这些分支推送/建 PR,遵守 git-safety(绝不直接动 main/master)。
const PROTECTED_BRANCHES = new Set(['main', 'master', 'HEAD'])

interface MergeContext {
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
}

interface DiffStats {
  changedFiles: number
  insertions: number
  deletions: number
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

export function inspectMerge(
  repoRoot: string,
  worktreePath: string,
  baseSha?: string
): InspectMergeResult {
  try {
    const context = resolveMergeContext(repoRoot, worktreePath, baseSha)
    const stats = diffStats(context.worktreePath, context.baseSha)
    const patch = buildSquashPatchText(context.worktreePath, context.baseSha)
    const conflictRisk = patch.ok
      ? conflictRiskForApplyCheck(context.repoRoot, patch.patchText)
      : 'unknown'

    return {
      ok: true,
      repoRoot: context.repoRoot,
      worktreePath: context.worktreePath,
      baseSha: context.baseSha,
      headSha: context.headSha,
      changedFiles: stats.changedFiles,
      insertions: stats.insertions,
      deletions: stats.deletions,
      conflictRisk
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function createSquashPatch(
  repoRoot: string,
  worktreePath: string,
  outDir?: string,
  baseSha?: string
): CreateSquashPatchResult {
  try {
    const context = resolveMergeContext(repoRoot, worktreePath, baseSha)
    const patch = buildSquashPatchText(context.worktreePath, context.baseSha)
    if (patch.ok === false) return failure(patch.error)

    const patchDir = normalizeOutputDirectory(outDir)
    const patchPath = path.join(patchDir, patchFileName(context))
    const patchText = ensureTrailingNewline(patch.patchText)
    writeDurableFileSync(patchPath, patchText, { mode: 0o600 })

    return {
      ok: true,
      repoRoot: context.repoRoot,
      worktreePath: context.worktreePath,
      baseSha: context.baseSha,
      headSha: context.headSha,
      path: patchPath,
      patchText,
      bytes: Buffer.byteLength(patchText, 'utf8')
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function canFastApplyPatch(repoRoot: string, patchText: string): CanFastApplyPatchResult {
  try {
    const root = normalizeDirectory('repoRoot', repoRoot)
    assertGitWorktreeRoot(root, 'repoRoot')
    if (typeof patchText !== 'string') return failure('patchText 必须是字符串')
    if (patchText.trim() === '') return { ok: true, canApply: true }

    const check = runGit(root, ['apply', '--check', '--whitespace=nowarn', '-'], {
      input: ensureTrailingNewline(patchText)
    })
    if (check.ok) return { ok: true, canApply: true }
    if (check.status !== null) {
      return { ok: true, canApply: false, error: check.error ?? 'git apply --check failed' }
    }
    return failure(check.error ?? 'git apply --check 无法执行')
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function applySquashPatch(repoRoot: string, patchText: string): ApplySquashPatchResult {
  try {
    const root = normalizeDirectory('repoRoot', repoRoot)
    assertGitWorktreeRoot(root, 'repoRoot')
    if (typeof patchText !== 'string') return failure('patchText 必须是字符串')
    if (patchText.trim() === '') {
      return { ok: true, repoRoot: root, bytes: 0, changedFiles: 0, applied: false }
    }

    const normalizedPatch = ensureTrailingNewline(patchText)
    const check = canFastApplyPatch(root, normalizedPatch)
    if (check.ok === false) return failure(check.error)
    if (check.canApply === false) return failure(check.error)

    const apply = runGit(root, ['apply', '--whitespace=nowarn', '-'], { input: normalizedPatch })
    if (!apply.ok) return failure(apply.error ?? 'git apply failed')

    return {
      ok: true,
      repoRoot: root,
      bytes: Buffer.byteLength(normalizedPatch, 'utf8'),
      changedFiles: changedFileCountFromPatch(normalizedPatch),
      applied: true
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

/**
 * 冲突三栏数据源:当 patch 无法干净应用到主工作区时,找出冲突文件并返回三份内容:
 * - base:merge 基线版本(git show <baseSha>:<path>)
 * - worktree:agent 隔离副本里的当前内容
 * - main:主工作区当前内容
 * 冲突文件优先从 `git apply --check` 的 stderr 解析;解析不到时退化为
 * "patch 涉及文件 ∩ 主工作区相对基线已改动文件" 的交集。
 * 上限:20 个文件、单文件 200KB(超限截断并标记)。
 */
export function reverseSquashPatch(repoRoot: string, patchText: string): ApplySquashPatchResult {
  try {
    const root = normalizeDirectory('repoRoot', repoRoot)
    assertGitWorktreeRoot(root, 'repoRoot')
    if (typeof patchText !== 'string') return failure('patchText 必须是字符串')
    if (patchText.trim() === '') {
      return { ok: true, repoRoot: root, bytes: 0, changedFiles: 0, applied: false }
    }

    const normalizedPatch = ensureTrailingNewline(patchText)
    const check = runGit(root, ['apply', '-R', '--check', '--whitespace=nowarn', '-'], {
      input: normalizedPatch
    })
    if (!check.ok) return failure(check.error ?? 'git apply -R --check failed')

    const apply = runGit(root, ['apply', '-R', '--whitespace=nowarn', '-'], { input: normalizedPatch })
    if (!apply.ok) return failure(apply.error ?? 'git apply -R failed')

    return {
      ok: true,
      repoRoot: root,
      bytes: Buffer.byteLength(normalizedPatch, 'utf8'),
      changedFiles: changedFileCountFromPatch(normalizedPatch),
      applied: true
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function getConflictFiles(
  repoRoot: string,
  worktreePath: string,
  baseSha?: string
): WorktreeConflictFilesResult {
  try {
    const context = resolveMergeContext(repoRoot, worktreePath, baseSha)
    const patch = buildSquashPatchText(context.worktreePath, context.baseSha)
    if (patch.ok === false) return { ok: false, error: patch.error }

    const patchText = ensureTrailingNewline(patch.patchText)
    if (!patchText.trim()) return { ok: true, files: [] }

    const check = runGit(context.repoRoot, ['apply', '--check', '--whitespace=nowarn', '-'], {
      input: patchText
    })
    // 能干净应用 = 没有冲突文件,直接返回空列表。
    if (check.ok) return { ok: true, files: [] }
    if (check.status === null) return { ok: false, error: check.error ?? 'git apply --check 无法执行' }

    const patchFiles = filesFromPatch(patchText)
    let conflicted = conflictFilesFromApplyCheckStderr(check.stderr, patchFiles)
    if (conflicted.length === 0) {
      // stderr 没解析出文件时的兜底:patch 文件列表 ∩ 主工作区相对基线的改动文件。
      const mainModified = new Set(modifiedFilesSinceBase(context.repoRoot, context.baseSha))
      conflicted = patchFiles.filter((file) => mainModified.has(file))
    }
    if (conflicted.length === 0) conflicted = patchFiles

    const truncatedList = conflicted.length > MAX_CONFLICT_FILES
    const files: WorktreeConflictFileContent[] = []
    for (const relPath of conflicted.slice(0, MAX_CONFLICT_FILES)) {
      const base = readGitShowCapped(context.repoRoot, context.baseSha, relPath)
      const worktree = readFileCapped(path.join(context.worktreePath, relPath))
      const main = readFileCapped(path.join(context.repoRoot, relPath))
      const entry: WorktreeConflictFileContent = {
        path: relPath,
        base: base.text,
        worktree: worktree.text,
        main: main.text
      }
      if (base.missing) entry.baseMissing = true
      if (worktree.missing) entry.worktreeMissing = true
      if (main.missing) entry.mainMissing = true
      if (base.truncated || worktree.truncated || main.truncated) entry.truncated = true
      files.push(entry)
    }

    const result: WorktreeConflictFilesResult = { ok: true, files }
    if (truncatedList) result.truncatedList = true
    return result
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/** 计算 patch 文本的 sha256(回执用,校验"合并的到底是哪份 patch")。 */
export function patchSha256(patchText: string): string {
  return createHash('sha256').update(patchText, 'utf8').digest('hex')
}

/** 追加一条合并回执到指定 JSON 文件(数组格式,只保留最近 MAX_MERGE_RECEIPTS 条)。 */
export function appendMergeReceipt(filePath: string, receipt: WorktreeMergeReceipt): void {
  const receipts = listMergeReceipts(filePath)
  receipts.push({ ...receipt, schemaVersion: MERGE_RECEIPT_SCHEMA_VERSION })
  const trimmed = receipts.slice(-MAX_MERGE_RECEIPTS)
  writeDurableFileSync(filePath, `${JSON.stringify({ schemaVersion: MERGE_RECEIPT_SCHEMA_VERSION, format: MERGE_RECEIPT_FORMAT, receipts: trimmed }, null, 2)}\n`, { mode: 0o600 })
}

/** 读取合并回执列表;文件缺失/损坏时返回空数组(回执是附加验收信息,不阻断主流程)。 */
export function listMergeReceipts(filePath: string): WorktreeMergeReceipt[] {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    const decoded = decodeMergeReceiptDocument(raw)
    const receipts = decoded.receipts.filter(isMergeReceipt).map((receipt) => ({ ...receipt, schemaVersion: MERGE_RECEIPT_SCHEMA_VERSION }))
    if (decoded.legacy && receipts.length > 0) {
      writeDurableFileSync(filePath, `${JSON.stringify({ schemaVersion: MERGE_RECEIPT_SCHEMA_VERSION, format: MERGE_RECEIPT_FORMAT, receipts }, null, 2)}\n`, { mode: 0o600 })
    }
    return receipts
  } catch (error) {
    if (error instanceof WorktreeMergeReceiptFormatError) throw error
    return []
  }
}

/** Remove terminal merge display receipts for one deleted Session. */
export function purgeMergeReceiptsForSession(filePath: string, sessionId: string): number {
  const id = sessionId.trim()
  if (!id) throw new Error('merge receipt Session ID is required')
  const receipts = listMergeReceipts(filePath)
  const next = receipts.filter((receipt) => receipt.sessionId !== id)
  if (next.length === receipts.length) return 0
  writeDurableFileSync(filePath, `${JSON.stringify({
    schemaVersion: MERGE_RECEIPT_SCHEMA_VERSION,
    format: MERGE_RECEIPT_FORMAT,
    receipts: next
  }, null, 2)}\n`, { mode: 0o600 })
  return receipts.length - next.length
}

function decodeMergeReceiptDocument(value: unknown): { receipts: unknown[]; legacy: boolean } {
  if (Array.isArray(value)) return { receipts: value, legacy: true }
  if (!value || typeof value !== 'object') throw new WorktreeMergeReceiptFormatError('worktree merge receipt document is invalid')
  const document = value as { schemaVersion?: unknown; format?: unknown; receipts?: unknown }
  if (document.schemaVersion !== MERGE_RECEIPT_SCHEMA_VERSION || document.format !== MERGE_RECEIPT_FORMAT || !Array.isArray(document.receipts)) {
    throw new WorktreeMergeReceiptFormatError(`worktree merge receipt schema version is unsupported: ${String(document.schemaVersion)}`)
  }
  return { receipts: document.receipts, legacy: false }
}

function isMergeReceipt(value: unknown): value is WorktreeMergeReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Partial<WorktreeMergeReceipt>
  return (
    typeof receipt.sessionId === 'string' &&
    typeof receipt.branch === 'string' &&
    typeof receipt.baseSha === 'string' &&
    typeof receipt.filesChanged === 'number' &&
    typeof receipt.insertions === 'number' &&
    typeof receipt.deletions === 'number' &&
    typeof receipt.mergedAt === 'number' &&
    typeof receipt.patchSha256 === 'string' &&
    (receipt.schemaVersion === undefined || receipt.schemaVersion === MERGE_RECEIPT_SCHEMA_VERSION)
  )
}

/**
 * 从 `git apply --check` stderr 解析冲突文件。常见格式:
 *   error: patch failed: src/foo.ts:12
 *   error: src/foo.ts: patch does not apply
 *   error: new.txt: already exists in working directory
 * 只保留 patch 文件列表里出现过的路径,避免把无关 error 文本误当文件名。
 */
function conflictFilesFromApplyCheckStderr(stderr: string, patchFiles: string[]): string[] {
  const known = new Set(patchFiles)
  const found = new Set<string>()
  for (const line of stderr.split(/\r?\n/)) {
    const failed = /^error: patch failed: (.+):\d+$/.exec(line.trim())
    if (failed && known.has(failed[1])) {
      found.add(failed[1])
      continue
    }
    const generic = /^error: (.+?): .+$/.exec(line.trim())
    if (generic && known.has(generic[1])) found.add(generic[1])
  }
  return [...found]
}

/** 从 patch 文本提取涉及文件(新旧路径都算,覆盖删除/新增/改名)。 */
function filesFromPatch(patchText: string): string[] {
  const files = new Set<string>()
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (!match) continue
    for (const target of [match[1], match[2]]) {
      if (target && target !== '/dev/null' && !target.startsWith('dev/null')) files.add(target)
    }
  }
  return [...files]
}

/** 主工作区相对基线的改动文件(含已提交 + 未提交,不含未跟踪;兜底交集用)。 */
function modifiedFilesSinceBase(repoRoot: string, baseSha: string): string[] {
  const result = runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseSha, '--'])
  if (!result.ok) return []
  return result.stdout.split('\0').filter(Boolean)
}

/** 读基线版本内容(git show <sha>:<path>),缺失 → missing,超 200KB → 截断。 */
function readGitShowCapped(
  repoRoot: string,
  baseSha: string,
  relPath: string
): { text: string; missing: boolean; truncated: boolean } {
  const result = runGit(repoRoot, ['show', `${baseSha}:${relPath}`])
  if (!result.ok) return { text: '', missing: true, truncated: false }
  return capText(result.stdout)
}

/** 读工作区文件内容,缺失 → missing,超 200KB → 截断。 */
function readFileCapped(filePath: string): { text: string; missing: boolean; truncated: boolean } {
  try {
    const buffer = readFileSync(filePath)
    return capText(buffer.toString('utf8'))
  } catch {
    return { text: '', missing: true, truncated: false }
  }
}

function capText(text: string): { text: string; missing: boolean; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_CONFLICT_FILE_BYTES) {
    return { text, missing: false, truncated: false }
  }
  // 按字节截断后转回字符串;末尾可能出现半个多字节字符,replace 掉替换符即可接受。
  const sliced = Buffer.from(text, 'utf8').subarray(0, MAX_CONFLICT_FILE_BYTES).toString('utf8')
  return { text: sliced, missing: false, truncated: true }
}

export function detectPullRequestTool(cwd?: string): PullRequestTool | null {
  for (const tool of ['gh', 'glab'] as const) {
    if (commandExists(tool, cwd)) return tool
  }
  return null
}

/**
 * 推送 managed worktree 分支并创建 PR/MR。
 * git-safety:绝不直接推 main/master;推送目标即受管分支自身,并用 -u 建立 upstream;
 * 无 force、无破坏性操作;全部走 execFile 数组参数,零字符串插值以避免注入。
 */
export function createPullRequest(options: CreatePullRequestOptions): CreatePullRequestResult {
  try {
    const root = normalizeDirectory('repoRoot', options.repoRoot)
    assertGitWorktreeRoot(root, 'repoRoot')
    const worktree = normalizeDirectory('worktreePath', options.worktreePath)
    assertSameRepository(root, worktree)

    const branch = typeof options.branch === 'string' ? options.branch.trim() : ''
    if (!branch) return failure('分支名不能为空')
    if (PROTECTED_BRANCHES.has(branch)) {
      return failure(`拒绝直接向受保护分支创建 PR: ${branch}`)
    }

    const title = typeof options.title === 'string' ? options.title.trim() : ''
    if (!title) return failure('PR 标题不能为空')
    const body = typeof options.body === 'string' ? options.body : ''

    const tool = detectPullRequestTool(worktree)
    if (!tool) {
      return {
        ok: true,
        created: false,
        message: '未检测到可用的 PR 工具(gh / glab),已跳过创建 PR'
      }
    }

    // 从 worktree 侧推送受管分支,设置上游;无 --force。
    const push = runGit(worktree, ['push', '-u', 'origin', `${branch}:${branch}`])
    if (!push.ok) return failure(push.error ?? `git push 失败: ${branch}`)

    const created =
      tool === 'gh'
        ? runPrTool('gh', worktree, ['pr', 'create', '--head', branch, '--title', title, '--body', body])
        : runPrTool('glab', worktree, ['mr', 'create', '--source-branch', branch, '--title', title, '--description', body, '--yes'])

    if (!created.ok) return failure(created.error ?? `${tool} 创建 PR 失败`)

    const url = extractUrl(created.stdout) ?? created.stdout.trim()
    return { ok: true, created: true, tool, branch, url, pushed: true }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

function commandExists(command: string, cwd?: string): boolean {
  if (cwd && parseWslHostPath(cwd)) {
    try {
      return spawnSync(command, ['--version'], { cwd, env: buildMinimalSubprocessEnv(), stdio: 'ignore', timeout: GIT_TIMEOUT_MS }).status === 0
    } catch { return false }
  }
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [command], {
      env: buildMinimalSubprocessEnv(),
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

function runPrTool(
  command: PullRequestTool,
  cwd: string,
  args: string[]
): { ok: boolean; stdout: string; error?: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: buildMinimalSubprocessEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.error) return { ok: false, stdout, error: result.error.message }
  if (result.status !== 0) {
    const output = stderr.trim() || stdout.trim()
    return { ok: false, stdout, error: output || `${command} exited with ${result.status ?? 'null'}` }
  }
  return { ok: true, stdout }
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/\S+/.exec(text)
  return match ? match[0].trim() : null
}

function resolveMergeContext(
  repoRoot: string,
  worktreePath: string,
  requestedBaseSha?: string
): MergeContext {
  const root = normalizeDirectory('repoRoot', repoRoot)
  const worktree = normalizeDirectory('worktreePath', worktreePath)
  assertSameRepository(root, worktree)

  const headSha = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const repoHeadSha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const baseSha = requestedBaseSha?.trim()
    ? git(worktree, ['rev-parse', '--verify', `${requestedBaseSha.trim()}^{commit}`])
    : mergeBase(root, worktree, repoHeadSha, headSha)

  return {
    repoRoot: root,
    worktreePath: worktree,
    baseSha,
    headSha
  }
}

function normalizeDirectory(label: string, value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  if (value.includes('\0')) throw new Error(`${label} 包含非法字符`)

  const resolved = path.resolve(value)
  const info = statSync(resolved)
  if (!info.isDirectory()) throw new Error(`${label} 不是目录: ${resolved}`)
  return realpathSync(resolved)
}

function normalizeOutputDirectory(outDir: string | undefined): string {
  const requested = outDir?.trim() ? outDir : path.join(tmpdir(), 'caogen-worktree-patches')
  if (requested.includes('\0')) throw new Error('outDir 包含非法字符')
  const resolved = path.resolve(requested)
  mkdirSync(resolved, { recursive: true })
  const info = statSync(resolved)
  if (!info.isDirectory()) throw new Error(`outDir 不是目录: ${resolved}`)
  return realpathSync(resolved)
}

function assertSameRepository(repoRoot: string, worktreePath: string): void {
  const repoTop = assertGitWorktreeRoot(repoRoot, 'repoRoot')
  const worktreeTop = assertGitWorktreeRoot(worktreePath, 'worktreePath')
  if (repoTop !== repoRoot) throw new Error(`repoRoot 必须是 Git 工作区根目录: ${repoRoot}`)
  if (worktreeTop !== worktreePath) throw new Error(`worktreePath 必须是 Git 工作区根目录: ${worktreePath}`)

  const repoCommonDir = gitCommonDir(repoRoot)
  const worktreeCommonDir = gitCommonDir(worktreePath)
  if (repoCommonDir !== worktreeCommonDir) {
    throw new Error('repoRoot 与 worktreePath 不属于同一个 Git 仓库')
  }
}

function assertGitWorktreeRoot(cwd: string, label: string): string {
  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'])
  const normalizedTopLevel = realpathSync(path.resolve(cwd, topLevel))
  if (!normalizedTopLevel) throw new Error(`${label} 不是 Git 工作区`)
  return normalizedTopLevel
}

function gitCommonDir(cwd: string): string {
  const raw = git(cwd, ['rev-parse', '--git-common-dir'])
  const fullPath = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  return realpathSync(fullPath)
}

function mergeBase(repoRoot: string, worktreePath: string, repoHeadSha: string, headSha: string): string {
  const result = runGit(worktreePath, ['merge-base', repoHeadSha, headSha])
  if (result.ok && result.stdout.trim()) return result.stdout.trim()
  throw new Error(
    `无法计算 repoRoot HEAD 与 worktree HEAD 的 merge-base: ${
      result.error ?? 'git merge-base 没有输出'
    }`
  )
}

function diffStats(worktreePath: string, baseSha: string): DiffStats {
  const numstat = gitRaw(worktreePath, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--numstat',
    baseSha,
    ...mergePathspecArgs()
  ])
  let changedFiles = 0
  let insertions = 0
  let deletions = 0

  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [added, removed] = line.split('\t')
    changedFiles += 1
    if (/^\d+$/.test(added)) insertions += Number(added)
    if (/^\d+$/.test(removed)) deletions += Number(removed)
  }

  for (const file of untrackedFiles(worktreePath)) {
    changedFiles += 1
    insertions += countTextLines(worktreePath, file)
  }

  return { changedFiles, insertions, deletions }
}

function buildSquashPatchText(
  worktreePath: string,
  baseSha: string
): { ok: true; patchText: string } | WorktreeMergeFailure {
  const tracked = runGit(worktreePath, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--full-index',
    baseSha,
    ...mergePathspecArgs()
  ])
  if (!tracked.ok) return failure(tracked.error ?? 'git diff failed')

  const chunks = [tracked.stdout]
  for (const file of untrackedFiles(worktreePath)) {
    const untracked = runGit(
      worktreePath,
      ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--binary', '--full-index', '--', GIT_DEV_NULL, file],
      { allowExitCodes: [0, 1] }
    )
    if (!untracked.ok) return failure(untracked.error ?? `无法生成 untracked patch: ${file}`)
    chunks.push(untracked.stdout)
  }

  return {
    ok: true,
    patchText: chunks.filter((chunk) => chunk.length > 0).join('\n')
  }
}

function conflictRiskForApplyCheck(repoRoot: string, patchText: string): ConflictRisk {
  const check = canFastApplyPatch(repoRoot, patchText)
  if (!check.ok) return 'unknown'
  return check.canApply ? 'low' : 'medium'
}

function untrackedFiles(worktreePath: string): string[] {
  const output = gitRaw(worktreePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--full-name',
    ...mergePathspecArgs()
  ])
  return output.split('\0').filter(Boolean)
}

function mergePathspecArgs(): string[] {
  return ['--', '.', ...WORKTREE_MERGE_EXCLUDE_PATHSPECS]
}

function countTextLines(worktreePath: string, relPath: string): number {
  try {
    const buffer = readFileSync(path.join(worktreePath, relPath))
    if (buffer.includes(0) || buffer.length === 0) return 0
    const text = buffer.toString('utf8')
    return text.endsWith('\n') ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length
  } catch {
    return 0
  }
}

function patchFileName(context: MergeContext): string {
  const hash = createHash('sha1')
    .update(context.repoRoot)
    .update('\0')
    .update(context.worktreePath)
    .digest('hex')
    .slice(0, 10)
  return `worktree-${context.headSha.slice(0, 12)}-${hash}-${Date.now()}.patch`
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim()
}

function gitRaw(cwd: string, args: string[]): string {
  const result = runGit(cwd, args)
  if (!result.ok) throw new Error(result.error ?? `git ${args.join(' ')} failed`)
  return result.stdout
}

function runGit(
  cwd: string,
  args: string[],
  options: { input?: string; allowExitCodes?: number[] } = {}
): GitResult {
  const allowed = options.allowExitCodes ?? [0]
  const result = spawnSync('git', withSafeLocalGitConfig(args), {
    cwd,
    input: options.input,
    encoding: 'utf8',
    env: isolatedLocalGitEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER
  })

  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const status = result.status

  if (result.error) {
    return {
      ok: false,
      stdout,
      stderr,
      status,
      error: result.error.message
    }
  }

  if (status === null || !allowed.includes(status)) {
    return {
      ok: false,
      stdout,
      stderr,
      status,
      error: gitError(args, status, stdout, stderr)
    }
  }

  return { ok: true, stdout, stderr, status }
}

function gitError(args: string[], status: number | null, stdout: string, stderr: string): string {
  const output = stderr.trim() || stdout.trim()
  const command = ['git', ...args].join(' ')
  if (output) return `${command} failed${status === null ? '' : ` (${status})`}: ${output}`
  return `${command} failed${status === null ? '' : ` (${status})`}`
}

function ensureTrailingNewline(text: string): string {
  if (!text) return text
  return text.endsWith('\n') ? text : `${text}\n`
}

function changedFileCountFromPatch(patchText: string): number {
  const files = new Set<string>()
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (!match) continue
    const target = match[2]
    if (target && target !== '/dev/null') files.add(target)
  }
  return files.size
}

function failure(error: string): WorktreeMergeFailure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
