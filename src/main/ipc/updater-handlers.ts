import { BrowserWindow, ipcMain } from 'electron'
import type { UpdaterEvent } from '../../shared/updater-types'
import {
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  subscribeUpdater
} from '../updater'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

let registered = false

/** Bridge updater lifecycle events to every first-party desktop window. */
export function registerUpdaterIpc(): void {
  if (registered) return
  registered = true

  subscribeUpdater((event: UpdaterEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('updater:event', event)
    }
  })

  ipcMain.handle('updater:check', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return checkForUpdates()
  })
  ipcMain.handle('updater:download', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return downloadUpdate()
  })
  ipcMain.on('updater:quit-and-install', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    quitAndInstall()
  })
}
