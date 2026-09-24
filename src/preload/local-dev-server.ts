import { ipcRenderer } from 'electron'
import type { LocalDevServerApi } from '../shared/local-dev-server-types'

export const localDevServerApi: LocalDevServerApi = {
  getLocalDevServer: id => ipcRenderer.invoke('local-dev-server:get', id),
  startLocalDevServer: input => ipcRenderer.invoke('local-dev-server:start', input),
  stopLocalDevServer: (id, requestId) => ipcRenderer.invoke('local-dev-server:stop', id, requestId)
}
