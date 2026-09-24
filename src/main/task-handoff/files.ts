import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeDurableFileSync } from '../durable-file'
import { canonicalJson } from '../project-workspace/codec'

export const HANDOFF_CHUNK_BYTES = 96 * 1024
export const HANDOFF_FILE_LIMITS = { files: 20_000, bytes: 512 * 1024 * 1024, depth: 40 } as const
export interface HandoffFileEntry { path: string; kind: 'file' | 'directory'; bytes: number; sha256: string; executable: boolean; chunks: string[] }
export interface HandoffGitSnapshot { head: string; branch?: string; indexDigest: string; bundle: HandoffFileEntry; stagedPatch: HandoffFileEntry }
export interface HandoffFileManifest {
  schemaVersion: 1; entries: HandoffFileEntry[]; excluded: string[]; totalBytes: number; git?: HandoffGitSnapshot; digest: string
}
export interface HandoffDestinationGrant { id: string; root: string; identity: string; createdAt: number; expiresAt: number; enabled: boolean }
interface LocalFileSnapshot { bytes: Buffer; executable: boolean }
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-zA-Z0-9_-]{1,160}$/
const OMIT_DIRECTORIES = new Set(['node_modules', '.venv', '__pycache__'])
const OMIT_PRIVATE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$|\.(?:p12|pfx|key|pem)$/i

/** Paths are portable names, never operating-system paths supplied by a remote peer. */
export function handoffRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\0\r\n:]/.test(value) || isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('移交资料路径无效。')
  return value
}
function ensureDirectory(path: string): string {
  const full = resolve(path)
  let current = full
  while (true) {
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('移交目录包含链接或不是普通目录。')
    const parent = dirname(current); if (parent === current) break; current = parent
  }
  if (realpathSync(full) !== full) throw new Error('移交目录身份不一致。')
  return full
}
function directoryIdentity(path: string): string { const info = lstatSync(ensureDirectory(path)); return `${info.dev}:${info.ino}` }
function readRegular(path: string, maxBytes: number): LocalFileSnapshot {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > maxBytes) throw new Error('移交文件包含链接、特殊文件或超出大小限制。')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const first = fstatSync(fd)
    if (first.dev !== before.dev || first.ino !== before.ino || !first.isFile()) throw new Error('移交文件在读取前已变化。')
    const bytes = readFileSync(fd), after = fstatSync(fd)
    if (bytes.length !== first.size || after.size !== first.size || after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs) throw new Error('移交文件在读取时发生变化。')
    return { bytes, executable: (first.mode & 0o111) !== 0 }
  } finally { closeSync(fd) }
}
function git(cwd: string, args: string[], input?: Buffer): Buffer {
  // Commands only read the source; target writes operate in a newly reserved directory.
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', '-c', 'core.fsmonitor=false', ...args], {
    cwd, input, maxBuffer: HANDOFF_FILE_LIMITS.bytes, timeout: 60_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe']
  })
}
function indexDigest(cwd: string): string { return sha(git(cwd, ['ls-files', '--stage', '-z'])) }

/** Content-addressed blocks are inert bytes; importing never runs a project's code or hooks. */
export class HandoffFileStore {
  readonly root: string
  constructor(root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); this.root = ensureDirectory(root) }
  put(bytes: Buffer): string {
    if (!Buffer.isBuffer(bytes) || bytes.length > HANDOFF_CHUNK_BYTES) throw new Error('移交块大小无效。')
    const digest = sha(bytes), path = join(this.root, digest)
    if (existsSync(path)) { if (sha(readRegular(path, HANDOFF_CHUNK_BYTES).bytes) !== digest) throw new Error('已保存的移交块已损坏。') }
    else writeDurableFileSync(path, bytes, { mode: 0o600, replace: false })
    return digest
  }
  receive(digest: string, base64: string): void {
    if (!hashPattern.test(digest) || typeof base64 !== 'string' || base64.length > Math.ceil(HANDOFF_CHUNK_BYTES / 3) * 4) throw new Error('移交块无效。')
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64 || sha(bytes) !== digest) throw new Error('移交块摘要不匹配。')
    this.put(bytes)
  }
  read(digest: string): Buffer {
    if (!hashPattern.test(digest)) throw new Error('移交块摘要无效。')
    const bytes = readRegular(join(this.root, digest), HANDOFF_CHUNK_BYTES).bytes
    if (sha(bytes) !== digest) throw new Error('移交块已损坏。')
    return bytes
  }
  has(digest: string): boolean { try { this.read(digest); return true } catch { return false } }
  capture(path: string, bytes: Buffer, executable = false): HandoffFileEntry {
    handoffRelativePath(path)
    const chunks: string[] = []
    for (let start = 0; start < bytes.length; start += HANDOFF_CHUNK_BYTES) chunks.push(this.put(bytes.subarray(start, start + HANDOFF_CHUNK_BYTES)))
    return { path, kind: 'file', bytes: bytes.length, sha256: sha(bytes), executable, chunks }
  }
  content(entry: HandoffFileEntry): Buffer {
    const bytes = Buffer.concat(entry.chunks.map(digest => this.read(digest)))
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error('移交文件缺块或摘要不一致。')
    return bytes
  }
}

