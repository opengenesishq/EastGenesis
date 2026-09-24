import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import type { BrowserHistoryQuery, BrowserPreferences } from '../../shared/browser-preferences-types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import { browserViewManager } from '../browserView'
import { browserManagement } from '../browser-management/service'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { workspaceBrowserRegistry } from '../workspace-browser-context'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerBrowserManagementIpc(deps: { getSessionMeta(id: string): SessionMeta | undefined; manager: typeof browserViewManager }): void {
  const service = browserManagement()
  const clearTokens = new Map<string, { ownerId: number; ids: string[]; expires: number; contextId?: string }>()
  function sender(event: IpcMainInvokeEvent, mainOnly = false): BrowserWindow {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
    if (!win || win.isDestroyed() || role !== 'main' && (mainOnly || role !== 'task')) throw new Error('请从主工作台设置访问浏览器管理。')
    return win
  }
  function scope(event: IpcMainInvokeEvent, requested?: string): string | undefined {
    const win = sender(event)
    if (requested !== undefined && (typeof requested !== 'string' || requested.length > 200 || !requested)) throw new Error('浏览器范围无效。')
    if (desktopWindowRole(win) === 'task') {
      const task = taskSessionForWindow(win)
      if (!task || requested && task !== requested || !deps.getSessionMeta(task) || deps.getSessionMeta(task)?.status === 'closed') throw new Error('此窗口不能访问其他任务的浏览记录。')
      return task
    }
    if (requested?.startsWith('workspace-browser:')) workspaceBrowserRegistry.get(requested, event.sender.id)
    return requested
  }
  function current(event: IpcMainInvokeEvent, target: BrowserTabTarget): string {
    const win = sender(event)
    if (!target || typeof target.contextId !== 'string') throw new Error('浏览器页面身份无效。')
    scope(event, target.contextId)
    deps.manager.assertWindowOwner(target.contextId, win); deps.manager.assertTarget(target, true, true)
    return deps.manager.getState(target.contextId)!.url
  }
  service.store.subscribe(event => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      const role = desktopWindowRole(win)
      if (role === 'main' || role === 'task' && (!event.contextId || taskSessionForWindow(win) === event.contextId)) win.webContents.send('browser-management:event', event)
    }
  })
  ipcMain.handle('browser-management:preferences', event => { sender(event); return service.store.getPreferences() })
  ipcMain.handle('browser-management:save', (event, input: { expectedRevision: number; preferences: BrowserPreferences }) => {
    sender(event, true)
    if (!input || !Number.isSafeInteger(input.expectedRevision)) throw new Error('浏览器设置版本无效。')
    return service.save(input.expectedRevision, input.preferences)
  })
  ipcMain.handle('browser-management:directory', async event => {
    const owner = sender(event, true)
    const result = await dialog.showOpenDialog(owner, { title: '选择浏览器下载目录', properties: ['openDirectory', 'createDirectory'], defaultPath: service.store.getPreferences().preferences.downloadDirectory })
    sender(event, true)
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('browser-management:history', (event, raw?: BrowserHistoryQuery) => {
    if (raw && (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['query', 'before', 'limit', 'contextId'].includes(key)) ||
      raw.query !== undefined && (typeof raw.query !== 'string' || raw.query.length > 500) || raw.before !== undefined && !Number.isFinite(raw.before) ||
      raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 200))) throw new Error('历史查询参数无效。')
    const contextId = scope(event, raw?.contextId), result = service.store.listHistory({ ...raw, contextId })
    for (const [token, value] of clearTokens) if (value.expires < Date.now() || value.ownerId === event.sender.id) clearTokens.delete(token)
    const clearToken = randomUUID(); clearTokens.set(clearToken, { ownerId: event.sender.id, ids: result.items.map(item => item.id), expires: Date.now() + 5 * 60_000, contextId })
    return { ...result, clearToken }
  })
  ipcMain.handle('browser-management:clear-history', (event, input: { clearToken: string }) => {
    const win = sender(event), value = input && clearTokens.get(input.clearToken)
    if (!value || value.ownerId !== win.webContents.id || value.expires < Date.now()) throw new Error('历史列表已变化或过期，请重新载入后清除。')
    scope(event, value.contextId); clearTokens.delete(input.clearToken)
    return { removed: service.store.clearHistory(value.ids) }
  })
  ipcMain.handle('browser-management:downloads', (event, input?: { contextId?: string }) => service.store.listDownloads(scope(event, input?.contextId)))
  ipcMain.handle('browser-management:download-control', (event, input: { id: string; action: 'cancel' | 'reveal' | 'remove-record' }) => {
    const allowedContext = scope(event)
    if (!input || typeof input.id !== 'string' || !['cancel', 'reveal', 'remove-record'].includes(input.action)) throw new Error('下载操作无效。')
    const record = service.store.listDownloads(allowedContext).find(item => item.id === input.id)
    if (!record) throw new Error('此窗口不能访问该下载。')
    service.downloads.control(input.id, input.action)
  })
  ipcMain.handle('browser-management:site', (event, target: BrowserTabTarget) => service.siteState(target, current(event, target)))
  ipcMain.handle('browser-management:site-rule', (event, input: { target: BrowserTabTarget; expectedRevision: number; rule: 'allow' | 'block' | 'inherit' }) => {
    if (!input || !['allow', 'block', 'inherit'].includes(input.rule)) throw new Error('站点规则无效。')
    const state = service.siteState(input.target, current(event, input.target)), snapshot = service.store.getPreferences()
    if (!state.origin) throw new Error('仅 http(s) 网页可以设置站点规则。')
    if (input.expectedRevision !== snapshot.revision) throw new Error('站点规则已变化，请重新打开站点菜单。')
    const previous = snapshot.preferences.siteRules.find(rule => rule.origin === state.origin)
    const siteRules = snapshot.preferences.siteRules.filter(rule => rule.origin !== state.origin)
    if (input.rule !== 'inherit') siteRules.push({ origin: state.origin, access: input.rule, downloads: previous?.downloads ?? 'inherit' })
    return service.save(input.expectedRevision, { ...snapshot.preferences, siteRules })
  })
}
