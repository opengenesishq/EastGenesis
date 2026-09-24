import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { EffectTarget, FileSystemIdentity, GitOperationResult } from '../../shared/types'
import {
  persistGitIndexArtifact,
  promoteGitIndexArtifactObjects,
  readFrozenGitIndexArtifact,
  type FrozenGitIndexArtifact,
  type GitIndexArtifactView
} from './git-index-artifact'
import {
  assertSafeNormalizedGitIndexInput,
  normalizeGitIndexPatch,
  normalizeGitIndexRequest,
  type GitIndexBuildRequest,
  type GitIndexInputCommands,
  type GitIndexOperation,
  type NormalizedGitIndexRequest
} from './git-index-input'
import {
  gitAlternateObjectDirectories,
  isolatedLocalGitEnv,
  withSafeIndexGitConfig
} from './safe-git'

export type GitIndexUpdateTarget = Extract<EffectTarget, { kind: 'git_index_update' }>
export type { GitIndexBuildRequest, GitIndexOperation } from './git-index-input'
export interface GitIndexObservation {
  identityMatches: boolean
  headMatches: boolean
  entriesDigest?: string
  indexState?: IndexFileState
  error?: string
}
interface RepositoryContext {
  repoRoot: string
  repoRootIdentity: FileSystemIdentity
  gitCommonDir: string
  gitCommonDirIdentity: FileSystemIdentity
  worktreeGitDir: string
  worktreeGitDirIdentity: FileSystemIdentity
  objectDir: string
  objectDirIdentity: FileSystemIdentity
  objectFormat: 'sha1' | 'sha256'
  indexPath: string
  preHeadState: 'commit' | 'unborn'
  preHead?: string
  headRef?: string
}
interface IndexFileState {
  state: 'absent' | 'file'
  identity?: FileSystemIdentity
  sha256?: string
  bytes?: number
}

const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const MAX_INDEX_BYTES = 64 * 1024 * 1024
const EMPTY_HOOKS_DIR = createEmptyHooksDirectory()
const inputCommands: GitIndexInputCommands = {
  environment: actualIndexEnvironment,
  text: gitText,
  buffer: gitBuffer
}

export function buildGitIndexUpdateTarget(request: GitIndexBuildRequest): GitIndexUpdateTarget {
  const context = inspectRepository(request.cwd)
  const normalized = normalizeGitIndexRequest(context.repoRoot, request, inputCommands)
  assertSafeNormalizedGitIndexInput(context.repoRoot, normalized, inputCommands)
  const preIndex = inspectIndexFile(context.indexPath)
  const preEntriesDigest = observeIndexEntries(context.repoRoot, actualIndexEnvironment())
  const artifact = planExpectedIndex(context, normalized, preIndex, preEntriesDigest)
  return {
    kind: 'git_index_update',
    ...context,
    preIndexState: preIndex.state,
    ...(preIndex.identity ? { preIndexIdentity: preIndex.identity } : {}),
    ...(preIndex.sha256 ? { preIndexSha256: preIndex.sha256 } : {}),
    ...(preIndex.bytes !== undefined ? { preIndexBytes: preIndex.bytes } : {}),
    preIndexEntriesDigest: preEntriesDigest,
    expectedIndexEntriesDigest: artifact.expectedIndexEntriesDigest,
    operation: normalized.operation,
    paths: normalized.paths,
    worktreeReadScope: normalized.worktreeReadScope,
    ...(normalized.scopePath ? { scopePath: normalized.scopePath } : {}),
    ...(normalized.patch ? {
      patchSha256: sha256(Buffer.from(normalized.patch, 'utf8')),
      patchBytes: Buffer.byteLength(normalized.patch, 'utf8')
    } : {}),
    ...artifact.view
  }
}

