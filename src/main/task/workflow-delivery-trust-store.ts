import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, open, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type {
  WorkflowDeliveryIdentityTrustSnapshot,
  WorkflowDeliveryTrustPolicyMode,
  WorkflowDeliveryTrustedIdentityView
} from '../../shared/workflow-types'
import { writeDurableFile } from '../durable-file'
import { canonicalJson, digest } from './workflow-ledger-codec'
import {
  getWorkflowDeliveryIdentityProfile,
  signWorkflowDeliveryCanonicalPayload,
  workflowDeliveryIdentityStorageStatus
} from './workflow-delivery-identity'

const TRUST_STORE_FORMAT = 'caogen.workflow-delivery-identity-trust-store.v1'
const MAX_STORE_BYTES = 512 * 1024
const MAX_IDENTITIES = 256
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const TRUST_BUNDLE_FORMAT = 'caogen.workflow-delivery-identity-trust-bundle.v1'
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

type StoredTrustIdentity = WorkflowDeliveryTrustedIdentityView

interface TrustStoreBody {
  schemaVersion: 1
  format: typeof TRUST_STORE_FORMAT
  revision: number
  identities: StoredTrustIdentity[]
  policy?: StoredTrustPolicy
}

interface StoredTrustPolicy {
  mode: WorkflowDeliveryTrustPolicyMode
  updatedAt: number
}

interface TrustStoreDocument extends TrustStoreBody {
  payloadDigest: string
}

interface TrustIdentityMutationInput {
  fingerprint: string
  label: string
  projectId?: string
  expectedRevision: number
  verifiedAt: number
  at?: number
}

interface WorkflowDeliveryTrustBundleBody {
  schemaVersion: 1
  format: typeof TRUST_BUNDLE_FORMAT
  exportedAt: number
  exporter: {
    algorithm: 'Ed25519'
    publicKeyFormat: 'spki-der-base64'
    publicKey: string
    fingerprint: string
  }
  identities: StoredTrustIdentity[]
  payloadDigest: string
}

interface WorkflowDeliveryTrustBundle extends WorkflowDeliveryTrustBundleBody {
  signature: string
}

let mutationTail: Promise<void> = Promise.resolve()

export async function listWorkflowDeliveryTrustedIdentities(
  rootDir: string
): Promise<WorkflowDeliveryIdentityTrustSnapshot> {
  return snapshotWithLocalIdentity(rootDir, await loadTrustStore(rootDir))
}

export async function getWorkflowDeliveryTrustPolicy(
  rootDir: string
): Promise<StoredTrustPolicy> {
  return clone(effectivePolicy(await loadTrustStore(rootDir)))
}

export function updateWorkflowDeliveryTrustPolicy(
  rootDir: string,
  mode: WorkflowDeliveryTrustPolicyMode,
  expectedRevision: number,
  at = Date.now()
): Promise<WorkflowDeliveryIdentityTrustSnapshot> {
  return serializeMutation(async () => {
    const current = await loadTrustStore(rootDir)
    assertExpectedRevision(current, expectedRevision)
    const normalizedMode = normalizeTrustPolicyMode(mode)
    const updatedAt = normalizeTimestamp(at)
    const currentPolicy = effectivePolicy(current)
    if (currentPolicy.mode === normalizedMode) return snapshotWithLocalIdentity(rootDir, current)
    const next = withDigest({
      schemaVersion: 1,
      format: TRUST_STORE_FORMAT,
      revision: current.revision + 1,
      identities: current.identities.map(clone),
      policy: { mode: normalizedMode, updatedAt }
    })
    await persistTrustStore(rootDir, next)
    return snapshotWithLocalIdentity(rootDir, next)
  })
}

