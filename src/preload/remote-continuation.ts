import { ipcRenderer } from 'electron'
import type { AgentDeskApi, RemoteApi, RemoteApprovalDecisionEnvelope, RemoteApprovalInput, RemoteCommandEnvelope, RemoteDeviceCapability, RemoteRunnerKind, RemoteWebhookEventEnvelope } from '../shared/types'

const invoke = (action: string, ...args: unknown[]) => ipcRenderer.invoke('appFeatures:invoke', 'remote-continuation', action, ...args)

export const remoteContinuationApi: Pick<AgentDeskApi, keyof RemoteApi> = {
  getRemoteContinuation: () => invoke('get'),
  createRemotePairingSession: (input?: { ttlMs?: number; projectId?: string; workspaceRead?: boolean; taskHandoff?: boolean }) => invoke('create-pairing', input),
  registerRemoteDevice: (input: { label: string; userId: string; publicKey: string; capabilities?: RemoteDeviceCapability[] }) => invoke('register-device', input),
  updateRemoteDeviceCapabilities: (deviceId: string, capabilities: RemoteDeviceCapability[]) => invoke('update-device-capabilities', deviceId, capabilities),
  unbindRemoteDevice: (deviceId: string) => invoke('unbind-device', deviceId),
  setRemoteConnectivity: (connectivity) => invoke('connectivity', connectivity),
  reconcileRemoteQueue: () => invoke('reconcile'),
  ingestRemoteCommand: (envelope: RemoteCommandEnvelope) => invoke('ingest-command', envelope),
  ingestRemoteWebhookEvent: (event: RemoteWebhookEventEnvelope) => invoke('ingest-webhook', event),
  createRemoteApproval: (input: RemoteApprovalInput) => invoke('create-approval', input),
  decideRemoteApproval: (input: RemoteApprovalDecisionEnvelope) => invoke('decide-approval', input),
  acquireRemoteRunnerLease: (input: { projectId: string; workItemId?: string; deviceId: string; runnerKind?: RemoteRunnerKind; ttlMs?: number }) => invoke('acquire-lease', input),
  releaseRemoteRunnerLease: (input: { leaseId: string; deviceId: string; expectedRevision: number }) => invoke('release-lease', input),
  getRemoteResultProjection: (projectId: string) => invoke('result-projection', projectId)
}
