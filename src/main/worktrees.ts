import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './git/safe-git'
import { inspectPullRequestCapability } from './git/pull-request-effect'
import type {
  ManagedWorktreeView,
  WorktreeApplyResult,
  WorktreeApplyCheckResult,
  WorktreeConflictFilesResult,
  WorktreeMergeReceipt,
  WorktreeMergeSummary,
  WorktreePatchResult,
  WorktreePullRequestResult,
  WorktreeSummary
} from '../shared/types'
import {
  appendMergeReceipt,
  applySquashPatch,
  canFastApplyPatch,
  createSquashPatch,
  getConflictFiles,
  inspectMerge,
  listMergeReceipts,
  purgeMergeReceiptsForSession,
  patchSha256
} from './worktreeMerge'
import {
  listManagedWorktreeRecords,
  managedWorktreeRecordForSession as recordForSession,
  type ManagedWorktreeRecord
} from './managed-worktree-lifecycle'

export {
  inspectManagedWorktreeRegistryProjection,
  inspectManagedWorktreeIdentity,
  inspectManagedWorktreeRegistryRecord,
  managedWorktreeRecordForSession,
  prepareManagedWorktreeCreateEffect,
  prepareManagedWorktreeRemoveEffect,
  prepareWorktree,
  projectConfirmedManagedWorktreeTarget,
  projectManagedWorktreeCreated,
  projectManagedWorktreeRemoved,
  removeManagedWorktree,
  removeManagedWorktreeView
} from './managed-worktree-lifecycle'
export type {
  ManagedWorktreeCreateEffectOptions,
  ManagedWorktreeCreateEffectPlan,
  ManagedWorktreeCreateEffectPlanResult,
  ManagedWorktreeCreateEffectToolInput,
  ManagedWorktreeLifecycleEffectTarget,
  ManagedWorktreeRecord,
  ManagedWorktreeRegistryRecordLookup,
  ManagedWorktreeRegistryProjectionState,
  ManagedWorktreeRemoveEffectOptions,
  ManagedWorktreeRemoveEffectPlan,
  ManagedWorktreeRemoveEffectPlanResult,
  ManagedWorktreeRemoveEffectToolInput,
  ManagedWorktreeState,
  WorktreeOpResult,
  WorktreePrepareOptions,
  WorktreePrepareResult
} from './managed-worktree-lifecycle'

const GIT_TIMEOUT_MS = 120_000

export interface ManagedWorktreePatchEffectPlan {
  sessionId: string
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  patchPath: string
  patchSha256: string
  patchBytes: number
}

export type ManagedWorktreePatchEffectPlanResult =
  | { ok: true; plan: ManagedWorktreePatchEffectPlan }
  | { ok: true; noop: Extract<WorktreeApplyResult, { ok: true }> }
  | { ok: false; error: string }

export interface ManagedWorktreePullRequestEffectPlan {
  sessionId: string
  worktreePath: string
  branch: string
  title: string
  body: string
  base?: string
}

export type ManagedWorktreePullRequestEffectPlanResult =
  | { ok: true; plan: ManagedWorktreePullRequestEffectPlan }
  | { ok: true; unavailable: true; message: string }
  | { ok: false; error: string }

type PreparedWorktreePatchInput =
  | { ok: true; record: ManagedWorktreeRecord; patchText: string }
  | { ok: false; error: string }

interface WorktreeDiffStats {
  changedFiles: number
  insertions?: number
  deletions?: number
  dirty: boolean
}

function patchesRoot(): string {
  return join(app.getPath('userData'), 'patches')
}