export function validateHandoffFileManifest(value: HandoffFileManifest): void {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > HANDOFF_FILE_LIMITS.files || !Array.isArray(value.excluded) || value.excluded.length > HANDOFF_FILE_LIMITS.files || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > HANDOFF_FILE_LIMITS.bytes) throw new Error('移交文件清单无效或超过限制。')
  const names = new Map<string, string>()
  for (const item of value.entries) {
    const path = handoffRelativePath(item.path), key = path.normalize('NFC').toLowerCase()
    if (names.has(key) || path.split('/').some(part => part.toLowerCase() === '.git')) throw new Error('移交文件名冲突或试图写入 Git 内部目录。')
    names.set(key, item.kind)
  }
  const entries = [...value.entries, ...(value.git ? [value.git.bundle, value.git.stagedPatch] : [])]
  let totalBytes = 0
  for (const item of entries) {
    handoffRelativePath(item.path)
    if (!['file', 'directory'].includes(item.kind) || typeof item.executable !== 'boolean' || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > HANDOFF_FILE_LIMITS.bytes || !hashPattern.test(item.sha256) || !Array.isArray(item.chunks) || item.chunks.some(d => typeof d !== 'string' || !hashPattern.test(d)) || item.chunks.length !== Math.ceil(item.bytes / HANDOFF_CHUNK_BYTES) || item.kind === 'directory' && (item.bytes !== 0 || item.chunks.length !== 0)) throw new Error('移交文件记录无效。')
    const segments = item.path.split('/')
    for (let index = 1; index < segments.length; index++) if (names.get(segments.slice(0, index).join('/').normalize('NFC').toLowerCase()) === 'file') throw new Error('移交文件目录重叠。')
    totalBytes += item.bytes
  }
  if (totalBytes !== value.totalBytes) throw new Error('移交文件总大小不一致。')
  for (const omitted of value.excluded) handoffRelativePath(omitted)
  if (value.git && (!/^[a-f0-9]{40,64}$/.test(value.git.head) || !hashPattern.test(value.git.indexDigest) || value.git.branch !== undefined && (!value.git.branch.startsWith('refs/heads/') || /[\0\r\n ]/.test(value.git.branch)) || value.git.bundle.kind !== 'file' || value.git.stagedPatch.kind !== 'file')) throw new Error('移交 Git 信息无效。')
  const { digest, ...manifest } = value
  if (!hashPattern.test(digest) || sha(canonicalJson(manifest)) !== digest) throw new Error('移交文件清单摘要不匹配。')
}

