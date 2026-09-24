import { ipcRenderer } from 'electron'
import type { TaskHandoffApi } from '../shared/task-handoff-api'
export const taskHandoffApi: TaskHandoffApi = {
  listTaskHandoffs: id => ipcRenderer.invoke('task-handoff:list', id),
  getTaskHandoffTargets: (id, sessionId) => ipcRenderer.invoke('task-handoff:targets', id, sessionId),
  prepareTaskHandoff: input => ipcRenderer.invoke('task-handoff:prepare', input),
  commitTaskHandoff: input => ipcRenderer.invoke('task-handoff:commit', input),
  reconcileTaskHandoff: id => ipcRenderer.invoke('task-handoff:reconcile', id),
  cancelTaskHandoff: id => ipcRenderer.invoke('task-handoff:cancel', id),
  listTaskHandoffDestinations: () => ipcRenderer.invoke('task-handoff:destinations'),
  addTaskHandoffDestination: () => ipcRenderer.invoke('task-handoff:destination-add'),
  revokeTaskHandoffDestination: id => ipcRenderer.invoke('task-handoff:destination-revoke', id),
  renewTaskHandoffDestination: id => ipcRenderer.invoke('task-handoff:destination-renew', id)
}
