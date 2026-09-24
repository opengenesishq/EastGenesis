import { app, ipcMain } from 'electron'
import { scanMigration } from '../migration'
import { applyMigration } from '../migration-apply'
import { executeMigrationApplyEffect } from '../migrationEffect'
import { MigrationSubscriptions } from '../migration-subscriptions'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import type { StoredMigrationScan } from '../migration-scan-store'
import type { MigrationApplyResult } from '../../shared/migration-types'

let service: MigrationSubscriptions | undefined
export function rememberMigrationImport(stored: StoredMigrationScan | undefined, result: MigrationApplyResult): string[] { return service?.remember(stored, result) ?? [] }
export function registerMigrationSubscriptionIpc(backupRoot: () => string): void {
  service = new MigrationSubscriptions({ root: app.getPath('userData'), scan: cwd => scanMigration(cwd, undefined, app.getPath('userData')),
    apply: (input, assertCurrent) => executeMigrationApplyEffect(input, { rootDir: app.getPath('userData'), backupRoot: backupRoot() }, undefined,
      (next, options) => { assertCurrent(); return applyMigration(next, options) }) })
  service.start(); app.once('before-quit', () => service?.stop())
  ipcMain.handle('migration-subscriptions:list', event => { assertTrustedWorkflowLedgerSender(event); return service!.list() })
  ipcMain.handle('migration-subscriptions:subscribe', (event, backupId: string, assetIds: string[]) => { assertTrustedWorkflowLedgerSender(event); return service!.subscribe(backupId, assetIds) })
  ipcMain.handle('migration-subscriptions:enabled', (event, id: string, revision: number, enabled: boolean) => { assertTrustedWorkflowLedgerSender(event); return service!.setEnabled(id, revision, enabled) })
  ipcMain.handle('migration-subscriptions:check', event => { assertTrustedWorkflowLedgerSender(event); return service!.check() })
  ipcMain.handle('migration-subscriptions:preview', (event, id: string, revision: number) => { assertTrustedWorkflowLedgerSender(event); return service!.preview(id, revision) })
  ipcMain.handle('migration-subscriptions:apply', (event, id: string) => { assertTrustedWorkflowLedgerSender(event); return service!.apply(id) })
}
