import { ipcRenderer } from 'electron'
import type { TaskSourceApi } from '../shared/task-source-types'

export const taskSourceApi: TaskSourceApi = {
  listTaskSources: sessionId => ipcRenderer.invoke('task-sources:list', sessionId),
  readTaskSource: (sessionId, collectionId, sourceId) => ipcRenderer.invoke('task-sources:read', sessionId, collectionId, sourceId),
  resolveTaskSourceUrl: (sessionId, collectionId, sourceId) => ipcRenderer.invoke('task-sources:url', sessionId, collectionId, sourceId)
}
