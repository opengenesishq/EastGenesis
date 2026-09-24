import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { sessionManager } from '../sessionManager'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { localSiteCatalogService, localSitePreviewService } from '../sites/local-site-runtime'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'

const localPreviews = localSitePreviewService()
const localPreviewOwners = new WeakSet<Electron.WebContents>()
function observeLocalPreviewOwner(event: IpcMainInvokeEvent): void {
  if (localPreviewOwners.has(event.sender)) return
  localPreviewOwners.add(event.sender)
  const owner = event.sender.id
  const cleanup = (): void => { void localPreviews.stopOwner(owner).catch(() => undefined) }
  event.sender.once('destroyed', cleanup)
  event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cleanup() })
}
function trusted(event: IpcMainInvokeEvent, sessionId: unknown): asserts sessionId is string {
  assertTrustedWorkflowLedgerSender(event)
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || sessionId.includes('\0')) throw new Error('任务身份无效')
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || !['main', 'task'].includes(role ?? '')) throw new Error('网站操作只能从工作台或原任务窗口发起。')
  if (role === 'task' && taskSessionForWindow(window) !== sessionId) throw new Error('网站操作不属于当前任务窗口。')
}
export function registerLocalSitePreviewIpc(): void {
  ipcMain.handle('sites:local-preview-start', async (event, id: unknown, path: string, expectedTaskKey?: string) => {
    trusted(event, id); observeLocalPreviewOwner(event)
    const site = await localSiteCatalogService().register({ sessionId: id, path })
    if (expectedTaskKey !== undefined && site.taskKey !== expectedTaskKey) throw new Error('原文件所属任务或目录已变化，请重新打开。')
    trusted(event, id)
    return localPreviews.start(event.sender.id, id, path, site.taskKey)
  })
  ipcMain.handle('sites:local-preview-get', (event, id: unknown) => { trusted(event, id); return localPreviews.get(event.sender.id, id) })
  ipcMain.handle('sites:local-preview-stop', (event, id: unknown, previewId?: string) => { trusted(event, id); return localPreviews.stop(event.sender.id, id, previewId) })
  const unsubscribeLocalPreviews = sessionManager.subscribe(({ sessionId }) => { void localPreviews.refreshSession(sessionId).catch(() => undefined) })
  app.once('before-quit', () => { unsubscribeLocalPreviews(); void localPreviews.dispose().catch(() => undefined) })
}