export function assertGitIndexUpdateTargetInput(
  target: GitIndexUpdateTarget,
  request: GitIndexBuildRequest
): void {
  if (request.operation !== target.operation) {
    throw new Error('Git index Effect toolName 与冻结目标操作不一致')
  }
  const current = inspectRepository(request.cwd)
  if (!repositoryIdentityMatches(target, current)) {
    throw new Error('Git index 调用 cwd 与冻结仓库或 worktree 身份不一致')
  }
  if (!headStateMatches(target, current)) {
    throw new Error('Git index 调用 cwd 的 HEAD 与冻结目标不一致')
  }
  const normalized = normalizeGitIndexRequest(current.repoRoot, request, inputCommands)
  assertSafeNormalizedGitIndexInput(current.repoRoot, normalized, inputCommands)
  if (!sameStringArray(normalized.paths, target.paths)) {
    throw new Error('Git index 调用路径与冻结目标不一致')
  }
  if (
    normalized.worktreeReadScope !== target.worktreeReadScope ||
    normalized.scopePath !== target.scopePath
  ) {
    throw new Error('Git index 调用 worktree scope 与冻结目标不一致')
  }
  const patchBytes = normalized.patch === undefined
    ? undefined
    : Buffer.byteLength(normalized.patch, 'utf8')
  const patchSha256 = normalized.patch === undefined
    ? undefined
    : sha256(Buffer.from(normalized.patch, 'utf8'))
  if (patchBytes !== target.patchBytes || patchSha256 !== target.patchSha256) {
    throw new Error('Git index 调用 patch 与冻结目标不一致')
  }
}

export function executeGitIndexUpdateTarget(
  target: GitIndexUpdateTarget,
  patch?: unknown
): GitOperationResult {
  try {
    const normalizedPatch = target.operation === 'apply_cached_hunk' ? normalizeGitIndexPatch(patch) : undefined
    if (target.patchSha256 && sha256(Buffer.from(normalizedPatch ?? '', 'utf8')) !== target.patchSha256) {
      throw new Error('hunk patch artifact 与冻结意图不一致')
    }
    const artifact = readFrozenGitIndexArtifact(target)
    assertFrozenIndexEntries(target.repoRoot, target.objectDir, artifact.indexBytes, target.expectedIndexEntriesDigest)
    promoteGitIndexArtifactObjects(target, artifact)
    replaceIndexWithArtifact(target, artifact)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function observeGitIndexUpdateTarget(target: GitIndexUpdateTarget): GitIndexObservation {
  try {
    const current = inspectRepository(target.repoRoot)
    const identityMatches = repositoryIdentityMatches(target, current)
    const headMatches = headStateMatches(target, current)
    if (!identityMatches || !headMatches) return { identityMatches, headMatches }
    return {
      identityMatches: true,
      headMatches: true,
      entriesDigest: observeIndexEntries(current.repoRoot, actualIndexEnvironment()),
      indexState: inspectIndexFile(current.indexPath)
    }
  } catch (error) {
    return { identityMatches: false, headMatches: false, error: errorMessage(error) }
  }
}

function inspectRepository(cwd: string): RepositoryContext {
  const env = actualIndexEnvironment()
  const repoRoot = realpathSync(gitText(cwd, ['rev-parse', '--show-toplevel'], env))
  const gitCommonDir = realpathSync(gitText(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env))
  const worktreeGitDir = realpathSync(gitText(repoRoot, ['rev-parse', '--absolute-git-dir'], env))
  const objectDir = realpathSync(gitText(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], env))
  const indexPath = resolve(gitText(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], env))
  const objectFormat = gitText(repoRoot, ['rev-parse', '--show-object-format'], env)
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error(`不支持 Git object format:${objectFormat}`)
  const headRef = tryGitText(repoRoot, ['symbolic-ref', '--quiet', 'HEAD'], env)
  const preHead = tryGitText(repoRoot, ['rev-parse', '--verify', 'HEAD'], env)
  if (!preHead && !headRef) throw new Error('无法确认 Git HEAD 或 unborn branch')
  return {
    repoRoot,
    repoRootIdentity: fileSystemIdentity(repoRoot),
    gitCommonDir,
    gitCommonDirIdentity: fileSystemIdentity(gitCommonDir),
    worktreeGitDir,
    worktreeGitDirIdentity: fileSystemIdentity(worktreeGitDir),
    objectDir,
    objectDirIdentity: fileSystemIdentity(objectDir),
    objectFormat,
    indexPath,
    preHeadState: preHead ? 'commit' : 'unborn',
    ...(preHead ? { preHead } : {}),
    ...(headRef ? { headRef } : {})
  }
}

