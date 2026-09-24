import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { McpOAuthBinding, McpOAuthConnectOptions } from '../../shared/mcp-oauth-types'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { sessionManager } from '../sessionManager'
import { TaskExecutionAuthorityStore } from '../permission/task-execution-authority-store'
import { authorizeMcpRuntimeBinding } from '../plugin/plugin-runtime-authorization'
import { storeProviderCredential, resolveProviderCredential, forgetProviderCredential } from '../providerCredentialRuntime'
import { McpOAuthService } from '../mcp/mcp-oauth-service'
import { configureMcpOAuthRuntime } from '../mcp/mcp-oauth-runtime'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

function trusted(event: IpcMainInvokeEvent, sessionId?: string): void {
  assertTrustedWorkflowLedgerSender(event)
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || !['main', 'task'].includes(role ?? '') || (role === 'task' && (!sessionId || taskSessionForWindow(window) !== sessionId))) throw new Error('MCP 授权只允许从工作台或原任务窗口操作。')
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || !sessionManager.get(sessionId))) throw new Error('MCP 授权关联任务不存在。')
}
function bindingValue(value: unknown): McpOAuthBinding {
  if (!value || typeof value !== 'object') throw new Error('MCP 插件身份无效。')
  const raw = value as McpOAuthBinding
  if (!['registryItemKey', 'contentDigest', 'capabilityDigest', 'serverId'].every(key => typeof raw[key as keyof McpOAuthBinding] === 'string' && raw[key as keyof McpOAuthBinding].length > 0 && raw[key as keyof McpOAuthBinding].length <= 8192)) throw new Error('MCP 插件身份无效。')
  return { registryItemKey: raw.registryItemKey, contentDigest: raw.contentDigest, capabilityDigest: raw.capabilityDigest, serverId: raw.serverId }
}

export function registerMcpOAuthIpc(): void {
  const service = new McpOAuthService({ root: app.getPath('userData'), authorize: binding => authorizeMcpRuntimeBinding({ binding }),
    credentials: { store: storeProviderCredential, resolve: resolveProviderCredential, forget: forgetProviderCredential }, openExternal: url => shell.openExternal(url) })
  configureMcpOAuthRuntime((binding, config) => service.accessToken(binding, config), (binding, config) => service.reject(binding, config), (binding, config) => service.authorizationContext(binding, config))
  const epochs = new Map<number, number>(), watched = new WeakSet<Electron.WebContents>(), confirmations = new Set<number>()
  function scope(event: IpcMainInvokeEvent, sessionId?: string): () => void {
    trusted(event, sessionId)
    if (!watched.has(event.sender)) {
      watched.add(event.sender)
      const close = (): void => { epochs.set(event.sender.id, (epochs.get(event.sender.id) ?? 0) + 1); service.stopOwner(event.sender.id) }
      event.sender.once('destroyed', close); event.sender.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) close() })
    }
    const epoch = epochs.get(event.sender.id) ?? 0, meta = sessionId && sessionManager.get(sessionId)?.meta
    const authority = meta ? new TaskExecutionAuthorityStore(app.getPath('userData')).get(meta).revision : undefined
    const taskBinding = meta ? JSON.stringify([meta.cwd, meta.projectId, meta.workspaceId, meta.taskStrategy]) : undefined
    return () => {
      trusted(event, sessionId)
      if ((epochs.get(event.sender.id) ?? 0) !== epoch) throw new Error('原授权窗口已重新载入。')
      const latest = sessionId && sessionManager.get(sessionId)?.meta
      if (latest && (new TaskExecutionAuthorityStore(app.getPath('userData')).get(latest).revision !== authority || JSON.stringify([latest.cwd, latest.projectId, latest.workspaceId, latest.taskStrategy]) !== taskBinding)) throw new Error('关联任务或授权已变化，请重新连接。')
    }
  }
  ipcMain.handle('mcp-oauth:get', async (event, raw, sessionId?: string) => { await sessionManager.whenInitialized(); trusted(event, sessionId); return service.get(bindingValue(raw), event.sender.id) })
  ipcMain.handle('mcp-oauth:prepare', async (event, raw, sessionId?: string) => { await sessionManager.whenInitialized(); const current = scope(event, sessionId); return service.prepare(bindingValue(raw), event.sender.id, current) })
  ipcMain.handle('mcp-oauth:connect', async (event, raw, options: McpOAuthConnectOptions, sessionId?: string) => {
    await sessionManager.whenInitialized()
    const current = scope(event, sessionId), binding = bindingValue(raw)
    if (confirmations.has(event.sender.id)) throw new Error('已有授权确认正在显示。')
    const preview = service.preview(binding, options, event.sender.id)
    confirmations.add(event.sender.id)
    try {
      const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, { type: 'question', title: '连接 MCP 服务', message: `授权 ${binding.serverId} 连接外部服务？`,
        detail: [`资源：${preview.resource}`, `授权服务器：${preview.issuer}`, `权限范围：${(options.scopes ?? preview.scopes).join(', ') || '由服务决定'}`, `客户端：${options.clientId?.trim() || '动态注册 EastGenesis public client'}`, `回调：http://127.0.0.1:${options.callbackPort || '临时端口'}/oauth/callback`, '将在系统浏览器中由你确认账号与授权。凭据保存在系统加密存储；系统加密不可用时仅保留本次运行。连接账号不会扩大任务或插件执行权限。'].join('\n'), buttons: ['取消', '打开浏览器授权'], defaultId: 0, cancelId: 0, noLink: true })
      current()
      if (result.response !== 1) return service.get(binding, event.sender.id)
      return await service.connect(binding, options, event.sender.id, current)
    } finally { confirmations.delete(event.sender.id) }
  })
  ipcMain.handle('mcp-oauth:cancel', (event, raw, sessionId?: string) => { trusted(event, sessionId); return service.cancel(bindingValue(raw), event.sender.id) })
  ipcMain.handle('mcp-oauth:disconnect', async (event, raw, remote: boolean, sessionId?: string) => {
    const current = scope(event, sessionId), binding = bindingValue(raw)
    if (remote !== true && remote !== false) throw new Error('撤销选项无效。')
    if (remote) {
      const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, { type: 'question', title: '断开 MCP 授权', message: `断开 ${binding.serverId}，并向服务请求撤销令牌？`, detail: '本机连接会立即断开。服务未提供撤销端点或返回结果未知时，需到服务账号设置中核对。', buttons: ['取消', '断开并请求撤销'], defaultId: 0, cancelId: 0, noLink: true })
      current(); if (result.response !== 1) return service.get(binding, event.sender.id)
    }
    return service.disconnect(binding, remote, current)
  })
  app.once('before-quit', () => { service.dispose(); configureMcpOAuthRuntime(undefined, undefined) })
}