// 合并回执文件:验收"上次到底合了什么"(sessionId/分支/统计/patch sha256/时间)。
function mergeReceiptsFile(userDataRoot?: string): string {
  return join(userDataRoot ?? app.getPath('userData'), 'worktree-merges.json')
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', withSafeLocalGitConfig(args), {
      cwd,
      encoding: 'utf8',
      env: isolatedLocalGitEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS
    }).trim()
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${errorText(err)}`)
  }
}

function gitOrNull(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args)
  } catch {
    return null
  }
}

function gitOutputAllowDiffExit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', withSafeLocalGitConfig(args), {
      cwd,
      encoding: 'utf8',
      env: isolatedLocalGitEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS
    })
  } catch (err) {
    const stdout = err instanceof Error ? bufferText((err as Error & { stdout?: Buffer | string }).stdout) : ''
    if (stdout) return `${stdout}\n`
    throw new Error(`git ${args.join(' ')} failed: ${errorText(err)}`)
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const withOutput = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string }
    const stderr = bufferText(withOutput.stderr)
    if (stderr) return stderr
    const stdout = bufferText(withOutput.stdout)
    if (stdout) return stdout
    return err.message
  }
  return String(err)
}

function bufferText(value: Buffer | string | undefined): string {
  if (value === undefined) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8').trim() : value.trim()
}

function safePathSegment(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe && safe === sessionId && safe !== '.' && safe !== '..') return safe
  const hash = createHash('sha1').update(sessionId).digest('hex').slice(0, 8)
  const prefix = safe && safe !== '.' && safe !== '..' ? safe : 'session'
  return `${prefix}-${hash}`
}

function toView(record: ManagedWorktreeRecord): ManagedWorktreeView {
  return { ...record }
}

function diffStats(record: ManagedWorktreeRecord): WorktreeDiffStats {
  if (record.state !== 'active' || !existsSync(record.worktreePath)) {
    return { changedFiles: 0, dirty: false }
  }
  const numstat = git(record.worktreePath, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--numstat',
    record.baseSha,
    '--'
  ])
  let changedFiles = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [added, removed] = line.split(/\t/)
    changedFiles += 1
    if (/^\d+$/.test(added)) insertions += Number(added)
    if (/^\d+$/.test(removed)) deletions += Number(removed)
  }
  for (const file of untrackedFiles(record.worktreePath)) {
    changedFiles += 1
    insertions += countTextLines(record.worktreePath, file)
  }
  return { changedFiles, insertions, deletions, dirty: changedFiles > 0 }
}

function untrackedFiles(worktreePath: string): string[] {
  const output = execFileSync(
    'git',
    withSafeLocalGitConfig(['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.']),
    {
      cwd: worktreePath,
      encoding: 'buffer',
      env: isolatedLocalGitEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS
    }
  )
  return output.toString('utf8').split('\0').filter(Boolean)
}

function countTextLines(worktreePath: string, relPath: string): number {
  try {
    const buf = readFileSync(join(worktreePath, relPath))
    if (buf.includes(0)) return 0
    const text = buf.toString('utf8')
    if (!text) return 0
    return text.endsWith('\n') ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length
  } catch {
    return 0
  }
}

function untrackedPatch(worktreePath: string): string {
  return untrackedFiles(worktreePath)
    .map((file) =>
      gitOutputAllowDiffExit(worktreePath, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-index',
        '--binary',
        '--',
        '/dev/null',
        file
      ])
    )
    .join('\n')
}

export function isGitRepository(cwd: string): boolean {
  if (!cwd) return false
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

export function repoRootFor(cwd: string): string | null {
  if (!cwd || !isGitRepository(cwd)) return null
  return gitOrNull(cwd, ['rev-parse', '--show-toplevel'])
}

export function listManagedWorktrees(): ManagedWorktreeRecord[] {
  try {
    return listManagedWorktreeRecords()
  } catch {
    return []
  }
}

export function getManagedWorktreeSummary(sessionId: string): WorktreeSummary {
  try {
    const record = recordForSession(sessionId)
    if (!record) {
      return {
        ok: false,
        isolated: false,
        changedFiles: 0,
        dirty: false,
        error: '当前会话没有 CaoGen 管理的 worktree'
      }
    }
    const stats = diffStats(record)
    return {
      ok: true,
      isolated: true,
      record: toView(record),
      ...stats
    }
  } catch (err) {
    return {
      ok: false,
      isolated: false,
      changedFiles: 0,
      dirty: false,
      error: errorText(err)
    }
  }
}

export function exportManagedWorktreePatch(sessionId: string): WorktreePatchResult {
  try {
    const record = recordForSession(sessionId)
    if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
    if (record.state !== 'active' || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'worktree 已不存在或已移除' }
    }
    const headSha = git(record.worktreePath, ['rev-parse', 'HEAD'])
    // 相对基线的完整改动 = 已提交(baseSha..HEAD)+ 工作区未提交(HEAD 相对工作树)。
    // 用 `git diff --binary baseSha`(不带 -- 的三点/两点)对比"基线↔当前工作树",
    // 它同时涵盖已提交与未提交改动,一步到位;再叠加未跟踪文件。
    const patch = [
      git(record.worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--binary', record.baseSha]),
      untrackedPatch(record.worktreePath)
    ]
      .filter(Boolean)
      .join('\n')
    if (git(record.worktreePath, ['rev-parse', 'HEAD']) !== headSha) {
      return { ok: false, error: '导出期间 worktree HEAD 已变化，请重新导出' }
    }
    mkdirSync(patchesRoot(), { recursive: true })
    const patchPath = join(patchesRoot(), `${safePathSegment(record.sessionId)}-${randomUUID()}.patch`)
    // git() 帮手会 trim 输出末尾换行,而 git apply 要求 patch 以换行结尾(否则 corrupt patch)
    const bytes = Buffer.from(patch ? `${patch}\n` : patch, 'utf8')
    writeFileSync(patchPath, bytes, { flag: 'wx' })
    return {
      ok: true,
      path: patchPath,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      repoRoot: record.repoRoot,
      worktreePath: record.worktreePath,
      baseSha: record.baseSha,
      headSha
    }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function inspectManagedWorktreeMerge(sessionId: string): WorktreeMergeSummary {
  try {
    const record = recordForSession(sessionId)
    if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
    if (record.state !== 'active' || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'worktree 已不存在或已移除' }
    }
    return inspectMerge(record.repoRoot, record.worktreePath, record.baseSha)
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function createManagedWorktreeMergePatch(sessionId: string): WorktreePatchResult {
  try {
    const record = recordForSession(sessionId)
    if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
    if (record.state !== 'active' || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'worktree 已不存在或已移除' }
    }
    return createSquashPatch(record.repoRoot, record.worktreePath, patchesRoot(), record.baseSha)
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function checkManagedWorktreeApply(sessionId: string): WorktreeApplyCheckResult {
  try {
    const patch = createManagedWorktreeMergePatch(sessionId)
    if ('error' in patch) return { ok: false, error: patch.error || '无法生成 worktree patch' }
    return canFastApplyPatch(patch.repoRoot ?? '', patch.patchText ?? '')
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function applyManagedWorktreePatch(sessionId: string): WorktreeApplyResult {
  void sessionId
  return {
    ok: false,
    error: '直接应用 worktree patch 的同步入口已禁用；必须通过 Operation Effect Gateway 执行'
  }
}

export function prepareManagedWorktreePatchEffect(
  sessionId: string
): ManagedWorktreePatchEffectPlanResult {
  try {
    const record = recordForSession(sessionId)
    if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
    if (record.state !== 'active' || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'worktree 已不存在或已移除' }
    }
    const patch = createManagedWorktreeMergePatch(sessionId)
    if ('error' in patch) return { ok: false, error: patch.error || '无法生成 worktree patch' }
    if (
      !patch.repoRoot ||
      !patch.worktreePath ||
      !patch.baseSha ||
      !patch.headSha ||
      !patch.path ||
      typeof patch.patchText !== 'string'
    ) {
      return { ok: false, error: 'worktree patch 缺少建立效果记录所需的冻结字段' }
    }
    if (patch.patchText.trim() === '') {
      return {
        ok: true,
        noop: {
          ok: true,
          repoRoot: patch.repoRoot,
          worktreePath: patch.worktreePath,
          baseSha: patch.baseSha,
          headSha: patch.headSha,
          path: patch.path,
          bytes: 0,
          changedFiles: 0,
          applied: false
        }
      }
    }
    return {
      ok: true,
      plan: {
        sessionId: record.sessionId,
        repoRoot: patch.repoRoot,
        worktreePath: patch.worktreePath,
        baseSha: patch.baseSha,
        headSha: patch.headSha,
        patchPath: patch.path,
        patchSha256: patchSha256(patch.patchText),
        patchBytes: Buffer.byteLength(patch.patchText, 'utf8')
      }
    }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function applyPreparedManagedWorktreePatch(
  plan: ManagedWorktreePatchEffectPlan
): WorktreeApplyResult {
  try {
    const prepared = loadPreparedWorktreePatch(plan)
    if ('error' in prepared) return { ok: false, error: prepared.error }
    const apply = applySquashPatch(plan.repoRoot, prepared.patchText)
    if (!apply.ok) return apply
    if (apply.applied) appendWorktreeMergeReceipt(prepared.record, apply, plan.patchSha256)
    return {
      ...apply,
      path: plan.patchPath,
      headSha: plan.headSha,
      baseSha: plan.baseSha,
      worktreePath: plan.worktreePath
    }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

function loadPreparedWorktreePatch(plan: ManagedWorktreePatchEffectPlan): PreparedWorktreePatchInput {
  const record = recordForSession(plan.sessionId)
  if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
  if (record.state !== 'active' || !existsSync(record.worktreePath)) {
    return { ok: false, error: 'worktree 已不存在或已移除' }
  }
  const identityMatches = record.repoRoot === plan.repoRoot
    && record.worktreePath === plan.worktreePath
    && record.baseSha === plan.baseSha
    && git(record.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']) === plan.headSha
  if (!identityMatches) return { ok: false, error: 'managed worktree 已偏离效果审批时状态' }
  if (!existsSync(plan.patchPath)) return { ok: false, error: '冻结的 worktree patch artifact 已不存在' }
  const patchText = readFileSync(plan.patchPath, 'utf8')
  const artifactMatches = Buffer.byteLength(patchText, 'utf8') === plan.patchBytes
    && patchSha256(patchText) === plan.patchSha256
  return artifactMatches
    ? { ok: true, record, patchText }
    : { ok: false, error: '冻结的 worktree patch artifact 已发生变化' }
}

function appendWorktreeMergeReceipt(
  record: ManagedWorktreeRecord,
  apply: Extract<WorktreeApplyResult, { ok: true }>,
  sha256: string
): void {
  try {
    const stats = diffStats(record)
    appendMergeReceipt(mergeReceiptsFile(), {
      sessionId: record.sessionId,
      branch: record.branch,
      baseSha: record.baseSha,
      filesChanged: apply.changedFiles,
      insertions: stats.insertions ?? 0,
      deletions: stats.deletions ?? 0,
      mergedAt: Date.now(),
      patchSha256: sha256
    })
  } catch {
    // 回执是附加验收信息,写盘失败不阻断已经生效的 patch。
  }
}

/** 冲突三栏数据:apply-check 被拒时,取每个冲突文件的 基线/worktree/主工作区 三份内容。 */
export function getWorktreeConflictFiles(sessionId: string): WorktreeConflictFilesResult {
  try {
    const record = recordForSession(sessionId)
    if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
    if (record.state !== 'active' || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'worktree 已不存在或已移除' }
    }
    return getConflictFiles(record.repoRoot, record.worktreePath, record.baseSha)
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

/** 合并回执列表(最新在前),供 UI 展示"上次合并:N 文件 +X/-Y · 时间"。 */
export function listWorktreeMergeReceipts(): WorktreeMergeReceipt[] {
  try {
    return listMergeReceipts(mergeReceiptsFile()).sort((a, b) => b.mergedAt - a.mergedAt)
  } catch {
    return []
  }
}

/** Removes only local display receipts after the owning Session is permanently deleted. */
export function purgeWorktreeMergeReceipts(sessionId: string, userDataRoot?: string): number {
  return purgeMergeReceiptsForSession(mergeReceiptsFile(userDataRoot), sessionId)
}

export function countWorktreeMergeReceiptsForSession(sessionId: string, userDataRoot?: string): number {
  return listMergeReceipts(mergeReceiptsFile(userDataRoot)).filter((receipt) => receipt.sessionId === sessionId).length
}

export function createManagedWorktreePullRequest(sessionId: string): WorktreePullRequestResult {
  void sessionId
  return {
    ok: false,
    error: '直接 push 并创建 PR/MR 的复合入口已禁用；必须通过独立 git_push 与 PR Effect 执行'
  }
}

export function prepareManagedWorktreePullRequestEffect(
  sessionId: string
): ManagedWorktreePullRequestEffectPlanResult {
  try {
    const record = recordForSession(sessionId)
    if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
    if (record.state !== 'active' || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'worktree 已不存在或已移除' }
    }
    const capability = inspectPullRequestCapability(record.worktreePath)
    if (!capability.available) {
      return {
        ok: true,
        unavailable: true,
        message: capability.message ?? '未检测到可用的 PR/MR 工具，已跳过创建'
      }
    }
    return {
      ok: true,
      plan: {
        sessionId: record.sessionId,
        worktreePath: record.worktreePath,
        branch: record.branch,
        title: `${record.branch}: CaoGen worktree changes`,
        body: [
          `Automated pull request for CaoGen managed worktree \`${record.branch}\`.`,
          '',
          `- Base: ${record.baseBranch ?? 'detached'} (${record.baseSha.slice(0, 12)})`,
          `- Worktree: ${record.worktreePath}`
        ].join('\n'),
        ...(record.baseBranch ? { base: record.baseBranch } : {})
      }
    }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}