export function captureHandoffFiles(source: string, blocks: HandoffFileStore): HandoffFileManifest {
  const root = ensureDirectory(source), initialIdentity = directoryIdentity(root)
  const relStore = relative(root, blocks.root)
  if (relStore === '' || !relStore.startsWith('..') && !isAbsolute(relStore)) throw new Error('移交准备区必须位于工作目录之外。')
  const entries: HandoffFileEntry[] = [], excluded: string[] = []
  let totalBytes = 0
  const scan = (directory: string, prefix: string, depth: number): void => {
    if (depth > HANDOFF_FILE_LIMITS.depth) throw new Error('移交目录层级过深。')
    const identity = directoryIdentity(directory)
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name
      handoffRelativePath(path)
      if (!prefix && name === '.git') continue
      if (name === '.git') throw new Error('嵌套 Git 仓库需单独移交。')
      const absolute = join(directory, name), info = lstatSync(absolute)
      if (OMIT_PRIVATE.test(name) || name === '.DS_Store' || info.isDirectory() && OMIT_DIRECTORIES.has(name)) { excluded.push(path); continue }
      if (entries.length >= HANDOFF_FILE_LIMITS.files || excluded.length >= HANDOFF_FILE_LIMITS.files) throw new Error('移交文件数量超过上限。')
      if (info.isSymbolicLink()) throw new Error('移交包含符号链接，请先处理后再预览。')
      if (info.isDirectory()) {
        entries.push({ path, kind: 'directory', bytes: 0, sha256: sha(''), executable: false, chunks: [] }); scan(absolute, path, depth + 1)
      } else {
        const value = readRegular(absolute, HANDOFF_FILE_LIMITS.bytes - totalBytes)
        entries.push(blocks.capture(path, value.bytes, value.executable)); totalBytes += value.bytes.length
      }
    }
    if (directoryIdentity(directory) !== identity) throw new Error('移交目录在读取期间已被替换。')
  }
  scan(root, '', 0)
  let snapshot: HandoffGitSnapshot | undefined
  if (existsSync(join(root, '.git'))) {
    const head = git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim()
    const gitDir = resolve(root, git(root, ['rev-parse', '--git-dir']).toString().trim())
    if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].some(file => existsSync(join(gitDir, file))) || git(root, ['ls-files', '--unmerged']).length || existsSync(join(root, '.gitmodules'))) throw new Error('请先结束合并/变基；子模块需单独处理后移交。')
    const index = indexDigest(root)
    const indexPaths = git(root, ['ls-files', '-z']).toString().split('\0').filter(Boolean)
    if (indexPaths.some(path => path.split('/').some(part => OMIT_PRIVATE.test(part)))) throw new Error('Git 暂存区包含凭据配置文件，请先在源端整理可移交仓库。')
    const flags = git(root, ['ls-files', '-v', '-z']).toString().split('\0').filter(Boolean)
    if (flags.some(line => !line.startsWith('H '))) throw new Error('稀疏或特殊 index 标记需要先恢复为普通 Git 工作区。')
    const historyPaths = git(root, ['rev-list', '--objects', 'HEAD']).toString().split('\n').map(line => line.slice(line.indexOf(' ') + 1)).filter(path => !/^[a-f0-9]{40,64}$/.test(path))
    if (historyPaths.some(path => path.split('/').some(part => OMIT_PRIVATE.test(part)))) throw new Error('Git 历史包含凭据配置文件，请先在源端整理可移交仓库。')
    if (entries.some(entry => entry.kind === 'file' && entry.bytes < 1024 && blocks.content(entry).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'))) throw new Error('存在未下载的 Git LFS 指针，请先补齐文件内容。')
    const stagedPatchBytes = git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD'])
    let branch: string | undefined
    try { branch = git(root, ['symbolic-ref', '--quiet', 'HEAD']).toString().trim() || undefined } catch { /* detached HEAD is supported */ }
    const scratch = join(blocks.root, `bundle-${randomUUID()}`)
    git(root, ['bundle', 'create', scratch, 'HEAD', ...(branch ? [branch] : [])])
    const bundleBytes = readRegular(scratch, HANDOFF_FILE_LIMITS.bytes - totalBytes).bytes
    // Keep the immutable bundle as an inert local capture; transport uses its blocks only.
    const bundle = blocks.capture('repository.bundle', bundleBytes)
    const stagedPatch = blocks.capture('staged.patch', stagedPatchBytes)
    if (indexDigest(root) !== index || git(root, ['rev-parse', 'HEAD']).toString().trim() !== head) throw new Error('Git 状态在预览期间变化，请重新预览。')
    totalBytes += bundle.bytes + stagedPatch.bytes
    snapshot = { head, branch, indexDigest: index, bundle, stagedPatch }
  }
  if (directoryIdentity(root) !== initialIdentity) throw new Error('移交工作目录已被替换。')
  const value = { schemaVersion: 1 as const, entries, excluded, totalBytes, ...(snapshot ? { git: snapshot } : {}) }
  const manifest = { ...value, digest: sha(canonicalJson(value)) }
  validateHandoffFileManifest(manifest)
  return manifest
}

