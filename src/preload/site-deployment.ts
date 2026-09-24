import { ipcRenderer } from 'electron'
import type { SiteDeploymentApi } from '../shared/site-deployment-types'
export const siteDeploymentApi: SiteDeploymentApi = {
  startLocalSitePreview: (id, path, expectedTaskKey) => ipcRenderer.invoke('sites:local-preview-start', id, path, expectedTaskKey),
  getLocalSitePreview: id => ipcRenderer.invoke('sites:local-preview-get', id),
  stopLocalSitePreview: (id, previewId) => ipcRenderer.invoke('sites:local-preview-stop', id, previewId),
  getSiteDeployments: id => ipcRenderer.invoke('sites:list', id),
  saveSiteDeploymentTarget: (id, target) => ipcRenderer.invoke('sites:save', id, target),
  removeSiteDeploymentTarget: (id, targetId, revision) => ipcRenderer.invoke('sites:remove', id, targetId, revision),
  prepareSiteDeployment: (id, targetId, rollbackOf) => ipcRenderer.invoke('sites:prepare', id, targetId, rollbackOf),
  executeSiteDeployment: (id, previewId) => ipcRenderer.invoke('sites:execute', id, previewId),
  cancelSiteDeployment: (id, receiptId) => ipcRenderer.invoke('sites:cancel', id, receiptId),
  inspectSiteDeployment: (id, receiptId) => ipcRenderer.invoke('sites:inspect', id, receiptId),
  stopSiteDeploymentPreview: (id, previewId) => ipcRenderer.invoke('sites:stop-preview', id, previewId)
}
