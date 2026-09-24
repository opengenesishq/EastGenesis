import { BrowserWindow, ipcMain } from 'electron'
import { assertTrustedWorkflowLedgerSender } from './ipc/workflow-ledger-handlers'

/** Recording a shortcut must not fire a menu command. */
export function registerDesktopShortcutCapture(): void {
  const recording = new Set<number>()
  const watched = new Set<number>()
  const stop = (window: BrowserWindow): void => {
    if (!recording.delete(window.webContents.id)) return
    if (!window.isDestroyed()) window.webContents.setIgnoreMenuShortcuts(false)
  }
  ipcMain.handle('desktop-shortcuts:capture', (event, active: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    if (typeof active !== 'boolean') throw new Error('快捷键录制状态无效。')
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('快捷键录制窗口不可用。')
    if (!active) { stop(window); return }
    recording.add(event.sender.id)
    event.sender.setIgnoreMenuShortcuts(true)
    if (!watched.has(event.sender.id)) {
      watched.add(event.sender.id)
      window.on('blur', () => stop(window))
      event.sender.once('destroyed', () => {
        watched.delete(event.sender.id)
        recording.delete(event.sender.id)
      })
    }
  })
}
