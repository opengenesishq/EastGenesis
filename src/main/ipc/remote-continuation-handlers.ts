import type { IpcMainInvokeEvent } from 'electron'
import { app } from 'electron'
import type {
  RemoteApprovalInput,
  RemoteApprovalDecisionEnvelope,
  RemoteCommandEnvelope,
  RemoteCommandPayload,
  RemoteWebhookEventEnvelope,
  RemoteConnectivity,
  RemoteDeviceCapability,
  RemoteRunnerKind
} from '../../shared/remote-types'
import { getRemoteContinuationStore } from '../remote/store'
import { executePendingRemoteCommands, executeRemoteCommand, reconcileRemoteExecutions } from '../remote/executor'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { createRemotePairingSession } from '../remote/webhook-server'
import { RemoteConsoleSessionStore } from '../remote/console-session-store'

type RemoteAction =
  | 'get'
  | 'register-device'
  | 'update-device-capabilities'
  | 'unbind-device'
  | 'connectivity'
  | 'reconcile'
  | 'ingest-command'
  | 'ingest-webhook'
  | 'create-approval'
  | 'decide-approval'
  | 'acquire-lease'
  | 'release-lease'
  | 'result-projection'
  | 'create-pairing'

export async function handleRemoteContinuationIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  ...args: unknown[]
) {
  assertTrustedWorkflowLedgerSender(event)
  const store = getRemoteContinuationStore(app.getPath('userData'))
  const action = requiredAction(rawAction)
  if (action === 'get') return store.getSnapshot()
  if (action === 'create-pairing') {
    const input = normalizePairingInput(args[0])
    if (input.projectId) await store.resultProjection(input.projectId)
    return createRemotePairingSession(input)
  }
  if (action === 'register-device') return store.registerDevice(normalizeRegisterInput(args[0]))
  if (action === 'update-device-capabilities') {
    return store.updateDeviceCapabilities(requiredString(args[0], 'deviceId'), normalizeCapabilities(args[1]))
  }
  if (action === 'unbind-device') {
    const id = requiredString(args[0], 'deviceId')
    const device = await store.unbindDevice(id)
    new RemoteConsoleSessionStore(app.getPath('userData')).revokeDevice(id)
    return device
  }
  if (action === 'connectivity') return store.setConnectivity(requiredConnectivity(args[0]))
  if (action === 'reconcile') {
    const result = await store.reconcile()
    await executePendingRemoteCommands(app.getPath('userData'))
    await reconcileRemoteExecutions(app.getPath('userData'))
    return result
  }
  if (action === 'ingest-command') {
    const record = await store.ingest(normalizeEnvelope(args[0]))
    if (record.status === 'pending') return executeRemoteCommand(app.getPath('userData'), record.envelope.commandId)
    return record
  }
  if (action === 'ingest-webhook') {
    const eventInput = normalizeWebhook(args[0])
    const record = await store.ingestWebhook(eventInput)
    if (record.status === 'pending') return executeRemoteCommand(app.getPath('userData'), record.envelope.commandId)
    return record
  }
  if (action === 'create-approval') return store.createApproval(normalizeApprovalInput(args[0]))
  if (action === 'decide-approval') {
    const decision = await store.decideApproval(normalizeRemoteApprovalDecision(args[0]))
    const command = await store.getCommand(decision.commandId)
    if (command && (command.status === 'pending' || (command.status === 'accepted' && command.execution?.status === 'running'))) {
      return executeRemoteCommand(app.getPath('userData'), command.envelope.commandId)
    }
    return decision
  }
  if (action === 'acquire-lease') return store.acquireLease(normalizeLeaseInput(args[0]))
  if (action === 'release-lease') return store.releaseLease(normalizeReleaseInput(args[0]))
  return store.resultProjection(requiredString(args[0], 'projectId'))
}

function requiredAction(value: unknown): RemoteAction {
  const actions: RemoteAction[] = ['get', 'register-device', 'update-device-capabilities', 'unbind-device', 'connectivity', 'reconcile', 'ingest-command', 'ingest-webhook', 'create-approval', 'decide-approval', 'acquire-lease', 'release-lease', 'result-projection', 'create-pairing']
  if (typeof value !== 'string' || !actions.includes(value as RemoteAction)) throw new Error('Remote continuation action is invalid')
  return value as RemoteAction
}

