import { ipcRenderer } from 'electron'
import type { BrowserStyleApi } from '../shared/browser-style-types'
export const browserStyleApi: BrowserStyleApi = {
  pickBrowserStyleTarget: (target, previewId) => ipcRenderer.invoke('browser-style:pick', { target, previewId }),
  previewBrowserStyles: input => ipcRenderer.invoke('browser-style:preview', input),
  revertBrowserStyles: input => ipcRenderer.invoke('browser-style:revert', input),
  getBrowserStyleDraft: input => ipcRenderer.invoke('browser-style:draft', input),
  releaseBrowserStylePreview: input => ipcRenderer.invoke('browser-style:release', input)
}
