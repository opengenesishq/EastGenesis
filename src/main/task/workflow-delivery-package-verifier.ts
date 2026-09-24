import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { close as closeFd, fstat as fstatFd, open as openFd, type BigIntStats } from 'node:fs'
import { basename } from 'node:path'
import { lstat, open, readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { TextDecoder } from 'node:util'
import { fromFd as openZipFromFd, type Entry, type ZipFile } from 'yauzl'
import type {
  WorkflowProjectDeliveryPackageVerificationBlocker,
  WorkflowProjectDeliveryPackageVerificationBlockerCode,
  WorkflowProjectDeliveryPackageVerificationReceiptSaveResult,
  WorkflowProjectDeliveryPackageVerificationResult,
  WorkflowDeliveryTrustPolicyMode
} from '../../shared/workflow-types'
import { canonicalJson, digest } from './workflow-ledger-codec'
import { writeDurableFile } from './workflow-ledger-migration-storage'
import {
  readLocalWorkflowDeliveryIdentityFingerprint,
  workflowDeliverySignatureEnvelope
} from './workflow-delivery-identity'
import {
  findWorkflowDeliveryIdentityTrustRecord,
  getWorkflowDeliveryTrustPolicy
} from './workflow-delivery-trust-store'

const MAX_ENTRY_COUNT = 10_000
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024 * 1024
const MAX_RESULT_BLOCKERS = 100
const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

interface PackageArtifactDeclaration {
  artifactId: string
  path: string
  sizeBytes: number
  digest: string
}

interface PackageManifest {
  projectId: string
  verdict: 'ready' | 'blocked'
  manifestDigest: string
  includedArtifacts: PackageArtifactDeclaration[]
  signingIdentity?: {
    publicKey: string
    fingerprint: string
  }
  signature?: string
}

interface VerifiedEntry {
  path: string
  sizeBytes: number
  digest: string
}

interface FileFingerprint {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface StableFileHash {
  digest: string
  sizeBytes: number
  fingerprint: FileFingerprint
}

class PackageVerificationError extends Error {
  constructor(
    readonly code: WorkflowProjectDeliveryPackageVerificationBlockerCode,
    message: string,
    readonly entry?: string
  ) {
    super(message)
  }
}

export async function verifyWorkflowProjectDeliveryPackageAtPath(
  rawFilePath: string,
  rootDir?: string
): Promise<Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>> {
  const filePath = rawFilePath.trim()
  const fileName = safeFileName(filePath)
  const verifiedAt = Date.now()
  const verificationId = randomUUID()
  let firstHash: StableFileHash | undefined
  let trustPolicyMode: WorkflowDeliveryTrustPolicyMode = 'audit_only'
  let trustPolicyAvailable = true
  if (rootDir) {
    try {
      trustPolicyMode = (await getWorkflowDeliveryTrustPolicy(rootDir)).mode
    } catch {
      trustPolicyAvailable = false
    }
  }
  try {
    firstHash = await hashStableRegularFile(filePath)
    const inspected = await inspectDeliveryZip(filePath, firstHash.fingerprint)
    const secondHash = await hashStableRegularFile(filePath)
    if (firstHash.digest !== secondHash.digest || !sameFingerprint(firstHash.fingerprint, secondHash.fingerprint)) {
      throw new PackageVerificationError('FILE_CHANGED', '交付包在校验过程中发生变化')
    }
    const blockers = compareManifestToEntries(inspected.manifest, inspected.entries)
    const byteIntegrity = blockers.length === 0 ? 'verified' : 'rejected'
    const signature = await verifyManifestSignature(inspected.manifest, rootDir)
    if (signature.status === 'invalid') {
      blockers.push({ code: 'SIGNATURE_INVALID', message: '交付包 Ed25519 身份签名无效' })
    }
    const trustPolicyVerdict = enforceTrustPolicy(
      trustPolicyMode,
      trustPolicyAvailable,
      signature.status,
      signature.trust,
      blockers
    )
    return {
      canceled: false,
      schemaVersion: 1,
      format: 'caogen.project-delivery-package-verification.v1',
      verificationId,
      verdict: blockers.length === 0 ? 'verified' : 'rejected',
      byteIntegrity,
      signatureStatus: signature.status,
      identityTrust: signature.trust,
      trustPolicyMode,
      trustPolicyVerdict,
      ...(signature.fingerprint ? { signingIdentityFingerprint: signature.fingerprint } : {}),
      ...(signature.label ? { signingIdentityLabel: signature.label } : {}),
      fileName,
      verifiedAt,
      sizeBytes: firstHash.sizeBytes,
      packageDigest: `sha256:${firstHash.digest}`,
      projectId: inspected.manifest.projectId,
      manifestDigest: inspected.manifest.manifestDigest,
      manifestVerdict: inspected.manifest.verdict,
      entryCount: inspected.entryCount,
      declaredArtifactCount: inspected.manifest.includedArtifacts.length,
      verifiedArtifactCount: inspected.entries.size,
      verifiedArtifactBytes: [...inspected.entries.values()].reduce((total, entry) => total + entry.sizeBytes, 0),
      blockers: blockers.slice(0, MAX_RESULT_BLOCKERS)
    }
  } catch (cause) {
    const blocker = packageBlocker(cause)
    return {
      canceled: false,
      schemaVersion: 1,
      format: 'caogen.project-delivery-package-verification.v1',
      verificationId,
      verdict: 'rejected',
      byteIntegrity: 'rejected',
      signatureStatus: 'unsigned',
      identityTrust: 'unsigned',
      trustPolicyMode,
      trustPolicyVerdict: 'blocked',
      fileName,
      verifiedAt,
      ...(firstHash ? {
        sizeBytes: firstHash.sizeBytes,
        packageDigest: `sha256:${firstHash.digest}`
      } : {}),
      blockers: [
        blocker,
        ...(!trustPolicyAvailable
          ? [{ code: 'TRUST_POLICY_UNAVAILABLE' as const, message: '无法读取组织交付信任策略，已拒绝交付包' }]
          : [])
      ]
    }
  }
}

function enforceTrustPolicy(
  mode: WorkflowDeliveryTrustPolicyMode,
  available: boolean,
  signatureStatus: 'valid' | 'invalid' | 'unsigned',
  identityTrust: 'local_identity' | 'trusted_identity' | 'revoked_identity' | 'unknown_identity' | 'unsigned',
  blockers: WorkflowProjectDeliveryPackageVerificationBlocker[]
): 'passed' | 'blocked' {
  if (!available) {
    blockers.push({ code: 'TRUST_POLICY_UNAVAILABLE', message: '无法读取组织交付信任策略，已拒绝交付包' })
    return 'blocked'
  }
  if (signatureStatus === 'invalid') return 'blocked'
  if (mode === 'audit_only') return 'passed'
  if (signatureStatus === 'unsigned') {
    blockers.push({ code: 'SIGNATURE_REQUIRED', message: '当前组织策略要求交付包提供有效的 Ed25519 身份签名' })
    return 'blocked'
  }
  if (mode === 'require_valid_signature') return 'passed'
  if (identityTrust === 'local_identity' || identityTrust === 'trusted_identity') return 'passed'
  if (identityTrust === 'revoked_identity') {
    blockers.push({ code: 'IDENTITY_REVOKED', message: '交付包签名身份已被组织撤销' })
  } else {
    blockers.push({ code: 'IDENTITY_NOT_TRUSTED', message: '交付包签名身份尚未加入组织信任列表' })
  }
  return 'blocked'
}

export async function saveWorkflowProjectDeliveryPackageVerificationReceiptToPath(
  verification: Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>,
  targetPath: string
): Promise<Exclude<WorkflowProjectDeliveryPackageVerificationReceiptSaveResult, { canceled: true }>> {
  const body = {
    schemaVersion: 1 as const,
    format: 'caogen.project-delivery-package-verification-receipt.v1' as const,
    generatedAt: Date.now(),
    verification
  }
  const receiptDigest = `sha256:${digest(body)}`
  const receipt = { ...body, receiptDigest }
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8')
  await writeDurableFile(targetPath, bytes, { replace: true })
  const info = await lstat(targetPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.byteLength) {
    throw new Error('Verification receipt target is not a stable regular file')
  }
  const observed = await readFile(targetPath)
  if (!observed.equals(bytes)) throw new Error('Verification receipt bytes changed after save')
  return {
    canceled: false,
    fileName: safeFileName(targetPath),
    sizeBytes: bytes.byteLength,
    receiptDigest,
    verdict: verification.verdict,
    ...(verification.projectId ? { projectId: verification.projectId } : {})
  }
}

export function suggestedWorkflowProjectDeliveryVerificationReceiptName(fileName: string): string {
  const stem = fileName.replace(/\.zip$/i, '').normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim()
  const safe = (stem || 'delivery').slice(0, 120).replace(/[. ]+$/g, '') || 'delivery'
  return `${safe}.verification-receipt.json`
}

async function inspectDeliveryZip(filePath: string, expectedFingerprint: FileFingerprint): Promise<{
  manifest: PackageManifest
  entries: ReadonlyMap<string, VerifiedEntry>
  entryCount: number
}> {
  const fd = await openStableReadFd(filePath, expectedFingerprint)
  const zipFile = await openZipFile(fd).catch(async (cause) => {
    await closeRawFd(fd)
    throw cause
  })
  if (zipFile.entryCount < 1 || zipFile.entryCount > MAX_ENTRY_COUNT) {
    zipFile.close()
    throw new PackageVerificationError('ZIP_ENTRY_LIMIT', `ZIP 条目数必须在 1-${MAX_ENTRY_COUNT} 之间`)
  }
  return new Promise((fulfill, reject) => {
    const paths = new Set<string>()
    const collisionKeys = new Set<string>()
    const entries = new Map<string, VerifiedEntry>()
    let manifestBytes: Buffer | undefined
    let totalUncompressedBytes = 0
    let settled = false

    const fail = (cause: unknown): void => {
      if (settled) return
      settled = true
      zipFile.close()
      reject(cause)
    }
    zipFile.once('error', () => fail(new PackageVerificationError('ZIP_INVALID', 'ZIP 目录或条目结构无效')))
    zipFile.on('entry', (entry) => {
      void (async () => {
        const path = decodeAndValidateEntryPath(entry)
        const collisionKey = path.normalize('NFKC').toLocaleLowerCase('en-US')
        if (paths.has(path) || collisionKeys.has(collisionKey)) {
          throw new PackageVerificationError('ZIP_DUPLICATE_PATH', 'ZIP 包含重复或大小写冲突路径', safeEntryName(path))
        }
        paths.add(path)
        collisionKeys.add(collisionKey)
        assertSafeEntry(entry, path)
        totalUncompressedBytes = safeSizeSum(totalUncompressedBytes, entry.uncompressedSize)

        if (path === 'manifest.json') {
          if (manifestBytes) throw new PackageVerificationError('MANIFEST_DUPLICATE', 'ZIP 必须只包含一个 manifest.json')
          if (entry.uncompressedSize > MAX_MANIFEST_BYTES) {
            throw new PackageVerificationError('MANIFEST_TOO_LARGE', 'manifest.json 超出大小限制')
          }
          manifestBytes = await readEntryBuffer(zipFile, entry, MAX_MANIFEST_BYTES)
        } else {
          entries.set(path, await hashEntry(zipFile, entry, path))
        }
        zipFile.readEntry()
      })().catch(fail)
    })
    zipFile.once('end', () => {
      if (settled) return
      settled = true
      try {
        if (!manifestBytes) throw new PackageVerificationError('MANIFEST_MISSING', 'ZIP 缺少 manifest.json')
        fulfill({ manifest: parseManifest(manifestBytes), entries, entryCount: zipFile.entryCount })
      } catch (cause) {
        reject(cause)
      }
    })
    zipFile.readEntry()
  })
}

function openStableReadFd(filePath: string, expectedFingerprint: FileFingerprint): Promise<number> {
  return new Promise((fulfill, reject) => {
    openFd(filePath, 'r', (openError, fd) => {
      if (openError) {
        reject(new PackageVerificationError('FILE_UNREADABLE', '无法打开所选交付包'))
        return
      }
      fstatFd(fd, { bigint: true }, (statError, stats) => {
        if (statError) {
          void closeRawFd(fd).then(() => reject(new PackageVerificationError('FILE_UNREADABLE', '无法读取所选交付包身份')))
          return
        }
        if (!stats.isFile() || !sameFingerprint(expectedFingerprint, fileFingerprint(stats))) {
          void closeRawFd(fd).then(() => reject(new PackageVerificationError('FILE_CHANGED', '交付包身份在 ZIP 校验前发生变化')))
          return
        }
        fulfill(fd)
      })
    })
  })
}

function closeRawFd(fd: number): Promise<void> {
  return new Promise((fulfill) => closeFd(fd, () => fulfill()))
}

function openZipFile(fd: number): Promise<ZipFile> {
  return new Promise((fulfill, reject) => {
    openZipFromFd(fd, {
      autoClose: true,
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: true,
      strictFileNames: false
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new PackageVerificationError('ZIP_INVALID', '所选文件不是受支持的 ZIP 交付包'))
      } else {
        fulfill(zipFile)
      }
    })
  })
}

