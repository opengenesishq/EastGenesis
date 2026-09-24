import { ipcRenderer } from 'electron'
import type { CompanionAppearanceApi } from '../shared/companion-appearance-types'
export const companionAppearanceApi: CompanionAppearanceApi = {
  listCompanionImages: () => ipcRenderer.invoke('companion-images:list'),
  importCompanionImage: () => ipcRenderer.invoke('companion-images:import'),
  previewCompanionImage: id => ipcRenderer.invoke('companion-images:preview', id),
  removeCompanionImage: id => ipcRenderer.invoke('companion-images:remove', id)
}
