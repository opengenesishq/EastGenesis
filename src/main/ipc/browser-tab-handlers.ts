import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import { browserViewManager } from '../browserView'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { workspaceBrowserRegistry } from '../workspace-browser-context'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { DEFAULT_BROWSER_URL, normalizeBrowserNavigationUrl } from '../browserNavigation'

export function registerBrowserTabIpc(deps: { getSessionMeta(id: string): SessionMeta | undefined; manager: typeof browserViewManager }): void {
  const { manager } = deps
  manager.setTaskIdentityResolver(id => {
    const meta = deps.getSessionMeta(id)
    return meta && meta.status !== 'closed' ? JSON.stringify([meta.id, meta.createdAt, meta.cwd, meta.sourceCwd, meta.workspaceId, meta.projectId, meta.goalId, meta.workItemId]) : undefined
  })
  function owner(event: IpcMainInvokeEvent, id: string): BrowserWindow {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
    if (!win || win.isDestroyed() || !['main', 'task'].includes(role ?? '')) throw new Error('浏览器只能从工作台或任务窗口访问。')
    if (role === 'task' && taskSessionForWindow(win) !== id) throw new Error('此窗口不能访问其他任务的浏览器。')
    const workspace = workspaceBrowserRegistry.get(id, event.sender.id)
    if (!workspace && (!deps.getSessionMeta(id) || deps.getSessionMeta(id)?.status === 'closed')) throw new Error('浏览器任务已关闭。')
    manager.assertWindowOwner(id, win)
    return win
  }
  manager.subscribeTabs((snapshot, win) => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('browser-tabs:event', snapshot) })
  ipcMain.handle('browser-tabs:list', (event, id: string) => { owner(event, id); return manager.getTabs(id) })
  ipcMain.handle('browser-tabs:select', (event, target: BrowserTabTarget) => { owner(event, target?.contextId); return manager.selectTab(target) })
  ipcMain.handle('browser-tabs:close', (event, target: BrowserTabTarget) => { owner(event, target?.contextId); return manager.closeTab(target) })
  ipcMain.handle('browser-tabs:visible', (event, id: string, visible: boolean) => {
    const win = owner(event, id)
    if (typeof visible !== 'boolean') throw new Error('浏览器显示参数无效。')
    manager.setVisible(id, visible, win)
  })
  ipcMain.handle('browser-tabs:create', async (event, id: string, raw?: { url?: string; activate?: boolean; contextEpoch?: string }) => {
    const win = owner(event, id), previous = manager.getTabs(id)
    if (raw && (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['url', 'activate', 'contextEpoch'].includes(key)) ||
      (raw.url !== undefined && typeof raw.url !== 'string') || (raw.activate !== undefined && typeof raw.activate !== 'boolean') ||
      (raw.contextEpoch !== undefined && raw.contextEpoch !== previous.contextEpoch))) throw new Error('浏览器新标签参数无效。')
    const url = normalizeBrowserNavigationUrl(raw?.url ?? DEFAULT_BROWSER_URL), epoch = previous.contextEpoch
    const assertCurrent = () => {
      if (owner(event, id) !== win || manager.getTabs(id).contextEpoch !== epoch) throw new Error('浏览器工作区已变化。')
    }
    if (url === DEFAULT_BROWSER_URL) {
      assertCurrent()
      const state = await manager.createTab(id, { ...raw, url, contextEpoch: epoch })
      assertCurrent(); return { ok: true, state }
    }
    const meta = deps.getSessionMeta(id), workspace = workspaceBrowserRegistry.get(id, event.sender.id)
    const outcome = await executeInteractiveOperationEffect({ kind: 'browser_navigation', title: '浏览器新标签导航', sourceSessionId: id,
      cwd: workspace?.cwd ?? meta?.cwd ?? app.getPath('userData'), projectId: meta?.projectId, toolName: 'browser_view_open',
      toolInput: { action: 'new_tab', sourceKind: workspace ? 'workspace_human' : 'task', contextEpoch: epoch,
        targetDigest: createHash('sha256').update(url).digest('hex') },
      execute: async () => { assertCurrent(); const state = await manager.createTab(id, { ...raw, url, contextEpoch: epoch }); assertCurrent(); return state },
      isSuccess: state => state.contextId === id && state.contextEpoch === epoch,
      resultSummary: state => JSON.stringify({ contextEpoch: state.contextEpoch, tabCount: state.tabs.length, activeTabId: state.activeTabId }) })
    if (outcome.status === 'completed' && outcome.value) return { ok: true, state: outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
    return { ok: false, error: outcome.status === 'failed' ? outcome.error : '新标签导航结果待核对，请查看原操作记录。', effectStatus: outcome.effectStatus, operationId: outcome.operationId }
  })
}