export async function exportWorkflowDeliveryIdentityTrustBundleBytes(
  rootDir: string
): Promise<{ bytes: Buffer; identityFingerprint: string; identityCount: number; fileDigest: string }> {
  const current = await loadTrustStore(rootDir)
  const exportedAt = Date.now()
  const local = await getWorkflowDeliveryIdentityProfile(rootDir)
  const unsigned = {
    schemaVersion: 1 as const,
    format: TRUST_BUNDLE_FORMAT as typeof TRUST_BUNDLE_FORMAT,
    exportedAt,
    exporter: {
      algorithm: local.algorithm,
      publicKeyFormat: local.publicKeyFormat,
      publicKey: local.publicKey,
      fingerprint: local.fingerprint
    },
    identities: current.identities.map(clone)
  }
  const body: WorkflowDeliveryTrustBundleBody = {
    ...unsigned,
    payloadDigest: `sha256:${digest(unsigned)}`
  }
  const signing = await signWorkflowDeliveryCanonicalPayload(rootDir, body)
  if (signing.identity.fingerprint !== local.fingerprint) {
    throw new Error('Delivery identity changed during trust bundle export; try again')
  }
  const signature = signing.signature
  const bytes = Buffer.from(`${canonicalJson({ ...body, signature })}\n`, 'utf8')
  return {
    bytes,
    identityFingerprint: signing.identity.fingerprint,
    identityCount: current.identities.length,
    fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }
}

export async function exportWorkflowDeliveryIdentityTrustBundleToPath(
  rootDir: string,
  targetPath: string
): Promise<{ fileName: string; sizeBytes: number; fileDigest: string; identityFingerprint: string; identityCount: number }> {
  const exported = await exportWorkflowDeliveryIdentityTrustBundleBytes(rootDir)
  await writeDurableFile(targetPath, exported.bytes, { mode: 0o600, replace: true })
  const observed = await readFile(targetPath)
  if (!observed.equals(exported.bytes)) throw new Error('Delivery identity trust bundle changed after save')
  return {
    fileName: basename(targetPath),
    sizeBytes: exported.bytes.byteLength,
    fileDigest: exported.fileDigest,
    identityFingerprint: exported.identityFingerprint,
    identityCount: exported.identityCount
  }
}

export async function importWorkflowDeliveryIdentityTrustBundleAtPath(
  rootDir: string,
  sourcePath: string,
  expectedRevision: number
): ReturnType<typeof importWorkflowDeliveryIdentityTrustBundleBytes> {
  return importWorkflowDeliveryIdentityTrustBundleBytes(rootDir, await readStableTrustBundle(sourcePath), expectedRevision)
}

export function suggestedWorkflowDeliveryIdentityTrustBundleName(): string {
  return 'caogen-delivery-trust-bundle.json'
}

export function importWorkflowDeliveryIdentityTrustBundleBytes(
  rootDir: string,
  bytes: Buffer,
  expectedRevision: number
): Promise<{
  signerTrust: 'local_identity' | 'trusted_identity'
  signerFingerprint: string
  importedCount: number
  updatedCount: number
  unchangedCount: number
  snapshot: WorkflowDeliveryIdentityTrustSnapshot
}> {
  return serializeMutation(async () => {
    if (bytes.length < 1 || bytes.length > MAX_STORE_BYTES) throw new Error('Delivery identity trust bundle size is invalid')
    let raw: unknown
    try { raw = JSON.parse(bytes.toString('utf8')) as unknown } catch {
      throw new Error('Delivery identity trust bundle is not valid JSON')
    }
    const bundle = parseTrustBundle(raw)
    const current = await loadTrustStore(rootDir)
    assertExpectedRevision(current, expectedRevision)
    const local = await getWorkflowDeliveryIdentityProfile(rootDir)
    const signerRecord = current.identities.find((item) => item.fingerprint === bundle.exporter.fingerprint)
    const signerTrust = local.fingerprint === bundle.exporter.fingerprint
      ? 'local_identity' as const
      : signerRecord?.status === 'trusted'
        ? 'trusted_identity' as const
        : undefined
    if (!signerTrust) {
      throw new Error('Trust bundle signer is not local or directly trusted; restore its identity backup or trust a verified package first')
    }

    const identities = current.identities.map(clone)
    let importedCount = 0
    let updatedCount = 0
    let unchangedCount = 0
    for (const imported of bundle.identities) {
      const index = identities.findIndex((item) => item.fingerprint === imported.fingerprint)
      if (index < 0) {
        makeRoomForIdentity(identities)
        identities.push(clone(imported))
        importedCount += 1
        continue
      }
      const existing = identities[index]
      const replacement = mergeTrustIdentity(existing, imported)
      if (canonicalJson(replacement) === canonicalJson(existing)) unchangedCount += 1
      else {
        identities[index] = replacement
        updatedCount += 1
      }
    }
    if (importedCount === 0 && updatedCount === 0) {
      return {
        signerTrust,
        signerFingerprint: bundle.exporter.fingerprint,
        importedCount,
        updatedCount,
        unchangedCount,
        snapshot: await snapshotWithLocalIdentity(rootDir, current)
      }
    }
    const next = withDigest({
      schemaVersion: 1,
      format: TRUST_STORE_FORMAT,
      revision: current.revision + 1,
      identities: sortIdentities(identities),
      policy: effectivePolicy(current)
    })
    await persistTrustStore(rootDir, next)
    return {
      signerTrust,
      signerFingerprint: bundle.exporter.fingerprint,
      importedCount,
      updatedCount,
      unchangedCount,
      snapshot: await snapshotWithLocalIdentity(rootDir, next)
    }
  })
}

