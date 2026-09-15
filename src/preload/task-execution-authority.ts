import { ipcRenderer } from 'electron'
import type { TaskExecutionAuthorityApi } from '../shared/task-execution-authority-types'

export const taskExecutionAuthorityApi: TaskExecutionAuthorityApi = {
  getTaskExecutionAuthority: (id) => ipcRenderer.invoke('taskExecutionAuthority:get', id),
  grantTaskExecutionAuthority: (id, input) => ipcRenderer.invoke('taskExecutionAuthority:grant', id, input),
  revokeTaskExecutionAuthority: (id, input) => ipcRenderer.invoke('taskExecutionAuthority:revoke', id, input)
}
