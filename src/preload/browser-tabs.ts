import { ipcRenderer } from 'electron'
import type { BrowserTabApi, BrowserTabsSnapshot } from '../shared/browser-tab-types'

export const browserTabsApi: BrowserTabApi = {
  listBrowserTabs: contextId => ipcRenderer.invoke('browser-tabs:list', contextId),
  createBrowserTab: (contextId, options) => ipcRenderer.invoke('browser-tabs:create', contextId, options),
  selectBrowserTab: target => ipcRenderer.invoke('browser-tabs:select', target),
  closeBrowserTab: target => ipcRenderer.invoke('browser-tabs:close', target),
  setBrowserContextVisible: (contextId, visible) => ipcRenderer.invoke('browser-tabs:visible', contextId, visible),
  onBrowserTabsEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: BrowserTabsSnapshot) => callback(snapshot)
    ipcRenderer.on('browser-tabs:event', listener)
    return () => ipcRenderer.removeListener('browser-tabs:event', listener)
  }
}
