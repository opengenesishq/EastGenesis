import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign
} from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { writeDurableFile } from '../durable-file'
import { protectedStorage } from '../security/protected-storage-runtime'
import { canonicalJson, digest } from './workflow-ledger-codec'

const IDENTITY_FORMAT = 'caogen.workflow-delivery-identity.v1'
const SIGNATURE_ENVELOPE_FORMAT = 'caogen.project-delivery-signature-envelope.v1'
const MAX_IDENTITY_BYTES = 32 * 1024
const MAX_RETIRED_IDENTITIES = 64
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const IDENTITY_BACKUP_FORMAT = 'caogen.workflow-delivery-identity-backup.v1'
const IDENTITY_BACKUP_PAYLOAD_FORMAT = 'caogen.workflow-delivery-identity-backup-payload.v1'

interface StoredWorkflowDeliveryIdentityBody {
  schemaVersion: 1
  format: typeof IDENTITY_FORMAT
  createdAt: number
  algorithm: 'Ed25519'
  publicKeyFormat: 'spki-der-base64'
  publicKey: string
  publicKeyFingerprint: string
  encryptedPrivateKey: string
  retiredIdentities?: WorkflowDeliveryRetiredIdentity[]
}

interface StoredWorkflowDeliveryIdentity extends StoredWorkflowDeliveryIdentityBody {
  payloadDigest: string
}

export interface WorkflowDeliverySigningIdentity {
  algorithm: 'Ed25519'
  publicKeyFormat: 'spki-der-base64'
  publicKey: string
  fingerprint: string
}

export interface WorkflowDeliveryRetiredIdentity {
  fingerprint: string
  retiredAt: number
  reason: 'rotated' | 'restored'
}

export interface WorkflowDeliveryIdentityProfile extends WorkflowDeliverySigningIdentity {
  createdAt: number
  retiredIdentities: WorkflowDeliveryRetiredIdentity[]
}

export type WorkflowDeliveryIdentityStorageStatus =
  | 'available'
  | 'encryption_unavailable'
  | 'insecure_linux_backend'

interface WorkflowDeliveryIdentityBackupPayload {
  schemaVersion: 1
  format: typeof IDENTITY_BACKUP_PAYLOAD_FORMAT
  createdAt: number
  publicKey: string
  publicKeyFingerprint: string
  privateKey: string
  retiredIdentities: WorkflowDeliveryRetiredIdentity[]
}

interface WorkflowDeliveryIdentityBackupEnvelopeBody {
  schemaVersion: 1
  format: typeof IDENTITY_BACKUP_FORMAT
  createdAt: number
  identityFingerprint: string
  kdf: { algorithm: 'scrypt'; salt: string; keyLength: 32; cost: 16384; blockSize: 8; parallelization: 1 }
  cipher: { algorithm: 'aes-256-gcm'; iv: string; authTag: string; ciphertext: string }
}

interface WorkflowDeliveryIdentityBackupEnvelope extends WorkflowDeliveryIdentityBackupEnvelopeBody {
  payloadDigest: string
}

export interface WorkflowDeliveryManifestSignature {
  algorithm: 'Ed25519'
  envelopeFormat: typeof SIGNATURE_ENVELOPE_FORMAT
  value: string
}

export interface WorkflowDeliverySignatureEnvelope {
  schemaVersion: 1
  format: typeof SIGNATURE_ENVELOPE_FORMAT
  projectId: string
  manifestDigest: string
}

const identityPromises = new Map<string, Promise<ResolvedWorkflowDeliveryIdentity>>()

interface ResolvedWorkflowDeliveryIdentity {
  identity: WorkflowDeliverySigningIdentity
  privateKey: ReturnType<typeof createPrivateKey>
  createdAt: number
  retiredIdentities: WorkflowDeliveryRetiredIdentity[]
}

let identityMutationTail: Promise<void> = Promise.resolve()

export async function signWorkflowProjectDeliveryManifest(
  rootDir: string,
  projectId: string,
  manifestDigest: string
): Promise<{ identity: WorkflowDeliverySigningIdentity; signature: WorkflowDeliveryManifestSignature }> {
  const resolved = await loadOrCreateWorkflowDeliveryIdentity(rootDir)
  const envelope: WorkflowDeliverySignatureEnvelope = {
    schemaVersion: 1,
    format: SIGNATURE_ENVELOPE_FORMAT,
    projectId,
    manifestDigest
  }
  return {
    identity: resolved.identity,
    signature: {
      algorithm: 'Ed25519',
      envelopeFormat: SIGNATURE_ENVELOPE_FORMAT,
      value: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), resolved.privateKey).toString('base64')
    }
  }
}

