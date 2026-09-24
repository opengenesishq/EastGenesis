import { ipcRenderer } from 'electron'
import type { HostedSiteApi } from '../shared/hosted-site-types'
export const hostedSiteApi: HostedSiteApi = {
  getHostedSite: (id, target) => ipcRenderer.invoke('hosted-sites:get', id, target),
  refreshHostedSite: (id, target, revision) => ipcRenderer.invoke('hosted-sites:refresh', id, target, revision),
  queryHostedSiteAnalytics: (id, target, range) => ipcRenderer.invoke('hosted-sites:analytics', id, target, range),
  prepareHostedSiteChange: (id, target, change) => ipcRenderer.invoke('hosted-sites:prepare', id, target, change),
  prepareHostedSiteEnvironment: (id, target, input) => ipcRenderer.invoke('hosted-sites:prepare-environment', id, target, input),
  discardHostedSitePreview: (id, preview) => ipcRenderer.invoke('hosted-sites:discard-preview', id, preview),
  executeHostedSiteChange: (id, preview) => ipcRenderer.invoke('hosted-sites:execute', id, preview),
  inspectHostedSiteChange: (id, receipt) => ipcRenderer.invoke('hosted-sites:inspect', id, receipt),
  cancelHostedSiteOperation: (id, operation) => ipcRenderer.invoke('hosted-sites:cancel', id, operation)
}