export function handoffFileChunks(manifest: HandoffFileManifest): string[] {
  validateHandoffFileManifest(manifest)
  return [...new Set([...manifest.entries, ...(manifest.git ? [manifest.git.bundle, manifest.git.stagedPatch] : [])].flatMap(entry => entry.chunks))]
}

/** Reconstruct into a reserved empty directory; activation belongs to the ownership transaction. */
export function restoreHandoffFiles(destination: string, manifest: HandoffFileManifest, blocks: HandoffFileStore): void {
  validateHandoffFileManifest(manifest)
  const root = ensureDirectory(destination), identity = directoryIdentity(root)
  if (readdirSync(root).length !== 0) throw new Error('接收目录必须为空；不会覆盖现有文件。')
  const space = statfsSync(root)
  if (space.bavail * space.bsize < manifest.totalBytes * 2 + 16 * 1024 * 1024) throw new Error('接收目录可用空间不足。')
  for (const digest of handoffFileChunks(manifest)) blocks.read(digest)
  if (manifest.git) {
    const snapshot = manifest.git, bundle = join(blocks.root, `restore-${randomUUID()}.bundle`)
    writeDurableFileSync(bundle, blocks.content(snapshot.bundle), { replace: false })
    git(root, ['init', '--quiet'])
    git(root, ['fetch', '--quiet', '--no-tags', '--update-head-ok', bundle, '+refs/heads/*:refs/heads/*', 'HEAD'])
    if (snapshot.branch) git(root, ['symbolic-ref', 'HEAD', snapshot.branch])
    else git(root, ['update-ref', '--no-deref', 'HEAD', snapshot.head])
    if (git(root, ['rev-parse', 'HEAD']).toString().trim() !== snapshot.head) throw new Error('接收 Git HEAD 与预览不一致。')
    git(root, ['read-tree', snapshot.head])
    const patch = blocks.content(snapshot.stagedPatch)
    if (patch.length) git(root, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patch)
    if (indexDigest(root) !== snapshot.indexDigest) throw new Error('接收 Git 暂存区与源记录不一致。')
  }
  for (const entry of manifest.entries) {
    const target = join(root, entry.path)
    if (directoryIdentity(root) !== identity) throw new Error('接收目录已被替换。')
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); ensureDirectory(dirname(target))
    if (entry.kind === 'directory') { mkdirSync(target, { recursive: true, mode: 0o700 }); ensureDirectory(target) }
    else writeDurableFileSync(target, blocks.content(entry), { replace: false, mode: entry.executable ? 0o700 : 0o600 })
  }
  verifyRestoredHandoffFiles(root, manifest)
}

export function verifyRestoredHandoffFiles(destination: string, manifest: HandoffFileManifest, sourceWithExclusions = false): void {
  validateHandoffFileManifest(manifest); const root = ensureDirectory(destination)
  for (const entry of manifest.entries) {
    const path = join(root, entry.path); ensureDirectory(dirname(path))
    if (entry.kind === 'directory') ensureDirectory(path)
    else { const value = readRegular(path, HANDOFF_FILE_LIMITS.bytes); if (value.bytes.length !== entry.bytes || sha(value.bytes) !== entry.sha256 || value.executable !== entry.executable) throw new Error('接收文件已变化或与清单不一致。') }
  }
  if (manifest.git && (git(root, ['rev-parse', 'HEAD']).toString().trim() !== manifest.git.head || indexDigest(root) !== manifest.git.indexDigest)) throw new Error('接收 Git 状态已变化。')
  const actual: string[] = []
  const scan = (directory: string, prefix: string): void => {
    ensureDirectory(directory)
    for (const name of readdirSync(directory)) {
      const path = prefix ? `${prefix}/${name}` : name, full = join(directory, name), info = lstatSync(full)
      if (!prefix && name === '.git' && manifest.git) continue
      if (sourceWithExclusions && manifest.excluded.includes(path)) continue
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('移交目录新增了链接或特殊文件。')
      actual.push(path); if (info.isDirectory()) scan(full, path)
    }
  }
  scan(root, '')
  if (canonicalJson(actual.sort()) !== canonicalJson(manifest.entries.map(item => item.path).sort())) throw new Error('移交文件集合已变化，请重新预览。')
}

