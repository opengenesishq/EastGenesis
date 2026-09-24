import { ipcRenderer } from 'electron'
import type { MemoryPreferencesApi } from '../shared/memory-preferences-types'
export const memoryPreferencesApi: MemoryPreferencesApi = {
  readTaskMemoryPreferences: id => ipcRenderer.invoke('memory:preferencesRead', id),
  updateTaskMemoryPreferences: (id, overrides) => ipcRenderer.invoke('memory:preferencesUpdate', id, overrides)
}