function decodeAndValidateEntryPath(entry: Entry): string {
  const rawName = entry.fileName as unknown
  if (!Buffer.isBuffer(rawName)) throw new PackageVerificationError('ZIP_PATH_INVALID', 'ZIP 条目路径编码无效')
  let path: string
  try {
    path = UTF8_DECODER.decode(rawName)
  } catch {
    throw new PackageVerificationError('ZIP_PATH_INVALID', 'ZIP 条目路径必须使用有效 UTF-8')
  }
  const invalid = !path || path.length > 512 || path.includes('\0') || path.includes('\\') ||
    path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.endsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  if (invalid) throw new PackageVerificationError('ZIP_PATH_INVALID', 'ZIP 条目包含不安全路径', safeEntryName(path))
  if (entry.extraFields.some((field) => field.id === 0x7075)) {
    throw new PackageVerificationError('ZIP_PATH_INVALID', 'ZIP 条目包含歧义 Unicode 路径', safeEntryName(path))
  }
  return path
}

function assertSafeEntry(entry: Entry, path: string): void {
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
    throw new PackageVerificationError('ZIP_SIZE_LIMIT', 'ZIP 条目大小无效', safeEntryName(path))
  }
  if (entry.isEncrypted()) {
    throw new PackageVerificationError('ZIP_ENTRY_UNSAFE', '不支持加密 ZIP 条目', safeEntryName(path))
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new PackageVerificationError('ZIP_ENTRY_UNSAFE', 'ZIP 条目使用不支持的压缩算法', safeEntryName(path))
  }
  const hostSystem = entry.versionMadeBy >>> 8
  const unixMode = entry.externalFileAttributes >>> 16
  if (hostSystem === 3 && (unixMode & 0xf000) === 0xa000) {
    throw new PackageVerificationError('ZIP_ENTRY_UNSAFE', 'ZIP 不允许符号链接条目', safeEntryName(path))
  }
}

