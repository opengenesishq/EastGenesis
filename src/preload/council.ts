import { ipcRenderer } from 'electron'
import type { CouncilApi } from '../shared/council-types'

export const councilApi: CouncilApi = {
  councilPreview: (input) => ipcRenderer.invoke('council:preview', input),
  councilStart: (input) => ipcRenderer.invoke('council:start', input),
  councilGet: (input) => ipcRenderer.invoke('council:get', input),
  councilStop: (input) => ipcRenderer.invoke('council:stop', input)
}