export async function findWorkflowDeliveryIdentityTrustRecord(
  rootDir: string,
  fingerprint: string
): Promise<WorkflowDeliveryTrustedIdentityView | undefined> {
  const normalized = normalizeFingerprint(fingerprint)
  const identity = (await loadTrustStore(rootDir)).identities.find((item) => item.fingerprint === normalized)
  return identity ? clone(identity) : undefined
}

export function trustWorkflowDeliveryIdentity(
  rootDir: string,
  input: TrustIdentityMutationInput
): Promise<WorkflowDeliveryIdentityTrustSnapshot> {
  return serializeMutation(async () => {
    const current = await loadTrustStore(rootDir)
    assertExpectedRevision(current, input.expectedRevision)
    const fingerprint = normalizeFingerprint(input.fingerprint)
    const label = normalizeLabel(input.label)
    const projectId = normalizeOptionalProjectId(input.projectId)
    const at = normalizeTimestamp(input.at)
    const verifiedAt = normalizeTimestamp(input.verifiedAt)
    if (verifiedAt > at) throw new Error('Delivery identity verification timestamp is in the future')
    const identities = current.identities.map(clone)
    const existing = identities.find((item) => item.fingerprint === fingerprint)
    if (existing) {
      existing.label = label
      existing.status = 'trusted'
      existing.updatedAt = at
      existing.lastVerifiedAt = verifiedAt
      delete existing.revokedAt
      if (projectId) existing.lastProjectId = projectId
      else delete existing.lastProjectId
    } else {
      makeRoomForIdentity(identities)
      identities.push({
        fingerprint,
        label,
        status: 'trusted',
        trustedAt: at,
        updatedAt: at,
        lastVerifiedAt: verifiedAt,
        ...(projectId ? { lastProjectId: projectId } : {})
      })
    }
    const next = withDigest({
      schemaVersion: 1,
      format: TRUST_STORE_FORMAT,
      revision: current.revision + 1,
      identities: sortIdentities(identities),
      policy: effectivePolicy(current)
    })
    await persistTrustStore(rootDir, next)
    return snapshotWithLocalIdentity(rootDir, next)
  })
}

export function revokeWorkflowDeliveryIdentity(
  rootDir: string,
  fingerprint: string,
  expectedRevision: number,
  at = Date.now()
): Promise<WorkflowDeliveryIdentityTrustSnapshot> {
  return serializeMutation(async () => {
    const current = await loadTrustStore(rootDir)
    assertExpectedRevision(current, expectedRevision)
    const normalized = normalizeFingerprint(fingerprint)
    const identity = current.identities.find((item) => item.fingerprint === normalized)
    if (!identity || identity.status !== 'trusted') {
      throw new Error('The delivery identity is not currently trusted')
    }
    const revokedAt = normalizeTimestamp(at)
    const identities = current.identities.map((item) => item.fingerprint === normalized
      ? { ...clone(item), status: 'revoked' as const, updatedAt: revokedAt, revokedAt }
      : clone(item))
    const next = withDigest({
      schemaVersion: 1,
      format: TRUST_STORE_FORMAT,
      revision: current.revision + 1,
      identities: sortIdentities(identities),
      policy: effectivePolicy(current)
    })
    await persistTrustStore(rootDir, next)
    return snapshotWithLocalIdentity(rootDir, next)
  })
}

