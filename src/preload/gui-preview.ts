import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GuiPreviewApi, GuiPreviewSnapshot, GuiPreviewWorkbenchApi } from '../shared/gui-preview-types'

export const isGuiPreview = process.argv.includes('--caogen-gui-preview')
export const guiPreviewApi: GuiPreviewApi = {
  getState: () => ipcRenderer.invoke('gui-preview:state'),
  pause: expectedRunId => ipcRenderer.invoke('gui-preview:pause', expectedRunId),
  takeOver: expectedRunId => ipcRenderer.invoke('gui-preview:take-over', expectedRunId),
  openTask: () => ipcRenderer.invoke('gui-preview:open-task'),
  close: () => ipcRenderer.invoke('gui-preview:close'),
  onState: callback => {
    const listener = (_event: IpcRendererEvent, value: GuiPreviewSnapshot): void => callback(value)
    ipcRenderer.on('gui-preview:state-changed', listener)
    return () => { ipcRenderer.removeListener('gui-preview:state-changed', listener) }
  }
}
export const guiPreviewWorkbenchApi: GuiPreviewWorkbenchApi = {
  openGuiPreview: sessionId => ipcRenderer.invoke('gui-preview:open', sessionId)
}
