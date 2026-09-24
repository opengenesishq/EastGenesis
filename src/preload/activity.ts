import { ipcRenderer } from 'electron'
import type { TaskActivityApi } from '../shared/activity-types'
export const taskActivityApi: TaskActivityApi = {
  listTaskActivity: () => ipcRenderer.invoke('activity:list'),
  markTaskActivity: input => ipcRenderer.invoke('activity:mark', input),
  resolveTaskActivity: (snapshotId, itemId) => ipcRenderer.invoke('activity:resolve', snapshotId, itemId),
  readTaskActivityRecord: (snapshotId, itemId) => ipcRenderer.invoke('activity:record', snapshotId, itemId),
  onTaskActivityChanged: callback => {
    const listener = () => callback()
    ipcRenderer.on('activity:changed', listener)
    return () => ipcRenderer.removeListener('activity:changed', listener)
  }
}