function safeSizeSum(current: number, addition: number): number {
  const next = current + addition
  if (!Number.isSafeInteger(next) || next > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new PackageVerificationError('ZIP_SIZE_LIMIT', 'ZIP 解压后总大小超出校验限制')
  }
  return next
}

async function hashEntry(zipFile: ZipFile, entry: Entry, path: string): Promise<VerifiedEntry> {
  const stream = await openEntryStream(zipFile, entry)
  const hash = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    sizeBytes += bytes.byteLength
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > entry.uncompressedSize) {
      stream.destroy()
      throw new PackageVerificationError('ZIP_SIZE_LIMIT', 'ZIP 条目实际大小超出声明', safeEntryName(path))
    }
    hash.update(bytes)
  }
  if (sizeBytes !== entry.uncompressedSize) {
    throw new PackageVerificationError('ARTIFACT_SIZE_MISMATCH', 'ZIP 条目实际大小与目录声明不一致', safeEntryName(path))
  }
  return { path, sizeBytes, digest: hash.digest('hex') }
}

async function readEntryBuffer(zipFile: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  const stream = await openEntryStream(zipFile, entry)
  const chunks: Buffer[] = []
  let sizeBytes = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    sizeBytes += bytes.byteLength
    if (sizeBytes > limit) {
      stream.destroy()
      throw new PackageVerificationError('MANIFEST_TOO_LARGE', 'manifest.json 超出大小限制')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, sizeBytes)
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((fulfill, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(new PackageVerificationError('ZIP_INVALID', '无法读取 ZIP 条目'))
      else fulfill(stream)
    })
  })
}

