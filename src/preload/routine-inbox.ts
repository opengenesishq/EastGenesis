import { ipcRenderer } from 'electron'
import type { RoutineInboxApi } from '../shared/routine-inbox-types'

export const routineInboxApi: RoutineInboxApi = {
  listRoutineInbox: input => ipcRenderer.invoke('routine-inbox:list', input),
  readRoutineInboxResult: (snapshotId, runId) => ipcRenderer.invoke('routine-inbox:read', snapshotId, runId),
  markRoutineInboxRead: input => ipcRenderer.invoke('routine-inbox:mark', input),
  resolveRoutineInboxTask: (snapshotId, runId) => ipcRenderer.invoke('routine-inbox:resolve', snapshotId, runId),
  onRoutineInboxChanged: callback => {
    const listener = () => callback()
    ipcRenderer.on('routine-inbox:changed', listener)
    return () => ipcRenderer.removeListener('routine-inbox:changed', listener)
  }
}
