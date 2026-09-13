import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { FileSystemIdentity } from '../../shared/types'
import type { GitIndexOperation } from './git-index-input'
import type { GitIndexUpdateTarget } from './git-index-state'

export interface GitIndexArtifactIntent {
  repoRoot: string
  worktreeGitDir: string
  preHead?: string
  headRef?: string
  preIndexState: 'absent' | 'file'
  preIndexSha256?: string
  preEntriesDigest: string
  expectedEntriesDigest: string
  operation: GitIndexOperation
  paths: string[]
  scopePath?: string
  patchSha256?: string
}

export interface GitIndexArtifactManifest {
  schemaVersion: 1
  expectedIndexEntriesDigest: string
  indexSha256: string
  indexBytes: number
  objects: GitIndexObjectManifestEntry[]
}

export interface GitIndexArtifactView {
  artifactRef: string
  artifactRoot: string
  artifactRootIdentity: FileSystemIdentity
  indexArtifactPath: string
  indexArtifactIdentity: FileSystemIdentity
  indexArtifactSha256: string
  indexArtifactBytes: number
  objectManifestPath: string
  objectManifestIdentity: FileSystemIdentity
  objectManifestSha256: string
  objectCount: number
}

export interface FrozenGitIndexArtifact {
  artifactRoot: string
  manifest: GitIndexArtifactManifest
  indexBytes: Buffer
}

interface GitIndexObjectManifestEntry {
  path: string
  sha256: string
  bytes: number
}

const MAX_INDEX_BYTES = 64 * 1024 * 1024
const MAX_ARTIFACT_OBJECT_BYTES = 256 * 1024 * 1024
const MAX_LOOSE_OBJECT_BYTES = 256 * 1024 * 1024

export function persistGitIndexArtifact(
  intent: GitIndexArtifactIntent,
  indexBytes: Buffer,
  tempObjects: string
): GitIndexArtifactView {
  const key = sha256(Buffer.from(JSON.stringify({ schemaVersion: 1, ...intent }), 'utf8'))
  const base = join(app.getPath('userData'), 'effect-artifacts', 'git-index')
  const artifactRoot = join(base, key)
  const artifactRef = `git-index/${key}`
  mkdirSync(base, { recursive: true, mode: 0o700 })
  if (!existsSync(artifactRoot)) {
    createArtifactDirectory(base, artifactRoot, intent.expectedEntriesDigest, indexBytes, tempObjects)
  }
  return validateArtifactDirectory(artifactRoot, artifactRef, intent.expectedEntriesDigest)
}

export function readFrozenGitIndexArtifact(target: GitIndexUpdateTarget): FrozenGitIndexArtifact {
  const resolved = resolveFrozenArtifact(target)
  const manifestPath = join(resolved.artifactRoot, 'manifest.json')
  const indexPath = join(resolved.artifactRoot, 'index')
  if (!resolved.portable) {
    assertIdentity(target.artifactRoot, target.artifactRootIdentity)
    assertIdentity(target.indexArtifactPath, target.indexArtifactIdentity)
    assertIdentity(target.objectManifestPath, target.objectManifestIdentity)
  }
  const manifestBytes = readBoundedFile(manifestPath, MAX_INDEX_BYTES, 'Git index artifact manifest')
  if (sha256(manifestBytes) !== target.objectManifestSha256) throw new Error('Git index artifact manifest 已变化')
  const manifest = parseManifest(manifestBytes)
  if (manifest.expectedIndexEntriesDigest !== target.expectedIndexEntriesDigest) {
    throw new Error('Git index artifact 意图摘要不匹配')
  }
  if (manifest.objects.length !== target.objectCount) throw new Error('Git object artifact 数量已变化')
  const indexBytes = readBoundedFile(indexPath, MAX_INDEX_BYTES, 'Git index artifact')
  if (sha256(indexBytes) !== target.indexArtifactSha256 || indexBytes.byteLength !== target.indexArtifactBytes) {
    throw new Error('Git index artifact 已变化')
  }
  if (manifest.indexSha256 !== target.indexArtifactSha256 || manifest.indexBytes !== target.indexArtifactBytes) {
    throw new Error('Git index artifact manifest 不一致')
  }
  validateManifestObjects(resolved.artifactRoot, manifest.objects)
  return { artifactRoot: resolved.artifactRoot, manifest, indexBytes }
}

