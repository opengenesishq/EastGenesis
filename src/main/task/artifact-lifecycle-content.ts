import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import type {
  ArtifactContentInput,
  PreparedArtifactContent
} from './artifact-lifecycle-types'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { containsSensitiveText } from '../security/secret-redaction'

const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/

export function artifactBlobRoot(rootDir: string): string {
  return join(rootDir, 'artifact-blobs', 'sha256')
}

export function artifactBlobPath(rootDir: string, digest: string): string {
  return join(artifactBlobRoot(rootDir), assertSha256Digest(digest).slice('sha256:'.length))
}

export function artifactSourceProjectRoot(rootDir: string, projectId: string): string {
  return join(resolve(rootDir), 'artifact-source-files', identityDigest(projectId))
}

export function artifactSourceFilePath(
  rootDir: string,
  projectId: string,
  artifactId: string,
  extension: string
): string {
  return join(
    artifactSourceProjectRoot(rootDir, projectId),
    `${identityDigest(artifactId)}${normalizeArtifactSourceExtension(extension)}`
  )
}

export function isArtifactSourceProjectPath(rootDir: string, projectId: string, value: string): boolean {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) return false
  const path = relative(artifactSourceProjectRoot(rootDir, projectId), resolve(value))
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function artifactSourceExtension(sourceRef: string): string {
  const extension = extname(sourceRef).toLowerCase()
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''
}

export async function countArtifactSourceProjectFiles(rootDir: string, projectId: string): Promise<number> {
  return countRegularFiles(artifactSourceProjectRoot(rootDir, projectId))
}

export async function purgeArtifactSourceProjectFiles(rootDir: string, projectId: string): Promise<number> {
  const projectRoot = artifactSourceProjectRoot(rootDir, projectId)
  const count = await countRegularFiles(projectRoot)
  if (count === 0 && !(await pathExists(projectRoot))) return 0
  await rm(projectRoot, { recursive: true, force: true })
  if (await pathExists(projectRoot)) {
    throw new WorkflowLedgerCorruptionError(`artifact source Project root still exists: ${projectRoot}`)
  }
  return count
}

export async function prepareArtifactContent(
  content: ArtifactContentInput,
  rootDir: string
): Promise<PreparedArtifactContent> {
  if (content.storageKind === 'blob') {
    if (!(content.bytes instanceof Uint8Array)) {
      throw new WorkflowLedgerCorruptionError('artifact blob bytes must be a Uint8Array')
    }
    const bytes = Uint8Array.from(content.bytes)
    assertArtifactContentCredentialFree(bytes)
    const digest = contentDigest(bytes)
    assertExpectedDigest(content.expectedDigest, digest)
    const hex = digest.slice('sha256:'.length)
    return {
      storageKind: 'blob',
      digest,
      sizeBytes: bytes.byteLength,
      bytes,
      blobRef: `sha256/${hex}`,
      locationPath: join(artifactBlobRoot(rootDir), hex)
    }
  }
  const sourceRef = await canonicalSourceRef(content.sourceRef)
  const inspected = await inspectArtifactSource(sourceRef)
  const digest = inspected.digest
  assertExpectedDigest(content.expectedDigest, digest)
  return {
    storageKind: 'source_ref',
    digest,
    sizeBytes: inspected.sizeBytes,
    sourceRef,
    locationPath: sourceRef
  }
}

export async function materializeArtifactBlob(content: PreparedArtifactContent): Promise<boolean> {
  if (content.storageKind !== 'blob') return false
  return materializeVerifiedBytes(content.locationPath, content.bytes, content.digest, content.sizeBytes)
}

export async function materializeArtifactSourceFile(input: {
  locationPath: string
  bytes: Uint8Array
  digest: string
  sizeBytes: number
}): Promise<boolean> {
  return materializeVerifiedBytes(input.locationPath, input.bytes, input.digest, input.sizeBytes)
}