function parseManifest(bytes: Buffer): PackageManifest {
  let raw: unknown
  try {
    raw = JSON.parse(UTF8_DECODER.decode(bytes))
  } catch {
    throw new PackageVerificationError('MANIFEST_INVALID', 'manifest.json 不是有效 UTF-8 JSON')
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.format !== 'caogen.project-delivery-package.v1' ||
      typeof raw.projectId !== 'string' || !raw.projectId.trim() ||
      (raw.verdict !== 'ready' && raw.verdict !== 'blocked') ||
      !isRecord(raw.verification) || !Array.isArray(raw.includedArtifacts) ||
      !Array.isArray(raw.blockedArtifactIds) || !raw.blockedArtifactIds.every(isNonEmptyString) ||
      typeof raw.manifestDigest !== 'string') {
    throw new PackageVerificationError('MANIFEST_INVALID', 'manifest.json 不符合 EastGenesis 交付包 v1 契约')
  }
  const digestMatch = SHA256_PATTERN.exec(raw.manifestDigest)
  if (!digestMatch) throw new PackageVerificationError('MANIFEST_INVALID', 'manifestDigest 格式无效')
  const body = { ...raw }
  delete body.manifestDigest
  delete body.signature
  if (digest(body).toLowerCase() !== digestMatch[1].toLowerCase()) {
    throw new PackageVerificationError('MANIFEST_DIGEST_MISMATCH', 'manifest.json 摘要校验失败')
  }
  const artifactIds = new Set<string>()
  const paths = new Set<string>()
  const includedArtifacts = raw.includedArtifacts.map((item): PackageArtifactDeclaration => {
    if (!isRecord(item) || !isNonEmptyString(item.artifactId) || !isNonEmptyString(item.path) ||
        !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0 ||
        typeof item.digest !== 'string') {
      throw new PackageVerificationError('MANIFEST_INVALID', 'includedArtifacts 条目字段无效')
    }
    const itemDigest = SHA256_PATTERN.exec(item.digest)
    if (!itemDigest || item.path === 'manifest.json' || !item.path.startsWith('artifacts/')) {
      throw new PackageVerificationError('MANIFEST_INVALID', 'Artifact 路径或摘要无效', safeEntryName(item.path))
    }
    if (artifactIds.has(item.artifactId) || paths.has(item.path)) {
      throw new PackageVerificationError('MANIFEST_INVALID', 'manifest.json 包含重复 Artifact 声明', safeEntryName(item.path))
    }
    artifactIds.add(item.artifactId)
    paths.add(item.path)
    return {
      artifactId: item.artifactId,
      path: item.path,
      sizeBytes: item.sizeBytes as number,
      digest: itemDigest[1].toLowerCase()
    }
  })
  const signing = parseManifestSigning(raw)
  return {
    projectId: raw.projectId,
    verdict: raw.verdict,
    manifestDigest: `sha256:${digestMatch[1].toLowerCase()}`,
    includedArtifacts,
    ...signing
  }
}

