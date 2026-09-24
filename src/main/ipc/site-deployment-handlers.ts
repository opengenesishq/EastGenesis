import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SiteDeploymentTarget } from '../../shared/site-deployment-types'
import { sessionManager } from '../sessionManager'
import { getTaskSnapshot } from '../task/task-snapshot'
import { resolveTaskSnapshotEffect } from './effect-resolution'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { SiteDeploymentService } from '../sites/site-deployment-service'
import { localSiteCatalogService, localSitePreviewService } from '../sites/local-site-runtime'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'

const service = new SiteDeploymentService({ root: () => app.getPath('userData'), session: id => sessionManager.get(id)?.meta,
  authorize: (id, action) => sessionManager.assertInteractiveExecutionAuthorized(id, action) })
const confirmations = new Set<string>()
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
async function confirm(event: IpcMainInvokeEvent, title: string, detail: string): Promise<boolean> {
  const options = { type: 'warning' as const, title, message: title, detail, buttons: ['取消', '执行此操作'], defaultId: 0, cancelId: 0, noLink: true }
  const window = BrowserWindow.fromWebContents(event.sender)
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response === 1
}
export function registerSiteDeploymentIpc(): void {
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
  ipcMain.handle('sites:list', (event, id: unknown) => { trusted(event, id); return service.list(id) })
  ipcMain.handle('sites:save', (event, id: unknown, input: SiteDeploymentTarget) => { trusted(event, id); return service.saveTarget(id, input) })
  ipcMain.handle('sites:remove', (event, id: unknown, target: string, revision: number) => { trusted(event, id); return service.removeTarget(id, target, revision) })
  ipcMain.handle('sites:prepare', (event, id: unknown, target: string, rollback?: string) => { trusted(event, id); return service.prepare(id, target, rollback) })
  ipcMain.handle('sites:stop-preview', (event, id: unknown, preview: string) => { trusted(event, id); return service.stopPreview(id, preview) })
  ipcMain.handle('sites:cancel', (event, id: unknown, receipt: string) => { trusted(event, id); return service.cancel(id, receipt) })
  ipcMain.handle('sites:execute', async (event, id: unknown, previewId: string) => {
    trusted(event, id)
    const key = `${id}:${previewId}`
    if (confirmations.has(key)) throw new Error('此部署操作正在等待确认')
    confirmations.add(key)
    try {
      const preview = await service.preview(id, previewId)
      const detail = [
        `任务：${sessionManager.get(id)?.meta.title ?? id}`, `目标：${preview.target.name} · 版本 ${preview.target.revision}`,
        `操作：${preview.action === 'deploy' ? '发布网站' : '回滚原部署'}${preview.rollbackOf ? ` · 原回执 ${preview.rollbackOf}` : ''}`,
        `文件：${preview.files.length} 个 · ${preview.bytes} 字节`, `内容摘要：${preview.manifestDigest}`,
        `程序及参数：${JSON.stringify(preview.command)}`, `环境变量：${preview.environmentKeys.join(', ') || '无额外变量；可使用程序已登录的账户'}`,
        `费用：${preview.target.estimatedCostUsd === undefined ? '未知，以部署服务账单为准' : `用户估算 $${preview.target.estimatedCostUsd}，不是硬性费用上限`}`,
        '执行用户配置的程序，可能将文件发布到外部服务；该程序可访问本机已有登录凭据。实际状态以程序回执为准。'
      ].join('\n')
      if (!await confirm(event, preview.action === 'deploy' ? '确认发布网站' : '确认回滚网站', detail)) return null
      trusted(event, id)
      return service.execute(id, previewId)
    } finally { confirmations.delete(key) }
  })
  ipcMain.handle('sites:inspect', async (event, id: unknown, receiptId: string) => {
    trusted(event, id)
    const state = await service.list(id), receipt = state.receipts.find(row => row.id === receiptId)
    if (!receipt) throw new Error('部署记录不存在')
    if (receipt.status === 'confirmed') return receipt
    const preview = await service.preview(id, receipt.snapshotId)
    if (!await confirm(event, '核对原网站部署', `目标：${receipt.targetName}\n原操作：${receipt.operationId}\n程序：${preview.target.executable}\n参数：${JSON.stringify(preview.target.inspectArgs)}\n环境变量：${preview.target.environmentKeys.join(', ') || '无额外变量'}\n只执行已配置的核对命令。不会重新发布或回滚。`)) return null
    const checked = await service.inspect(id, receiptId)
    if (checked.verification !== 'adapter_receipt' || !checked.recoverySnapshotId || !checked.effectId) return checked
    const snapshot = await getTaskSnapshot(checked.recoverySnapshotId), effect = snapshot?.run?.effects?.find(row => row.id === checked.effectId)
    if (!snapshot || !effect) return checked
    if (effect.status === 'confirmed') return service.acceptInspection(id, receiptId)
    if (effect.status !== 'waiting_reconciliation') return checked
    const result = await resolveTaskSnapshotEffect(event.sender, snapshot.id, effect.id, effect.revision, 'confirmed_applied', {
      listTaskSnapshots: () => sessionManager.listTaskSnapshots(), getTaskSnapshot: id => getTaskSnapshot(id),
      resolveTaskEffect: (...args) => sessionManager.resolveTaskEffect(...args), updateWorktreeState: () => undefined,
      describeTarget: () => receipt.targetName,
      describeIntent: () => `网站操作 ${receipt.operationId} · 发布摘要 ${receipt.manifestDigest}`
    }, `核对命令返回原部署 ${checked.deploymentId} · ${checked.url}`)
    return result.snapshot.run?.effects?.find(row => row.id === effect.id)?.status === 'confirmed' ? service.acceptInspection(id, receiptId) : checked
  })
  app.once('before-quit', () => { service.dispose(); unsubscribeLocalPreviews(); void localPreviews.dispose().catch(() => undefined) })
}