async function materializeVerifiedBytes(
  locationPath: string,
  bytes: Uint8Array,
  digest: string,
  sizeBytes: number
): Promise<boolean> {
  if (bytes.byteLength !== sizeBytes || contentDigest(bytes) !== digest) {
    throw new WorkflowLedgerCorruptionError('artifact materialized bytes do not match their declared digest')
  }
  await mkdir(dirname(locationPath), { recursive: true, mode: 0o700 })
  if (await pathExists(locationPath)) {
    await assertRegularContent(locationPath, digest, sizeBytes)
    return false
  }
  const temporaryPath = `${locationPath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, locationPath)
    await chmod(locationPath, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    if (!(await pathExists(locationPath))) throw error
  }
  await assertRegularContent(locationPath, digest, sizeBytes)
  return true
}

export async function verifyPreparedContent(content: PreparedArtifactContent): Promise<void> {
  await assertRegularContent(content.locationPath, content.digest, content.sizeBytes)
}

export async function assertRegularContent(
  filePath: string,
  expectedDigest: string,
  expectedSize: number
): Promise<void> {
  const fileStat = await lstat(filePath)
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new WorkflowLedgerCorruptionError(`artifact content is not a regular file: ${filePath}`)
  }
  const inspected = await inspectArtifactSource(filePath)
  if (inspected.sizeBytes !== expectedSize || inspected.digest !== expectedDigest) {
    throw new WorkflowLedgerCorruptionError(`artifact content digest mismatch: ${filePath}`)
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function assertArtifactContentCredentialFree(bytes: Uint8Array): void {
  if (containsSensitiveText(Buffer.from(bytes).toString('utf8'))) {
    throw new WorkflowLedgerCorruptionError('artifact content contains credential material')
  }
}

export function assertSha256Digest(value: string, label = 'artifact digest'): string {
  const normalized = value.trim().toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) {
    throw new WorkflowLedgerCorruptionError(`${label} must use sha256:<64 lowercase hex>`)
  }
  return normalized
}

async function canonicalSourceRef(value: string): Promise<string> {
  const sourcePath = value.startsWith('file:') ? fileURLToPath(value) : value
  if (!isAbsolute(sourcePath)) {
    throw new WorkflowLedgerCorruptionError('artifact sourceRef must be an absolute path or file URL')
  }
  const directStat = await lstat(sourcePath)
  if (directStat.isSymbolicLink() || !directStat.isFile()) {
    throw new WorkflowLedgerCorruptionError('artifact sourceRef must name a regular non-symlink file')
  }
  const canonical = await realpath(sourcePath)
  if (!(await stat(canonical)).isFile()) {
    throw new WorkflowLedgerCorruptionError('artifact sourceRef must resolve to a regular file')
  }
  return canonical
}

async function inspectArtifactSource(
  sourceRef: string
): Promise<{ digest: string; sizeBytes: number }> {
  const handle = await open(sourceRef, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new WorkflowLedgerCorruptionError('artifact sourceRef is not a regular file')
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WorkflowLedgerCorruptionError('artifact sourceRef is too large to represent safely')
    }
    const hash = createHash('sha256')
    const decoder = new StringDecoder('utf8')
    let scanTail = ''
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(bytes)
      const decoded = decoder.write(bytes)
      const candidate = `${scanTail}${decoded}`
      if (containsSensitiveText(candidate)) {
        throw new WorkflowLedgerCorruptionError('artifact content contains credential material')
      }
      scanTail = candidate.slice(-256 * 1024)
    }
    const finalText = `${scanTail}${decoder.end()}`
    if (containsSensitiveText(finalText)) {
      throw new WorkflowLedgerCorruptionError('artifact content contains credential material')
    }
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new WorkflowLedgerCorruptionError('artifact sourceRef changed while its digest was captured')
    }
    return {
      digest: `sha256:${hash.digest('hex')}`,
      sizeBytes: Number(after.size)
    }
  } finally {
    await handle.close()
  }
}

function assertExpectedDigest(expected: string | undefined, actual: string): void {
  if (expected === undefined) return
  if (assertSha256Digest(expected, 'artifact expectedDigest') !== actual) {
    throw new WorkflowLedgerCorruptionError('artifact expectedDigest does not match content bytes')
  }
}

function identityDigest(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new WorkflowLedgerCorruptionError('artifact source identity is invalid')
  }
  return createHash('sha256').update(value.trim()).digest('hex')
}

function normalizeArtifactSourceExtension(value: string): string {
  if (value === '') return ''
  if (!/^\.[a-z0-9]{1,16}$/.test(value)) {
    throw new WorkflowLedgerCorruptionError('artifact source extension is invalid')
  }
  return value
}

async function countRegularFiles(directory: string): Promise<number> {
  let directoryStat
  try {
    directoryStat = await lstat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new WorkflowLedgerCorruptionError(`artifact source Project root is invalid: ${directory}`)
  }
  let count = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    const childStat = await lstat(child)
    if (childStat.isSymbolicLink()) {
      throw new WorkflowLedgerCorruptionError(`artifact source file is a symbolic link: ${child}`)
    }
    if (childStat.isDirectory()) count += await countRegularFiles(child)
    else if (childStat.isFile()) count += 1
    else throw new WorkflowLedgerCorruptionError(`artifact source entry is invalid: ${child}`)
  }
  return count
}
