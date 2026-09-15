import { ipcRenderer } from 'electron'
import type { SessionInputApi } from '../shared/session-input-types'

export const sessionInputApi: SessionInputApi = {
  listSessionInputs: (id) => ipcRenderer.invoke('sessionInputs:list', id),
  queueSessionInput: (id, requestId, payload) => ipcRenderer.invoke('sessionInputs:queue', id, requestId, payload),
  applySessionInput: (id, requestId) => ipcRenderer.invoke('sessionInputs:apply', id, requestId),
  cancelSessionInput: (id, requestId) => ipcRenderer.invoke('sessionInputs:cancel', id, requestId)
}
