import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { LocalSiteRegistration } from '../../shared/local-site-catalog-types'
import { sessionManager } from '../sessionManager'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { localSiteCatalogService, localSitePreviewService } from '../sites/local-site-runtime'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

function trusted(event: IpcMainInvokeEvent, sessionId?: string): void {
  assertTrustedWorkflowLedgerSender(event)
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || (role !== 'main' && role !== 'task')) throw new Error('站点只能从工作台或原任务窗口打开。')
  if (role === 'task' && (!sessionId || taskSessionForWindow(window) !== sessionId)) throw new Error('站点总览只能在主工作台打开。')
}
export function registerLocalSiteCatalogIpc(): void {
  const watched = new WeakSet<Electron.WebContents>()
  function observe(event: IpcMainInvokeEvent): void {
    if (watched.has(event.sender)) return
    watched.add(event.sender)
    const owner = event.sender.id, stop = (): void => { void localSitePreviewService().stopOwner(owner).catch(() => undefined) }
    event.sender.once('destroyed', stop)
    event.sender.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) stop() })
  }
  ipcMain.handle('local-sites:list', async event => {
    trusted(event); await sessionManager.whenInitialized()
    const result = await localSiteCatalogService().list(); trusted(event); return result
  })
  ipcMain.handle('local-sites:register', async (event, input: LocalSiteRegistration) => {
    trusted(event, input?.sessionId); await sessionManager.whenInitialized()
    const result = await localSiteCatalogService().register(input); trusted(event, input.sessionId); return result
  })
  ipcMain.handle('local-sites:resolve', async (event, siteId: string, revision: string) => {
    trusted(event); await sessionManager.whenInitialized()
    const result = await localSiteCatalogService().resolve(siteId, revision); trusted(event); return result
  })
  ipcMain.handle('local-sites:preview', async (event, siteId: string, revision: string) => {
    trusted(event); observe(event); await sessionManager.whenInitialized()
    const site = await localSiteCatalogService().resolve(siteId, revision); trusted(event)
    const owner = event.sender.id, previews = localSitePreviewService()
    const result = await previews.start(owner, site.sessionId, site.path, site.taskKey)
    try { trusted(event) } catch (error) { await previews.stop(owner, site.sessionId, result.id); throw error }
    return result
  })
}
