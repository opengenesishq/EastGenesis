import { ipcRenderer } from 'electron'
import type { MigrationApi } from '../shared/types'

export const migrationApi: MigrationApi = {
  scanMigration: (cwd?: string) => ipcRenderer.invoke('migration:scan', cwd),
  applyMigration: (input) => ipcRenderer.invoke('migration:apply', input),
  listMigrationHistory: () => ipcRenderer.invoke('migration:history'),
  previewMigrationRollback: backupId => ipcRenderer.invoke('migration:rollback-preview', backupId),
  rollbackMigration: (backupId: string, reviewDigest?: string) => ipcRenderer.invoke('migration:rollback', backupId, reviewDigest)
}
