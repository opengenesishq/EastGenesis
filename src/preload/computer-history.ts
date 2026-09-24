import { ipcRenderer } from 'electron'
import type { ComputerHistoryApi } from '../shared/computer-history-types'
export const computerHistoryApi: ComputerHistoryApi = {
  getComputerHistoryState: () => ipcRenderer.invoke('computerHistory:state'),
  listComputerHistorySources: () => ipcRenderer.invoke('computerHistory:sources'),
  updateComputerHistoryPolicy: input => ipcRenderer.invoke('computerHistory:update', input),
  queryComputerHistory: input => ipcRenderer.invoke('computerHistory:query', input),
  previewComputerHistoryDeletion: input => ipcRenderer.invoke('computerHistory:previewDelete', input),
  deleteComputerHistory: (token, reviewed) => ipcRenderer.invoke('computerHistory:delete', token, reviewed)
}