function normalizePairingInput(value: unknown): { ttlMs?: number; projectId?: string; workspaceRead?: boolean; taskHandoff?: boolean } {
  if (value === undefined || value === null) return {}
  const input = record(value, 'remote pairing')
  assertKeys(input, new Set(['ttlMs', 'projectId', 'workspaceRead', 'taskHandoff']), 'remote pairing')
  if (input.ttlMs !== undefined && (typeof input.ttlMs !== 'number' || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 30_000 || input.ttlMs > 15 * 60_000)) throw new Error('Remote pairing ttl is invalid')
  if (input.projectId !== undefined) requiredString(input.projectId, 'projectId')
  if (input.workspaceRead !== undefined && typeof input.workspaceRead !== 'boolean') throw new Error('Workspace read permission must be explicit')
  if (input.taskHandoff !== undefined && typeof input.taskHandoff !== 'boolean') throw new Error('Task handoff permission must be explicit')
  return { ...(input.workspaceRead === true ? { workspaceRead: true } : {}), ...(input.taskHandoff === true ? { taskHandoff: true } : {}), ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs as number }), ...(input.projectId === undefined ? {} : { projectId: input.projectId as string }) }
}
function normalizeWebhook(value: unknown): RemoteWebhookEventEnvelope {
  const input = record(value, 'remote webhook event')
  assertKeys(input, new Set(['schemaVersion', 'eventId', 'command', 'payloadDigest', 'expiresAt', 'signature']), 'remote webhook event')
  if (input.schemaVersion !== 1 || typeof input.eventId !== 'string' || typeof input.payloadDigest !== 'string' || typeof input.expiresAt !== 'number' || typeof input.signature !== 'string') throw new Error('Remote webhook event is invalid')
  const command = normalizeEnvelope(input.command)
  if (input.eventId !== command.commandId || input.payloadDigest !== command.payloadDigest) throw new Error('Remote webhook identity or digest is invalid')
  if (input.expiresAt !== command.expiresAt) throw new Error('Remote webhook expiry does not match command')
  return { schemaVersion: 1, eventId: input.eventId, command, payloadDigest: input.payloadDigest, expiresAt: input.expiresAt, signature: input.signature }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}