export async function getWorkflowDeliverySigningIdentity(
  rootDir: string
): Promise<WorkflowDeliverySigningIdentity> {
  return (await loadOrCreateWorkflowDeliveryIdentity(rootDir)).identity
}

export async function getWorkflowDeliveryIdentityProfile(rootDir: string): Promise<WorkflowDeliveryIdentityProfile> {
  const resolved = await loadOrCreateWorkflowDeliveryIdentity(rootDir)
  return {
    ...resolved.identity,
    createdAt: resolved.createdAt,
    retiredIdentities: resolved.retiredIdentities.map((item) => ({ ...item }))
  }
}

export function workflowDeliveryIdentityStorageStatus(): WorkflowDeliveryIdentityStorageStatus {
  if (!protectedStorage.isEncryptionAvailable()) return 'encryption_unavailable'
  if (process.platform === 'linux' && protectedStorage.getSelectedStorageBackend() === 'basic_text') {
    return 'insecure_linux_backend'
  }
  return 'available'
}

export async function signWorkflowDeliveryCanonicalPayload(
  rootDir: string,
  payload: unknown
): Promise<{ identity: WorkflowDeliverySigningIdentity; signature: string }> {
  const resolved = await loadOrCreateWorkflowDeliveryIdentity(rootDir)
  return {
    identity: resolved.identity,
    signature: sign(null, Buffer.from(canonicalJson(payload), 'utf8'), resolved.privateKey).toString('base64')
  }
}

export async function exportWorkflowDeliveryIdentityBackupBytes(
  rootDir: string,
  rawPassphrase: string
): Promise<{ bytes: Buffer; identityFingerprint: string; fileDigest: string }> {
  const passphrase = normalizeBackupPassphrase(rawPassphrase)
  const resolved = await loadOrCreateWorkflowDeliveryIdentity(rootDir)
  const privateKey = resolved.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  const payload: WorkflowDeliveryIdentityBackupPayload = {
    schemaVersion: 1,
    format: IDENTITY_BACKUP_PAYLOAD_FORMAT,
    createdAt: resolved.createdAt,
    publicKey: resolved.identity.publicKey,
    publicKeyFingerprint: resolved.identity.fingerprint,
    privateKey,
    retiredIdentities: resolved.retiredIdentities.map((item) => ({ ...item }))
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(canonicalJson(payload), 'utf8'), cipher.final()])
  const body: WorkflowDeliveryIdentityBackupEnvelopeBody = {
    schemaVersion: 1,
    format: IDENTITY_BACKUP_FORMAT,
    createdAt: Date.now(),
    identityFingerprint: resolved.identity.fingerprint,
    kdf: {
      algorithm: 'scrypt',
      salt: salt.toString('base64'),
      keyLength: 32,
      cost: 16384,
      blockSize: 8,
      parallelization: 1
    },
    cipher: {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    }
  }
  const envelope: WorkflowDeliveryIdentityBackupEnvelope = {
    ...body,
    payloadDigest: `sha256:${digest(body)}`
  }
  const bytes = Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8')
  return {
    bytes,
    identityFingerprint: resolved.identity.fingerprint,
    fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }
}

export async function exportWorkflowDeliveryIdentityBackupToPath(
  rootDir: string,
  targetPath: string,
  passphrase: string
): Promise<{ fileName: string; sizeBytes: number; fileDigest: string; identityFingerprint: string }> {
  const exported = await exportWorkflowDeliveryIdentityBackupBytes(rootDir, passphrase)
  await writeDurableFile(targetPath, exported.bytes, { mode: 0o600, replace: true })
  const observed = await readFile(targetPath)
  if (!observed.equals(exported.bytes)) throw new Error('Delivery identity backup changed after save')
  return {
    fileName: basename(targetPath),
    sizeBytes: exported.bytes.byteLength,
    fileDigest: exported.fileDigest,
    identityFingerprint: exported.identityFingerprint
  }
}

export async function restoreWorkflowDeliveryIdentityBackupAtPath(
  rootDir: string,
  sourcePath: string,
  passphrase: string
): Promise<{ disposition: 'restored' | 'reinstalled'; previousFingerprint?: string; profile: WorkflowDeliveryIdentityProfile }> {
  return restoreWorkflowDeliveryIdentityBackupBytes(rootDir, await readStableBoundedFile(sourcePath), passphrase)
}

