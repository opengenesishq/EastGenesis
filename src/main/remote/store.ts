import { app } from 'electron'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  RemoteApprovalInput, RemoteApprovalRecord, RemoteCommandEnvelope, RemoteCommandRecord,
  RemoteContinuationSnapshot, RemoteDeviceCapability, RemoteDeviceIdentity,
  RemoteResultProjection, RemoteRunnerLease, RemoteRunnerKind, RemoteConnectivity, RemoteCommandPayload,
  RemoteCommandExecutionStatus
} from '../../shared/remote-types'
import { REMOTE_SCHEMA_VERSION } from '../../shared/remote-types'
import { writeDurableFile } from '../durable-file'
import { canonicalJson, digest, requiredId, requiredText } from '../project-workspace/codec'
import { createProductionProjectAggregateService } from '../project-aggregate'
import { listRoutines } from '../routineStore'
import { getRemoteWebhookStatus } from './webhook-status'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import { isBusinessLineId } from '../../shared/business-line-types'
import type { RemoteApprovalDecisionEnvelope } from '../../shared/remote-types'
import type { RemoteCreatedTaskProjection } from '../../shared/remote-created-task-types'

const FILE_NAME = 'remote-continuation.json'
const MAX_AUDIT = 2000
const DEFAULT_LEASE_TTL_MS = 5 * 60_000
const MAX_LEASE_TTL_MS = 24 * 60 * 60_000

interface StoredDevice extends RemoteDeviceIdentity { publicKey: string }
interface RemoteDocument {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION
  revision: number
  connectivity: RemoteConnectivity
  devices: StoredDevice[]
  commands: RemoteCommandRecord[]
  approvals: RemoteApprovalRecord[]
  leases: RemoteRunnerLease[]
  audit: RemoteContinuationSnapshot['audit']
}

const emptyDocument = (): RemoteDocument => ({ schemaVersion: REMOTE_SCHEMA_VERSION, revision: 0, connectivity: 'online', devices: [], commands: [], approvals: [], leases: [], audit: [] })
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const atNow = (): number => Date.now()
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function normalizeDocument(value: unknown): RemoteDocument {
  if (!value || typeof value !== 'object') throw new Error('Remote continuation store is invalid')
  const candidate = value as Partial<RemoteDocument>
  if (candidate.schemaVersion !== REMOTE_SCHEMA_VERSION || !Number.isSafeInteger(candidate.revision) || (candidate.revision ?? -1) < 0) throw new Error('Remote continuation store schema is unsupported')
  if (candidate.connectivity !== 'online' && candidate.connectivity !== 'offline') throw new Error('Remote connectivity is invalid')
  if (!Array.isArray(candidate.devices) || !Array.isArray(candidate.commands) || !Array.isArray(candidate.approvals) || !Array.isArray(candidate.leases) || !Array.isArray(candidate.audit)) throw new Error('Remote continuation store collections are invalid')
  // Approval records were introduced after the first remote continuation
  // schema. Keep existing command history readable while filling only the
  // fields needed by the new approval application state machine.
  const approvals = candidate.approvals.map((approval) => {
    const item = approval as Partial<RemoteApprovalRecord>
    const legacyDigest = typeof item.approvalDigest === 'string' && item.approvalDigest
      ? item.approvalDigest
      : digest({ commandId: item.commandId, sessionId: item.sessionId, permissionRequestId: item.permissionRequestId, action: item.action, targetDigest: item.targetDigest, dataScope: item.dataScope, costLimitUsd: item.costLimitUsd ?? 0, revision: item.revision, expiresAt: item.expiresAt })
    return {
      ...item,
      recordRevision: Number.isSafeInteger(item.recordRevision) ? item.recordRevision : 1,
      approvalDigest: legacyDigest,
      applicationStatus: item.applicationStatus ?? (item.status === 'approved' || item.status === 'rejected' ? 'applied' : 'pending')
    } as RemoteApprovalRecord
  })
  return { ...copy(candidate as RemoteDocument), approvals }
}

function safeDevice(device: StoredDevice): RemoteDeviceIdentity {
  const { publicKey, ...safe } = device
  return { ...copy(safe), ...(device.status === 'active' ? { publicKey } : {}) }
}

function snapshot(document: RemoteDocument): RemoteContinuationSnapshot {
  const body = { schemaVersion: REMOTE_SCHEMA_VERSION, revision: document.revision, connectivity: document.connectivity, devices: document.devices.map(safeDevice), commands: document.commands, approvals: document.approvals, leases: document.leases, audit: document.audit, webhook: getRemoteWebhookStatus() }
  return { ...body, snapshotDigest: digest(body) }
}

