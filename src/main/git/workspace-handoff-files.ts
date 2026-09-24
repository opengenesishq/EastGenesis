import { execFileSyncInExecutionEnvironment as execFileSync } from '../wsl/process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './safe-git'
import { writeDurableFileSync } from '../durable-file'

export interface HandoffFile { path: string; kind: 'file' | 'symlink'; sha256: string; mode: number; bytes: number }
export interface HandoffFiles {
  root: string; identity: string; commonDir: string; head: string; ref: string | null
  indexTree: string; files: HandoffFile[]; digest: string
}
const MAX_BYTES = 512 * 1024 * 1024
const MAX_FILES = 30000
export function handoffHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export function handoffGit(root: string, args: string[], indexPath?: string): string {
  return execFileSync('git', withSafeLocalGitConfig(args), { cwd: root, encoding: 'utf8', timeout: 120000,
    maxBuffer: 128 * 1024 * 1024, env: { ...isolatedLocalGitEnv(process.env), ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
}
function handoffIndexTree(root: string): string {
  const gitDir = resolve(root, handoffGit(root, ['rev-parse', '--git-dir']))
  const copy = join(gitDir, `caogen-handoff-read-index-${randomUUID()}`)
  try {
    writeDurableFileSync(copy, readFileSync(join(gitDir, 'index')), { replace: false })
    return handoffGit(root, ['write-tree'], copy)
  } finally { if (existsSync(copy)) unlinkSync(copy) }
}
export function handoffRepository(cwd: string): string { return realpathSync(handoffGit(cwd, ['rev-parse', '--show-toplevel'])) }
export function captureHandoffFiles(cwd: string, blobsRoot: string): HandoffFiles {
  const root = handoffRepository(cwd), gitDir = resolve(root, handoffGit(root, ['rev-parse', '--git-dir']))
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
    if (existsSync(join(gitDir, marker))) throw new Error('请先完成当前 Git 操作，再交接工作目录。')
  }
  const entries = handoffGit(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)
  if (entries.some(line => line.startsWith('160000 ') || !/^[0-9]{6} [a-f0-9]+ 0\t/.test(line))) {
    throw new Error('当前仓库含未解决冲突或 Git 子模块；请先处理后再交接。')
  }
  const before = handoffGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const head = handoffGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const indexTree = handoffIndexTree(root)
  const paths = [...new Set(handoffGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort()
  if (paths.length > MAX_FILES) throw new Error('当前文件过多，请先将依赖或生成缓存加入 .gitignore 再交接。')
  let bytes = 0
  const files: HandoffFile[] = []
  for (const path of paths) {
    const value = readHandoffFile(root, path)
    if (!value) continue
    bytes += value.entry.bytes
    if (bytes > MAX_BYTES) throw new Error('当前未忽略文件超过 512 MB，请先整理缓存再交接。')
    const blob = join(blobsRoot, value.entry.sha256)
    if (!existsSync(blob)) writeDurableFileSync(blob, value.content, { replace: false })
    else if (sha(readFileSync(blob)) !== value.entry.sha256) throw new Error('交接文件备份损坏。')
    files.push(value.entry)
  }
  if (before !== handoffGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ||
      head !== handoffGit(root, ['rev-parse', 'HEAD']) || indexTree !== handoffIndexTree(root)) {
    throw new Error('文件或 Git 状态在准备交接期间发生变化，请重试。')
  }
  const body = { root, identity: directoryIdentity(root), commonDir: realpathSync(resolve(root, handoffGit(root, ['rev-parse', '--git-common-dir']))),
    head, ref: gitRef(root), indexTree, files }
  return { ...body, digest: stateDigest(body) }
}
export function sameHandoffContents(a: HandoffFiles, b: HandoffFiles): boolean {
  return a.head === b.head && a.indexTree === b.indexTree && handoffHash(a.files) === handoffHash(b.files)
}
export function assertHandoffFilesCurrent(snapshot: HandoffFiles): void {
  assertTopology(snapshot)
  if (handoffGit(snapshot.root, ['rev-parse', 'HEAD']) !== snapshot.head || handoffIndexTree(snapshot.root) !== snapshot.indexTree) throw new Error('Git 状态在交接期间发生变化。')
  assertFileSet(snapshot.root, snapshot.files)
}
export function transferHandoffFiles(source: HandoffFiles, target: HandoffFiles, blobsRoot: string): void {
  assertHandoffFilesCurrent(source)
  assertTopology(target)
  if (source.commonDir !== target.commonDir) throw new Error('交接两端不属于同一个 Git 仓库。')
  const gitDir = resolve(target.root, handoffGit(target.root, ['rev-parse', '--git-dir']))
  const indexLock = join(gitDir, 'index.lock')
  const lockBytes = Buffer.from(`caogen-workspace-handoff:${handoffHash([source.digest, target.digest])}\n`)
  // Git writers respect index.lock. A crashed handoff can reclaim only its
  // exact sentinel; an ordinary Git lock is never removed by this code.
  if (existsSync(indexLock)) {
    if (!lstatSync(indexLock).isFile() || lstatSync(indexLock).isSymbolicLink() || !readFileSync(indexLock).equals(lockBytes)) {
      throw new Error('目标 Git 索引正被其他操作使用，请稍后再交接。')
    }
  } else writeDurableFileSync(indexLock, lockBytes, { replace: false })
  try { transferLockedHandoffFiles(source, target, blobsRoot, gitDir) }
  finally {
    if (existsSync(indexLock) && lstatSync(indexLock).isFile() && !lstatSync(indexLock).isSymbolicLink() && readFileSync(indexLock).equals(lockBytes)) unlinkSync(indexLock)
  }
}
function transferLockedHandoffFiles(source: HandoffFiles, target: HandoffFiles, blobsRoot: string, gitDir: string): void {
  assertHandoffFilesCurrent(source)
  assertTopology(target)
  const head = handoffGit(target.root, ['rev-parse', 'HEAD'])
  const index = handoffIndexTree(target.root)
  if (![source.head, target.head].includes(head) || ![source.indexTree, target.indexTree].includes(index)) throw new Error('目标 Git 状态已被其他工作改变，未覆盖。')
  const expected = new Map(source.files.map(file => [file.path, file]))
  const original = new Map(target.files.map(file => [file.path, file]))
  // A restart may see any prefix of this exact write set. Only old/new bytes are admissible.
  const known = new Set([...expected.keys(), ...original.keys()])
  for (const path of trackedPaths(target.root)) if (!known.has(path)) throw new Error(`目标出现新文件，未覆盖：${path}`)
  for (const path of known) {
    const current = readHandoffFile(target.root, path)?.entry
    if (!sameFile(current, original.get(path)) && !sameFile(current, expected.get(path))) throw new Error(`目标文件已被修改，未覆盖：${path}`)
  }
  for (const path of [...known].sort((a, b) => b.length - a.length)) {
    if (expected.has(path)) continue
    const current = readHandoffFile(target.root, path)?.entry
    if (!sameFile(current, original.get(path)) && !sameFile(current, expected.get(path))) throw new Error(`目标文件在交接时被修改，未覆盖：${path}`)
    const file = safeFilePath(target.root, path)
    if (existsSync(file) || lstatOptional(file)?.isSymbolicLink()) unlinkSync(file)
    pruneParents(target.root, dirname(file))
  }
  for (const file of source.files) {
    const current = readHandoffFile(target.root, file.path)?.entry
    if (sameFile(current, file)) continue
    if (!sameFile(current, original.get(file.path))) throw new Error(`目标文件在交接时被修改，未覆盖：${file.path}`)
    const content = readFileSync(join(blobsRoot, file.sha256))
    if (sha(content) !== file.sha256 || content.byteLength !== file.bytes) throw new Error('交接备份字节校验失败。')
    const destination = safeFilePath(target.root, file.path)
    mkdirSync(dirname(destination), { recursive: true })
    if (file.kind === 'symlink') {
      const temporary = `${destination}.handoff-${randomUUID()}`
      symlinkSync(content.toString('utf8'), temporary)
      renameSync(temporary, destination)
    } else {
      writeDurableFileSync(destination, content, { mode: file.mode })
      chmodSync(destination, file.mode)
    }
  }
  const preparedIndex = join(gitDir, `caogen-handoff-index-${randomUUID()}`)
  try {
    handoffGit(target.root, ['read-tree', source.indexTree], preparedIndex)
    writeDurableFileSync(join(gitDir, 'index'), readFileSync(preparedIndex))
  } finally { if (existsSync(preparedIndex)) unlinkSync(preparedIndex) }
  if (head !== source.head) handoffGit(target.root, ['update-ref', target.ref ?? 'HEAD', source.head, head])
  assertFileSet(target.root, source.files)
  if (handoffIndexTree(target.root) !== source.indexTree || handoffGit(target.root, ['rev-parse', 'HEAD']) !== source.head) throw new Error('交接后的 Git 状态没有收敛。')
}
export function assertTransferredHandoffFiles(source: HandoffFiles, target: HandoffFiles): void {
  assertTopology(target)
  assertFileSet(target.root, source.files)
  if (handoffIndexTree(target.root) !== source.indexTree || handoffGit(target.root, ['rev-parse', 'HEAD']) !== source.head) throw new Error('交接后的 Git 状态已变化。')
}
function assertFileSet(root: string, expected: HandoffFile[]): void {
  const actual = trackedPaths(root).flatMap(path => { const item = readHandoffFile(root, path); return item ? [item.entry] : [] })
  if (handoffHash(actual) !== handoffHash(expected)) throw new Error('文件在交接期间发生变化，请先核对目录状态。')
}
function trackedPaths(root: string): string[] { return [...new Set(handoffGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort() }
function assertTopology(snapshot: HandoffFiles): void {
  if (handoffRepository(snapshot.root) !== snapshot.root || directoryIdentity(snapshot.root) !== snapshot.identity || gitRef(snapshot.root) !== snapshot.ref ||
      realpathSync(resolve(snapshot.root, handoffGit(snapshot.root, ['rev-parse', '--git-common-dir']))) !== snapshot.commonDir) throw new Error('交接目录或分支身份已变化。')
}
function gitRef(root: string): string | null { try { return handoffGit(root, ['symbolic-ref', '-q', 'HEAD']) } catch { return null } }
function directoryIdentity(path: string): string { const stat = lstatSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}` }
function stateDigest(value: Omit<HandoffFiles, 'digest'>): string { return handoffHash(value) }
function sha(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function sameFile(a?: HandoffFile, b?: HandoffFile): boolean { return handoffHash(a ?? null) === handoffHash(b ?? null) }
function lstatOptional(path: string) { try { return lstatSync(path) } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error } }
function readHandoffFile(root: string, path: string): { entry: HandoffFile; content: Buffer } | undefined {
  const target = safeFilePath(root, path), before = lstatOptional(target)
  if (!before) return undefined
  if (!before.isFile() && !before.isSymbolicLink()) throw new Error(`交接不支持此文件类型：${path}`)
  const content = before.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : readFileSync(target)
  const after = lstatSync(target)
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`文件在读取时发生变化：${path}`)
  return { entry: { path, kind: before.isSymbolicLink() ? 'symlink' : 'file', mode: before.mode & 0o777, sha256: sha(content), bytes: content.byteLength }, content }
}
function safeFilePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('交接文件路径无效。')
  const full = resolve(root, path), rel = relative(root, full)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('交接路径超出仓库。')
  let cursor = dirname(full)
  while (cursor !== root) { if (lstatOptional(cursor)?.isSymbolicLink()) throw new Error('交接父路径不能包含符号链接。'); cursor = dirname(cursor) }
  return full
}
function pruneParents(root: string, path: string): void {
  while (path !== root) { try { rmdirSync(path) } catch { return }; path = dirname(path) }
}
