import { ipcRenderer } from 'electron'
import type { BrowserDebugApi } from '../shared/browser-debug-types'
export const browserDebugApi: BrowserDebugApi = {
  getBrowserDebugStatus: target => ipcRenderer.invoke('browser-debug:status', target),
  grantBrowserDebug: target => ipcRenderer.invoke('browser-debug:grant', target),
  revokeBrowserDebug: input => ipcRenderer.invoke('browser-debug:revoke', input),
  getBrowserDebugSnapshot: input => ipcRenderer.invoke('browser-debug:snapshot', input)
}