export function recordWorkflowDeliveryRetiredLocalIdentity(
  rootDir: string,
  fingerprint: string,
  reason: 'rotated' | 'restored',
  at = Date.now(),
  activeFingerprint?: string
): Promise<WorkflowDeliveryIdentityTrustSnapshot> {
  return serializeMutation(async () => {
    const current = await loadTrustStore(rootDir)
    const normalized = normalizeFingerprint(fingerprint)
    const retiredAt = normalizeTimestamp(at)
    const active = activeFingerprint ? normalizeFingerprint(activeFingerprint) : undefined
    const identities = current.identities.filter((item) => item.fingerprint !== active).map(clone)
    const existing = identities.find((item) => item.fingerprint === normalized)
    if (existing) {
      existing.status = 'revoked'
      existing.updatedAt = Math.max(existing.updatedAt, retiredAt)
      existing.revokedAt = Math.max(existing.revokedAt ?? 0, retiredAt)
    } else {
      makeRoomForIdentity(identities)
      identities.push({
        fingerprint: normalized,
        label: `EastGenesis local identity (${reason})`,
        status: 'revoked',
        trustedAt: retiredAt,
        updatedAt: retiredAt,
        lastVerifiedAt: retiredAt,
        revokedAt: retiredAt
      })
    }
    const next = withDigest({
      schemaVersion: 1,
      format: TRUST_STORE_FORMAT,
      revision: current.revision + 1,
      identities: sortIdentities(identities),
      policy: effectivePolicy(current)
    })
    await persistTrustStore(rootDir, next)
    return snapshotWithLocalIdentity(rootDir, next)
  })
}

async function loadTrustStore(rootDir: string): Promise<TrustStoreDocument> {
  const filePath = trustStorePath(rootDir)
  let before
  try {
    before = await lstat(filePath, { bigint: true })
  } catch (error) {
    if (isMissingFile(error)) return emptyTrustStore()
    throw new Error('Delivery identity trust store cannot be inspected')
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_STORE_BYTES) {
    throw new Error('Delivery identity trust store is invalid')
  }
  const handle = await open(filePath, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('Delivery identity trust store changed before read')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
      throw new Error('Delivery identity trust store changed during read')
    }
    let raw: unknown
    try { raw = JSON.parse(bytes.toString('utf8')) as unknown } catch {
      throw new Error('Delivery identity trust store is not valid JSON')
    }
    return parseTrustStore(raw)
  } finally {
    await handle.close()
  }
}

function parseTrustStore(raw: unknown): TrustStoreDocument {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.format !== TRUST_STORE_FORMAT ||
      !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 ||
      !Array.isArray(raw.identities) || raw.identities.length > MAX_IDENTITIES ||
      typeof raw.payloadDigest !== 'string' || !SHA256_FINGERPRINT.test(raw.payloadDigest)) {
    throw new Error('Delivery identity trust store schema is invalid')
  }
  const identities = raw.identities.map(parseIdentity)
  const fingerprints = new Set(identities.map((item) => item.fingerprint))
  if (fingerprints.size !== identities.length) throw new Error('Delivery identity trust store contains duplicates')
  const document = raw as unknown as TrustStoreDocument
  if (document.policy !== undefined) parseTrustPolicy(document.policy)
  const { payloadDigest, ...body } = document
  if (`sha256:${digest(body)}` !== payloadDigest) {
    throw new Error('Delivery identity trust store integrity check failed')
  }
  return { ...document, identities: sortIdentities(identities) }
}

function parseIdentity(raw: unknown): StoredTrustIdentity {
  if (!isRecord(raw) || typeof raw.fingerprint !== 'string' || !SHA256_FINGERPRINT.test(raw.fingerprint) ||
      typeof raw.label !== 'string' || raw.label !== normalizeLabel(raw.label) ||
      (raw.status !== 'trusted' && raw.status !== 'revoked') ||
      !isTimestamp(raw.trustedAt) || !isTimestamp(raw.updatedAt) || !isTimestamp(raw.lastVerifiedAt) ||
      (raw.updatedAt as number) < (raw.trustedAt as number) ||
      (raw.lastVerifiedAt as number) > (raw.updatedAt as number) ||
      (raw.lastProjectId !== undefined && normalizeOptionalProjectId(raw.lastProjectId) !== raw.lastProjectId) ||
      (raw.status === 'revoked' ? !isTimestamp(raw.revokedAt) : raw.revokedAt !== undefined)) {
    throw new Error('Delivery identity trust record is invalid')
  }
  return raw as unknown as StoredTrustIdentity
}

