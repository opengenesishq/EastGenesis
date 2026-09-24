import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { HostedSiteChange, HostedSiteRange } from '../../shared/hosted-site-types'
import { sessionManager } from '../sessionManager'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { formalFileWriteGuard } from '../permission/limited-file-execution'
import { TaskExecutionAuthorityStore } from '../permission/task-execution-authority-store'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { getTaskSnapshot } from '../task/task-snapshot'
import { HostedSiteService } from '../sites/hosted-site-service'
import { hostedDigest } from '../sites/hosted-site-protocol'
import { SiteDeploymentService } from '../sites/site-deployment-service'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { resolveTaskSnapshotEffect } from './effect-resolution'

function trusted(event: IpcMainInvokeEvent, id: unknown): asserts id is string {
  assertTrustedWorkflowLedgerSender(event)
  if (typeof id !== 'string' || !id || id.length > 256 || id.includes('\0')) throw new Error('原任务身份无效。')
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || (role !== 'main' && role !== 'task') || (role === 'task' && taskSessionForWindow(window) !== id)) throw new Error('站点管理必须来自工作台或原任务窗口。')
}
export function registerHostedSiteIpc(): void {
  const deployments = new SiteDeploymentService({ root: () => app.getPath('userData'), session: id => sessionManager.get(id)?.meta, authorize: (id, action) => sessionManager.assertInteractiveExecutionAuthorized(id, action) })
  const service = new HostedSiteService({ root: () => app.getPath('userData'), session: id => sessionManager.get(id)?.meta, deployments: id => deployments.list(id),
    authorityRevision: meta => new TaskExecutionAuthorityStore(app.getPath('userData')).get(meta).revision,
    authorize: async (meta, command, revision) => {
      const guard = formalFileWriteGuard('bash', { command }, meta.cwd, { rootDir: app.getPath('userData'), sessionId: meta.id, sessionMeta: meta, taskExecutionAuthorityRevision: revision })
      guard(); await sessionManager.assertInteractiveExecutionAuthorized(meta.id, '调用已配置的托管站点适配器'); guard()
    },
    effect: async (operationId, meta, request, execute, success) => executeInteractiveOperationEffect({ rootDir: app.getPath('userData'), operationId, kind: 'terminal_action',
      title: `托管站点 ${request.operation} · ${request.siteId}`, sourceSessionId: meta.id, projectId: meta.projectId, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId,
      cwd: meta.cwd, toolName: 'terminal_start', toolInput: { sourceKind: 'hosted_site_management', operation: request.operation, siteIdDigest: hostedDigest(request.siteId), requestDigest: hostedDigest(request) },
      execute: async effect => { if (effect.target.kind !== 'unsupported' || effect.target.toolName !== 'terminal_start') throw new Error('站点适配器 Effect 不匹配。'); return execute() },
      isSuccess: success, resultSummary: output => JSON.stringify({ exitCode: output.exitCode, signal: output.signal, outputTruncated: output.outputTruncated, outputDigest: hostedDigest(output.stdout) }) })
  })
  const epochs = new Map<number, number>(), watched = new WeakSet<Electron.WebContents>()
  function scope(event: IpcMainInvokeEvent, id: string): () => void {
    trusted(event, id)
    if (!watched.has(event.sender)) {
      watched.add(event.sender)
      const close = (): void => { epochs.set(event.sender.id, (epochs.get(event.sender.id) ?? 0) + 1); service.stopOwner(event.sender.id) }
      event.sender.once('destroyed', close); event.sender.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) close() })
    }
    const epoch = epochs.get(event.sender.id) ?? 0
    return () => { trusted(event, id); if ((epochs.get(event.sender.id) ?? 0) !== epoch) throw new Error('原站点管理窗口已重新载入。') }
  }
  ipcMain.handle('hosted-sites:get', async (event, id: string, target: string) => { trusted(event, id); await sessionManager.whenInitialized(); trusted(event, id); return service.get(id, target) })
  ipcMain.handle('hosted-sites:refresh', async (event, id: string, target: string, revision: number) => { const current = scope(event, id); await sessionManager.whenInitialized(); current(); return service.refresh(id, target, revision, event.sender.id, current) })
  ipcMain.handle('hosted-sites:analytics', (event, id: string, target: string, range: HostedSiteRange) => service.analytics(id, target, range, event.sender.id, scope(event, id)))
  ipcMain.handle('hosted-sites:prepare', (event, id: string, target: string, change: HostedSiteChange) => service.prepare(id, target, change, event.sender.id, scope(event, id)))
  ipcMain.handle('hosted-sites:prepare-environment', (event, id: string, target: string, input: unknown) => service.prepareEnvironment(id, target, input, event.sender.id, scope(event, id)))
  ipcMain.handle('hosted-sites:discard-preview', (event, id: string, previewId: string) => { trusted(event, id); return service.discardPreview(id, previewId, event.sender.id) })
  ipcMain.handle('hosted-sites:cancel', (event, id: string, operation: string) => { trusted(event, id); return service.cancel(id, operation) })
  const confirmations = new Set<string>()
  ipcMain.handle('hosted-sites:execute', async (event, id: string, previewId: string) => {
    const current = scope(event, id), key = `${id}:${previewId}`
    if (confirmations.has(key)) throw new Error('此站点操作正在等待确认。')
    confirmations.add(key)
    try {
      const preview = await service.preview(id, previewId), deleting = preview.change.kind === 'site.delete'; current()
      const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, { type: deleting ? 'warning' : 'question', title: deleting ? '删除线上站点' : '确认线上站点变更',
        message: deleting ? `删除线上站点 ${preview.before.name}？` : `修改线上站点 ${preview.before.name}？`,
        detail: [`账户：${preview.before.accountName} · ${preview.before.accountScope}`, `站点：${preview.before.siteId}`, `部署：${preview.before.deploymentId ?? '未知'}`,
          `当前版本：${preview.expectedRevision}`, `变更：${JSON.stringify(preview.change)}`, `影响：${preview.impact.join('\n')}`,
          `域名：${preview.before.domains.map(domain => domain.hostname).join(', ') || '无'} → ${preview.after.domains.map(domain => domain.hostname).join(', ') || '无'}`,
          `访问：${preview.before.access.mode} → ${preview.after.access.mode}`, `程序及参数：${JSON.stringify(preview.command)}`, `允许环境变量：${preview.environmentKeys.join(', ') || '无'}`, `原操作：${preview.operationId}`].join('\n'),
        buttons: ['取消', deleting ? '删除此线上站点' : '执行此变更'], defaultId: 0, cancelId: 0, noLink: true,
        ...(deleting ? { checkboxLabel: `我已核对站点 ${preview.before.siteId} 和删除影响`, checkboxChecked: false } : {}) })
      if (result.response !== 1 || (deleting && !result.checkboxChecked)) return null
      current(); return service.execute(id, previewId, event.sender.id, current)
    } finally { confirmations.delete(key) }
  })
  ipcMain.handle('hosted-sites:inspect', async (event, id: string, receiptId: string) => {
    const current = scope(event, id), receipt = await service.inspect(id, receiptId, event.sender.id, current)
    const saved = await service.inspection(id, receiptId)
    if (!saved.inspection || !receipt.recoverySnapshotId) return receipt
    current()
    const snapshot = await getTaskSnapshot(receipt.recoverySnapshotId), effect = snapshot?.run?.effects?.find(item => !receipt.effectId || item.id === receipt.effectId)
    if (!snapshot || !effect) return receipt
    if (effect.status === 'confirmed' && saved.inspection.result === 'applied') return service.acceptInspection(id, receiptId)
    if (effect.status === 'abandoned' && saved.inspection.result === 'not_applied' && effect.evidence.some(item => item.resolutionReceipt?.resolution === 'confirmed_not_applied')) return service.acceptInspection(id, receiptId)
    if (effect.status !== 'waiting_reconciliation') return receipt
    const resolved = await resolveTaskSnapshotEffect(event.sender, snapshot.id, effect.id, effect.revision,
      saved.inspection.result === 'applied' ? 'confirmed_applied' : 'confirmed_not_applied', {
        listTaskSnapshots: () => sessionManager.listTaskSnapshots(), getTaskSnapshot: value => getTaskSnapshot(value), resolveTaskEffect: (...args) => sessionManager.resolveTaskEffect(...args),
        updateWorktreeState: () => undefined, describeTarget: () => `${receipt.accountScope} / ${receipt.siteId}`, describeIntent: () => `${JSON.stringify(receipt.change)} · ${receipt.operationId}`
      }, `适配器核对原 operationId 与 planDigest，结果 ${saved.inspection.result}。`)
    current()
    const reconciled = resolved.snapshot.run?.effects?.find(item => item.id === effect.id)
    if (reconciled?.status === 'confirmed' || (saved.inspection.result === 'not_applied' && reconciled?.status === 'abandoned' && reconciled.evidence.some(item => item.resolutionReceipt?.resolution === 'confirmed_not_applied'))) return service.acceptInspection(id, receiptId)
    return receipt
  })
  app.once('before-quit', () => service.dispose())
}
