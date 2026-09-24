import { ipcRenderer } from 'electron'
import type { LocalSitePreviewApi } from '../shared/local-site-preview-types'
export const localSitePreviewApi: LocalSitePreviewApi = {
  startLocalSitePreview: (id, path, expectedTaskKey) => ipcRenderer.invoke('sites:local-preview-start', id, path, expectedTaskKey),
  getLocalSitePreview: id => ipcRenderer.invoke('sites:local-preview-get', id),
  stopLocalSitePreview: (id, previewId) => ipcRenderer.invoke('sites:local-preview-stop', id, previewId)
}