function parseManifestSigning(raw: Record<string, unknown>): Pick<PackageManifest, 'signingIdentity' | 'signature'> {
  if (raw.signingIdentity === undefined && raw.signature === undefined) return {}
  if (!isRecord(raw.signingIdentity) || !isRecord(raw.signature) ||
      raw.signingIdentity.algorithm !== 'Ed25519' ||
      raw.signingIdentity.publicKeyFormat !== 'spki-der-base64' ||
      !isBoundedBase64(raw.signingIdentity.publicKey, 256) ||
      typeof raw.signingIdentity.fingerprint !== 'string' ||
      !SHA256_PATTERN.test(raw.signingIdentity.fingerprint) ||
      raw.signature.algorithm !== 'Ed25519' ||
      raw.signature.envelopeFormat !== 'caogen.project-delivery-signature-envelope.v1' ||
      !isBoundedBase64(raw.signature.value, 256)) {
    throw new PackageVerificationError('MANIFEST_INVALID', '交付包身份签名字段无效')
  }
  const publicKey = Buffer.from(raw.signingIdentity.publicKey, 'base64')
  const fingerprint = `sha256:${createHash('sha256').update(publicKey).digest('hex')}`
  if (fingerprint.toLowerCase() !== raw.signingIdentity.fingerprint.toLowerCase()) {
    throw new PackageVerificationError('MANIFEST_INVALID', '交付包身份公钥指纹不匹配')
  }
  try {
    const key = createPublicKey({ key: publicKey, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
  } catch {
    throw new PackageVerificationError('MANIFEST_INVALID', '交付包身份公钥无效')
  }
  return {
    signingIdentity: {
      publicKey: raw.signingIdentity.publicKey,
      fingerprint
    },
    signature: raw.signature.value
  }
}

async function verifyManifestSignature(
  manifest: PackageManifest,
  rootDir: string | undefined
): Promise<{
  status: 'valid' | 'invalid' | 'unsigned'
  trust: 'local_identity' | 'trusted_identity' | 'revoked_identity' | 'unknown_identity' | 'unsigned'
  fingerprint?: string
  label?: string
}> {
  if (!manifest.signingIdentity || !manifest.signature) return { status: 'unsigned', trust: 'unsigned' }
  let valid = false
  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(workflowDeliverySignatureEnvelope(manifest.projectId, manifest.manifestDigest)), 'utf8'),
      createPublicKey({
        key: Buffer.from(manifest.signingIdentity.publicKey, 'base64'),
        type: 'spki',
        format: 'der'
      }),
      Buffer.from(manifest.signature, 'base64')
    )
  } catch {
    valid = false
  }
  const localFingerprint = rootDir
    ? await readLocalWorkflowDeliveryIdentityFingerprint(rootDir)
    : undefined
  const trustRecord = rootDir && valid && localFingerprint !== manifest.signingIdentity.fingerprint
    ? await findWorkflowDeliveryIdentityTrustRecord(rootDir, manifest.signingIdentity.fingerprint).catch(() => undefined)
    : undefined
  return {
    status: valid ? 'valid' : 'invalid',
    trust: valid && localFingerprint === manifest.signingIdentity.fingerprint
      ? 'local_identity'
      : valid && trustRecord?.status === 'trusted'
        ? 'trusted_identity'
        : valid && trustRecord?.status === 'revoked'
          ? 'revoked_identity'
      : 'unknown_identity',
    fingerprint: manifest.signingIdentity.fingerprint,
    ...(trustRecord ? { label: trustRecord.label } : {})
  }
}

