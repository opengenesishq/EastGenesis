import { ipcRenderer } from 'electron'
import type { SshApi } from '../shared/ssh-types'
export const sshApi: SshApi = {
  listSshHosts: () => ipcRenderer.invoke('ssh:hosts'),
  saveSshHost: (input, id, revision) => ipcRenderer.invoke('ssh:save', input, id, revision),
  deleteSshHost: (id, revision) => ipcRenderer.invoke('ssh:delete', id, revision),
  pickSshIdentity: () => ipcRenderer.invoke('ssh:pick-identity'),
  scanSshHostKey: (id, revision) => ipcRenderer.invoke('ssh:scan', id, revision),
  trustSshHostKey: token => ipcRenderer.invoke('ssh:trust', token),
  connectSshHost: (id, revision) => ipcRenderer.invoke('ssh:connect', id, revision),
  readSshTerminal: id => ipcRenderer.invoke('ssh:read', id),
  writeSshTerminal: (id, data) => ipcRenderer.invoke('ssh:write', id, data),
  resizeSshTerminal: (id, cols, rows) => ipcRenderer.invoke('ssh:resize', id, cols, rows),
  closeSshTerminal: id => ipcRenderer.invoke('ssh:close', id),
  onSshTerminalEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on('ssh:event', listener)
    return () => ipcRenderer.removeListener('ssh:event', listener)
  }
}
