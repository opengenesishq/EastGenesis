import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { ComputerHistoryStore } from '../computer-history/store'
import { ComputerHistoryService } from '../computer-history/service'
import { MacosComputerHistoryCollector } from '../computer-history/collector'
import { desktopWindowRole } from '../desktop-window-registry'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

let registeredService: ComputerHistoryService | undefined
/** Reads only the existing shared store; never starts a capture or creates a second owner. */
export function existingComputerHistory(): ComputerHistoryService {
  if (!registeredService) throw new Error('电脑历史服务不可用，请检查存储后重试。')
  return registeredService
}

/** Local main-window UI only. Browser pages, tools and companion windows receive no history authority. */
export function registerComputerHistoryIpc(): void {
  let service: ComputerHistoryService | undefined
  try {
    service = new ComputerHistoryService({ store: new ComputerHistoryStore(join(app.getPath('userData'), 'computer-history')),
      collector: new MacosComputerHistoryCollector(), platform: process.platform, temporary: Boolean(process.env.CAOGEN_TEMPORARY_PROFILE_ID) })
    service.start()
    registeredService = service
  } catch { /* Register a recoverable UI error; a damaged optional store must not break app startup. */ }
  const observed = new WeakSet<Electron.WebContents>()
  function access(event: IpcMainInvokeEvent): ComputerHistoryService {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || desktopWindowRole(win) !== 'main') throw new Error('请在 EastGenesis 主窗口管理电脑历史。')
    if (!service) throw new Error('电脑历史存储无法读取，采集已停止。请检查本地文件权限后重启。')
    if (!observed.has(event.sender)) {
      observed.add(event.sender)
      const id = event.sender.id
      event.sender.once('destroyed', () => service?.clearOwner(id))
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) service?.clearOwner(id) })
    }
    return service
  }
  ipcMain.handle('computerHistory:state', event => access(event).state())
  ipcMain.handle('computerHistory:sources', event => access(event).sources(event.sender.id))
  ipcMain.handle('computerHistory:update', (event, input: unknown) => access(event).update(event.sender.id, input))
  ipcMain.handle('computerHistory:query', (event, input: unknown) => access(event).query(input))
  ipcMain.handle('computerHistory:previewDelete', (event, input: unknown) => access(event).previewDelete(event.sender.id, input))
  ipcMain.handle('computerHistory:delete', (event, token: unknown, reviewed: unknown) => access(event).delete(event.sender.id, token, reviewed))
  app.once('before-quit', () => service?.stop())
}
