import { ipcRenderer } from 'electron'
import type { BrowserManagementApi, BrowserManagementEvent } from '../shared/browser-preferences-types'

export const browserManagementApi: BrowserManagementApi = {
  getBrowserPreferences: () => ipcRenderer.invoke('browser-management:preferences'),
  saveBrowserPreferences: input => ipcRenderer.invoke('browser-management:save', input),
  chooseBrowserDownloadDirectory: () => ipcRenderer.invoke('browser-management:directory'),
  listBrowserHistory: query => ipcRenderer.invoke('browser-management:history', query),
  clearBrowserHistory: input => ipcRenderer.invoke('browser-management:clear-history', input),
  listBrowserDownloads: query => ipcRenderer.invoke('browser-management:downloads', query),
  controlBrowserDownload: input => ipcRenderer.invoke('browser-management:download-control', input),
  getBrowserSiteState: target => ipcRenderer.invoke('browser-management:site', target),
  setCurrentBrowserSiteRule: input => ipcRenderer.invoke('browser-management:site-rule', input),
  onBrowserManagementEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: BrowserManagementEvent) => callback(event)
    ipcRenderer.on('browser-management:event', listener)
    return () => ipcRenderer.removeListener('browser-management:event', listener)
  }
}
