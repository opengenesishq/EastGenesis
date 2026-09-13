import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import { patchSha256 } from '../worktreeMerge'

export type CodeForgePatchEffectTarget = Extract<EffectTarget, { kind: 'code_forge_patch' }>

export interface CodeForgePatchArtifactSeed {
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  patchSha256: string
  patchBytes: number
}

export type PatchArtifactObservation =
  | { state: 'absent' }
  | { state: 'file'; identity: FileSystemIdentity; sha256: string; bytes: number }

export const MAX_PATCH_ARTIFACT_BYTES = 32 * 1024 * 1024

interface OpenedArtifact {
  descriptor: number
  pathStats: Stats
}

export function codeForgePatchArtifactRoot(): {
  artifactRoot: string
  artifactRootIdentity: FileSystemIdentity
} {
  const artifactRoot = realpathSync(tmpdir())
  return { artifactRoot, artifactRootIdentity: fileSystemIdentity(artifactRoot) }
}

export function codeForgePatchArtifactPath(
  seed: CodeForgePatchArtifactSeed,
  artifactRoot: string
): string {
  const digest = digestValue({
    schema: 'code-forge-patch-v1',
    repoRoot: seed.repoRoot,
    worktreePath: seed.worktreePath,
    baseSha: seed.baseSha,
    headSha: seed.headSha,
    patchSha256: seed.patchSha256,
    patchBytes: seed.patchBytes
  })
  return path.join(artifactRoot, `caogen-code-forge-${digest}.patch`)
}

export function observeCodeForgePatchArtifact(filePath: string): PatchArtifactObservation {
  const opened = openArtifactForObservation(filePath)
  if (!opened) return { state: 'absent' }
  const { descriptor, pathStats } = opened
  try {
    const before = fstatSync(descriptor)
    assertSafeArtifactStats(before, filePath)
    assertArtifactStatsUnchanged(pathStats, before, filePath)
    const bytes = readArtifactBytes(descriptor, before.size, filePath)
    const after = fstatSync(descriptor)
    assertArtifactStatsUnchanged(before, after, filePath)
    const finalPathStats = lstatSync(filePath)
    assertSafeArtifactPathStats(finalPathStats, filePath)
    assertArtifactStatsUnchanged(after, finalPathStats, filePath)
    return {
      state: 'file',
      identity: { device: String(after.dev), inode: String(after.ino) },
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length
    }
  } finally {
    closeSync(descriptor)
  }
}

function openArtifactForObservation(filePath: string): OpenedArtifact | undefined {
  let pathStats: Stats
  try {
    pathStats = lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  assertSafeArtifactPathStats(pathStats, filePath)
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  return {
    descriptor: openSync(filePath, constants.O_RDONLY | noFollow | nonBlock),
    pathStats
  }
}

function assertSafeArtifactPathStats(info: Stats, filePath: string): void {
  if (info.isSymbolicLink()) throw new Error(`Code Forge patch artifact 不是安全的普通文件:${filePath}`)
  assertSafeArtifactStats(info, filePath)
}

function assertSafeArtifactStats(info: Stats, filePath: string): void {
  if (!info.isFile() || info.size > MAX_PATCH_ARTIFACT_BYTES) {
    throw new Error(`Code Forge patch artifact 不是安全的普通文件:${filePath}`)
  }
}

function readArtifactBytes(descriptor: number, size: number, filePath: string): Buffer {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < bytes.length) {
    const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
    if (bytesRead <= 0) throw new Error(`读取 Code Forge patch artifact 提前结束:${filePath}`)
    offset += bytesRead
  }
  return bytes
}

function assertArtifactStatsUnchanged(
  before: Stats,
  after: Stats,
  filePath: string
): void {
  assertSafeArtifactStats(after, filePath)
  const unchanged = [
    before.dev === after.dev,
    before.ino === after.ino,
    before.size === after.size,
    before.mtimeMs === after.mtimeMs,
    before.ctimeMs === after.ctimeMs
  ].every(Boolean)
  if (!unchanged) throw new Error(`读取 Code Forge patch artifact 期间文件身份变化:${filePath}`)
}

export function assertCodeForgePatchArtifactTarget(target: CodeForgePatchEffectTarget): void {
  if (target.patchBytes > MAX_PATCH_ARTIFACT_BYTES) {
    throw new Error(`Code Forge patch target 超过 ${MAX_PATCH_ARTIFACT_BYTES} 字节上限`)
  }
  const artifactRoot = realpathSync(target.artifactRoot)
  const info = lstatSync(artifactRoot)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Code Forge artifact root 不是安全目录')
  if (
    artifactRoot !== target.artifactRoot ||
    !sameIdentity(fileSystemIdentity(artifactRoot), target.artifactRootIdentity) ||
    path.dirname(target.artifactPath) !== artifactRoot ||
    target.artifactPath !== codeForgePatchArtifactPath(target, artifactRoot)
  ) {
    throw new Error('Code Forge artifact target 已偏离冻结路径或文件系统身份')
  }
}

export function publishCodeForgePatchArtifact(
  target: CodeForgePatchEffectTarget,
  patchText: string
): void {
  assertCodeForgePatchArtifactTarget(target)
  if (patchSha256(patchText) !== target.patchSha256 || Buffer.byteLength(patchText, 'utf8') !== target.patchBytes) {
    throw new Error('待写入 Code Forge patch 与冻结摘要或大小不匹配')
  }
  const temporary = path.join(target.artifactRoot, `.caogen-code-forge-${process.pid}-${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, patchText, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    assertPublishedContent(temporary, target)
    try {
      linkSync(temporary, target.artifactPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      assertPublishedContent(target.artifactPath, target)
    }
    fsyncDirectory(target.artifactRoot)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function assertPublishedContent(filePath: string, target: CodeForgePatchEffectTarget): void {
  const state = observeCodeForgePatchArtifact(filePath)
  if (state.state !== 'file' || state.sha256 !== target.patchSha256 || state.bytes !== target.patchBytes) {
    throw new Error('Code Forge patch 发布文件未满足冻结摘要')
  }
}

function digestValue(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function fileSystemIdentity(filePath: string): FileSystemIdentity {
  const info = statSync(filePath)
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // Some platforms do not support directory fsync; the file is durable before publication.
  }
}
