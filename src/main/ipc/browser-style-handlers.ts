import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SessionMeta } from '../../shared/types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import type { BrowserStyleChanges, BrowserStyleReference } from '../../shared/browser-style-types'
import { browserViewManager } from '../browserView'
import { browserStyleController } from '../browser-style/controller'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerBrowserStyleIpc(deps: { getSessionMeta(id: string): SessionMeta | undefined; manager: typeof browserViewManager }): void {
  function owner(event: IpcMainInvokeEvent, target: BrowserTabTarget): BrowserWindow {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
    if (!win || win.isDestroyed() || !['main', 'task'].includes(role ?? '') || !target || typeof target.contextId !== 'string') throw new Error('请从当前任务浏览器使用样式调整。')
    const meta = deps.getSessionMeta(target.contextId)
    if (!meta || meta.status === 'closed' || target.contextId.startsWith('workspace-browser:') || role === 'task' && taskSessionForWindow(win) !== target.contextId) throw new Error('样式预览不属于当前任务。')
    deps.manager.assertWindowOwner(target.contextId, win)
    return win
  }
  ipcMain.handle('browser-style:pick', (event, input: { target: BrowserTabTarget; previewId: string }) => {
    const target = input?.target
    const win = owner(event, target), record = deps.manager.assertTarget(target, true, true)
    if (record.view.webContents.isLoadingMainFrame()) throw new Error('请等待页面加载后选择元素。')
    return browserStyleController.pick({ target, ownerId: event.sender.id, contents: record.view.webContents,
      assertCurrent: () => { owner(event, target); deps.manager.assertTarget(target, true, true) },
      notice: message => { if (!win.isDestroyed()) win.webContents.send('browser:event', { kind: 'error', sessionId: target.contextId, message }) } }, input.previewId)
  })
  ipcMain.handle('browser-style:preview', (event, input: BrowserStyleReference & { changes: BrowserStyleChanges }) => { owner(event, input?.target); return browserStyleController.preview(event.sender.id, input) })
  ipcMain.handle('browser-style:revert', (event, input: BrowserStyleReference) => { owner(event, input?.target); return browserStyleController.revert(event.sender.id, input) })
  ipcMain.handle('browser-style:draft', (event, input: BrowserStyleReference) => { owner(event, input?.target); return browserStyleController.draft(event.sender.id, input) })
  ipcMain.handle('browser-style:release', (event, input: { previewId: string; target: BrowserTabTarget }) => { owner(event, input?.target); return browserStyleController.release(event.sender.id, input) })
}