function compareManifestToEntries(
  manifest: PackageManifest,
  entries: ReadonlyMap<string, VerifiedEntry>
): WorkflowProjectDeliveryPackageVerificationBlocker[] {
  const blockers: WorkflowProjectDeliveryPackageVerificationBlocker[] = []
  const declaredPaths = new Set(manifest.includedArtifacts.map((item) => item.path))
  for (const entry of entries.values()) {
    if (!declaredPaths.has(entry.path)) {
      blockers.push({ code: 'ENTRY_UNDECLARED', message: 'ZIP 包含清单未声明的文件', entry: safeEntryName(entry.path) })
    }
  }
  for (const declared of manifest.includedArtifacts) {
    const actual = entries.get(declared.path)
    if (!actual) {
      blockers.push({ code: 'ARTIFACT_ENTRY_MISSING', message: '清单声明的 Artifact 文件缺失', entry: safeEntryName(declared.path) })
    } else if (actual.sizeBytes !== declared.sizeBytes) {
      blockers.push({ code: 'ARTIFACT_SIZE_MISMATCH', message: 'Artifact 文件大小与清单不一致', entry: safeEntryName(declared.path) })
    } else if (actual.digest !== declared.digest) {
      blockers.push({ code: 'ARTIFACT_DIGEST_MISMATCH', message: 'Artifact 文件 SHA-256 与清单不一致', entry: safeEntryName(declared.path) })
    }
    if (blockers.length >= MAX_RESULT_BLOCKERS) break
  }
  return blockers
}

