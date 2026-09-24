import { ipcRenderer } from 'electron'
import type { WorkspaceBehaviorApi } from '../shared/workspace-behavior-types'
export const workspaceBehaviorApi: WorkspaceBehaviorApi = {
  listExternalEditors: () => ipcRenderer.invoke('workspace-behavior:editors'),
  chooseExternalEditor: () => ipcRenderer.invoke('workspace-behavior:choose-editor'),
  openWorkspaceFileInEditor: input => ipcRenderer.invoke('workspace-behavior:open-editor', input)
}