function normalizeRegisterInput(value: unknown): { label: string; userId: string; publicKey: string; capabilities?: RemoteDeviceCapability[] } {
  const input = record(value, 'remote device')
  const allowed = new Set(['label', 'userId', 'publicKey', 'capabilities'])
  assertKeys(input, allowed, 'remote device')
  if (input.capabilities !== undefined) normalizeCapabilities(input.capabilities)
  return { label: requiredString(input.label, 'label'), userId: requiredString(input.userId, 'userId'), publicKey: requiredString(input.publicKey, 'publicKey'), ...(input.capabilities ? { capabilities: input.capabilities as RemoteDeviceCapability[] } : {}) }
}
function normalizeCapabilities(value: unknown): RemoteDeviceCapability[] {
  const allowed: RemoteDeviceCapability[] = ['view_results', 'resume_work_item', 'create_task', 'control_work_item', 'approve_effect', 'trigger_routine', 'remote_runner', 'workspace_read', 'task_handoff']
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !allowed.includes(item as RemoteDeviceCapability))) throw new Error('device capabilities are invalid')
  return [...new Set(value as RemoteDeviceCapability[])]
}
function requiredConnectivity(value: unknown): RemoteConnectivity {
  if (value !== 'online' && value !== 'offline') throw new Error('Remote connectivity is invalid')
  return value
}
function normalizeScopeInput(value: unknown): RemoteCommandEnvelope['scope'] {
  const input = record(value, 'remote command scope')
  assertKeys(input, new Set(['projectId', 'goalId', 'workItemId', 'runId', 'routineId', 'artifactIds', 'dataClass']), 'remote command scope')
  if (input.artifactIds !== undefined && (!Array.isArray(input.artifactIds) || input.artifactIds.some((item) => typeof item !== 'string'))) throw new Error('scope artifactIds are invalid')
  if (input.dataClass !== 'metadata_only' && input.dataClass !== 'artifact_summary') throw new Error('scope dataClass is invalid')
  return { projectId: requiredString(input.projectId, 'scope.projectId'), ...(input.goalId ? { goalId: requiredString(input.goalId, 'scope.goalId') } : {}), ...(input.workItemId ? { workItemId: requiredString(input.workItemId, 'scope.workItemId') } : {}), ...(input.runId ? { runId: requiredString(input.runId, 'scope.runId') } : {}), ...(input.routineId ? { routineId: requiredString(input.routineId, 'scope.routineId') } : {}), artifactIds: (input.artifactIds as string[] | undefined) ?? [], dataClass: input.dataClass }
}
function normalizeEnvelope(value: unknown): RemoteCommandEnvelope {
  const input = record(value, 'remote command envelope')
  assertKeys(input, new Set(['schemaVersion', 'commandId', 'issuerDeviceId', 'kind', 'scope', 'revision', 'expiresAt', 'createdAt', 'payloadDigest', 'payload', 'signature']), 'remote command envelope')
  if (input.schemaVersion !== 1 || typeof input.commandId !== 'string' || typeof input.issuerDeviceId !== 'string' || typeof input.signature !== 'string' || typeof input.payloadDigest !== 'string' || typeof input.createdAt !== 'number' || typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.revision) || typeof input.kind !== 'string' || !['resume_work_item', 'approve_effect', 'view_result', 'trigger_routine', 'create_task', 'append_task', 'pause_work_item', 'cancel_work_item'].includes(input.kind)) throw new Error('Remote command envelope is invalid')
  if (input.kind === 'trigger_routine' && !(input.scope && typeof input.scope === 'object' && 'routineId' in (input.scope as object))) throw new Error('trigger_routine requires scope.routineId')
  if (input.kind !== 'trigger_routine' && input.scope && typeof input.scope === 'object' && 'routineId' in (input.scope as object)) throw new Error('routineId is only valid for trigger_routine')
  // The store validates the signed payload without rewriting its bytes.
  const payload = input.payload === undefined ? undefined : record(input.payload, 'remote command payload') as unknown as RemoteCommandPayload
  return { schemaVersion: 1, commandId: input.commandId, issuerDeviceId: input.issuerDeviceId, kind: input.kind as RemoteCommandEnvelope['kind'], scope: normalizeScopeInput(input.scope), revision: input.revision as number, expiresAt: input.expiresAt as number, createdAt: input.createdAt as number, payloadDigest: input.payloadDigest, ...(payload ? { payload } : {}), signature: input.signature }
}
function normalizeApprovalInput(value: unknown): RemoteApprovalInput {
  const input = record(value, 'remote approval')
  assertKeys(input, new Set(['commandId', 'sessionId', 'permissionRequestId', 'action', 'targetDigest', 'dataScope', 'costLimitUsd', 'revision', 'expiresAt']), 'remote approval')
  if (!Number.isSafeInteger(input.revision) || typeof input.expiresAt !== 'number') throw new Error('Remote approval revision or expiry is invalid')
  return { commandId: requiredString(input.commandId, 'commandId'), sessionId: requiredString(input.sessionId, 'sessionId'), permissionRequestId: requiredString(input.permissionRequestId, 'permissionRequestId'), action: requiredString(input.action, 'action'), targetDigest: requiredString(input.targetDigest, 'targetDigest'), dataScope: requiredString(input.dataScope, 'dataScope'), ...(input.costLimitUsd === undefined ? {} : { costLimitUsd: input.costLimitUsd as number }), revision: input.revision as number, expiresAt: input.expiresAt as number }
}
export function normalizeRemoteApprovalDecision(value: unknown): RemoteApprovalDecisionEnvelope {
  const input = record(value, 'remote approval decision')
  assertKeys(input, new Set(['schemaVersion', 'approvalId', 'issuerDeviceId', 'decision', 'expectedRecordRevision', 'approvalDigest', 'createdAt', 'expiresAt', 'signature']), 'remote approval decision')
  if (input.schemaVersion !== 1) throw new Error('Remote approval decision schema is invalid')
  if (input.decision !== 'approve' && input.decision !== 'reject') throw new Error('Remote approval decision is invalid')
  if (!Number.isSafeInteger(input.expectedRecordRevision) || !Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt)) throw new Error('Remote approval decision revision or time bounds are invalid')
  return { schemaVersion: 1, approvalId: requiredString(input.approvalId, 'approvalId'), issuerDeviceId: requiredString(input.issuerDeviceId, 'issuerDeviceId'), decision: input.decision as 'approve' | 'reject', expectedRecordRevision: input.expectedRecordRevision as number, approvalDigest: requiredString(input.approvalDigest, 'approvalDigest'), createdAt: input.createdAt as number, expiresAt: input.expiresAt as number, signature: requiredString(input.signature, 'signature') }
}
function normalizeLeaseInput(value: unknown): { projectId: string; workItemId?: string; deviceId: string; runnerKind?: RemoteRunnerKind; ttlMs?: number } {
  const input = record(value, 'remote runner lease')
  assertKeys(input, new Set(['projectId', 'workItemId', 'deviceId', 'runnerKind', 'ttlMs']), 'remote runner lease')
  if (input.runnerKind !== undefined && input.runnerKind !== 'local' && input.runnerKind !== 'remote') throw new Error('Remote runner kind is invalid')
  if (input.ttlMs !== undefined && typeof input.ttlMs !== 'number') throw new Error('Remote runner ttl is invalid')
  return { projectId: requiredString(input.projectId, 'projectId'), ...(input.workItemId ? { workItemId: requiredString(input.workItemId, 'workItemId') } : {}), deviceId: requiredString(input.deviceId, 'deviceId'), ...(input.runnerKind ? { runnerKind: input.runnerKind } : {}), ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }) }
}
function normalizeReleaseInput(value: unknown): { leaseId: string; deviceId: string; expectedRevision: number } {
  const input = record(value, 'remote runner release')
  assertKeys(input, new Set(['leaseId', 'deviceId', 'expectedRevision']), 'remote runner release')
  if (!Number.isSafeInteger(input.expectedRevision)) throw new Error('Remote runner expectedRevision is invalid')
  return { leaseId: requiredString(input.leaseId, 'leaseId'), deviceId: requiredString(input.deviceId, 'deviceId'), expectedRevision: input.expectedRevision as number }
}
function assertKeys(input: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.join(', ')}`)
}
