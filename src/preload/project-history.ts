import { ipcRenderer } from 'electron'
import type { ProjectHistoryApi } from '../shared/project-history'
export const projectHistoryApi: ProjectHistoryApi = {
  archiveProjectHistory: input => ipcRenderer.invoke('history:archiveProject', input)
}