export function suggestedWorkflowDeliveryIdentityBackupName(fingerprint: string): string {
  return `caogen-delivery-identity-${fingerprint.replace(/^sha256:/, '').slice(0, 12)}.backup.json`
}

export function restoreWorkflowDeliveryIdentityBackupBytes(
  rootDir: string,
  bytes: Buffer,
  rawPassphrase: string
): Promise<{ disposition: 'restored' | 'reinstalled'; previousFingerprint?: string; profile: WorkflowDeliveryIdentityProfile }> {
  return serializeIdentityMutation(async () => {
    if (bytes.length < 1 || bytes.length > MAX_IDENTITY_BYTES) throw new Error('Delivery identity backup size is invalid')
    const envelope = parseBackupEnvelope(JSON.parse(bytes.toString('utf8')) as unknown)
    const payload = decryptBackupPayload(envelope, normalizeBackupPassphrase(rawPassphrase))
    const current = await loadExistingWorkflowDeliveryIdentity(rootDir)
    const restoredPrivateKey = createPrivateKey({ key: Buffer.from(payload.privateKey, 'base64'), type: 'pkcs8', format: 'der' })
    const previousFingerprint = current?.identity.fingerprint
    const disposition = previousFingerprint === payload.publicKeyFingerprint ? 'reinstalled' as const : 'restored' as const
    const retired = mergeRetiredIdentities(
      payload.retiredIdentities,
      current?.retiredIdentities ?? [],
      previousFingerprint && previousFingerprint !== payload.publicKeyFingerprint
        ? [{ fingerprint: previousFingerprint, retiredAt: Date.now(), reason: 'restored' as const }]
        : []
    ).filter((item) => item.fingerprint !== payload.publicKeyFingerprint)
    const created = createStoredWorkflowDeliveryIdentity(restoredPrivateKey, payload.createdAt, retired)
    await persistIdentity(rootDir, created.stored)
    identityPromises.set(resolve(rootDir), Promise.resolve(created.resolved))
    return {
      disposition,
      ...(previousFingerprint && previousFingerprint !== payload.publicKeyFingerprint ? { previousFingerprint } : {}),
      profile: profile(created.resolved)
    }
  })
}

export function rotateWorkflowDeliveryIdentity(
  rootDir: string,
  expectedFingerprint?: string
): Promise<{ previousFingerprint?: string; profile: WorkflowDeliveryIdentityProfile }> {
  return serializeIdentityMutation(async () => {
    const current = await loadExistingWorkflowDeliveryIdentity(rootDir)
    if (expectedFingerprint !== undefined && current?.identity.fingerprint !== expectedFingerprint.trim().toLowerCase()) {
      throw new Error('Delivery identity changed; refresh and try again')
    }
    const retired = current
      ? mergeRetiredIdentities(current.retiredIdentities, [{
          fingerprint: current.identity.fingerprint,
          retiredAt: Date.now(),
          reason: 'rotated'
        }])
      : []
    const created = createWorkflowDeliveryIdentity(retired)
    await persistIdentity(rootDir, created.stored)
    identityPromises.set(resolve(rootDir), Promise.resolve(created.resolved))
    return {
      ...(current ? { previousFingerprint: current.identity.fingerprint } : {}),
      profile: profile(created.resolved)
    }
  })
}

export async function readLocalWorkflowDeliveryIdentityFingerprint(rootDir: string): Promise<string | undefined> {
  try {
    return (await loadExistingWorkflowDeliveryIdentity(rootDir))?.identity.fingerprint
  } catch {
    return undefined
  }
}

export function workflowDeliverySignatureEnvelope(
  projectId: string,
  manifestDigest: string
): WorkflowDeliverySignatureEnvelope {
  return {
    schemaVersion: 1,
    format: SIGNATURE_ENVELOPE_FORMAT,
    projectId,
    manifestDigest
  }
}

function loadOrCreateWorkflowDeliveryIdentity(rootDir: string): Promise<ResolvedWorkflowDeliveryIdentity> {
  const root = resolve(rootDir)
  const existingPromise = identityPromises.get(root)
  if (existingPromise) return existingPromise
  const promise = loadExistingWorkflowDeliveryIdentity(root).then(async (existing) => {
    if (existing) return existing
    const created = createWorkflowDeliveryIdentity()
    try {
      await writeDurableFile(identityPath(root), `${canonicalJson(created.stored)}\n`, {
        mode: 0o600,
        replace: false
      })
      return created.resolved
    } catch (error) {
      const concurrent = await loadExistingWorkflowDeliveryIdentity(root)
      if (concurrent) return concurrent
      throw error
    }
  }).catch((error) => {
    identityPromises.delete(root)
    throw error
  })
  identityPromises.set(root, promise)
  return promise
}