function capabilities(input: readonly RemoteDeviceCapability[] | undefined): RemoteDeviceCapability[] {
  const allowed: RemoteDeviceCapability[] = ['view_results', 'resume_work_item', 'create_task', 'control_work_item', 'approve_effect', 'trigger_routine', 'remote_runner', 'workspace_read', 'task_handoff']
  const values = input ?? ['view_results', 'resume_work_item', 'approve_effect']
  if (!Array.isArray(values) || values.some((value) => !allowed.includes(value))) throw new Error('Remote device capabilities are invalid')
  return [...new Set(values)]
}

function requireDevice(document: RemoteDocument, id: string, capability?: RemoteDeviceCapability): StoredDevice {
  const device = document.devices.find((item) => item.id === requiredId(id, 'deviceId'))
  if (!device || device.status !== 'active') throw new Error('Remote device is not bound')
  if (capability && !device.capabilities.includes(capability)) throw new Error(`Remote device lacks capability: ${capability}`)
  return device
}

function unsignedEnvelope(envelope: RemoteCommandEnvelope): Omit<RemoteCommandEnvelope, 'signature'> {
  const { signature: _signature, ...unsigned } = envelope
  return unsigned
}

function commandCapability(kind: RemoteCommandEnvelope['kind']): RemoteDeviceCapability {
  if (kind === 'approve_effect') return 'approve_effect'
  if (kind === 'resume_work_item') return 'resume_work_item'
  if (kind === 'create_task') return 'create_task'
  if (kind === 'append_task' || kind === 'pause_work_item' || kind === 'cancel_work_item') return 'control_work_item'
  if (kind === 'trigger_routine') return 'trigger_routine'
  return 'view_results'
}