export function verifyCurrentHandoffSource(source: string, manifest: HandoffFileManifest): void {
  verifyRestoredHandoffFiles(source, manifest, true)
  const paths: string[] = [], root = ensureDirectory(source)
  const visit = (directory: string, prefix: string): void => {
    ensureDirectory(directory)
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, full = join(directory, name), info = lstatSync(full)
      if (!prefix && name === '.git' || OMIT_PRIVATE.test(name) || name === '.DS_Store' || info.isDirectory() && OMIT_DIRECTORIES.has(name)) continue
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('来源新增链接或特殊文件，请重新预览。')
      paths.push(path); if (info.isDirectory()) visit(full, path)
    }
  }
  visit(root, '')
  if (canonicalJson(paths.sort()) !== canonicalJson(manifest.entries.map(item => item.path).sort())) throw new Error('来源文件清单已变化，请取消后重新预览。')
}

/** Only the receiving desktop can register a destination root; peers receive opaque IDs. */
export class HandoffDestinationStore {
  constructor(private root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); ensureDirectory(root) }
  list(): HandoffDestinationGrant[] {
    const path = join(this.root, 'destinations.json'); if (!existsSync(path)) return []
    const rows = JSON.parse(readRegular(path, 128 * 1024).bytes.toString()) as HandoffDestinationGrant[]
    if (!Array.isArray(rows) || rows.length > 20 || rows.some(row => !row || !idPattern.test(row.id) || typeof row.root !== 'string' || !isAbsolute(row.root) || typeof row.identity !== 'string' || typeof row.enabled !== 'boolean' || !Number.isFinite(row.expiresAt))) throw new Error('接收目录授权记录损坏。')
    return rows
  }
  add(root: string, lifetimeMs = 24 * 60 * 60_000): HandoffDestinationGrant {
    if (!Number.isFinite(lifetimeMs) || lifetimeMs < 60_000 || lifetimeMs > 7 * 24 * 60 * 60_000) throw new Error('接收授权有效期无效。')
    const rows = this.list(), target = ensureDirectory(root)
    if (rows.length >= 20) throw new Error('最多登记20个接收目录，请先关闭并移除旧目录。')
    const grant = { id: randomUUID(), root: target, identity: directoryIdentity(target), createdAt: Date.now(), expiresAt: Date.now() + lifetimeMs, enabled: true }
    rows.push(grant); this.save(rows); return grant
  }
  revoke(id: string): void { const rows = this.list(), row = rows.find(row => row.id === id); if (!row) throw new Error('接收目录授权不存在。'); row.enabled = false; this.save(rows) }
  renew(id: string): void {
    const rows = this.list(), row = rows.find(row => row.id === id)
    if (!row || directoryIdentity(row.root) !== row.identity) throw new Error('原接收目录已被替换，不能延续此授权。')
    row.enabled = true; row.expiresAt = Date.now() + 24 * 60 * 60_000; this.save(rows)
  }
  require(id: string): HandoffDestinationGrant {
    const row = this.list().find(row => row.id === id)
    if (!row?.enabled || row.expiresAt <= Date.now() || directoryIdentity(row.root) !== row.identity) throw new Error('接收目录授权已过期、被撤销或目录已替换。')
    return row
  }
  reserve(id: string, handoffId: string): string {
    if (!idPattern.test(handoffId)) throw new Error('交接标识无效。')
    const grant = this.require(id), target = join(grant.root, `caogen-task-${handoffId}`)
    if (existsSync(target)) throw new Error('本次接收目录已存在，请核对原交接。')
    mkdirSync(target, { mode: 0o700 }); this.require(id); ensureDirectory(target); return target
  }
  private save(rows: HandoffDestinationGrant[]): void { writeDurableFileSync(join(this.root, 'destinations.json'), JSON.stringify(rows), { mode: 0o600 }) }
}