function planExpectedIndex(
  context: RepositoryContext,
  request: NormalizedGitIndexRequest,
  preIndex: IndexFileState,
  preEntriesDigest: string
): { expectedIndexEntriesDigest: string; view: GitIndexArtifactView } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'caogen-index-plan-'))
  try {
    const tempIndex = join(tempRoot, 'index')
    const tempObjects = join(tempRoot, 'objects')
    mkdirSync(tempObjects, { recursive: true, mode: 0o700 })
    copyIndexForPlanning(context, preIndex, tempRoot, tempIndex)
    const env = planningEnvironment(context.objectDir, tempIndex, tempObjects)
    const copiedDigest = observeIndexEntries(context.repoRoot, env)
    if (copiedDigest !== preEntriesDigest) throw new Error('复制 Git index 期间状态发生变化')
    assertPlannedPathScope(context.repoRoot, request, env)
    runPlannedOperation(context, request, env)
    gitBuffer(context.repoRoot, ['update-index', '--no-split-index'], env)
    const expectedIndexEntriesDigest = observeIndexEntries(context.repoRoot, env)
    if (expectedIndexEntriesDigest === preEntriesDigest) throw new Error('Git index 操作没有产生变化')
    const indexBytes = readBoundedFile(tempIndex, MAX_INDEX_BYTES, '预期 Git index')
    const view = persistGitIndexArtifact({
      repoRoot: context.repoRoot,
      worktreeGitDir: context.worktreeGitDir,
      preHead: context.preHead,
      headRef: context.headRef,
      preIndexState: preIndex.state,
      preIndexSha256: preIndex.sha256,
      preEntriesDigest,
      expectedEntriesDigest: expectedIndexEntriesDigest,
      operation: request.operation,
      paths: request.paths,
      scopePath: request.scopePath,
      patchSha256: request.patch ? sha256(Buffer.from(request.patch, 'utf8')) : undefined
    }, indexBytes, tempObjects)
    const persistedIndex = readBoundedFile(view.indexArtifactPath, MAX_INDEX_BYTES, 'Git index artifact')
    if (sha256(persistedIndex) !== view.indexArtifactSha256) throw new Error('Git index artifact 已变化')
    assertFrozenIndexEntries(context.repoRoot, context.objectDir, persistedIndex, expectedIndexEntriesDigest)
    return { expectedIndexEntriesDigest, view }
  } finally {
    removeTemporaryGitDirectory(tempRoot)
  }
}

function assertPlannedPathScope(
  repoRoot: string,
  request: NormalizedGitIndexRequest,
  env: NodeJS.ProcessEnv
): void {
  if (request.operation !== 'stage_paths' && request.operation !== 'unstage_paths') return
  const tracked = gitBuffer(repoRoot, ['ls-files', '-z'], env).toString('utf8').split('\0').filter(Boolean)
  for (const candidate of request.paths) {
    const absolute = resolve(repoRoot, candidate)
    if (existsSync(absolute) && lstatSync(absolute).isDirectory()) {
      throw new Error(`Git index 操作不接受目录 pathspec:${candidate}`)
    }
    if (tracked.some((entry) => entry.startsWith(`${candidate}/`))) {
      throw new Error(`Git index 操作不接受目录 pathspec:${candidate}`)
    }
  }
}

function copyIndexForPlanning(
  context: RepositoryContext,
  preIndex: IndexFileState,
  tempRoot: string,
  tempIndex: string
): void {
  if (preIndex.state === 'file') copyFileSync(context.indexPath, tempIndex)
  const sharedIndex = tryGitText(context.repoRoot, ['rev-parse', '--path-format=absolute', '--shared-index-path'], actualIndexEnvironment())
  if (sharedIndex && existsSync(sharedIndex)) copyFileSync(sharedIndex, join(tempRoot, basename(sharedIndex)))
}

