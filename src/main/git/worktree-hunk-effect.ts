import { execFileSyncInExecutionEnvironment as execFileSync } from '../wsl/process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import { inspectSingleFilePatch } from './git-patch-inspection'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './safe-git'
import { resolveWritableProjectPathSync } from '../utils/safe-project-path'

const MAX_HUNK_PATCH_CHARS = 1_000_000
const MAX_HUNK_FILE_BYTES = 64 * 1024 * 1024

export interface DiscardWorkspaceHunkPlan {
  rootPath: string
  relativePath: string
  preState: 'absent' | 'file'
  preContent?: Buffer
  expectedState: 'absent' | 'file'
  expectedContent?: Buffer
}

export type DiscardWorkspaceHunkPlanResult =
  | { ok: true; plan: DiscardWorkspaceHunkPlan }
  | { ok: false; error: string }

export function planDiscardWorkspaceHunk(
  cwd: string,
  filePath: unknown,
  hunkPatch: unknown
): DiscardWorkspaceHunkPlanResult {
  try {
    const patch = normalizedPatch(hunkPatch)
    const declaredPath = typeof filePath === 'string' ? filePath : ''
    const inspection = inspectSingleFilePatch(cwd, declaredPath, patch)
    if (inspection.ok === false) return { ok: false, error: inspection.error }
    const target = resolveWritableProjectPathSync(inspection.repoRoot, inspection.relativePath)
    const preContent = readRegularFile(target.fullPath)
    const expected = applyReversePatchInSandbox(inspection.repoRoot, target.relativePath, patch, preContent)
    if (samePlannedState(preContent, expected)) {
      return { ok: false, error: '丢弃 hunk 的执行前状态与预期状态相同，已阻止空操作' }
    }
    return {
      ok: true,
      plan: {
        rootPath: target.root,
        relativePath: target.relativePath,
        preState: preContent === undefined ? 'absent' : 'file',
        ...(preContent === undefined ? {} : { preContent }),
        expectedState: expected === undefined ? 'absent' : 'file',
        ...(expected === undefined ? {} : { expectedContent: expected })
      }
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function buildDiscardWorkspaceHunkEffectTarget(
  cwd: string,
  filePath: unknown,
  hunkPatch: unknown
): EffectTarget {
  const planned = planDiscardWorkspaceHunk(cwd, filePath, hunkPatch)
  if (planned.ok === false) throw new Error(`无法冻结 discard hunk 目标:${planned.error}`)
  const plan = planned.plan
  const target = resolveWritableProjectPathSync(plan.rootPath, plan.relativePath)
  const current = readRegularFile(target.fullPath)
  if (!samePlannedState(plan.preContent, current)) {
    throw new Error('discard hunk 目标内容在规划期间发生变化')
  }
  const expected = plan.expectedContent ?? Buffer.alloc(0)
  return {
    kind: 'file_content',
    rootPath: target.root,
    rootIdentity: fileSystemIdentity(target.root),
    relativePath: target.relativePath,
    preState: current === undefined ? 'absent' : 'file',
    ...(current === undefined
      ? {}
      : {
          preFileIdentity: fileSystemIdentity(target.fullPath),
          preSha256: sha256(current),
          preBytes: current.byteLength
        }),
    expectedState: plan.expectedState,
    expectedSha256: sha256(expected),
    expectedBytes: expected.byteLength
  }
}

function normalizedPatch(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('hunk patch 不能为空')
  if (value.length > MAX_HUNK_PATCH_CHARS) throw new Error('hunk patch 过大')
  if (value.includes('\0')) throw new Error('hunk patch 包含非法 NUL 字符')
  if (/^(?:GIT binary patch|Binary files |rename (?:from|to) |copy (?:from|to) |old mode |new mode )/m.test(value)) {
    throw new Error('discard hunk 只接受单文件文本 hunk，不接受二进制、重命名、复制或模式变更')
  }
  const hunkHeaders = value.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm) ?? []
  if (hunkHeaders.length !== 1) throw new Error('discard hunk 必须且只能包含一个 unified diff hunk')
  return value.endsWith('\n') ? value : `${value}\n`
}

function applyReversePatchInSandbox(
  executionCwd: string,
  relativePath: string,
  patch: string,
  preContent: Buffer | undefined
): Buffer | undefined {
  const sandbox = mkdtempSync(join(tmpdir(), 'caogen-discard-hunk-'))
  try {
    const sandboxTarget = resolve(sandbox, relativePath)
    if (preContent !== undefined) {
      mkdirSync(dirname(sandboxTarget), { recursive: true })
      writeFileSync(sandboxTarget, preContent)
    }
    runReverseApply(executionCwd, sandbox, patch, true)
    runReverseApply(executionCwd, sandbox, patch, false)
    return readRegularFile(sandboxTarget)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

function runReverseApply(executionCwd: string, sandbox: string, patch: string, check: boolean): void {
  execFileSync(
    'git',
    withSafeLocalGitConfig([
      '-C', sandbox,
      'apply',
      '-R',
      ...(check ? ['--check'] : []),
      '--whitespace=nowarn',
      '-'
    ]),
    {
      cwd: executionCwd,
      input: patch,
      encoding: 'utf8',
      env: isolatedLocalGitEnv(process.env),
      timeout: 30_000,
      maxBuffer: MAX_HUNK_PATCH_CHARS * 20,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
}

function readRegularFile(filePath: string): Buffer | undefined {
  let before: ReturnType<typeof lstatSync>
  try {
    before = lstatSync(filePath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('discard hunk 目标必须是普通文件')
  if (before.size > BigInt(MAX_HUNK_FILE_BYTES)) {
    throw new Error(`discard hunk 目标超过自动保护上限 ${MAX_HUNK_FILE_BYTES} bytes`)
  }
  const content = readFileSync(filePath)
  const after = lstatSync(filePath, { bigint: true })
  if (
    BigInt(content.byteLength) !== before.size ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error('discard hunk 目标在规划期间发生变化')
  }
  return content
}

function samePlannedState(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.equals(right)
}

function fileSystemIdentity(filePath: string): FileSystemIdentity {
  const stats = statSync(filePath, { bigint: true })
  return { device: stats.dev.toString(), inode: stats.ino.toString() }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr
    if (text?.trim()) return text.trim()
  }
  return error instanceof Error ? error.message : String(error)
}
