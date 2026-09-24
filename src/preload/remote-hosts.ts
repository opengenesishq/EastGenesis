import { ipcRenderer } from 'electron'
import type { RemoteHostApi } from '../shared/remote-host-types'
export const remoteHostsApi: RemoteHostApi = {
  listRemoteSshTunnels: () => ipcRenderer.invoke('remote-hosts:tunnels'),
  startRemoteHostSshTunnel: input => ipcRenderer.invoke('remote-hosts:tunnel-start', input),
  writeRemoteSshTunnelInput: (id, input) => ipcRenderer.invoke('remote-hosts:tunnel-input', id, input),
  closeRemoteSshTunnel: id => ipcRenderer.invoke('remote-hosts:tunnel-close', id),
  listRemoteHosts: () => ipcRenderer.invoke('remote-hosts:list'),
  inspectRemoteHostPairing: (value, tunnelId) => ipcRenderer.invoke('remote-hosts:inspect', value, tunnelId),
  pairRemoteHost: value => ipcRenderer.invoke('remote-hosts:pair', value),
  readRemoteHostTasks: id => ipcRenderer.invoke('remote-hosts:tasks', id),
  sendRemoteHostCommand: value => ipcRenderer.invoke('remote-hosts:command', value),
  findRemoteHostCommandByRequestId: (hostId, requestId) => ipcRenderer.invoke('remote-hosts:request-receipt', hostId, requestId),
  reconcileRemoteHostCommand: (id, commandId) => ipcRenderer.invoke('remote-hosts:receipt', id, commandId),
  describeRemoteWorkspace: (hostId, workItemId) => ipcRenderer.invoke('remote-hosts:workspace-describe', hostId, workItemId),
  readRemoteWorkspace: input => ipcRenderer.invoke('remote-hosts:workspace-read', input),
  saveRemoteWorkspaceFile: input => ipcRenderer.invoke('remote-hosts:workspace-save', input),
  decideRemoteHostApproval: input => ipcRenderer.invoke('remote-hosts:approval-decide', input),
  reconcileRemoteHostApproval: (id, requestId) => ipcRenderer.invoke('remote-hosts:approval-receipt', id, requestId),
  revokeRemoteHost: id => ipcRenderer.invoke('remote-hosts:revoke', id),
  renewRemoteHost: id => ipcRenderer.invoke('remote-hosts:renew', id),
  forgetRemoteHost: id => ipcRenderer.invoke('remote-hosts:forget', id)
}
