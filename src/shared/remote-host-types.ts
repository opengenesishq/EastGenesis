import type { RemoteCommandKind, RemoteCommandStatus, RemoteDeviceCapability, RemoteResultProjection } from './remote-types'
import type { RemoteSshBinding, RemoteSshTunnelView } from './ssh-types'
import type { RemoteWorkspaceBinding, RemoteWorkspaceOperation, RemoteWorkspaceView, RemoteWorkspaceFileVersion, RemoteWorkspaceSaveResult } from './remote-workspace-types'
import type { RemoteCreatedTask, RemoteCreatePhase } from './remote-created-task-types'
export type { RemoteCreatedTask, RemoteCreatePhase } from './remote-created-task-types'

export interface RemoteHostServerIdentity {
  origin: string
  spkiFingerprint: string
  commonName: string
  issuer: string
  validFrom: string
  validTo: string
}
export interface RemoteHostPairingPreview { id: string; identity: RemoteHostServerIdentity; expiresAt: number }
export type RemoteHostCommandKind = Exclude<RemoteCommandKind, 'view_result'>
export interface RemoteHostExpectedConnection {
  projectId: string
  deviceId: string
  origin: string
  spkiFingerprint: string
  ssh?: RemoteSshBinding
}
export interface RemoteHostCommandReceipt {
  commandId: string
  requestId?: string
  source?: 'welcome'
  kind: RemoteHostCommandKind
  workItemId?: string
  routineId?: string
  createdAt: number
  state: 'sending' | 'unknown' | 'received' | 'not_received'
  status?: RemoteCommandStatus
  execution?: { status: 'running' | 'succeeded' | 'failed' }
  error?: string
  approval?: RemoteHostApproval
  createdTask?: RemoteCreatedTask
  createPhase?: RemoteCreatePhase
}
export interface RemoteHostView {
  id: string
  label: string
  storage: 'encrypted' | 'session'
  identity: RemoteHostServerIdentity
  ssh?: RemoteSshBinding
  status: 'paired' | 'expired' | 'pairing_unknown' | 'revocation_unknown' | 'revoked'
  projectId?: string
  projectName?: string
  deviceId?: string
  expiresAt?: number
  capabilities: RemoteDeviceCapability[]
  createdAt: number
  lastCheckedAt?: number
  error?: string
  commands: RemoteHostCommandReceipt[]
  decisions?: RemoteHostApprovalReceipt[]
  renewal?: { requestId: string; createdAt: number }
}
export interface RemoteHostTask {
  id: string; title: string; status: string; revision: number
  canResume: boolean; canAppend: boolean; canPause: boolean; canCancel: boolean
  resumeReason?: string
}
export interface RemoteHostTasks {
  hostId: string; projectId: string; projectName: string; projectRevision: number
  capabilities: RemoteDeviceCapability[]; workItems: RemoteHostTask[]
  projection: RemoteResultProjection
  routines: { id: string; name: string; nextRunAt: number | null }[]
  approvals: RemoteHostApproval[]
  approvalCandidates: RemoteHostApprovalCandidate[]
}
export interface RemoteHostApprovalCandidate {
  sessionId: string; workItemId: string; permissionRequestId: string; action: string
  targetDigest: string; dataScope: string; revision: number; summary: string
}
export interface RemoteHostApproval {
  id: string; commandId: string; action: string; targetDigest: string; approvalDigest: string
  recordRevision: number; expiresAt: number; status: 'pending' | 'approved' | 'rejected' | 'expired'
  applicationStatus: 'pending' | 'applying' | 'applied' | 'failed'
  summary?: string
}
export interface RemoteHostApprovalReceipt {
  requestId: string; approvalId: string; decision: 'approve' | 'reject'; createdAt: number
  state: 'sending' | 'unknown' | 'received'; approval?: RemoteHostApproval; error?: string
}
export interface RemoteHostRevokeEnvelope {
  schemaVersion: 1; kind: 'revoke_device'; issuerDeviceId: string; projectId: string
  requestId: string; createdAt: number; expiresAt: number; signature: string
}
export interface RemoteHostRenewEnvelope {
  schemaVersion: 1; kind: 'renew_console'; issuerDeviceId: string; projectId: string
  oldConsoleTokenDigest: string; requestId: string; createdAt: number; expiresAt: number; signature: string
}
export interface RemoteHostApi {
  listRemoteSshTunnels(): Promise<RemoteSshTunnelView[]>
  startRemoteHostSshTunnel(input: { sshHostId: string; sshHostRevision: number; pairingUrl?: string; hostId?: string }): Promise<RemoteSshTunnelView>
  writeRemoteSshTunnelInput(tunnelId: string, input: string): Promise<void>
  closeRemoteSshTunnel(tunnelId: string): Promise<void>
  listRemoteHosts(): Promise<{ hosts: RemoteHostView[]; secureStorageAvailable: boolean }>
  inspectRemoteHostPairing(pairingUrl: string, tunnelId?: string): Promise<RemoteHostPairingPreview>
  pairRemoteHost(input: { previewId: string; confirmedSpkiFingerprint: string; label: string; deviceLabel: string; storage: 'encrypted' | 'session' }): Promise<RemoteHostView>
  readRemoteHostTasks(hostId: string): Promise<RemoteHostTasks>
  sendRemoteHostCommand(input: { hostId: string; kind: RemoteHostCommandKind; workItemId?: string; routineId?: string; expectedRevision: number; text?: string; requestId: string; approvalCandidate?: RemoteHostApprovalCandidate; source?: 'welcome'; expectedConnection?: RemoteHostExpectedConnection }): Promise<RemoteHostCommandReceipt>
  /** Local outbox lookup only. Never contacts the host, creates a command or replays a send. */
  findRemoteHostCommandByRequestId(hostId: string, requestId: string): Promise<RemoteHostCommandReceipt | null>
  reconcileRemoteHostCommand(hostId: string, commandId: string): Promise<RemoteHostCommandReceipt>
  decideRemoteHostApproval(input: { hostId: string; approvalId: string; expectedRevision: number; approvalDigest: string; decision: 'approve' | 'reject'; requestId: string }): Promise<RemoteHostApprovalReceipt>
  reconcileRemoteHostApproval(hostId: string, requestId: string): Promise<RemoteHostApprovalReceipt>
  describeRemoteWorkspace(hostId: string, workItemId: string): Promise<RemoteWorkspaceView>
  readRemoteWorkspace(input: { hostId: string; binding: RemoteWorkspaceBinding; operation: Exclude<RemoteWorkspaceOperation, 'describe'>; path?: string; cursor?: number; file?: RemoteWorkspaceFileVersion; offset?: number }): Promise<RemoteWorkspaceView>
  saveRemoteWorkspaceFile(input: { hostId: string; binding: RemoteWorkspaceBinding; path: string }): Promise<RemoteWorkspaceSaveResult>
  revokeRemoteHost(hostId: string): Promise<RemoteHostView>
  renewRemoteHost(hostId: string): Promise<RemoteHostView>
  forgetRemoteHost(hostId: string): Promise<void>
}
