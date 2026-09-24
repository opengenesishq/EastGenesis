import type { RemoteCreatedTask, RemoteCreatePhase } from './remote-created-task-types'

/**
 * Remote continuation contracts. The remote surface is intentionally a
 * control and projection plane. File reads and task transfer require separate
 * opt-in capabilities; task transfer retains its own preview and ownership checks.
 */
export const REMOTE_SCHEMA_VERSION = 1 as const

export type RemoteDeviceCapability =
  | 'view_results'
  | 'workspace_read'
  | 'task_handoff'
  | 'resume_work_item'
  | 'create_task'
  | 'control_work_item'
  | 'approve_effect'
  | 'trigger_routine'
  | 'remote_runner'

export type RemoteDeviceStatus = 'active' | 'revoked'
export type RemoteConnectivity = 'online' | 'offline'
export type RemoteCommandKind = 'resume_work_item' | 'approve_effect' | 'view_result' | 'trigger_routine' | 'create_task' | 'append_task' | 'pause_work_item' | 'cancel_work_item'
export type RemoteCommandStatus = 'pending' | 'offline' | 'expired' | 'rejected' | 'accepted'
export type RemoteCommandExecutionStatus = 'running' | 'succeeded' | 'failed'
export type RemoteApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type RemoteRunnerKind = 'local' | 'remote'

export type RemoteCommandPayload =
  | { kind: 'approve_effect'; sessionId: string; permissionRequestId: string; action: string; targetDigest: string; dataScope: string }
  | { kind: 'create_task'; objective: string; businessLineId?: string }
  | { kind: 'append_task'; text: string; clientRequestId: string }
  | { kind: 'pause_work_item'; reason?: string }
  | { kind: 'cancel_work_item'; reason?: string }

export interface RemoteDeviceIdentity {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION
  id: string
  label: string
  userId: string
  /** Present only while the binding is active; unbind erases the key material. */
  publicKey?: string
  publicKeyFingerprint: string
  capabilities: RemoteDeviceCapability[]
  status: RemoteDeviceStatus
  createdAt: number
  lastOnlineAt?: number
  revokedAt?: number
  auditIds: string[]
}

export interface RemoteCommandScope {
  projectId: string
  goalId?: string
  workItemId?: string
  runId?: string
  /** Required for trigger_routine; kept in the same signed scope as the Project. */
  routineId?: string
  artifactIds: string[]
  dataClass: 'metadata_only' | 'artifact_summary'
}

export interface RemoteCommandEnvelope {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION
  commandId: string
  issuerDeviceId: string
  kind: RemoteCommandKind
  scope: RemoteCommandScope
  revision: number
  expiresAt: number
  createdAt: number
  payloadDigest: string
  /** Signed command input. Metadata-only commands may omit this for v1 compatibility. */
  payload?: RemoteCommandPayload
  signature: string
}

/** Transport wrapper for an inbound Webhook. eventId must equal commandId. */
export interface RemoteWebhookEventEnvelope {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION
  eventId: string
  command: RemoteCommandEnvelope
  payloadDigest: string
  expiresAt: number
  signature: string
}

export interface RemoteCommandRecord {
  envelope: RemoteCommandEnvelope
  status: RemoteCommandStatus
  receivedAt: number
  updatedAt: number
  rejectionReason?: string
  auditId: string
  /** Durable local execution binding. A commandId can create at most one Routine Run. */
  execution?: {
    status: RemoteCommandExecutionStatus
    routineRunId?: string
    runId?: string
    createdTask?: RemoteCreatedTask
    createPhase?: RemoteCreatePhase
    error?: string
    updatedAt: number
  }
}

export interface RemoteApprovalInput {
  commandId: string
  sessionId: string
  permissionRequestId: string
  action: string
  targetDigest: string
  dataScope: string
  costLimitUsd?: number
  revision: number
  expiresAt: number
}