async function hashStableRegularFile(filePath: string): Promise<StableFileHash> {
  let before
  try {
    before = await lstat(filePath, { bigint: true })
  } catch {
    throw new PackageVerificationError('FILE_UNREADABLE', '无法读取所选交付包')
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new PackageVerificationError('FILE_UNREADABLE', '所选交付包不是普通文件')
  }
  const handle = await open(filePath, 'r').catch(() => {
    throw new PackageVerificationError('FILE_UNREADABLE', '无法打开所选交付包')
  })
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (!openedBefore.isFile() || openedBefore.dev !== before.dev || openedBefore.ino !== before.ino) {
      throw new PackageVerificationError('FILE_CHANGED', '交付包身份在校验前发生变化')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let sizeBytes = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      sizeBytes += bytesRead
      if (!Number.isSafeInteger(sizeBytes)) throw new PackageVerificationError('ZIP_SIZE_LIMIT', '交付包过大，无法安全校验')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const openedAfter = await handle.stat({ bigint: true })
    const after = await lstat(filePath, { bigint: true })
    const fingerprint = fileFingerprint(openedBefore)
    if (!sameFingerprint(fingerprint, fileFingerprint(openedAfter)) ||
        openedAfter.dev !== after.dev || openedAfter.ino !== after.ino || BigInt(sizeBytes) !== openedAfter.size) {
      throw new PackageVerificationError('FILE_CHANGED', '交付包在读取过程中发生变化')
    }
    return { digest: hash.digest('hex'), sizeBytes, fingerprint }
  } finally {
    await handle.close()
  }
}

function fileFingerprint(stats: BigIntStats): FileFingerprint {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function packageBlocker(cause: unknown): WorkflowProjectDeliveryPackageVerificationBlocker {
  if (cause instanceof PackageVerificationError) {
    return { code: cause.code, message: cause.message, ...(cause.entry ? { entry: cause.entry } : {}) }
  }
  return { code: 'ZIP_INVALID', message: '交付包无法通过结构校验' }
}

function safeFileName(filePath: string): string {
  const value = basename(filePath).trim()
  return value && value.length <= 180 ? value : 'delivery.zip'
}

function safeEntryName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 240)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isBoundedBase64(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value.length % 4 === 0 && BASE64_PATTERN.test(value)
}
