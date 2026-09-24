import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SessionMeta } from '../../shared/types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import { browserViewManager } from '../browserView'
import { browserDebugController } from '../browser-debug/controller'
import { browserDebugBinding, browserDebugEnabled, configureBrowserDebugRuntime } from '../browser-debug/runtime'
import { externalBrowserRegistry } from '../external-browser-registry'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerBrowserDebugIpc(deps: { getSessionMeta(id: string): SessionMeta | undefined; manager: typeof browserViewManager }): void {
  configureBrowserDebugRuntime(deps.getSessionMeta)
  function owner(event: IpcMainInvokeEvent, id: string): BrowserWindow {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
    const meta = typeof id === 'string' && deps.getSessionMeta(id)
    if (!win || win.isDestroyed() || !['main', 'task'].includes(role ?? '') || !meta || meta.status === 'closed' || id.startsWith('workspace-browser:') ||
      role === 'task' && taskSessionForWindow(win) !== id) throw new Error('调试面板不属于当前任务窗口。')
    deps.manager.assertWindowOwner(id, win)
    return win
  }
  ipcMain.handle('browser-debug:status', (event, target: BrowserTabTarget) => {
    owner(event, target?.contextId)
    if (externalBrowserRegistry.taskStatus(target.contextId)) return { enabled: browserDebugEnabled(), supported: false, reason: '高级调试当前仅支持内置浏览器，外部 CDP 和扩展暂不支持。' }
    deps.manager.assertTarget(target, true, true)
    return { enabled: browserDebugEnabled(), supported: true, grant: browserDebugController.status(target.contextId) }
  })
  ipcMain.handle('browser-debug:grant', (event, target: BrowserTabTarget) => {
    owner(event, target?.contextId)
    return browserDebugController.grant(browserDebugBinding(target, event.sender.id))
  })
  ipcMain.handle('browser-debug:revoke', (event, input: { sessionId: string; grantId: string }) => {
    owner(event, input?.sessionId)
    if (typeof input?.grantId !== 'string') throw new Error('调试授权标识无效。')
    const existing = browserDebugController.status(input.sessionId)
    if (existing?.id === input.grantId) browserDebugController.assertGrant(input.sessionId, event.sender.id, input.grantId)
    browserDebugController.revokeSession(input.sessionId, input.grantId)
  })
  ipcMain.handle('browser-debug:snapshot', (event, input: { target: BrowserTabTarget; grantId: string }) => {
    owner(event, input?.target?.contextId)
    deps.manager.assertTarget(input.target, true, true)
    browserDebugController.assertGrant(input.target.contextId, event.sender.id, input.grantId)
    return browserDebugController.snapshot(input.target.contextId, input.grantId)
  })
}