export function promoteGitIndexArtifactObjects(
  target: GitIndexUpdateTarget,
  artifact: FrozenGitIndexArtifact
): void {
  assertIdentity(target.objectDir, target.objectDirIdentity)
  for (const entry of artifact.manifest.objects) promoteObject(target, artifact.artifactRoot, entry)
}

function createArtifactDirectory(
  base: string,
  artifactRoot: string,
  expectedEntriesDigest: string,
  indexBytes: Buffer,
  tempObjects: string
): void {
  const tempArtifact = join(base, `.${basename(artifactRoot)}-${randomUUID()}.tmp`)
  try {
    mkdirSync(tempArtifact, { recursive: false, mode: 0o700 })
    durableWriteFile(join(tempArtifact, 'index'), indexBytes)
    const objects = copyObjectTree(tempObjects, join(tempArtifact, 'objects'))
    const manifest: GitIndexArtifactManifest = {
      schemaVersion: 1,
      expectedIndexEntriesDigest: expectedEntriesDigest,
      indexSha256: sha256(indexBytes),
      indexBytes: indexBytes.byteLength,
      objects
    }
    durableWriteFile(join(tempArtifact, 'manifest.json'), Buffer.from(JSON.stringify(manifest), 'utf8'))
    renameSync(tempArtifact, artifactRoot)
    fsyncDirectory(base)
  } catch (error) {
    rmSync(tempArtifact, { recursive: true, force: true })
    if (!existsSync(artifactRoot)) throw error
  }
}

function copyObjectTree(sourceRoot: string, destinationRoot: string): GitIndexObjectManifestEntry[] {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 })
  const entries: GitIndexObjectManifestEntry[] = []
  let totalBytes = 0
  for (const directory of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^[0-9a-f]{2}$/.test(directory.name)) continue
    for (const file of readdirSync(join(sourceRoot, directory.name), { withFileTypes: true })) {
      if (!file.isFile() || !/^[0-9a-f]+$/.test(file.name)) continue
      const relativePath = `${directory.name}/${file.name}`
      const bytes = readBoundedFile(join(sourceRoot, relativePath), MAX_ARTIFACT_OBJECT_BYTES, 'Git object artifact')
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_ARTIFACT_OBJECT_BYTES) throw new Error('Git object artifacts 总大小超过上限')
      const destination = join(destinationRoot, relativePath)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      durableWriteFile(destination, bytes)
      entries.push({ path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength })
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function validateArtifactDirectory(
  artifactRoot: string,
  artifactRef: string,
  expectedEntriesDigest: string
): GitIndexArtifactView {
  const root = realpathSync(artifactRoot)
  const indexArtifactPath = realpathSync(join(root, 'index'))
  const objectManifestPath = realpathSync(join(root, 'manifest.json'))
  const manifestBytes = readBoundedFile(objectManifestPath, MAX_INDEX_BYTES, 'Git index artifact manifest')
  const manifest = parseManifest(manifestBytes)
  if (manifest.expectedIndexEntriesDigest !== expectedEntriesDigest) throw new Error('Git index artifact 意图摘要不匹配')
  const indexBytes = readBoundedFile(indexArtifactPath, MAX_INDEX_BYTES, 'Git index artifact')
  if (sha256(indexBytes) !== manifest.indexSha256 || indexBytes.byteLength !== manifest.indexBytes) {
    throw new Error('Git index artifact 内容摘要不匹配')
  }
  validateManifestObjects(root, manifest.objects)
  return {
    artifactRef,
    artifactRoot: root,
    artifactRootIdentity: fileSystemIdentity(root),
    indexArtifactPath,
    indexArtifactIdentity: fileSystemIdentity(indexArtifactPath),
    indexArtifactSha256: manifest.indexSha256,
    indexArtifactBytes: manifest.indexBytes,
    objectManifestPath,
    objectManifestIdentity: fileSystemIdentity(objectManifestPath),
    objectManifestSha256: sha256(manifestBytes),
    objectCount: manifest.objects.length
  }
}

