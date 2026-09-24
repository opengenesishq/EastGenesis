import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { desktopWindowRole } from '../desktop-window-registry'
import { caogenManagedPluginsRoot } from '../plugin/caogen-extension-roots'
import { PluginCatalogService } from '../plugin/catalog-service'

export function registerPluginCatalogIpc(): void {
  // A damaged catalog cache must affect this panel, not desktop startup.
  let instance: PluginCatalogService | undefined
  const service = (): PluginCatalogService => instance ??= new PluginCatalogService(app.getPath('userData'), caogenManagedPluginsRoot())
  const guard = (event: IpcMainInvokeEvent): void => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || desktopWindowRole(win) !== 'main') throw new Error('请在主工作台管理插件目录与安装。')
  }
  ipcMain.handle('plugin-catalog:list', event => { guard(event); return service().get() })
  ipcMain.handle('plugin-catalog:add-source', (event, input) => { guard(event); return service().add(input) })
  ipcMain.handle('plugin-catalog:enable-source', (event, id, enabled) => { guard(event); return service().enabled(id, enabled) })
  ipcMain.handle('plugin-catalog:remove-source', (event, id) => { guard(event); return service().remove(id) })
  ipcMain.handle('plugin-catalog:refresh', (event, id) => { guard(event); return service().refresh(id) })
  ipcMain.handle('plugin-catalog:prepare', (event, input) => { guard(event); return service().prepare(input) })
  ipcMain.handle('plugin-catalog:cancel', (event, id) => { guard(event); return service().cancel(id) })
  ipcMain.handle('plugin-catalog:install', (event, input) => { guard(event); return service().install(input) })
  ipcMain.handle('plugin-catalog:reconcile', (event, id) => { guard(event); return service().reconcile(id) })
}
