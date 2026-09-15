import { ipcRenderer } from 'electron'
import type { PreparationPermissionApi } from '../shared/preparation-permission-types'

export const preparationPermissionApi: PreparationPermissionApi = {
  getPreparationPermission: (id) => ipcRenderer.invoke('preparationPermission:get', id),
  grantPreparationPermission: (id, input) => ipcRenderer.invoke('preparationPermission:grant', id, input),
  revokePreparationPermission: (id, input) => ipcRenderer.invoke('preparationPermission:revoke', id, input)
}
