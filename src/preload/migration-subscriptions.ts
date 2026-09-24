import { ipcRenderer } from 'electron'
import type { MigrationSubscriptionApi } from '../shared/migration-subscription-types'
export const migrationSubscriptionApi: MigrationSubscriptionApi = {
  listMigrationSubscriptions: () => ipcRenderer.invoke('migration-subscriptions:list'),
  subscribeMigrationImport: (backupId, ids) => ipcRenderer.invoke('migration-subscriptions:subscribe', backupId, ids),
  setMigrationSubscriptionEnabled: (id, revision, enabled) => ipcRenderer.invoke('migration-subscriptions:enabled', id, revision, enabled),
  checkMigrationSubscriptions: () => ipcRenderer.invoke('migration-subscriptions:check'),
  previewMigrationSubscription: (id, revision) => ipcRenderer.invoke('migration-subscriptions:preview', id, revision),
  applyMigrationSubscription: id => ipcRenderer.invoke('migration-subscriptions:apply', id)
}