async function persistTrustStore(rootDir: string, document: TrustStoreDocument): Promise<void> {
  const filePath = trustStorePath(rootDir)
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, 'utf8')
  await writeDurableFile(filePath, bytes, {
    mode: 0o600,
    replace: true
  })
  const observed = await readFile(filePath)
  if (!observed.equals(bytes)) throw new Error('Delivery identity trust store changed after write')
}

function emptyTrustStore(): TrustStoreDocument {
  return withDigest({
    schemaVersion: 1,
    format: TRUST_STORE_FORMAT,
    revision: 0,
    identities: [],
    policy: { mode: 'audit_only', updatedAt: 1 }
  })
}

function withDigest(body: TrustStoreBody): TrustStoreDocument {
  return { ...body, payloadDigest: `sha256:${digest(body)}` }
}

async function snapshotWithLocalIdentity(
  rootDir: string,
  document: TrustStoreDocument
): Promise<WorkflowDeliveryIdentityTrustSnapshot> {
  const localIdentityStatus = workflowDeliveryIdentityStorageStatus() === 'available'
    ? 'available' as const
    : 'protected_storage_unavailable' as const
  const local = localIdentityStatus === 'available'
    ? await getWorkflowDeliveryIdentityProfile(rootDir)
    : undefined
  return {
    schemaVersion: 1,
    format: 'caogen.workflow-delivery-identity-trust-view.v1',
    revision: document.revision,
    identities: document.identities.map(clone),
    policy: effectivePolicy(document),
    localIdentityStatus,
    ...(local
      ? {
          localIdentity: {
            fingerprint: local.fingerprint,
            createdAt: local.createdAt,
            retiredIdentities: local.retiredIdentities.map((item) => ({ ...item }))
          }
        }
      : {})
  }
}

function effectivePolicy(document: TrustStoreDocument): StoredTrustPolicy {
  return document.policy ? clone(parseTrustPolicy(document.policy)) : { mode: 'audit_only', updatedAt: 1 }
}

function parseTrustPolicy(raw: unknown): StoredTrustPolicy {
  if (!isRecord(raw) || normalizeTrustPolicyMode(raw.mode) !== raw.mode || !isTimestamp(raw.updatedAt)) {
    throw new Error('Delivery identity trust policy is invalid')
  }
  return raw as unknown as StoredTrustPolicy
}

function normalizeTrustPolicyMode(value: unknown): WorkflowDeliveryTrustPolicyMode {
  if (value !== 'audit_only' && value !== 'require_valid_signature' && value !== 'require_trusted_identity') {
    throw new Error('Delivery identity trust policy mode is invalid')
  }
  return value
}

function assertExpectedRevision(document: TrustStoreDocument, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('Delivery identity trust revision is invalid')
  }
  if (document.revision !== expectedRevision) {
    throw new Error('Delivery identity trust list changed; refresh and try again')
  }
}