export interface RemoteApprovalRecord extends RemoteApprovalInput {
  id: string
  status: RemoteApprovalStatus
  createdAt: number
  updatedAt: number
  recordRevision: number
  approvalDigest: string
  decidedByDeviceId?: string
  applicationStatus: 'pending' | 'applying' | 'applied' | 'failed'
  appliedAt?: number
  applicationError?: string
  auditId: string
}

export interface RemoteApprovalDecisionEnvelope {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION
  approvalId: string
  issuerDeviceId: string
  decision: 'approve' | 'reject'
  expectedRecordRevision: number
  approvalDigest: string
  createdAt: number
  expiresAt: number
  signature: string
}

export interface RemoteRunnerLease {
  id: string
  projectId: string
  workItemId?: string
  deviceId: string
  runnerKind: RemoteRunnerKind
  fencingToken: number
  acquiredAt: number
  expiresAt: number
  status: 'active' | 'released' | 'expired'
  revision: number
}

export interface RemoteResultProjection {
  projectId: string
  projectName: string
  projectRevision: number
  generatedAt: number
  goalCount: number
  workItemCount: number
  activeWorkItemCount: number
  runCount: number
  artifactCount: number
  availableArtifactCount: number
  evidenceCount: number
  acceptanceCount: number
  passedAcceptanceCount: number
  openItemCount: number
  riskCount: number
  artifactDigests: string[]
  acceptanceStatuses: string[]
  projectionDigest: string
}

export interface RemotePairingSession {
  url: string
  token: string
  expiresAt: number
  host: string
  port: number
  projectId?: string
}

export interface RemoteAuditEntry {
  id: string
  action: string
  actorDeviceId?: string
  commandId?: string
  projectId?: string
  at: number
  result: 'accepted' | 'rejected' | 'revoked' | 'expired' | 'state_changed'
  detailDigest: string
}

export interface RemoteContinuationSnapshot {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION
  revision: number
  connectivity: RemoteConnectivity
  devices: RemoteDeviceIdentity[]
  commands: RemoteCommandRecord[]
  approvals: RemoteApprovalRecord[]
  leases: RemoteRunnerLease[]
  audit: RemoteAuditEntry[]
  webhook?: { host: string; port: number; running: boolean; protocol?: 'http' | 'https' }
  snapshotDigest: string
}

export interface RemoteApi {
  getRemoteContinuation(): Promise<RemoteContinuationSnapshot>
  createRemotePairingSession(input?: { ttlMs?: number; projectId?: string; workspaceRead?: boolean; taskHandoff?: boolean }): Promise<RemotePairingSession>
  registerRemoteDevice(input: { label: string; userId: string; publicKey: string; capabilities?: RemoteDeviceCapability[] }): Promise<RemoteDeviceIdentity>
  updateRemoteDeviceCapabilities(deviceId: string, capabilities: RemoteDeviceCapability[]): Promise<RemoteDeviceIdentity>
  unbindRemoteDevice(deviceId: string): Promise<RemoteDeviceIdentity>
  setRemoteConnectivity(connectivity: RemoteConnectivity): Promise<RemoteContinuationSnapshot>
  reconcileRemoteQueue(): Promise<RemoteContinuationSnapshot>
  ingestRemoteCommand(envelope: RemoteCommandEnvelope): Promise<RemoteCommandRecord>
  ingestRemoteWebhookEvent(event: RemoteWebhookEventEnvelope): Promise<RemoteCommandRecord>
  createRemoteApproval(input: RemoteApprovalInput): Promise<RemoteApprovalRecord>
  decideRemoteApproval(input: RemoteApprovalDecisionEnvelope): Promise<RemoteApprovalRecord>
  acquireRemoteRunnerLease(input: { projectId: string; workItemId?: string; deviceId: string; runnerKind?: RemoteRunnerKind; ttlMs?: number }): Promise<RemoteRunnerLease>
  releaseRemoteRunnerLease(input: { leaseId: string; deviceId: string; expectedRevision: number }): Promise<RemoteRunnerLease>
  getRemoteResultProjection(projectId: string): Promise<RemoteResultProjection>
}
