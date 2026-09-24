import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { SessionMeta } from '../../shared/types'
import { normalizeExternalBrowserInput } from '../../shared/external-browser-types'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { externalBrowserRegistry } from '../external-browser-registry'
import { browserExtensionBridge } from '../browser-extension/bridge'

export function registerBrowserExtensionIpc(deps: { getSessionMeta(id: string): SessionMeta | undefined }): void {
  const owner = (event: IpcMainInvokeEvent): BrowserWindow => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || !['main', 'task'].includes(desktopWindowRole(win) ?? '') || event.senderFrame !== event.sender.mainFrame) throw new Error('请从任务或主工作台管理浏览器扩展。')
    return win
  }
  app.once('before-quit', () => browserExtensionBridge.close())
  ipcMain.handle('browser-extension:directory', async event => {
    owner(event)
    const path = app.isPackaged ? join(process.resourcesPath, 'browser-extension') : join(app.getAppPath(), 'resources', 'browser-extension')
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as { version?: string }
    const failure = await shell.openPath(path); if (failure) throw new Error(failure)
    return { path, version: manifest.version ?? '1' }
  })
  ipcMain.handle('browser-extension:pair', async (event, raw: unknown) => {
    let id: string | undefined
    try {
      const win = owner(event)
      if (!raw || typeof raw !== 'object') throw new Error('扩展配对参数无效。')
      const input = normalizeExternalBrowserInput({ ...raw, transport: 'extension' })
      const meta = deps.getSessionMeta(input.sessionId)
      if (!meta || meta.status === 'closed' || desktopWindowRole(win) === 'task' && taskSessionForWindow(win) !== input.sessionId) throw new Error('扩展配对不属于当前任务。')
      const connection = externalBrowserRegistry.create(input, win); id = connection.id
      const code = await browserExtensionBridge.create(id, input.extensionId!, meta.title ?? input.sessionId)
      if (win.isDestroyed() || deps.getSessionMeta(input.sessionId)?.status === 'closed' || !deps.getSessionMeta(input.sessionId)) throw new Error('配对任务已关闭。')
      externalBrowserRegistry.get(id, win)
      void externalBrowserRegistry.connect(id, win).catch(() => undefined)
      return { ok: true, value: { connection, ...code } }
    } catch (cause) { if (id) { externalBrowserRegistry.revoke(id); browserExtensionBridge.revoke(id) } return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
  })
}