async function loadExistingWorkflowDeliveryIdentity(
  rootDir: string
): Promise<ResolvedWorkflowDeliveryIdentity | undefined> {
  const filePath = identityPath(rootDir)
  let info
  try {
    info = await lstat(filePath)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error('EastGenesis delivery identity cannot be inspected')
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_IDENTITY_BYTES) {
    throw new Error('EastGenesis delivery identity store is invalid')
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch {
    throw new Error('EastGenesis delivery identity store is unreadable')
  }
  const stored = parseStoredIdentity(raw)
  const privateKey = decryptPrivateKey(stored.encryptedPrivateKey)
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('EastGenesis delivery identity private key is not Ed25519')
  }
  const derivedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const expectedPublicKey = Buffer.from(stored.publicKey, 'base64')
  if (!derivedPublicKey.equals(expectedPublicKey)) {
    throw new Error('EastGenesis delivery identity key pair does not match')
  }
  return {
      identity: publicIdentity(stored.publicKey, stored.publicKeyFingerprint),
      privateKey,
      createdAt: stored.createdAt,
      retiredIdentities: stored.retiredIdentities?.map((item) => ({ ...item })) ?? []
  }
}

function createWorkflowDeliveryIdentity(retiredIdentities: WorkflowDeliveryRetiredIdentity[] = []): {
  stored: StoredWorkflowDeliveryIdentity
  resolved: ResolvedWorkflowDeliveryIdentity
} {
  assertProtectedStorageAvailable()
  const pair = generateKeyPairSync('ed25519')
  return createStoredWorkflowDeliveryIdentity(pair.privateKey, Date.now(), retiredIdentities)
}

function createStoredWorkflowDeliveryIdentity(
  privateKey: ReturnType<typeof createPrivateKey>,
  createdAt: number,
  retiredIdentities: WorkflowDeliveryRetiredIdentity[]
): { stored: StoredWorkflowDeliveryIdentity; resolved: ResolvedWorkflowDeliveryIdentity } {
  assertProtectedStorageAvailable()
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' })
  const publicKey = publicDer.toString('base64')
  const publicKeyFingerprint = publicKeyDigest(publicDer)
  const body: StoredWorkflowDeliveryIdentityBody = {
    schemaVersion: 1,
    format: IDENTITY_FORMAT,
    createdAt,
    algorithm: 'Ed25519',
    publicKeyFormat: 'spki-der-base64',
    publicKey,
    publicKeyFingerprint,
    encryptedPrivateKey: `enc:${protectedStorage.encryptString(privateDer.toString('base64')).toString('base64')}`,
    ...(retiredIdentities.length > 0 ? { retiredIdentities: mergeRetiredIdentities(retiredIdentities) } : {})
  }
  return {
    stored: { ...body, payloadDigest: `sha256:${digest(body)}` },
    resolved: {
      identity: publicIdentity(publicKey, publicKeyFingerprint),
      privateKey,
      createdAt,
      retiredIdentities: mergeRetiredIdentities(retiredIdentities)
    }
  }
}

