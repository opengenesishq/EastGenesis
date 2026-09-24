import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { TaskHandoffHostIdentity, TaskHandoffIdentity, TaskHandoffReleaseProof, TaskHostOwnershipRecord } from '../../shared/task-handoff-types'
import { writeDurableFileSync } from '../durable-file'
import { acquireFileLock, releaseFileLock } from '../digital-worker/persistence'

interface Document { schemaVersion: 1; host: TaskHandoffHostIdentity & { privateKey: string }; records: TaskHostOwnershipRecord[] }
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error(`TASK_HOST_OWNERSHIP_INVALID: ${label}`)
}
export function assertTaskHandoffIdentity(value: TaskHandoffIdentity): void {
  if (!value || typeof value !== 'object') throw new Error('TASK_HOST_OWNERSHIP_INVALID: identity')
  text(value.sessionId, 'sessionId')
  if (!Number.isSafeInteger(value.sessionCreatedAt) || value.sessionCreatedAt < 0) throw new Error('TASK_HOST_OWNERSHIP_INVALID: sessionCreatedAt')
}
function generation(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error('TASK_HOST_OWNERSHIP_INVALID: generation') }
export function taskHandoffHostId(publicKey: string): string {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('TASK_HOST_OWNERSHIP_INVALID: signing key')
  return `host:${createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')}`
}
export function verifyTaskHandoffReleaseProof(proof: TaskHandoffReleaseProof, expectedSourcePublicKey: string): void {
  if (!proof || proof.schemaVersion !== 1) throw new Error('TASK_HANDOFF_PROOF_INVALID: schema')
  assertTaskHandoffIdentity(proof.identity); generation(proof.fromGeneration); generation(proof.toGeneration)
  text(proof.handoffId, 'handoffId'); text(proof.toHostId, 'toHostId')
  if (proof.sourcePublicKey !== expectedSourcePublicKey || proof.fromHostId !== taskHandoffHostId(expectedSourcePublicKey) ||
      proof.fromHostId === proof.toHostId || proof.toGeneration !== proof.fromGeneration + 1 ||
      !/^[a-f0-9]{64}$/.test(proof.bundleDigest) || !Number.isSafeInteger(proof.issuedAt) || proof.issuedAt < 0) throw new Error('TASK_HANDOFF_PROOF_INVALID: binding')
  const { signature, ...body } = proof
  if (typeof signature !== 'string' || !verify(null, Buffer.from(canonical(body)), createPublicKey({ key: Buffer.from(expectedSourcePublicKey, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signature, 'base64'))) throw new Error('TASK_HANDOFF_PROOF_INVALID: signature')
}

/** Synchronous transitions share the app's single-instance main process; disk writes are also locked. */
export class TaskHostOwnershipStore {
  readonly filePath: string
  readonly markerPath: string
  constructor(readonly rootDir: string) {
    this.filePath = join(resolve(rootDir), 'private', 'task-handoff', 'ownership.json')
    this.markerPath = join(resolve(rootDir), 'private', 'task-handoff-initialized.json')
  }
  hostIdentity(): TaskHandoffHostIdentity {
    const document = this.read() ?? this.mutate(() => undefined)
    return { hostId: document.host.hostId, publicKey: document.host.publicKey }
  }
  status(sessionId: string): TaskHostOwnershipRecord | undefined {
    text(sessionId, 'sessionId')
    return structuredClone(this.read()?.records.find(record => record.identity.sessionId === sessionId))
  }
  prepare(identity: TaskHandoffIdentity, handoffId: string): TaskHostOwnershipRecord {
    assertTaskHandoffIdentity(identity); text(handoffId, 'handoffId')
    const doc = this.mutate(document => {
      const record = this.find(document, identity)
      if (record?.state === 'preparing' && record.handoffId === handoffId && !record.incoming && record.ownerHostId === document.host.hostId) return
      if (record && (record.state !== 'owned' || record.ownerHostId !== document.host.hostId)) throw new Error('TASK_HANDOFF_NOT_OWNER: task is already transferring or transferred')
      if (record?.handoffId === handoffId) throw new Error('TASK_HANDOFF_ID_REUSED')
      const next: TaskHostOwnershipRecord = { schemaVersion: 1, identity: { ...identity }, ownerHostId: document.host.hostId, generation: record?.generation ?? 0, state: 'preparing', handoffId, updatedAt: Date.now() }
      this.put(document, next)
    })
    return structuredClone(this.find(doc, identity)!)
  }
  cancelBeforeRelease(identity: TaskHandoffIdentity, handoffId: string): TaskHostOwnershipRecord {
    const doc = this.mutate(document => {
      const record = this.find(document, identity)
      if (!record || record.state !== 'preparing' || record.incoming || record.handoffId !== handoffId || record.ownerHostId !== document.host.hostId) throw new Error('TASK_HANDOFF_CANCEL_FORBIDDEN')
      this.put(document, { ...record, state: 'owned', generation: record.generation + 1, updatedAt: Date.now() })
    })
    return structuredClone(this.find(doc, identity)!)
  }
  release(identity: TaskHandoffIdentity, input: { targetHostId: string; handoffId: string; bundleDigest: string }): TaskHandoffReleaseProof {
    text(input.targetHostId, 'targetHostId'); text(input.handoffId, 'handoffId')
    if (!/^[a-f0-9]{64}$/.test(input.bundleDigest)) throw new Error('TASK_HANDOFF_DIGEST_INVALID')
    const doc = this.mutate(document => {
      const record = this.find(document, identity)
      if (record?.state === 'released' && record.handoffId === input.handoffId && record.releaseProof?.toHostId === input.targetHostId && record.releaseProof.bundleDigest === input.bundleDigest) return
      if (!record || record.state !== 'preparing' || record.incoming || record.handoffId !== input.handoffId || record.ownerHostId !== document.host.hostId || input.targetHostId === document.host.hostId) throw new Error('TASK_HANDOFF_RELEASE_FORBIDDEN')
      const body: Omit<TaskHandoffReleaseProof, 'signature'> = { schemaVersion: 1, identity: { ...identity }, fromHostId: document.host.hostId, toHostId: input.targetHostId, fromGeneration: record.generation, toGeneration: record.generation + 1, handoffId: input.handoffId, bundleDigest: input.bundleDigest, sourcePublicKey: document.host.publicKey, issuedAt: Date.now() }
      const proof = { ...body, signature: sign(null, Buffer.from(canonical(body)), createPrivateKey({ key: Buffer.from(document.host.privateKey, 'base64'), type: 'pkcs8', format: 'der' })).toString('base64') }
      this.put(document, { ...record, state: 'released', ownerHostId: input.targetHostId, targetHostId: input.targetHostId, generation: proof.toGeneration, releaseProof: proof, updatedAt: Date.now() })
    })
    return structuredClone(this.find(doc, identity)!.releaseProof!)
  }
  stageImported(identity: TaskHandoffIdentity, sourceHostId: string, handoffId: string, fromGeneration: number): TaskHostOwnershipRecord {
    assertTaskHandoffIdentity(identity); text(sourceHostId, 'sourceHostId'); text(handoffId, 'handoffId'); generation(fromGeneration)
    const doc = this.mutate(document => {
      if (sourceHostId === document.host.hostId) throw new Error('TASK_HANDOFF_SOURCE_EQUALS_TARGET')
      const record = this.find(document, identity)
      if (record?.state === 'preparing' && record.incoming && record.handoffId === handoffId && record.ownerHostId === sourceHostId && record.generation === fromGeneration) return
      if (record && (record.state !== 'released' || record.ownerHostId !== sourceHostId || record.generation > fromGeneration)) throw new Error('TASK_HANDOFF_IMPORT_CONFLICT')
      this.put(document, { schemaVersion: 1, identity: { ...identity }, ownerHostId: sourceHostId, generation: fromGeneration, state: 'preparing', incoming: true, handoffId, targetHostId: document.host.hostId, updatedAt: Date.now() })
    })
    return structuredClone(this.find(doc, identity)!)
  }
  activateImported(proof: TaskHandoffReleaseProof, expectedSourcePublicKey: string): TaskHostOwnershipRecord {
    verifyTaskHandoffReleaseProof(proof, expectedSourcePublicKey)
    const doc = this.mutate(document => {
      if (proof.toHostId !== document.host.hostId) throw new Error('TASK_HANDOFF_WRONG_TARGET')
      const record = this.find(document, proof.identity)
      if (record?.state === 'owned' && record.ownerHostId === document.host.hostId && same(record.releaseProof, proof)) return
      if (!record || record.state !== 'preparing' || !record.incoming || record.handoffId !== proof.handoffId || record.ownerHostId !== proof.fromHostId || record.generation !== proof.fromGeneration) throw new Error('TASK_HANDOFF_IMPORT_NOT_STAGED')
      this.put(document, { ...record, ownerHostId: document.host.hostId, generation: proof.toGeneration, state: 'owned', incoming: false, releaseProof: structuredClone(proof), updatedAt: Date.now() })
    })
    return structuredClone(this.find(doc, proof.identity)!)
  }
  private find(document: Document, identity: TaskHandoffIdentity): TaskHostOwnershipRecord | undefined {
    assertTaskHandoffIdentity(identity)
    const record = document.records.find(item => item.identity.sessionId === identity.sessionId)
    if (record && !same(record.identity, identity)) throw new Error('TASK_HANDOFF_SESSION_IDENTITY_CONFLICT')
    return record
  }
  private put(document: Document, record: TaskHostOwnershipRecord): void {
    const index = document.records.findIndex(item => item.identity.sessionId === record.identity.sessionId)
    if (index < 0) document.records.push(record); else document.records[index] = record
  }
  private mutate(change: (document: Document) => void): Document {
    const lock = acquireFileLock(`${this.filePath}.lock`)
    try {
      const document = this.read() ?? newDocument()
      change(document)
      writeDurableFileSync(this.filePath, `${JSON.stringify(document)}\n`)
      writeDurableFileSync(this.markerPath, `${JSON.stringify({ schemaVersion: 1, hostId: document.host.hostId })}\n`)
      return document
    } finally { releaseFileLock(`${this.filePath}.lock`, lock) }
  }
  private read(): Document | undefined {
    try {
      // Do not follow a substituted ownership file or private directory.
      for (const path of [dirname(dirname(this.filePath)), dirname(this.filePath), this.filePath]) {
        const info = lstatSync(path)
        if (info.isSymbolicLink()) throw new Error('TASK_HOST_OWNERSHIP_INVALID: symlink')
      }
      const document = JSON.parse(readFileSync(this.filePath, 'utf8')) as Document
      if (document.schemaVersion !== 1 || !Array.isArray(document.records) || !document.host || document.host.hostId !== taskHandoffHostId(document.host.publicKey)) throw new Error('TASK_HOST_OWNERSHIP_INVALID: document')
      const privateKey = createPrivateKey({ key: Buffer.from(document.host.privateKey, 'base64'), type: 'pkcs8', format: 'der' })
      if (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64') !== document.host.publicKey) throw new Error('TASK_HOST_OWNERSHIP_INVALID: key pair')
      try {
        if (lstatSync(this.markerPath).isSymbolicLink()) throw new Error('TASK_HOST_OWNERSHIP_INVALID: marker symlink')
        const marker = JSON.parse(readFileSync(this.markerPath, 'utf8'))
        if (marker.schemaVersion !== 1 || marker.hostId !== document.host.hostId) throw new Error('TASK_HOST_OWNERSHIP_INVALID: marker')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const ids = new Set<string>()
      for (const record of document.records) {
        assertTaskHandoffIdentity(record.identity); generation(record.generation); text(record.ownerHostId, 'ownerHostId')
        if (record.schemaVersion !== 1 || !['owned', 'preparing', 'released'].includes(record.state) || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0 ||
            (record.incoming !== undefined && typeof record.incoming !== 'boolean') || ids.has(record.identity.sessionId)) throw new Error('TASK_HOST_OWNERSHIP_INVALID: record')
        ids.add(record.identity.sessionId)
        if (record.state !== 'owned') text(record.handoffId, 'handoffId')
        if (record.state === 'owned' && (record.ownerHostId !== document.host.hostId || record.incoming)) throw new Error('TASK_HOST_OWNERSHIP_INVALID: owned host')
        if (record.state === 'preparing' && (record.incoming ? record.ownerHostId === document.host.hostId || record.targetHostId !== document.host.hostId : record.ownerHostId !== document.host.hostId)) throw new Error('TASK_HOST_OWNERSHIP_INVALID: preparing host')
        if (record.state === 'released' && (!record.releaseProof || record.incoming || record.targetHostId !== record.ownerHostId || record.releaseProof.fromHostId !== document.host.hostId)) throw new Error('TASK_HOST_OWNERSHIP_INVALID: missing or unbound release proof')
        if (record.releaseProof) {
          verifyTaskHandoffReleaseProof(record.releaseProof, record.releaseProof.sourcePublicKey)
          if (!same(record.releaseProof.identity, record.identity) || record.releaseProof.toGeneration !== record.generation || record.releaseProof.toHostId !== record.ownerHostId || record.releaseProof.handoffId !== record.handoffId) throw new Error('TASK_HOST_OWNERSHIP_INVALID: proof record binding')
        }
      }
      return document
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { lstatSync(this.markerPath) }
        catch (markerError) { if ((markerError as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw markerError }
      }
      throw new Error('TASK_HOST_OWNERSHIP_UNREADABLE: 交接所有权记录无法核对，已阻止执行。', { cause: error })
    }
  }
}
function newDocument(): Document {
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { schemaVersion: 1, host: { hostId: taskHandoffHostId(publicKey), publicKey, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }, records: [] }
}
