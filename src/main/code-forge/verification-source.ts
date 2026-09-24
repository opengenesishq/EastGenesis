import { spawnSyncInExecutionEnvironment as spawnSync } from '../wsl/process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from '../git/safe-git'
import { stableValueDigest } from '../task/tool-idempotency'

export interface CodeForgeSourceVersion {
  schemaVersion: 1
  cwd: string
  root: string
  rootIdentity: string
  head: string
  digest: string
  files: number
  scope: 'tracked-and-nonignored-untracked'
}

/** Content is read directly: Git assume-unchanged/sparse flags cannot hide edits. */
export function observeCodeForgeSourceVersion(cwd: string): CodeForgeSourceVersion {
  const canonicalCwd = realpathSync(cwd)
  const root = realpathSync(git(canonicalCwd, ['rev-parse', '--show-toplevel']).trim())
  const rootIdentity = stableValueDigest(identity(lstatSync(root)))
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim()
  const inventory = sourceInventory(root)
  const observations: Array<{ path: string; stat?: Stats; value: unknown }> = []
  let total = 0
  for (const entry of inventory.files) {
    if (entry.mode === '160000') throw new Error('含子模块的源码尚不能生成完整验证版本')
    const file = resolve(root, entry.path)
    if (isAbsolute(entry.path) || relative(root, file).startsWith(`..${sep}`) || file === root) throw new Error('源码路径越界')
    let stat: Stats
    try { stat = lstatSync(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      observations.push({ path: file, value: { path: entry.path, absent: true } }); continue
    }
    if (realpathSync(dirname(file)) !== dirname(file)) throw new Error('源码父目录包含符号链接')
    total += stat.size
    if (total > 256 * 1024 * 1024 || inventory.files.length > 25_000) throw new Error('源码超出验证版本采集上限')
    let digest: string
    if (stat.isSymbolicLink()) digest = sha(readlinkSync(file))
    else {
      if (!stat.isFile()) throw new Error('源码包含非普通文件')
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (!sameStat(stat, fstatSync(fd))) throw new Error('源码在打开前发生变化')
        digest = sha(readFileSync(fd))
        if (!sameStat(stat, fstatSync(fd))) throw new Error('源码在读取时发生变化')
      } finally { closeSync(fd) }
    }
    observations.push({ path: file, stat, value: { path: entry.path, mode: stat.mode, digest } })
  }
  for (const entry of observations) {
    let current: Stats | undefined
    try { current = lstatSync(entry.path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (Boolean(current) !== Boolean(entry.stat) || (current && entry.stat && !sameStat(current, entry.stat))) throw new Error('源码在版本采集期间发生变化')
  }
  if (stableValueDigest(sourceInventory(root)) !== stableValueDigest(inventory) || git(root, ['rev-parse', '--verify', 'HEAD']).trim() !== head ||
      stableValueDigest(identity(lstatSync(root))) !== rootIdentity) throw new Error('Git 版本在采集期间发生变化')
  return { schemaVersion: 1, cwd: canonicalCwd, root, rootIdentity, head,
    digest: stableValueDigest({ head, index: inventory.index, files: observations.map((entry) => entry.value) }),
    files: observations.length, scope: 'tracked-and-nonignored-untracked' }
}

function sourceInventory(root: string): { index: string; files: Array<{ path: string; mode?: string }> } {
  const index = git(root, ['ls-files', '--stage', '-z'])
  const files = new Map<string, { path: string; mode?: string }>()
  for (const record of index.split('\0').filter(Boolean)) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(record)
    if (!match || match[2] !== '0') throw new Error('Git index 含冲突或无法识别的记录')
    files.set(match[3], { path: match[3], mode: match[1] })
  }
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) files.set(file, { path: file })
  return { index, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) }
}
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', withSafeLocalGitConfig(args), { cwd, env: isolatedLocalGitEnv(process.env), encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error('无法读取 Git 源码版本')
  return result.stdout
}
function identity(stat: Stats): unknown { return { device: stat.dev, inode: stat.ino } }
function sameStat(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs }
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
