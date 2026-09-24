import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { normalizeExternalBrowserInput, type ExternalBrowserConnectInput } from '../../shared/external-browser-types'
import { sessionManager } from '../sessionManager'
import { externalBrowserRegistry } from '../external-browser-registry'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'

function ownerFor(event: IpcMainInvokeEvent): BrowserWindow {
  assertTrustedWorkflowLedgerSender(event)
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || !['main', 'task'].includes(desktopWindowRole(owner) ?? '') || event.senderFrame !== event.sender.mainFrame) throw new Error('外部浏览器只能从当前 EastGenesis 任务或主工作台操作。')
  return owner
}

function result<T>(operation: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return Promise.resolve().then(operation).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
}

export function registerExternalBrowserIpc(): void {
  sessionManager.subscribe(({ sessionId }) => {
    const session = sessionManager.get(sessionId)
    if (!session || session.meta.status === 'closed') externalBrowserRegistry.revokeForSession(sessionId)
  })
  ipcMain.handle('externalBrowser:list', event => {
    const owner = ownerFor(event)
    return externalBrowserRegistry.list(owner)
  })
  ipcMain.handle('externalBrowser:connect', (event, rawInput: unknown) => result(async () => {
    const owner = ownerFor(event)
    const input = normalizeExternalBrowserInput(rawInput) as ExternalBrowserConnectInput
    if (desktopWindowRole(owner) === 'task' && taskSessionForWindow(owner) !== input.sessionId) throw new Error('此窗口不能连接其他任务的浏览器。')
    await sessionManager.whenInitialized()
    if (!sessionManager.get(input.sessionId) || sessionManager.get(input.sessionId)?.meta.status === 'closed') throw new Error('当前任务已关闭或不存在。')
    if (input.transport !== 'cdp') throw new Error('请使用扩展配对入口，生成一次性配对码。')
    const connection = externalBrowserRegistry.create(input, owner)
    return externalBrowserRegistry.connect(connection.id, owner)
  }))
  ipcMain.handle('externalBrowser:reconnect', (event, connectionId: unknown) => result(async () => {
    const owner = ownerFor(event)
    if (typeof connectionId !== 'string' || !connectionId.trim()) throw new Error('连接标识无效。')
    const connection = externalBrowserRegistry.get(connectionId, owner)
    if (connection.transport === 'extension') throw new Error('扩展断开后需要重新生成配对码并明确授权标签。')
    if (!sessionManager.get(connection.sessionId) || sessionManager.get(connection.sessionId)?.meta.status === 'closed') throw new Error('当前任务已关闭或不存在。')
    return externalBrowserRegistry.connect(connectionId, owner)
  }))
  ipcMain.handle('externalBrowser:tabs', (event, connectionId: unknown) => result(async () => {
    const owner = ownerFor(event)
    if (typeof connectionId !== 'string' || !connectionId.trim()) throw new Error('连接标识无效。')
    return externalBrowserRegistry.listTabs(connectionId, owner)
  }))
  ipcMain.handle('externalBrowser:selectTab', (event, connectionId: unknown, tabId: unknown) => result(async () => {
    const owner = ownerFor(event)
    if (typeof connectionId !== 'string' || !connectionId.trim() || typeof tabId !== 'string' || !tabId.trim()) throw new Error('标签页选择参数无效。')
    return externalBrowserRegistry.selectTabLive(connectionId, owner, tabId)
  }))
  ipcMain.handle('externalBrowser:revoke', (event, connectionId: unknown) => result(() => {
    const owner = ownerFor(event)
    if (typeof connectionId !== 'string' || !connectionId.trim()) throw new Error('连接标识无效。')
    externalBrowserRegistry.get(connectionId, owner)
    return { revoked: externalBrowserRegistry.revoke(connectionId) as true }
  }))
}