function parseManifest(bytes: Buffer): GitIndexArtifactManifest {
  const value = JSON.parse(bytes.toString('utf8')) as GitIndexArtifactManifest
  if (
    value.schemaVersion !== 1 ||
    typeof value.expectedIndexEntriesDigest !== 'string' ||
    typeof value.indexSha256 !== 'string' ||
    !Number.isSafeInteger(value.indexBytes) ||
    !Array.isArray(value.objects)
  ) {
    throw new Error('Git index artifact manifest 无效')
  }
  return value
}

function validateManifestObjects(root: string, objects: GitIndexObjectManifestEntry[]): void {
  for (const entry of objects) {
    if (!isManifestObject(entry)) throw new Error('Git object artifact manifest 无效')
    const bytes = readBoundedFile(join(root, 'objects', entry.path), MAX_ARTIFACT_OBJECT_BYTES, 'Git object artifact')
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error('Git object artifact 摘要不匹配')
  }
}

function isManifestObject(entry: unknown): entry is GitIndexObjectManifestEntry {
  if (!entry || typeof entry !== 'object') return false
  const value = entry as Record<string, unknown>
  return (
    typeof value.path === 'string' &&
    /^[0-9a-f]{2}\/[0-9a-f]+$/.test(value.path) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) >= 0 &&
    Number(value.bytes) <= MAX_ARTIFACT_OBJECT_BYTES
  )
}

function promoteObject(
  target: GitIndexUpdateTarget,
  artifactRoot: string,
  entry: GitIndexObjectManifestEntry
): void {
  const objectId = objectIdForEntry(entry, target.objectFormat)
  const source = join(artifactRoot, 'objects', entry.path)
  const objectDirectory = ensureLooseObjectDirectory(target, entry.path.slice(0, 2))
  const destination = join(objectDirectory, entry.path.slice(3))
  if (existsSync(destination)) {
    validateLooseObjectFile(destination, objectId, target.objectFormat)
    return
  }
  const temporary = join(objectDirectory, `.caogen-${process.pid}-${randomUUID()}.tmp`)
  let published = false
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL)
    if (process.platform !== 'win32') chmodSync(temporary, 0o444)
    fsyncFile(temporary)
    validateLooseObjectFile(temporary, objectId, target.objectFormat)
    published = publishLooseObject(temporary, destination, objectId, target.objectFormat)
    if (process.platform === 'win32' && published) {
      rmSync(temporary, { force: true })
      chmodSync(destination, 0o444)
      validateLooseObjectFile(destination, objectId, target.objectFormat)
    }
    fsyncDirectory(objectDirectory)
  } finally {
    if (process.platform === 'win32' && published) {
      if (existsSync(temporary)) rmSync(temporary, { force: true })
      if (existsSync(destination)) chmodSync(destination, 0o444)
    }
    rmSync(temporary, { force: true })
  }
}

function resolveFrozenArtifact(target: GitIndexUpdateTarget): { artifactRoot: string; portable: boolean } {
  const key = artifactKey(target.artifactRef, target.artifactRoot)
  const portableRoot = resolve(realpathSync(app.getPath('userData')), 'effect-artifacts', 'git-index', key)
  if (target.artifactRef) return { artifactRoot: assertPortableArtifactRoot(portableRoot), portable: true }
  try {
    assertIdentity(target.artifactRoot, target.artifactRootIdentity)
    return { artifactRoot: realpathSync(target.artifactRoot), portable: false }
  } catch {
    return { artifactRoot: assertPortableArtifactRoot(portableRoot), portable: true }
  }
}

function artifactKey(artifactRef: string | undefined, artifactRoot: string): string {
  if (artifactRef !== undefined) {
    const match = /^git-index\/([a-f0-9]{64})$/.exec(artifactRef)
    if (!match) throw new Error('Git index artifactRef 无效')
    return match[1]
  }
  const key = basename(resolve(artifactRoot))
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Git index legacy artifact path 无效')
  return key
}

function assertPortableArtifactRoot(expected: string): string {
  const info = lstatSync(expected)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Git index portable artifact root 不安全')
  const actual = realpathSync(expected)
  if (actual !== expected) throw new Error('Git index portable artifact root 越过应用私有目录')
  return actual
}

