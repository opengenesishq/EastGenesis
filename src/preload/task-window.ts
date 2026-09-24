import { ipcRenderer } from 'electron'
import type { TaskWindowApi, TaskWindowState } from '../shared/task-window-types'

export const taskWindowApi: TaskWindowApi = {
  taskWindowSessionId: process.argv.find((value) => value.startsWith('--caogen-task-window='))?.slice('--caogen-task-window='.length) || null,
  openTaskWindow: (sessionId) => ipcRenderer.invoke('task-window:open', sessionId),
  getTaskWindowState: () => ipcRenderer.invoke('task-window:state'),
  setTaskWindowAlwaysOnTop: (value) => ipcRenderer.invoke('task-window:pin', value),
  showTaskInMainWindow: (sessionId) => ipcRenderer.invoke('task-window:show-main', sessionId),
  sendRemoteWelcomeDraftToMain: input => ipcRenderer.invoke('task-window:remote-draft-send', input),
  listRemoteWelcomeDrafts: () => ipcRenderer.invoke('task-window:remote-drafts'),
  acknowledgeRemoteWelcomeDraft: id => ipcRenderer.invoke('task-window:remote-draft-ack', id),
  onRemoteWelcomeDraftsChanged: callback => {
    const listener = (): void => callback()
    ipcRenderer.on('task-window:remote-drafts-changed', listener)
    return () => ipcRenderer.removeListener('task-window:remote-drafts-changed', listener)
  },
  onTaskWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: TaskWindowState): void => callback(state)
    ipcRenderer.on('task-window:state-changed', listener)
    return () => ipcRenderer.removeListener('task-window:state-changed', listener)
  }
}