function parseTrustBundle(raw: unknown): WorkflowDeliveryTrustBundle {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.format !== TRUST_BUNDLE_FORMAT ||
      !isTimestamp(raw.exportedAt) || (raw.exportedAt as number) > Date.now() + MAX_CLOCK_SKEW_MS ||
      !isRecord(raw.exporter) || raw.exporter.algorithm !== 'Ed25519' ||
      raw.exporter.publicKeyFormat !== 'spki-der-base64' || !isBoundedBase64(raw.exporter.publicKey, 256) ||
      typeof raw.exporter.fingerprint !== 'string' || !SHA256_FINGERPRINT.test(raw.exporter.fingerprint) ||
      !Array.isArray(raw.identities) || raw.identities.length > MAX_IDENTITIES ||
      typeof raw.payloadDigest !== 'string' || !SHA256_FINGERPRINT.test(raw.payloadDigest) ||
      !isBoundedBase64(raw.signature, 256)) {
    throw new Error('Delivery identity trust bundle schema is invalid')
  }
  const identities = raw.identities.map(parseIdentity)
  if (new Set(identities.map((item) => item.fingerprint)).size !== identities.length) {
    throw new Error('Delivery identity trust bundle contains duplicates')
  }
  const bundle = { ...raw, identities } as unknown as WorkflowDeliveryTrustBundle
  const { signature, payloadDigest, ...unsigned } = bundle
  if (`sha256:${digest(unsigned)}` !== payloadDigest) {
    throw new Error('Delivery identity trust bundle integrity check failed')
  }
  const publicDer = Buffer.from(bundle.exporter.publicKey, 'base64')
  if (`sha256:${createHash('sha256').update(publicDer).digest('hex')}` !== bundle.exporter.fingerprint) {
    throw new Error('Delivery identity trust bundle signer fingerprint is invalid')
  }
  try {
    const key = createPublicKey({ key: publicDer, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519' ||
        !verify(null, Buffer.from(canonicalJson({ ...unsigned, payloadDigest }), 'utf8'), key, Buffer.from(signature, 'base64'))) {
      throw new Error('invalid')
    }
  } catch {
    throw new Error('Delivery identity trust bundle signature is invalid')
  }
  return bundle
}

function mergeTrustIdentity(
  existing: StoredTrustIdentity,
  imported: StoredTrustIdentity
): StoredTrustIdentity {
  if (existing.status === 'revoked' && existing.updatedAt >= imported.updatedAt) return clone(existing)
  if (imported.status === 'revoked' && imported.updatedAt >= existing.updatedAt) return clone(imported)
  if (imported.updatedAt > existing.updatedAt) return clone(imported)
  return clone(existing)
}

function makeRoomForIdentity(identities: StoredTrustIdentity[]): void {
  if (identities.length < MAX_IDENTITIES) return
  const oldestRevoked = identities
    .filter((item) => item.status === 'revoked')
    .sort((left, right) => left.updatedAt - right.updatedAt)[0]
  if (!oldestRevoked) throw new Error(`Delivery identity trust store reached its ${MAX_IDENTITIES} identity limit`)
  identities.splice(identities.findIndex((item) => item.fingerprint === oldestRevoked.fingerprint), 1)
}

function sortIdentities(identities: StoredTrustIdentity[]): StoredTrustIdentity[] {
  return identities.sort((left, right) =>
    Number(left.status === 'revoked') - Number(right.status === 'revoked') ||
    right.updatedAt - left.updatedAt || left.fingerprint.localeCompare(right.fingerprint)
  )
}

function normalizeFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!SHA256_FINGERPRINT.test(normalized)) throw new Error('Delivery identity fingerprint is invalid')
  return normalized
}

function normalizeLabel(value: string): string {
  const label = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('Delivery identity label must contain 1-100 visible characters')
  }
  return label
}

function normalizeOptionalProjectId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Delivery identity Project ID is invalid')
  const projectId = value.trim()
  if (!projectId || projectId.length > 200 || /[\u0000-\u001f\u007f]/.test(projectId)) {
    throw new Error('Delivery identity Project ID is invalid')
  }
  return projectId
}

function normalizeTimestamp(value: number | undefined): number {
  const timestamp = value ?? Date.now()
  if (!isTimestamp(timestamp)) throw new Error('Delivery identity trust timestamp is invalid')
  return timestamp
}

function isBoundedBase64(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value.length % 4 === 0 && BASE64_PATTERN.test(value)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function trustStorePath(rootDir: string): string {
  return join(resolve(rootDir), 'private', 'workflow-delivery-identity-trust.json')
}

function serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(mutation, mutation)
  mutationTail = result.then(() => undefined, () => undefined)
  return result
}

async function readStableTrustBundle(filePath: string): Promise<Buffer> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_STORE_BYTES) {
    throw new Error('Delivery identity trust bundle is not a bounded regular file')
  }
  const bytes = await readFile(filePath)
  const after = await lstat(filePath, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error('Delivery identity trust bundle changed during read')
  }
  return bytes
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
