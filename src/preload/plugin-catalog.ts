import { ipcRenderer } from 'electron'
import type { PluginCatalogApi } from '../shared/plugin-catalog-types'
export const pluginCatalogApi: PluginCatalogApi = {
  getPluginCatalog: () => ipcRenderer.invoke('plugin-catalog:list'),
  addPluginCatalogSource: input => ipcRenderer.invoke('plugin-catalog:add-source', input),
  setPluginCatalogSourceEnabled: (id, enabled) => ipcRenderer.invoke('plugin-catalog:enable-source', id, enabled),
  removePluginCatalogSource: id => ipcRenderer.invoke('plugin-catalog:remove-source', id),
  refreshPluginCatalogSource: id => ipcRenderer.invoke('plugin-catalog:refresh', id),
  prepareCatalogPlugin: input => ipcRenderer.invoke('plugin-catalog:prepare', input),
  cancelCatalogPluginPreparation: id => ipcRenderer.invoke('plugin-catalog:cancel', id),
  installCatalogPlugin: input => ipcRenderer.invoke('plugin-catalog:install', input),
  reconcileCatalogPlugin: id => ipcRenderer.invoke('plugin-catalog:reconcile', id)
}
