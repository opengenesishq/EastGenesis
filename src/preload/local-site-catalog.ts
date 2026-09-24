import { ipcRenderer } from 'electron'
import type { LocalSiteCatalogApi } from '../shared/local-site-catalog-types'

export const localSiteCatalogApi: LocalSiteCatalogApi = {
  listLocalSites: () => ipcRenderer.invoke('local-sites:list'),
  registerLocalSite: input => ipcRenderer.invoke('local-sites:register', input),
  resolveLocalSite: (id, revision) => ipcRenderer.invoke('local-sites:resolve', id, revision),
  previewLocalSite: (id, revision) => ipcRenderer.invoke('local-sites:preview', id, revision)
}