function ensureLooseObjectDirectory(target: GitIndexUpdateTarget, prefix: string): string {
  assertIdentity(target.objectDir, target.objectDirIdentity)
  const directory = join(target.objectDir, prefix)
  try {
    mkdirSync(directory, { recursive: false, mode: 0o777 })
    fsyncDirectory(target.objectDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Git object directory 不安全:${directory}`)
  const canonical = realpathSync(directory)
  if (dirname(canonical) !== target.objectDir) throw new Error(`Git object directory 越过仓库边界:${directory}`)
  return canonical
}

function publishLooseObject(
  temporary: string,
  destination: string,
  objectId: string,
  objectFormat: GitIndexUpdateTarget['objectFormat']
): boolean {
  try {
    linkSync(temporary, destination)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    validateLooseObjectFile(destination, objectId, objectFormat)
    return false
  }
}

function objectIdForEntry(
  entry: GitIndexObjectManifestEntry,
  objectFormat: GitIndexUpdateTarget['objectFormat']
): string {
  const objectId = entry.path.replace('/', '')
  const expectedLength = objectFormat === 'sha1' ? 40 : 64
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(objectId)) {
    throw new Error(`Git object artifact 与 ${objectFormat} 路径不匹配`)
  }
  return objectId
}

function validateLooseObjectFile(
  path: string,
  objectId: string,
  objectFormat: GitIndexUpdateTarget['objectFormat']
): void {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARTIFACT_OBJECT_BYTES) {
    throw new Error(`Git loose object 不是安全的普通文件:${path}`)
  }
  const compressed = readFileSync(path)
  const after = lstatSync(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error(`读取 Git loose object 期间文件身份变化:${path}`)
  }
  const loose = inflateSync(compressed, { maxOutputLength: MAX_LOOSE_OBJECT_BYTES })
  const separator = loose.indexOf(0)
  const header = separator >= 0 ? loose.subarray(0, separator).toString('ascii') : ''
  const match = /^(blob|tree|commit|tag) ([0-9]+)$/.exec(header)
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) !== loose.byteLength - separator - 1) {
    throw new Error(`Git loose object header 无效:${path}`)
  }
  const observedId = createHash(objectFormat).update(loose).digest('hex')
  if (observedId !== objectId) throw new Error(`Git loose object OID 不匹配:${path}`)
}

function readBoundedFile(path: string, maxBytes: number, label: string): Buffer {
  const info = statSync(path)
  if (!info.isFile() || info.size > maxBytes) throw new Error(`${label} 不是普通文件或超过大小上限`)
  return readFileSync(path)
}

function durableWriteFile(path: string, bytes: Buffer): void {
  // The path is a freshly-created private staging name; a non-exclusive handle
  // allows Windows to reopen it for FlushFileBuffers-compatible fsync fallback.
  let descriptor: number | undefined = openSync(path, 'w', 0o600)
  try {
    writeFileSync(descriptor, bytes)
    if (!fsyncFileDescriptor(path, descriptor)) descriptor = undefined
  } finally {
    if (descriptor !== undefined) safeClose(descriptor)
  }
}

function fsyncFile(path: string): void {
  let descriptor: number | undefined = openSync(path, 'r')
  try {
    if (!fsyncFileDescriptor(path, descriptor)) descriptor = undefined
  } finally {
    if (descriptor !== undefined) safeClose(descriptor)
  }
}

function fsyncFileDescriptor(path: string, descriptor: number): boolean {
  try {
    fsyncSync(descriptor)
    return true
  } catch (error) {
    if (process.platform !== 'win32' || !isWindowsFsyncPermissionError(error)) {
      throw new Error(`fsync ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Windows can reject FlushFileBuffers for Git's loose-object staging
    // handles; the atomic rename remains the publication barrier.
    safeClose(descriptor)
    return false
  }
}

function safeClose(descriptor: number): void {
  try {
    closeSync(descriptor)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'EBADF') throw error
  }
}

function isWindowsFsyncPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
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

function fileSystemIdentity(path: string): FileSystemIdentity {
  const info = statSync(path)
  return { device: String(info.dev), inode: String(info.ino) }
}

function assertIdentity(path: string, expected: FileSystemIdentity): void {
  if (!sameIdentity(fileSystemIdentity(realpathSync(path)), expected)) throw new Error(`文件系统身份已变化:${path}`)
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
