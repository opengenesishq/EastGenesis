import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats
} from 'node:fs'
import path from 'node:path'
import {
  isolatedLocalGitEnv,
  unsafeMergeConfigKeys,
  withSafeLocalGitConfig
} from '../git/safe-git'

export interface CodeForgeUntrackedFileObservation {
  path: string
  bytes: number
  lines: number
  device: string
  inode: string
  mtimeMs: number
  ctimeMs: number
}

const GIT_TIMEOUT_MS = 120_000
const MAX_CONFIG_BUFFER = 4 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export function assertNoExecutableCodeForgeFilters(cwd: string): void {
  const result = spawnSync(
    'git',
    withSafeLocalGitConfig(['config', '--includes', '-z', '--list']),
    {
      cwd,
      env: isolatedLocalGitEnv(process.env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_CONFIG_BUFFER
    }
  )
  if (result.error || result.status !== 0) {
    throw new Error('Code Forge 无法安全检查 Git filter 配置')
  }
  const output = typeof result.stdout === 'string' ? result.stdout : ''
  const filters = unsafeMergeConfigKeys(output).filter((key) =>
    /^filter\..+\.(?:clean|smudge|process)$/i.test(key)
  )
  if (filters.length > 0) {
    throw new Error(`仓库配置了可执行 Git filter，已阻止 Code Forge 读取:${filters.join(', ')}`)
  }
}

export function assertNoExecutableCodeForgeFiltersIn(cwds: readonly string[]): void {
  const checked = new Set<string>()
  for (const cwd of cwds) {
    const canonical = realpathSync(cwd)
    if (checked.has(canonical)) continue
    assertNoExecutableCodeForgeFilters(canonical)
    checked.add(canonical)
  }
}

export function inspectCodeForgeUntrackedFiles(
  root: string,
  paths: readonly string[],
  maxBytes: number
): CodeForgeUntrackedFileObservation[] {
  const canonicalRoot = realpathSync(root)
  const uniquePaths = [...new Set(paths)].sort()
  const observations: CodeForgeUntrackedFileObservation[] = []
  let aggregateBytes = 0
  for (const relativePath of uniquePaths) {
    const observation = inspectUntrackedFile(canonicalRoot, relativePath, maxBytes)
    aggregateBytes += observation.bytes
    if (aggregateBytes > maxBytes) {
      throw new Error(`Code Forge 未跟踪文件聚合大小超过 ${maxBytes} 字节上限`)
    }
    observations.push(observation)
  }
  return observations
}

export function assertCodeForgeUntrackedFileUnchanged(
  root: string,
  observation: CodeForgeUntrackedFileObservation,
  maxBytes: number
): void {
  const absolutePath = safeAbsolutePath(realpathSync(root), observation.path)
  const info = lstatSync(absolutePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error(`Code Forge 未跟踪路径不是安全的普通文件:${observation.path}`)
  }
  if (
    String(info.dev) !== observation.device ||
    String(info.ino) !== observation.inode ||
    info.size !== observation.bytes ||
    info.mtimeMs !== observation.mtimeMs ||
    info.ctimeMs !== observation.ctimeMs
  ) {
    throw new Error(`Code Forge 未跟踪文件在观察后发生变化:${observation.path}`)
  }
}

function inspectUntrackedFile(
  root: string,
  relativePath: string,
  maxBytes: number
): CodeForgeUntrackedFileObservation {
  const absolutePath = safeAbsolutePath(root, relativePath)
  const before = lstatSync(absolutePath)
  assertSafeUntrackedStats(before, relativePath, maxBytes)

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  const descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow | nonBlock)
  try {
    const opened = fstatSync(descriptor)
    assertOpenedUntrackedFile(before, opened, relativePath, maxBytes, '打开时')
    const lines = countLinesBounded(descriptor, opened.size, relativePath)
    const after = fstatSync(descriptor)
    assertOpenedUntrackedFile(opened, after, relativePath, maxBytes, '读取期间')
    return {
      path: relativePath,
      bytes: after.size,
      lines,
      device: String(after.dev),
      inode: String(after.ino),
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs
    }
  } finally {
    closeSync(descriptor)
  }
}

function assertSafeUntrackedStats(
  info: Stats,
  relativePath: string,
  maxBytes: number
): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Code Forge 未跟踪路径不是安全的普通文件:${relativePath}`)
  }
  if (info.size > maxBytes) {
    throw new Error(`Code Forge 未跟踪文件超过 ${maxBytes} 字节上限:${relativePath}`)
  }
}

function assertOpenedUntrackedFile(
  expected: Stats,
  observed: Stats,
  relativePath: string,
  maxBytes: number,
  phase: string
): void {
  if (!observed.isFile() || observed.size > maxBytes || !sameFile(expected, observed)) {
    throw new Error(`Code Forge 未跟踪文件${phase}身份发生变化:${relativePath}`)
  }
}

function countLinesBounded(descriptor: number, expectedBytes: number, relativePath: string): number {
  if (expectedBytes === 0) return 0
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, expectedBytes))
  let offset = 0
  let newlines = 0
  let lastByte = -1
  let binary = false
  while (offset < expectedBytes) {
    const requested = Math.min(buffer.length, expectedBytes - offset)
    const bytesRead = readSync(descriptor, buffer, 0, requested, offset)
    if (bytesRead <= 0) throw new Error(`Code Forge 未跟踪文件读取提前结束:${relativePath}`)
    for (let index = 0; index < bytesRead; index += 1) {
      const value = buffer[index]
      if (value === 0) binary = true
      if (value === 0x0a) newlines += 1
      lastByte = value
    }
    offset += bytesRead
  }
  if (binary) return 0
  return newlines + (lastByte === 0x0a ? 0 : 1)
}

function safeAbsolutePath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new Error('Code Forge 未跟踪文件路径非法')
  }
  const absolutePath = path.resolve(root, relativePath)
  const relative = path.relative(root, absolutePath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Code Forge 未跟踪文件路径越出仓库')
  }
  const parent = path.dirname(absolutePath)
  if (realpathSync(parent) !== parent) {
    throw new Error(`Code Forge 未跟踪文件父路径包含符号链接:${relativePath}`)
  }
  return absolutePath
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}