export class RemoteContinuationStore {
  private readonly filePath: string
  private state: RemoteDocument | undefined
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly rootDir: string) { this.filePath = join(rootDir, FILE_NAME) }

  private async read(): Promise<RemoteDocument> {
    if (this.state) return copy(this.state)
    try { this.state = normalizeDocument(JSON.parse(await readFile(this.filePath, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') this.state = emptyDocument()
      else if (error instanceof SyntaxError) throw new Error(`Remote continuation store is corrupt: ${error.message}`)
      else throw error
    }
    return copy(this.state)
  }

  private async mutate<T>(fn: (state: RemoteDocument, at: number) => T): Promise<T> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const state = await this.read()
      const result = fn(state, atNow())
      state.revision += 1
      await writeDurableFile(this.filePath, `${canonicalJson(state)}\n`, { mode: 0o600 })
      this.state = state
      return copy(result)
    } finally { release() }
  }

  getSnapshot(): Promise<RemoteContinuationSnapshot> { return this.read().then(snapshot) }

  registerDevice(input: { label: string; userId: string; publicKey: string; capabilities?: RemoteDeviceCapability[] }): Promise<RemoteDeviceIdentity> {
    return this.mutate((state, at) => {
      const publicKey = requiredText(input.publicKey, 'publicKey')
      let key: ReturnType<typeof createPublicKey>
      try { key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }) } catch { throw new Error('Remote device publicKey is invalid') }
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Remote device publicKey must be Ed25519')
      const device: StoredDevice = { schemaVersion: REMOTE_SCHEMA_VERSION, id: randomUUID(), label: requiredText(input.label, 'label').slice(0, 120), userId: requiredText(input.userId, 'userId').slice(0, 200), publicKey, publicKeyFingerprint: `sha256:${sha256(publicKey)}`, capabilities: capabilities(input.capabilities), status: 'active', createdAt: at, auditIds: [] }
      const audit = this.audit(state, 'device_bound', device.id, undefined, undefined, at, 'state_changed', device.publicKeyFingerprint)
      device.auditIds.push(audit.id); state.devices.push(device)
      return safeDevice(device)
    })
  }

  updateDeviceCapabilities(id: string, input: RemoteDeviceCapability[]): Promise<RemoteDeviceIdentity> {
    return this.mutate((state, at) => {
      const device = requireDevice(state, id)
      const next = capabilities(input)
      const previous = device.capabilities
      if (canonicalJson(previous) === canonicalJson(next)) return safeDevice(device)
      device.capabilities = next
      const removed = previous.filter((item) => !next.includes(item))
      for (const command of state.commands) {
        if (command.envelope.issuerDeviceId !== device.id || !['pending', 'offline'].includes(command.status)) continue
        if (!removed.includes(commandCapability(command.envelope.kind))) continue
        command.status = 'rejected'
        command.rejectionReason = 'device_capability_removed'
        command.updatedAt = at
      }
      const audit = this.audit(
        state,
        'device_capabilities_updated',
        device.id,
        undefined,
        undefined,
        at,
        'state_changed',
        digest({ previous, next })
      )
      device.auditIds.push(audit.id)
      return safeDevice(device)
    })
  }

  unbindDevice(id: string): Promise<RemoteDeviceIdentity> {
    return this.mutate((state, at) => {
      const device = requireDevice(state, id)
      device.status = 'revoked'; device.revokedAt = at; device.publicKey = ''
      for (const command of state.commands) if (command.envelope.issuerDeviceId === device.id && ['pending', 'offline'].includes(command.status)) { command.status = 'rejected'; command.rejectionReason = 'device_unbound'; command.updatedAt = at }
      const audit = this.audit(state, 'device_unbound', device.id, undefined, undefined, at, 'revoked', device.publicKeyFingerprint); device.auditIds.push(audit.id)
      return safeDevice(device)
    })
  }

  setConnectivity(value: RemoteConnectivity): Promise<RemoteContinuationSnapshot> {
    return this.mutate((state, at) => {
      if (value !== 'online' && value !== 'offline') throw new Error('Remote connectivity is invalid')
      state.connectivity = value
      if (value === 'offline') for (const command of state.commands) if (command.status === 'pending') { command.status = 'offline'; command.updatedAt = at }
      this.audit(state, `connectivity_${value}`, undefined, undefined, undefined, at, 'state_changed', value)
      return snapshot(state)
    })
  }

  reconcile(): Promise<RemoteContinuationSnapshot> {
    return this.mutate((state, at) => {
      for (const command of state.commands) {
        if (command.envelope.expiresAt <= at && !['expired', 'rejected'].includes(command.status)) { command.status = 'expired'; command.updatedAt = at }
        else if (command.status === 'offline' && state.connectivity === 'online') { command.status = 'pending'; command.updatedAt = at }
      }
      for (const approval of state.approvals) {
        if (approval.status === 'pending' && approval.expiresAt <= at) {
          approval.status = 'expired'
          approval.applicationStatus = 'applying'
          approval.recordRevision += 1
          approval.updatedAt = at
        }
      }
      for (const lease of state.leases) if (lease.status === 'active' && lease.expiresAt <= at) { lease.status = 'expired'; lease.revision += 1 }
      return snapshot(state)
    })
  }

  purgeProject(projectId: string): Promise<{ commands: number; approvals: number; leases: number; audit: number }> {
    return this.mutate((state) => {
      const id = requiredId(projectId, 'projectId')
      const commandIds = new Set(state.commands.filter((item) => item.envelope.scope.projectId === id).map((item) => item.envelope.commandId))
      const counts = {
        commands: commandIds.size,
        approvals: state.approvals.filter((item) => commandIds.has(item.commandId)).length,
        leases: state.leases.filter((item) => item.projectId === id).length,
        audit: state.audit.filter((item) => item.projectId === id || (item.commandId && commandIds.has(item.commandId))).length
      }
      state.commands = state.commands.filter((item) => !commandIds.has(item.envelope.commandId))
      state.approvals = state.approvals.filter((item) => !commandIds.has(item.commandId))
      state.leases = state.leases.filter((item) => item.projectId !== id)
      state.audit = state.audit.filter((item) => item.projectId !== id && !(item.commandId && commandIds.has(item.commandId)))
      return counts
    })
  }

  async ingest(envelope: RemoteCommandEnvelope): Promise<RemoteCommandRecord> {
    if (envelope.schemaVersion !== REMOTE_SCHEMA_VERSION || !['view_result', 'resume_work_item', 'approve_effect', 'trigger_routine', 'create_task', 'append_task', 'pause_work_item', 'cancel_work_item'].includes(envelope.kind)) throw new Error('Remote command kind or schema is invalid')
    requiredId(envelope.commandId, 'commandId')
    if (!envelope.scope || !Array.isArray(envelope.scope.artifactIds) || envelope.scope.artifactIds.some(id => typeof id !== 'string') || !['metadata_only', 'artifact_summary'].includes(envelope.scope.dataClass)) throw new Error('Remote command scope is invalid')
    const initialState = await this.read()
    const initialDevice = requireDevice(initialState, envelope.issuerDeviceId, commandCapability(envelope.kind))
    assertValidCommandSignature(initialDevice, envelope)
    const alreadyStored = initialState.commands.find((item) => item.envelope.commandId === envelope.commandId)
    if (alreadyStored) {
      if (canonicalJson(alreadyStored.envelope) !== canonicalJson(envelope)) throw new Error('Remote command identity conflict')
      return copy(alreadyStored)
    }
    const aggregate = await createProductionProjectAggregateService(this.rootDir).verifyLiveProject(envelope.scope.projectId)
    if (envelope.scope.goalId && !aggregate.goals.some((item) => item.id === envelope.scope.goalId)) throw new Error('Remote command Goal is outside Project scope')
    if (envelope.scope.workItemId && !aggregate.workItems.some((item) => item.id === envelope.scope.workItemId)) throw new Error('Remote command WorkItem is outside Project scope')
    if (envelope.scope.goalId && envelope.scope.workItemId && !aggregate.workItems.some(item => item.id === envelope.scope.workItemId && item.goalId === envelope.scope.goalId)) throw new Error('Remote command WorkItem is outside Goal scope')
    if (envelope.scope.runId && !aggregate.workflow.runs.some((item) => item.id === envelope.scope.runId)) throw new Error('Remote command Run is outside Project scope')
    if (envelope.scope.artifactIds.some((id) => !aggregate.workflow.artifacts.some((item) => item.id === id))) throw new Error('Remote command Artifact is outside Project scope')
    if (envelope.kind === 'resume_work_item' && !envelope.scope.workItemId) throw new Error('Remote resume command requires a WorkItem')
    if (envelope.kind === 'trigger_routine') {
      if (!envelope.scope.routineId) throw new Error('Remote routine command requires a Routine')
      const routine = (await listRoutines(join(this.rootDir, 'routines'))).find((item) => item.id === envelope.scope.routineId)
      if (!routine || routine.projectId !== envelope.scope.projectId) throw new Error('Remote command Routine is outside Project scope')
    }
    if (!Number.isSafeInteger(envelope.createdAt) || !Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= envelope.createdAt) throw new Error('Remote command time bounds are invalid')
    if (!/^[0-9a-f]{64}$/.test(envelope.payloadDigest)) throw new Error('Remote command payloadDigest is invalid')
    const expectedPayload = envelope.payload ?? { kind: envelope.kind, scope: envelope.scope, revision: envelope.revision }
    if (envelope.payloadDigest !== digest(expectedPayload)) throw new Error('Remote command payload digest does not match signed payload')
    validateCommandPayload(envelope.kind, envelope.payload, envelope.scope)
    if (envelope.payload?.kind === 'create_task' && envelope.payload.businessLineId) assertActiveBusinessLine(envelope.payload.businessLineId, this.rootDir)
    return this.mutate((state, at) => {
      const device = requireDevice(state, envelope.issuerDeviceId, commandCapability(envelope.kind))
      assertValidCommandSignature(device, envelope)
      const existing = state.commands.find((item) => item.envelope.commandId === envelope.commandId)
      if (existing) {
        if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) throw new Error('Remote command identity conflict')
        return existing
      }
      device.lastOnlineAt = at
      const scopedRevision = envelope.scope.workItemId
        ? aggregate.workItems.find((item) => item.id === envelope.scope.workItemId)!.revision
        : envelope.scope.goalId
          ? aggregate.goals.find((item) => item.id === envelope.scope.goalId)!.revision
          : aggregate.projectRevision
      if (envelope.revision !== scopedRevision) throw new Error(`Remote command revision is stale: expected ${scopedRevision}, got ${envelope.revision}`)
      const status: RemoteCommandRecord['status'] = envelope.expiresAt <= at ? 'expired' : state.connectivity === 'online' ? 'pending' : 'offline'
      const audit = this.audit(state, 'command_ingested', device.id, envelope.commandId, envelope.scope.projectId, at, status === 'expired' ? 'expired' : 'accepted', envelope.payloadDigest)
      const record: RemoteCommandRecord = { envelope: copy(envelope), status, receivedAt: at, updatedAt: at, auditId: audit.id }; state.commands.push(record); return record
    })
  }

  async ingestWebhook(event: import('../../shared/remote-types').RemoteWebhookEventEnvelope): Promise<RemoteCommandRecord> {
    if (event.eventId !== event.command.commandId) throw new Error('Webhook eventId must equal commandId')
    if (event.payloadDigest !== event.command.payloadDigest) throw new Error('Webhook payload digest does not match command')
    if (!/^[0-9a-f]{64}$/.test(event.payloadDigest)) throw new Error('Webhook payload digest is invalid')
    if (!Number.isSafeInteger(event.expiresAt) || event.expiresAt < event.command.createdAt || event.expiresAt !== event.command.expiresAt) throw new Error('Webhook expiry is invalid')
    if (event.expiresAt <= atNow()) throw new Error('Webhook event is expired')
    const state = await this.read()
    const device = requireDevice(state, event.command.issuerDeviceId, commandCapability(event.command.kind))
    let valid = false
    try {
      const { signature: _signature, ...unsigned } = event
      valid = Boolean(device.publicKey) && verify(
        null,
        Buffer.from(canonicalJson(unsigned)),
        createPublicKey({ key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki' }),
        Buffer.from(event.signature, 'base64')
      )
    } catch { valid = false }
    if (!valid) throw new Error('Remote webhook signature is invalid')
    const existing = await this.getCommand(event.eventId)
    if (existing) return existing
    return this.ingest(event.command)
  }

  /** Return one command without exposing private device key material. */
  async getCommand(commandId: string): Promise<RemoteCommandRecord | null> {
    const state = await this.read()
    const command = state.commands.find((item) => item.envelope.commandId === requiredId(commandId, 'commandId'))
    return command ? copy(command) : null
  }

  /** Atomically claim a pending command so duplicate delivery cannot create duplicate effects. */
  claimCommandExecution(commandId: string): Promise<RemoteCommandRecord | null> {
    return this.mutate((state, at) => {
      const command = state.commands.find((item) => item.envelope.commandId === requiredId(commandId, 'commandId'))
      if (!command) return null
      if (command.envelope.expiresAt <= at && !['expired', 'rejected'].includes(command.status)) {
        command.status = 'expired'; command.updatedAt = at
        return command
      }
      if (command.status === 'offline' || command.status === 'expired' || command.status === 'rejected') return command
      try { requireDevice(state, command.envelope.issuerDeviceId, commandCapability(command.envelope.kind)) }
      catch {
        command.status = 'rejected'; command.rejectionReason = 'device_or_capability_revoked'; command.updatedAt = at
        return command
      }
      if (command.execution) return command
      if (command.status !== 'pending' && command.status !== 'accepted') return command
      command.status = 'accepted'
      command.updatedAt = at
      command.execution = {
        status: 'running',
        ...(command.envelope.kind === 'trigger_routine' ? { routineRunId: `remote:${sha256(command.envelope.commandId)}` } : {}),
        updatedAt: at
      }
      this.audit(state, 'command_execution_started', command.envelope.issuerDeviceId, command.envelope.commandId, command.envelope.scope.projectId, at, 'accepted', command.envelope.payloadDigest)
      return command
    })
  }

  finishCommandExecution(commandId: string, input: { status: RemoteCommandExecutionStatus; routineRunId?: string; runId?: string; error?: string } & Partial<RemoteCreatedTaskProjection>): Promise<RemoteCommandRecord | null> {
    return this.mutate((state, at) => {
      const command = state.commands.find((item) => item.envelope.commandId === requiredId(commandId, 'commandId'))
      if (!command) return null
      if (command.execution && ['succeeded', 'failed'].includes(command.execution.status)) return command
      if (input.createdTask && (command.envelope.kind !== 'create_task' || input.createdTask.projectId !== command.envelope.scope.projectId || input.createdTask.sessionId !== input.runId)) throw new Error('远端新任务回执绑定无效。')
      const error = input.error?.trim().slice(0, 1000)
      command.execution = { status: input.status, ...(input.routineRunId ? { routineRunId: input.routineRunId } : {}), ...(input.runId ? { runId: input.runId } : {}),
        ...(input.createdTask ? { createdTask: input.createdTask } : {}), ...(input.createPhase ? { createPhase: input.createPhase } : {}), ...(error ? { error } : {}), updatedAt: at }
      command.updatedAt = at
      this.audit(state, `command_execution_${input.status}`, command.envelope.issuerDeviceId, command.envelope.commandId, command.envelope.scope.projectId, at, input.status === 'failed' ? 'rejected' : 'state_changed', input.routineRunId ?? error ?? command.envelope.payloadDigest)
      return command
    })
  }

  async createApproval(input: RemoteApprovalInput): Promise<RemoteApprovalRecord> {
    const command = await this.getCommand(input.commandId)
    if (!command || command.envelope.kind !== 'approve_effect') throw new Error('Remote approval command binding is invalid')
    const { sessionManager } = await import('../sessionManager.js')
    const session = sessionManager.get(input.sessionId)
    if (!session || session.meta.workspaceId !== command.envelope.scope.projectId) throw new Error('Remote approval Session is outside Project scope')
    const pending = session.pendingPermissions().find((request) => request.requestId === input.permissionRequestId)
    if (!pending || pending.toolName !== input.action) throw new Error('Remote approval permission request is no longer pending')
    const expectedDataScope = digest({ toolName: pending.toolName, capabilities: pending.capabilities, effectScope: pending.effectScope ?? null, riskLevel: pending.riskLevel ?? null })
    if (input.dataScope !== expectedDataScope) throw new Error('Remote approval data scope does not match the frozen permission request')
    if (input.targetDigest !== pending.effectScope?.targetDigest) throw new Error('Remote approval target digest does not match the frozen Effect')
    if (input.costLimitUsd !== undefined && input.costLimitUsd < session.meta.costUsd) throw new Error('Remote approval cost limit is below current Session cost')
    return this.mutate((state, at) => {
      const storedCommand = state.commands.find((item) => item.envelope.commandId === requiredId(input.commandId, 'commandId'))
      if (!storedCommand || storedCommand.envelope.revision !== input.revision || storedCommand.envelope.expiresAt !== input.expiresAt) throw new Error('Remote approval command binding is invalid')
      if (storedCommand.envelope.kind !== 'approve_effect') throw new Error('Remote approval requires an approve_effect command')
      if (!Number.isFinite(input.costLimitUsd ?? 0) || (input.costLimitUsd ?? 0) < 0) throw new Error('Remote approval cost limit is invalid')
      const digestInput = { commandId: input.commandId, sessionId: input.sessionId, permissionRequestId: input.permissionRequestId, action: input.action, targetDigest: input.targetDigest, dataScope: input.dataScope, costLimitUsd: input.costLimitUsd ?? 0, revision: input.revision, expiresAt: input.expiresAt }
      const approval: RemoteApprovalRecord = { ...copy(input), id: randomUUID(), status: 'pending', createdAt: at, updatedAt: at, recordRevision: 1, approvalDigest: digest(digestInput), applicationStatus: 'pending', auditId: '' }
      const audit = this.audit(state, 'approval_created', storedCommand.envelope.issuerDeviceId, storedCommand.envelope.commandId, storedCommand.envelope.scope.projectId, at, 'accepted', digest({ action: input.action, targetDigest: input.targetDigest, dataScope: input.dataScope, revision: input.revision })); approval.auditId = audit.id; state.approvals.push(approval); return approval
    })
  }

  async getApproval(approvalId: string): Promise<RemoteApprovalRecord | null> {
    const state = await this.read()
    const approval = state.approvals.find((item) => item.id === requiredId(approvalId, 'approvalId'))
    return approval ? copy(approval) : null
  }

  async getApprovalForCommand(commandId: string): Promise<RemoteApprovalRecord | null> {
    const state = await this.read()
    const approval = state.approvals.find((item) => item.commandId === requiredId(commandId, 'commandId'))
    return approval ? copy(approval) : null
  }

  decideApproval(input: RemoteApprovalDecisionEnvelope): Promise<RemoteApprovalRecord> {
    return this.mutate((state, at) => {
      if (input.expiresAt <= at || input.expiresAt < input.createdAt) throw new Error('Remote approval decision is expired')
      const device = requireDevice(state, input.issuerDeviceId, 'approve_effect')
      const approval = state.approvals.find((item) => item.id === requiredId(input.approvalId, 'approvalId'))
      if (!approval) throw new Error('Remote approval was not found')
      if (approval.recordRevision !== input.expectedRecordRevision) throw new Error('Remote approval revision conflict')
      if (approval.approvalDigest !== input.approvalDigest) throw new Error('Remote approval digest conflict')
      assertApprovalDecisionSignature(device, input)
      if (approval.status === 'pending' && approval.expiresAt <= at) { approval.status = 'expired'; approval.applicationStatus = 'applying'; approval.recordRevision += 1; approval.updatedAt = at }
      if (approval.status !== 'pending') return approval
      approval.status = input.decision === 'approve' ? 'approved' : 'rejected'; approval.applicationStatus = 'applying'; approval.recordRevision += 1; approval.updatedAt = at; approval.decidedByDeviceId = device.id
      this.audit(state, `approval_${input.decision}d`, device.id, approval.commandId, undefined, at, input.decision === 'approve' ? 'accepted' : 'rejected', approval.targetDigest)
      return approval
    })
  }

  finishApprovalApplication(approvalId: string, input: { status: 'applied' | 'failed'; error?: string }): Promise<RemoteApprovalRecord | null> {
    return this.mutate((state, at) => {
      const approval = state.approvals.find((item) => item.id === requiredId(approvalId, 'approvalId'))
      if (!approval) return null
      if (approval.applicationStatus === 'applied' || approval.applicationStatus === 'failed') return approval
      approval.applicationStatus = input.status
      approval.appliedAt = at
      approval.applicationError = input.error?.trim().slice(0, 1000)
      approval.updatedAt = at
      return approval
    })
  }

  async acquireLease(input: { projectId: string; workItemId?: string; deviceId: string; runnerKind?: RemoteRunnerKind; ttlMs?: number }): Promise<RemoteRunnerLease> {
    const aggregate = await createProductionProjectAggregateService(this.rootDir).verifyLiveProject(requiredId(input.projectId, 'projectId'))
    if (input.workItemId && !aggregate.workItems.some((item) => item.id === input.workItemId)) throw new Error('Remote runner WorkItem is outside Project scope')
    return this.mutate((state, at) => {
      const device = requireDevice(state, input.deviceId, input.runnerKind === 'remote' ? 'remote_runner' : undefined)
      const projectId = requiredId(input.projectId, 'projectId'); const ttl = Math.min(Math.max(Math.floor(input.ttlMs ?? DEFAULT_LEASE_TTL_MS), 1_000), MAX_LEASE_TTL_MS)
      // A lease is never allowed to create an implicit Project or WorkItem.
      // The aggregate check happens before any lease state is committed.
      const current = state.leases.find((lease) => lease.status === 'active' && lease.projectId === projectId && lease.workItemId === input.workItemId && lease.expiresAt > at)
      if (current && current.deviceId !== device.id) throw new Error('Remote runner lease is held by another device')
      if (current) { current.expiresAt = at + ttl; current.revision += 1; return current }
      const lease: RemoteRunnerLease = { id: randomUUID(), projectId, ...(input.workItemId ? { workItemId: requiredId(input.workItemId, 'workItemId') } : {}), deviceId: device.id, runnerKind: input.runnerKind ?? 'local', fencingToken: 1, acquiredAt: at, expiresAt: at + ttl, status: 'active', revision: 1 }; state.leases.push(lease); this.audit(state, 'runner_lease_acquired', device.id, undefined, projectId, at, 'accepted', lease.id); return lease
    })
  }

  releaseLease(input: { leaseId: string; deviceId: string; expectedRevision: number }): Promise<RemoteRunnerLease> {
    return this.mutate((state, at) => {
      const device = requireDevice(state, input.deviceId); const lease = state.leases.find((item) => item.id === requiredId(input.leaseId, 'leaseId'))
      if (!lease || lease.deviceId !== device.id) throw new Error('Remote runner lease owner mismatch')
      if (lease.revision !== input.expectedRevision) throw new Error('Remote runner lease revision conflict')
      if (lease.status === 'active') { lease.status = 'released'; lease.revision += 1 }; lease.expiresAt = Math.min(lease.expiresAt, at); this.audit(state, 'runner_lease_released', device.id, undefined, lease.projectId, at, 'state_changed', lease.id); return lease
    })
  }

  async resultProjection(projectId: string): Promise<RemoteResultProjection> {
    const id = requiredId(projectId, 'projectId'); const aggregate = await createProductionProjectAggregateService(this.rootDir).verifyLiveProject(id); const workflow = aggregate.workflow
    const artifacts = workflow.artifacts.filter((item) => item.projectId === id); const acceptances = workflow.acceptances.filter((item) => item.projectId === id); const active = aggregate.workItems.filter((item) => !['done', 'failed', 'cancelled'].includes(item.status)); const available = artifacts.filter((item) => workflow.artifactLocations.some((location) => location.artifactId === item.id && location.availability === 'available'))
    const body = { projectId: id, projectName: aggregate.workspace.name, projectRevision: aggregate.projectRevision, generatedAt: atNow(), goalCount: aggregate.goals.length, workItemCount: aggregate.workItems.length, activeWorkItemCount: active.length, runCount: workflow.runs.length, artifactCount: artifacts.length, availableArtifactCount: available.length, evidenceCount: workflow.workflowEvidence.length + workflow.taskEvidence.length, acceptanceCount: acceptances.length, passedAcceptanceCount: acceptances.filter((item) => item.status === 'passed').length, openItemCount: active.length, riskCount: active.filter((item) => item.status === 'blocked').length, artifactDigests: available.map((item) => item.digest).slice(0, 100), acceptanceStatuses: acceptances.map((item) => item.status) }
    return { ...body, projectionDigest: sha256(canonicalJson(body)) }
  }

  private audit(state: RemoteDocument, action: string, actorDeviceId: string | undefined, commandId: string | undefined, projectId: string | undefined, at: number, result: RemoteContinuationSnapshot['audit'][number]['result'], detail: string) {
    const entry = { id: randomUUID(), action, ...(actorDeviceId ? { actorDeviceId } : {}), ...(commandId ? { commandId } : {}), ...(projectId ? { projectId } : {}), at, result, detailDigest: sha256(detail) }; state.audit.push(entry); if (state.audit.length > MAX_AUDIT) state.audit.splice(0, state.audit.length - MAX_AUDIT); return entry
  }
}

function validateCommandPayload(kind: RemoteCommandEnvelope['kind'], payload: RemoteCommandPayload | undefined, scope: RemoteCommandEnvelope['scope']): void {
  if (kind === 'approve_effect' && payload !== undefined) {
    if (payload.kind !== kind || !scope.workItemId || scope.dataClass !== 'metadata_only') throw new Error('Remote approval payload scope mismatch')
    assertPayloadKeys(payload, ['kind', 'sessionId', 'permissionRequestId', 'action', 'targetDigest', 'dataScope'])
    for (const value of [payload.sessionId, payload.permissionRequestId, payload.action]) requiredId(value, 'approval field')
    if (![payload.targetDigest, payload.dataScope].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Remote approval digest invalid')
    return
  }
  if (kind === 'view_result' || kind === 'resume_work_item' || kind === 'approve_effect' || kind === 'trigger_routine') {
    if (payload !== undefined) throw new Error(`Remote ${kind} command does not accept a task payload`)
    return
  }
  if (!payload || payload.kind !== kind) throw new Error(`Remote ${kind} command requires a matching signed payload`)
  if (scope.dataClass !== 'metadata_only' || scope.artifactIds.length || scope.runId || scope.routineId) throw new Error('Remote task command requires metadata_only task scope')
  if (kind === 'create_task') {
    const task = payload as Extract<RemoteCommandPayload, { kind: 'create_task' }>
    assertPayloadKeys(task, ['kind', 'objective', 'businessLineId'])
    if (typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 20_000) throw new Error('Remote create task objective is invalid')
    if (task.businessLineId !== undefined && !isBusinessLineId(task.businessLineId)) throw new Error('Remote create task businessLineId is invalid')
    if (scope.workItemId || scope.goalId) throw new Error('Remote create task cannot bind an existing Goal or WorkItem')
    return
  }
  if (!scope.workItemId) throw new Error(`Remote ${kind} command requires a WorkItem`)
  if (kind === 'append_task') {
    const append = payload as Extract<RemoteCommandPayload, { kind: 'append_task' }>
    assertPayloadKeys(append, ['kind', 'text', 'clientRequestId'])
    if (typeof append.text !== 'string' || !append.text.trim() || append.text.length > 200_000 || typeof append.clientRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(append.clientRequestId)) throw new Error('Remote append task payload is invalid')
  }
  if (kind === 'pause_work_item' || kind === 'cancel_work_item') {
    const control = payload as Extract<RemoteCommandPayload, { kind: 'pause_work_item' | 'cancel_work_item' }>
    assertPayloadKeys(control, ['kind', 'reason'])
    if (control.reason !== undefined && (typeof control.reason !== 'string' || control.reason.length > 2_000)) throw new Error(`Remote ${kind} reason is invalid`)
  }
}

function assertPayloadKeys(payload: RemoteCommandPayload, allowed: string[]): void {
  if (Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('Remote task payload contains unsupported fields')
}

function assertApprovalDecisionSignature(device: StoredDevice, input: RemoteApprovalDecisionEnvelope): void {
  const { signature: _signature, ...unsigned } = input
  let valid = false
  try {
    valid = Boolean(device.publicKey) && verify(
      null,
      Buffer.from(canonicalJson(unsigned)),
      createPublicKey({ key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(input.signature, 'base64')
    )
  } catch { valid = false }
  if (!valid) throw new Error('Remote approval decision signature is invalid')
}

function assertValidCommandSignature(device: StoredDevice, envelope: RemoteCommandEnvelope): void {
  let valid = false
  try { valid = Boolean(device.publicKey) && verify(null, Buffer.from(canonicalJson(unsignedEnvelope(envelope))), createPublicKey({ key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(envelope.signature, 'base64')) } catch { valid = false }
  if (!valid) throw new Error('Remote command signature is invalid')
}

const stores = new Map<string, RemoteContinuationStore>()
export function getRemoteContinuationStore(rootDir = app.getPath('userData')): RemoteContinuationStore { const existing = stores.get(rootDir); if (existing) return existing; const store = new RemoteContinuationStore(rootDir); stores.set(rootDir, store); return store }
