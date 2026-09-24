import { ipcRenderer } from 'electron'
import type { BrowserExtensionApi } from '../shared/browser-extension-types'
export const browserExtensionApi: BrowserExtensionApi = {
  openBrowserExtensionDirectory: () => ipcRenderer.invoke('browser-extension:directory'),
  beginBrowserExtensionPairing: input => ipcRenderer.invoke('browser-extension:pair', input)
}
