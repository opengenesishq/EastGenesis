import { ipcRenderer } from 'electron'
import type { TemporaryTaskApi } from '../shared/temporary-task-types'
export const temporaryTaskApi: TemporaryTaskApi = {
  getTemporaryTaskState: () => ipcRenderer.invoke('temporary-task:state'),
  openTemporaryTask: () => ipcRenderer.invoke('temporary-task:open'),
  cleanTemporaryTask: id => ipcRenderer.invoke('temporary-task:clean', id),
  endTemporaryTask: id => ipcRenderer.invoke('temporary-task:end', id),
  finishTemporaryTask: () => ipcRenderer.invoke('temporary-task:finish'),
  openTemporaryTaskFiles: () => ipcRenderer.invoke('temporary-task:files'),
  onTemporaryTaskEntry: callback => {
    const listener = (): void => callback()
    ipcRenderer.on('temporary-task:entry', listener)
    return () => { ipcRenderer.removeListener('temporary-task:entry', listener) }
  }
}