function parseStoredIdentity(raw: unknown): StoredWorkflowDeliveryIdentity {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.format !== IDENTITY_FORMAT ||
      !Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) <= 0 ||
      raw.algorithm !== 'Ed25519' || raw.publicKeyFormat !== 'spki-der-base64' ||
      !isBoundedBase64(raw.publicKey, 256) || !isFingerprint(raw.publicKeyFingerprint) ||
      typeof raw.encryptedPrivateKey !== 'string' || !raw.encryptedPrivateKey.startsWith('enc:') ||
      !isBoundedBase64(raw.encryptedPrivateKey.slice(4), 2048) || !isFingerprint(raw.payloadDigest)) {
      throw new Error('EastGenesis delivery identity store has an invalid schema')
  }
  const stored = raw as unknown as StoredWorkflowDeliveryIdentity
  if (stored.retiredIdentities !== undefined) {
    if (!Array.isArray(stored.retiredIdentities) || stored.retiredIdentities.length > MAX_RETIRED_IDENTITIES) {
      throw new Error('EastGenesis delivery identity history is invalid')
    }
    const parsed = stored.retiredIdentities.map(parseRetiredIdentity)
    if (new Set(parsed.map((item) => item.fingerprint)).size !== parsed.length ||
        parsed.some((item) => item.fingerprint === stored.publicKeyFingerprint)) {
      throw new Error('EastGenesis delivery identity history is invalid')
    }
  }
  const { payloadDigest, ...body } = stored
  if (`sha256:${digest(body)}` !== payloadDigest) {
    throw new Error('EastGenesis delivery identity store integrity check failed')
  }
  const publicDer = Buffer.from(stored.publicKey, 'base64')
  if (publicKeyDigest(publicDer) !== stored.publicKeyFingerprint) {
    throw new Error('EastGenesis delivery identity fingerprint does not match')
  }
  try {
    const publicKey = createPublicKey({ key: publicDer, type: 'spki', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
  } catch {
    throw new Error('EastGenesis delivery identity public key is invalid')
  }
  return stored
}

function decryptPrivateKey(value: string): ReturnType<typeof createPrivateKey> {
  assertProtectedStorageAvailable()
  try {
    const decrypted = protectedStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    if (!isBoundedBase64(decrypted, 1024)) throw new Error('invalid key encoding')
    const key = createPrivateKey({ key: Buffer.from(decrypted, 'base64'), type: 'pkcs8', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
    return key
  } catch {
    throw new Error('EastGenesis delivery identity private key cannot be decrypted')
  }
}

function assertProtectedStorageAvailable(): void {
  const status = workflowDeliveryIdentityStorageStatus()
  if (status === 'encryption_unavailable') {
    throw new Error('System credential encryption is unavailable; the delivery package was not created')
  }
  if (status === 'insecure_linux_backend') {
    throw new Error('Protected system credential storage is unavailable; the delivery package was not created')
  }
}

function identityPath(rootDir: string): string {
  return join(resolve(rootDir), 'private', 'workflow-delivery-identity.json')
}

async function persistIdentity(rootDir: string, stored: StoredWorkflowDeliveryIdentity): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(stored)}\n`, 'utf8')
  await writeDurableFile(identityPath(rootDir), bytes, { mode: 0o600, replace: true })
  const observed = await readFile(identityPath(rootDir))
  if (!observed.equals(bytes)) throw new Error('EastGenesis delivery identity changed after write')
}

function parseBackupEnvelope(raw: unknown): WorkflowDeliveryIdentityBackupEnvelope {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.format !== IDENTITY_BACKUP_FORMAT ||
      !Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) <= 0 ||
      !isFingerprint(raw.identityFingerprint) || !isFingerprint(raw.payloadDigest) ||
      !isRecord(raw.kdf) || raw.kdf.algorithm !== 'scrypt' || raw.kdf.keyLength !== 32 ||
      raw.kdf.cost !== 16384 || raw.kdf.blockSize !== 8 || raw.kdf.parallelization !== 1 ||
      !isBoundedBase64(raw.kdf.salt, 64) || !isRecord(raw.cipher) ||
      raw.cipher.algorithm !== 'aes-256-gcm' || !isBoundedBase64(raw.cipher.iv, 64) ||
      !isBoundedBase64(raw.cipher.authTag, 64) || !isBoundedBase64(raw.cipher.ciphertext, 16384)) {
    throw new Error('Delivery identity backup has an invalid schema')
  }
  const envelope = raw as unknown as WorkflowDeliveryIdentityBackupEnvelope
  const { payloadDigest, ...body } = envelope
  if (`sha256:${digest(body)}` !== payloadDigest) throw new Error('Delivery identity backup integrity check failed')
  if (Buffer.from(envelope.kdf.salt, 'base64').length !== 16 ||
      Buffer.from(envelope.cipher.iv, 'base64').length !== 12 ||
      Buffer.from(envelope.cipher.authTag, 'base64').length !== 16) {
    throw new Error('Delivery identity backup encryption parameters are invalid')
  }
  return envelope
}

function decryptBackupPayload(
  envelope: WorkflowDeliveryIdentityBackupEnvelope,
  passphrase: string
): WorkflowDeliveryIdentityBackupPayload {
  let raw: unknown
  try {
    const key = scryptSync(passphrase, Buffer.from(envelope.kdf.salt, 'base64'), 32, {
      N: envelope.kdf.cost,
      r: envelope.kdf.blockSize,
      p: envelope.kdf.parallelization,
      maxmem: 64 * 1024 * 1024
    })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.cipher.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.cipher.authTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.cipher.ciphertext, 'base64')),
      decipher.final()
    ])
    raw = JSON.parse(plaintext.toString('utf8')) as unknown
  } catch {
    throw new Error('Delivery identity backup passphrase or encrypted bytes are invalid')
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.format !== IDENTITY_BACKUP_PAYLOAD_FORMAT ||
      !Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) <= 0 ||
      !isBoundedBase64(raw.publicKey, 256) || !isFingerprint(raw.publicKeyFingerprint) ||
      !isBoundedBase64(raw.privateKey, 1024) || !Array.isArray(raw.retiredIdentities) ||
      raw.retiredIdentities.length > MAX_RETIRED_IDENTITIES) {
    throw new Error('Delivery identity backup payload is invalid')
  }
  const retiredIdentities = raw.retiredIdentities.map(parseRetiredIdentity)
  const payload = { ...raw, retiredIdentities } as unknown as WorkflowDeliveryIdentityBackupPayload
  let privateKey
  try {
    privateKey = createPrivateKey({ key: Buffer.from(payload.privateKey, 'base64'), type: 'pkcs8', format: 'der' })
  } catch {
    throw new Error('Delivery identity backup private key is invalid')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Delivery identity backup private key is invalid')
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (publicDer.toString('base64') !== payload.publicKey || publicKeyDigest(publicDer) !== payload.publicKeyFingerprint ||
      payload.publicKeyFingerprint !== envelope.identityFingerprint ||
      retiredIdentities.some((item) => item.fingerprint === payload.publicKeyFingerprint) ||
      new Set(retiredIdentities.map((item) => item.fingerprint)).size !== retiredIdentities.length) {
    throw new Error('Delivery identity backup key binding is invalid')
  }
  return payload
}

function parseRetiredIdentity(raw: unknown): WorkflowDeliveryRetiredIdentity {
  if (!isRecord(raw) || !isFingerprint(raw.fingerprint) ||
      !Number.isSafeInteger(raw.retiredAt) || (raw.retiredAt as number) <= 0 ||
      (raw.reason !== 'rotated' && raw.reason !== 'restored')) {
    throw new Error('Delivery identity history entry is invalid')
  }
  return raw as unknown as WorkflowDeliveryRetiredIdentity
}

function mergeRetiredIdentities(
  ...sources: readonly WorkflowDeliveryRetiredIdentity[][]
): WorkflowDeliveryRetiredIdentity[] {
  const merged = new Map<string, WorkflowDeliveryRetiredIdentity>()
  for (const source of sources.flat()) {
    const entry = parseRetiredIdentity(source)
    const current = merged.get(entry.fingerprint)
    if (!current || entry.retiredAt > current.retiredAt) merged.set(entry.fingerprint, { ...entry })
  }
  return [...merged.values()]
    .sort((left, right) => right.retiredAt - left.retiredAt || left.fingerprint.localeCompare(right.fingerprint))
    .slice(0, MAX_RETIRED_IDENTITIES)
}

function normalizeBackupPassphrase(value: string): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024 || /[\u0000]/.test(value)) {
    throw new Error('Delivery identity backup passphrase must contain 12-1024 characters')
  }
  return value
}

function profile(resolved: ResolvedWorkflowDeliveryIdentity): WorkflowDeliveryIdentityProfile {
  return {
    ...resolved.identity,
    createdAt: resolved.createdAt,
    retiredIdentities: resolved.retiredIdentities.map((item) => ({ ...item }))
  }
}

function serializeIdentityMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = identityMutationTail.then(mutation, mutation)
  identityMutationTail = result.then(() => undefined, () => undefined)
  return result
}

async function readStableBoundedFile(filePath: string): Promise<Buffer> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_IDENTITY_BYTES) {
    throw new Error('Delivery identity backup is not a bounded regular file')
  }
  const bytes = await readFile(filePath)
  const after = await lstat(filePath, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error('Delivery identity backup changed during read')
  }
  return bytes
}

function publicIdentity(publicKey: string, fingerprint: string): WorkflowDeliverySigningIdentity {
  return {
    algorithm: 'Ed25519',
    publicKeyFormat: 'spki-der-base64',
    publicKey,
    fingerprint
  }
}

function publicKeyDigest(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isBoundedBase64(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value.length % 4 === 0 && BASE64_PATTERN.test(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
