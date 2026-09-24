import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { workspaceBrowserRegistry } from '../workspace-browser-context'
import type { SessionMeta } from '../../shared/types'
import {
  browserGoBackWithEffect,
  browserGoForwardWithEffect,
  navigateBrowserWithEffect,
  openBrowserWithEffect,
  reloadBrowserWithEffect,
  type BrowserEffectContext,
  type BrowserEffectManager
} from '../browserEffect'
import type { BrowserBounds } from '../../shared/types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'

export interface BrowserMutationIpcDependencies {
  getSessionMeta(id: string): SessionMeta | undefined
  manager: BrowserEffectManager & {
    setBounds(sessionId: string, bounds: BrowserBounds, owner?: BrowserWindow): void
    close(sessionId: string, owner?: BrowserWindow): void
  }
}

export function registerBrowserMutationIpc(dependencies: BrowserMutationIpcDependencies): void {
  const observed = new WeakSet<Electron.WebContents>()
  ipcMain.handle('browser:open-workspace', (event, rawUrl?: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    if (rawUrl !== undefined && typeof rawUrl !== 'string') throw new Error('浏览器地址无效。')
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return { ok: false, error: '浏览器宿主窗口不存在。' }
    const ownerId = event.sender.id
    const context = workspaceBrowserRegistry.acquire(ownerId, app.getPath('userData'))
    if (!observed.has(event.sender)) {
      observed.add(event.sender)
      const dispose = (): void => {
        const id = workspaceBrowserRegistry.release(ownerId)
        if (id) { try { dependencies.manager.close(id) } catch { /* Owner may already be destroyed. */ } }
      }
      event.sender.once('destroyed', dispose)
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) dispose() })
    }
    return openBrowserWithEffect(workspaceOperationContext(dependencies, event, context.id, context.cwd),
      dependencies.manager, owner, rawUrl, executeInteractiveOperationEffect)
  })
  ipcMain.handle('browser:open', (event, id: string, url?: string) => {
    const context = operationContext(dependencies, event, id)
    if (!context) return { ok: false, error: '会话不存在' }
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return { ok: false, error: '浏览器宿主窗口不存在' }
    return openBrowserWithEffect(
      context,
      dependencies.manager,
      owner,
      typeof url === 'string' ? url : undefined,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:navigate', (event, id: string, url: string, target?: BrowserTabTarget) => {
    const context = operationContext(dependencies, event, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return navigateBrowserWithEffect(
      context,
      target && dependencies.manager.bind ? (context.assertActive?.(), dependencies.manager.bind(id, target)) : dependencies.manager,
      typeof url === 'string' ? url : '',
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:back', (event, id: string, target?: BrowserTabTarget) => {
    const context = operationContext(dependencies, event, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return browserGoBackWithEffect(
      context,
      target && dependencies.manager.bind ? (context.assertActive?.(), dependencies.manager.bind(id, target)) : dependencies.manager,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:forward', (event, id: string, target?: BrowserTabTarget) => {
    const context = operationContext(dependencies, event, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return browserGoForwardWithEffect(
      context,
      target && dependencies.manager.bind ? (context.assertActive?.(), dependencies.manager.bind(id, target)) : dependencies.manager,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:reload', (event, id: string, target?: BrowserTabTarget) => {
    const context = operationContext(dependencies, event, id)
    if (!context) return { ok: false, error: '会话不存在' }
    return reloadBrowserWithEffect(
      context,
      target && dependencies.manager.bind ? (context.assertActive?.(), dependencies.manager.bind(id, target)) : dependencies.manager,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('browser:bounds', (event, id: string, bounds: BrowserBounds) => {
    assertTrustedWorkflowLedgerSender(event)
    workspaceBrowserRegistry.get(id, event.sender.id)
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner) {
      dependencies.manager.assertWindowOwner(id, owner)
      dependencies.manager.setBounds(id, bounds, owner)
    }
  })

  ipcMain.handle('browser:close', (event, id: string) => {
    assertTrustedWorkflowLedgerSender(event)
    workspaceBrowserRegistry.get(id, event.sender.id)
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner) {
      dependencies.manager.assertWindowOwner(id, owner)
      dependencies.manager.close(id, owner)
    }
  })
}

export function assertRendererBrowserOwner(manager: BrowserEffectManager, event: IpcMainInvokeEvent, id: string): void {
  assertTrustedWorkflowLedgerSender(event)
  workspaceBrowserRegistry.get(id, event.sender.id)
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || event.sender.isDestroyed()) throw new Error('浏览器宿主窗口已关闭。')
  manager.assertWindowOwner(id, owner)
}

function operationContext(
  dependencies: BrowserMutationIpcDependencies,
  event: IpcMainInvokeEvent,
  id: string
): BrowserEffectContext | undefined {
  assertTrustedWorkflowLedgerSender(event)
  const standalone = workspaceBrowserRegistry.get(id, event.sender.id)
  if (standalone) return workspaceOperationContext(dependencies, event, standalone.id, standalone.cwd)
  const session = dependencies.getSessionMeta(id)
  if (!session) return undefined
  return {
    assertActive: browserWindowGuard(dependencies, event, id),
    sourceSessionId: session.id,
    projectId: session.projectId,
    cwd: session.cwd
  }
}

function workspaceOperationContext(dependencies: BrowserMutationIpcDependencies, event: IpcMainInvokeEvent, id: string, cwd: string): BrowserEffectContext {
  const sender = event.sender
  const ownerId = sender.id
  const assertWindow = browserWindowGuard(dependencies, event, id)
  return {
    sourceSessionId: id, cwd, sourceKind: 'workspace_human',
    assertActive: () => {
      assertWindow()
      workspaceBrowserRegistry.get(id, ownerId)
    }
  }
}

function browserWindowGuard(dependencies: BrowserMutationIpcDependencies, event: IpcMainInvokeEvent, id: string): () => void {
  const sender = event.sender
  const owner = BrowserWindow.fromWebContents(sender)
  return () => {
    if (!owner || owner.isDestroyed() || sender.isDestroyed()) throw new Error('浏览器宿主窗口已关闭。')
    dependencies.manager.assertWindowOwner(id, owner)
  }
}