function runPlannedOperation(context: RepositoryContext, request: NormalizedGitIndexRequest, env: NodeJS.ProcessEnv): void {
  if (request.operation === 'stage_paths') gitBuffer(context.repoRoot, ['add', '--', ...request.paths], env)
  else if (request.operation === 'stage_all') gitBuffer(context.repoRoot, ['add', '-A', '--', request.scopePath ?? '.'], env)
  else if (request.operation === 'unstage_paths' && context.preHeadState === 'unborn') {
    gitBuffer(context.repoRoot, ['update-index', '--force-remove', '--', ...request.paths], env)
  } else if (request.operation === 'unstage_paths') {
    gitBuffer(context.repoRoot, ['restore', `--source=${context.preHead}`, '--staged', '--', ...request.paths], env)
  } else gitBuffer(context.repoRoot, ['apply', '--cached', '--whitespace=nowarn'], env, Buffer.from(request.patch ?? '', 'utf8'))
}

function replaceIndexWithArtifact(target: GitIndexUpdateTarget, artifact: FrozenGitIndexArtifact): void {
  const lockPath = `${target.indexPath}.lock`
  let descriptor: number | undefined, ownsLock = false, renamed = false
  try {
    descriptor = openSync(lockPath, 'wx', 0o666)
    ownsLock = true
    assertExecutionPrecondition(target)
    if (artifact.manifest.indexSha256 !== target.indexArtifactSha256) throw new Error('Git index artifact manifest 不一致')
    writeFileSync(descriptor, artifact.indexBytes)
    try {
      fsyncSync(descriptor)
    } catch (error) {
      if (process.platform !== 'win32' || !isWindowsFsyncPermissionError(error)) throw error
      closeSync(descriptor)
      descriptor = undefined
      const retryDescriptor = openSync(lockPath, 'r+')
      try {
        fsyncSync(retryDescriptor)
      } finally {
        closeSync(retryDescriptor)
      }
    }
    if (descriptor !== undefined) {
      closeSync(descriptor)
      descriptor = undefined
    }
    renameSync(lockPath, target.indexPath)
    renamed = true
    fsyncDirectory(dirname(target.indexPath))
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (ownsLock && !renamed && existsSync(lockPath)) unlinkSync(lockPath)
  }
}

function isWindowsFsyncPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
}

function assertExecutionPrecondition(target: GitIndexUpdateTarget): void {
  const current = inspectRepository(target.repoRoot)
  if (!repositoryIdentityMatches(target, current)) throw new Error('Git index 仓库身份已变化')
  if (!headStateMatches(target, current)) throw new Error('Git HEAD 已变化')
  const index = inspectIndexFile(current.indexPath)
  if (!indexFileStateMatchesTarget(index, target)) throw new Error('Git index 原始文件状态已变化')
  const entriesDigest = observeIndexEntries(current.repoRoot, actualIndexEnvironment())
  if (entriesDigest !== target.preIndexEntriesDigest) throw new Error('Git index entries 已变化')
}

function repositoryIdentityMatches(target: GitIndexUpdateTarget, current: RepositoryContext): boolean {
  return [
    target.repoRoot === current.repoRoot,
    target.gitCommonDir === current.gitCommonDir,
    target.worktreeGitDir === current.worktreeGitDir,
    target.objectDir === current.objectDir,
    sameIdentity(target.repoRootIdentity, current.repoRootIdentity),
    sameIdentity(target.gitCommonDirIdentity, current.gitCommonDirIdentity),
    sameIdentity(target.worktreeGitDirIdentity, current.worktreeGitDirIdentity),
    sameIdentity(target.objectDirIdentity, current.objectDirIdentity),
    target.indexPath === current.indexPath,
    target.objectFormat === current.objectFormat
  ].every(Boolean)
}

function headStateMatches(target: GitIndexUpdateTarget, current: RepositoryContext): boolean {
  return target.preHeadState === current.preHeadState && target.preHead === current.preHead && target.headRef === current.headRef
}

export function indexFileStateMatchesTarget(state: IndexFileState, target: GitIndexUpdateTarget): boolean {
  if (state.state !== target.preIndexState) return false
  if (state.state === 'absent') return true
  return [
    target.preIndexIdentity && state.identity && sameIdentity(target.preIndexIdentity, state.identity),
    state.sha256 === target.preIndexSha256,
    state.bytes === target.preIndexBytes
  ].every(Boolean)
}

function inspectIndexFile(indexPath: string): IndexFileState {
  if (!existsSync(indexPath)) return { state: 'absent' }
  const info = lstatSync(indexPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Git index 不是普通文件')
  if (info.size > MAX_INDEX_BYTES) throw new Error(`Git index 超过 ${MAX_INDEX_BYTES} bytes 上限`)
  const bytes = readFileSync(indexPath)
  const after = lstatSync(indexPath)
  if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size) throw new Error('读取 Git index 期间文件身份变化')
  return { state: 'file', identity: fileSystemIdentity(indexPath), sha256: sha256(bytes), bytes: bytes.byteLength }
}

function observeIndexEntries(repoRoot: string, env: NodeJS.ProcessEnv): string {
  return sha256(gitBuffer(repoRoot, ['ls-files', '--stage', '-z'], env))
}

function actualIndexEnvironment(): NodeJS.ProcessEnv {
  const env = isolatedLocalGitEnv(process.env)
  env.GIT_LITERAL_PATHSPECS = '1'
  return env
}

function planningEnvironment(
  objectDir: string,
  tempIndex: string,
  tempObjects: string
): NodeJS.ProcessEnv {
  const env = actualIndexEnvironment()
  env.GIT_INDEX_FILE = tempIndex
  env.GIT_OBJECT_DIRECTORY = tempObjects
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = gitAlternateObjectDirectories([objectDir])
  return env
}

function assertFrozenIndexEntries(
  repoRoot: string,
  objectDir: string,
  indexBytes: Buffer,
  expectedDigest: string
): void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'caogen-index-verify-'))
  try {
    const tempIndex = join(tempRoot, 'index')
    const tempObjects = join(tempRoot, 'objects')
    mkdirSync(tempObjects, { recursive: true, mode: 0o700 })
    writeFileSync(tempIndex, indexBytes, { flag: 'wx', mode: 0o600 })
    const observed = observeIndexEntries(repoRoot, planningEnvironment(objectDir, tempIndex, tempObjects))
    if (observed !== expectedDigest) throw new Error('Git index artifact entries 与冻结预期不一致')
  } finally {
    removeTemporaryGitDirectory(tempRoot)
  }
}

function removeTemporaryGitDirectory(root: string): void {
  if (process.platform === 'win32' && existsSync(root)) makeTemporaryGitFilesWritable(root)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

function makeTemporaryGitFilesWritable(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) makeTemporaryGitFilesWritable(join(path, entry))
  }
  chmodSync(path, info.isDirectory() ? 0o700 : 0o600)
}

function gitText(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return gitBuffer(cwd, args, env).toString('utf8').trim()
}

function tryGitText(cwd: string, args: string[], env: NodeJS.ProcessEnv): string | undefined {
  try {
    return gitText(cwd, args, env) || undefined
  } catch {
    return undefined
  }
}

function gitBuffer(cwd: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Buffer {
  const result = spawnSync('git', withSafeIndexGitConfig(args, EMPTY_HOOKS_DIR), {
    cwd,
    env,
    input,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '')
  if (result.status !== 0) throw new Error((stderr || `git 退出码 ${result.status}`).trim())
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '')
}

function readBoundedFile(path: string, maxBytes: number, label: string): Buffer {
  const info = statSync(path)
  if (!info.isFile() || info.size > maxBytes) throw new Error(`${label} 不是普通文件或超过大小上限`)
  return readFileSync(path)
}

function fsyncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // Directory fsync is unavailable on some platforms; file fsync and atomic rename still apply.
  }
}

function createEmptyHooksDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'caogen-empty-index-hooks-'))
  try {
    statSync(path).mode
  } catch {
    throw new Error('无法创建可信空 hooks 目录')
  }
  return path
}

function fileSystemIdentity(path: string): FileSystemIdentity {
  const info = statSync(path)
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
