import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ChatShareAdapterInput, ChatShareOperationInput, PrepareChatSnapshotInput } from '../../shared/chat-snapshot-share-types'
import { sessionManager } from '../sessionManager'
import { SiteDeploymentService } from '../sites/site-deployment-service'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { writeDurableFile } from '../durable-file'
import { readCurrentPermissionSettings } from '../settings'
import { evaluateToolPermission } from '../permission/tool-permission'
import { formalFileWriteGuard } from '../permission/limited-file-execution'
import { TaskExecutionAuthorityStore } from '../permission/task-execution-authority-store'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { getTaskSnapshot } from '../task/task-snapshot'
import { ChatSnapshotShareService, type ChatShareScope } from '../sharing/chat-snapshot-share-service'
import { chatShareDigest } from '../sharing/chat-snapshot-projection'
import type { ChatSnapshotOwner } from '../sharing/chat-snapshot-store'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { resolveTaskSnapshotEffect } from './effect-resolution'

export function registerChatSnapshotShareIpc(): void {
  const root = app.getPath('userData'), authorityStore = new TaskExecutionAuthorityStore(root)
  const deployments = new SiteDeploymentService({ root: () => root, session: id => sessionManager.get(id)?.meta, authorize: (id, action) => sessionManager.assertInteractiveExecutionAuthorized(id, action) })
  const authority = (source: ChatSnapshotOwner, mode: 'publish' | 'manage'): string => {
    const meta = mode === 'publish' ? sessionManager.get(source.id)?.meta : undefined
    if (mode === 'publish' && !meta) throw new Error('原任务不存在，不能发布新的聊天内容。')
    return chatShareDigest({ global: readCurrentPermissionSettings(root), task: meta ? authorityStore.get(meta) : 'explicit-share-management' })
  }
  const service: ChatSnapshotShareService = new ChatSnapshotShareService({ root, home: app.getPath('home'), session: id => sessionManager.get(id)?.meta,
    transcript: id => sessionManager.getTranscript(id), targets: async id => (await deployments.list(id)).targets, authority,
    authorize: async (source, mode, command, expected) => {
      if (authority(source, mode) !== expected) throw new Error('分享操作授权已变化。')
      const meta = mode === 'publish' ? sessionManager.get(source.id)?.meta : undefined
      const cwd = meta?.cwd ?? service.store.adapterCwd
      const decision = evaluateToolPermission(readCurrentPermissionSettings(root), { toolName: 'bash', input: { command }, cwd })
      if (decision.kind === 'deny') throw new Error(decision.reason)
      const guard = formalFileWriteGuard('bash', { command }, cwd, { rootDir: root,
        ...(meta ? { sessionId: meta.id, sessionMeta: meta, taskExecutionAuthorityRevision: authorityStore.get(meta).revision } : {}) })
      guard()
      if (meta) await sessionManager.assertInteractiveExecutionAuthorized(meta.id, '发布所选聊天静态快照')
      guard()
      if (authority(source, mode) !== expected) throw new Error('分享操作授权已变化。')
    },
    effect: (source, request, execute, success) => executeInteractiveOperationEffect({ rootDir: root, operationId: request.operationId,
      kind: 'terminal_action', title: `聊天快照 ${request.operation}`, sourceSessionId: source.id, cwd: service.store.adapterCwd,
      toolName: 'terminal_start', toolInput: { sourceKind: 'chat_snapshot_share', operation: request.operation,
        requestDigest: chatShareDigest(request), shareId: request.shareId, manifestDigest: request.manifestDigest },
      execute: async effect => { if (effect.target.kind !== 'unsupported' || effect.target.toolName !== 'terminal_start') throw new Error('分享操作 Effect 不匹配。'); return execute() },
      isSuccess: success, resultSummary: output => JSON.stringify({ exitCode: output.exitCode, signal: output.signal, outputTruncated: output.outputTruncated, stdoutDigest: chatShareDigest(output.stdout) }) })
  })
  const epochs = new Map<number,number>(), watched = new WeakSet<Electron.WebContents>(), pending = new Set<string>()
  const scopeFor = (event: IpcMainInvokeEvent): ChatShareScope => {
    const read = (): string | undefined => {
      assertTrustedWorkflowLedgerSender(event)
      const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
      if (!win || win.isDestroyed() || role !== 'main' && role !== 'task') throw new Error('聊天快照仅能从主工作台或原任务窗口操作。')
      const id = role === 'task' ? taskSessionForWindow(win) : undefined
      if (role === 'task' && !id) throw new Error('任务窗口身份不可用。')
      return id
    }
    const sessionId = read(), owner = event.sender.id
    if (!watched.has(event.sender)) {
      watched.add(event.sender)
      const close = (): void => { epochs.set(owner, (epochs.get(owner) ?? 0)+1); service.releaseOwner(owner) }
      event.sender.once('destroyed', close); event.sender.on('did-start-navigation', (_event,_url,_inPlace,main) => { if (main) close() })
    }
    const epoch = epochs.get(owner) ?? 0
    return { owner, sessionId, assertCurrent: () => { if (read() !== sessionId || (epochs.get(owner) ?? 0) !== epoch) throw new Error('原分享窗口已变化，请重新打开。') } }
  }
  const confirm = async (event: IpcMainInvokeEvent, scope: ChatShareScope, key: string, message: string, detail: string): Promise<boolean> => {
    if (pending.has(key)) throw new Error('此分享操作正在等待确认。')
    pending.add(key)
    try {
      scope.assertCurrent()
      const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, { type: 'question', title: '聊天快照分享', message, detail,
        buttons: ['取消','执行此操作'], defaultId: 0, cancelId: 0, noLink: true })
      scope.assertCurrent(); return answer.response === 1
    } finally { pending.delete(key) }
  }
  ipcMain.handle('chat-share:capture', async (event, id: string) => { const scope = scopeFor(event); await sessionManager.whenInitialized(); scope.assertCurrent(); return service.capture(id, scope) })
  ipcMain.handle('chat-share:prepare-snapshot', (event, id: string, input: PrepareChatSnapshotInput) => service.prepareSnapshot(id, input, scopeFor(event)))
  ipcMain.handle('chat-share:read', (event, id: string) => service.readSnapshot(id, scopeFor(event)))
  ipcMain.handle('chat-share:list', (event, id?: string) => service.list(scopeFor(event), id))
  ipcMain.handle('chat-share:save-adapter', (event, id: string, input: ChatShareAdapterInput) => service.saveAdapter(id, input, scopeFor(event)))
  ipcMain.handle('chat-share:export', async (event, id: string) => {
    const scope = scopeFor(event), content = service.readSnapshot(id, scope)
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '保存只读聊天快照', defaultPath: `caogen-chat-${id}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] })
    if (result.canceled || !result.filePath) return { canceled: true }
    scope.assertCurrent()
    const current = service.readSnapshot(id, scope)
    if (current.snapshot.digest !== content.snapshot.digest) throw new Error('快照已变化，请重新预览。')
    await writeDurableFile(result.filePath, content.html)
    return { canceled: false, filePath: result.filePath }
  })
  ipcMain.handle('chat-share:prepare-operation', async (event, input: ChatShareOperationInput) => {
    const scope = scopeFor(event), target = service.operationTarget(input, scope)
    if (!await confirm(event, scope, `prepare:${input.snapshotId}`, '读取已配置分享适配器的账号与能力？',
      `快照：${target.snapshot.view.title}\n程序：${target.adapter.view.executable}\n参数：${JSON.stringify(target.adapter.view.args)}\n环境变量：${target.adapter.view.environmentKeys.join(', ') || '无额外变量'}\n将执行用户配置的程序读取当前账号和分享能力；此步骤不提供聊天正文。`)) return null
    return service.prepareOperation(input, scope)
  })
  ipcMain.handle('chat-share:execute', async (event, id: string) => {
    const scope = scopeFor(event), preview = service.preview(id, scope)
    if (!await confirm(event, scope, `execute:${id}`, preview.action === 'publish' ? '发布这份已核对的聊天快照？' : '撤销这份公开聊天快照？',
      `快照：${preview.snapshot.title}\n正文：${preview.snapshot.messageCount} 条，${preview.snapshot.bytes} 字节\n内容摘要：${preview.snapshot.digest}\n账号：${preview.account.accountName} · ${preview.account.accountScope}\n目标：${preview.account.adapterNamespace} / ${preview.account.targetId}\n分享：${preview.shareId}\n原版本：${preview.expectedRevision ?? '新分享'}\n程序：${JSON.stringify(preview.command)}\n环境变量：${preview.adapter.environmentKeys.join(', ') || '无额外变量'}\n${preview.action === 'publish' ? '发布后所选正文可通过公开 URL 读取。' : '仅撤销此分享资源；已经下载的副本无法收回。'}`)) return null
    return service.execute(id, scope)
  })
  ipcMain.handle('chat-share:inspect', async (event, id: string) => {
    const scope = scopeFor(event), original = service.receipt(id, scope)
    if (!await confirm(event, scope, `inspect:${id}`, '核对原聊天分享操作？', `原操作：${original.view.operationId}\n分享：${original.view.shareId}\n账号：${original.view.account.accountScope}\n目标：${original.view.account.targetId}\n程序：${JSON.stringify(original.preview.view.command)}\n只核对原操作，不重新发布或撤销。`)) return null
    const receipt = await service.inspect(id, scope), saved = service.receipt(id, scope)
    if (!saved.inspection) return receipt
    if (!receipt.recoverySnapshotId) throw new Error('缺少原 Effect 恢复记录，核对结果已保留。')
    const snapshot = await getTaskSnapshot(receipt.recoverySnapshotId), effect = snapshot?.run?.effects?.find(item => !receipt.effectId || item.id === receipt.effectId)
    if (!snapshot || !effect) throw new Error('原操作恢复账本不可用，核对结果已保留。')
    const applied = saved.inspection.result === 'applied'
    if (applied && effect.status === 'confirmed' || !applied && effect.status === 'abandoned' && effect.evidence.some(item => item.resolutionReceipt?.resolution === 'confirmed_not_applied')) return service.acceptInspection(id, scope)
    if (effect.status !== 'waiting_reconciliation') throw new Error('原 Effect 尚未进入可核对状态，核对结果已保留。')
    const resolved = await resolveTaskSnapshotEffect(event.sender, snapshot.id, effect.id, effect.revision, applied ? 'confirmed_applied' : 'confirmed_not_applied', {
      listTaskSnapshots: () => sessionManager.listTaskSnapshots(), getTaskSnapshot: value => getTaskSnapshot(value), resolveTaskEffect: (...args) => sessionManager.resolveTaskEffect(...args),
      updateWorktreeState: () => undefined, describeTarget: () => `${receipt.account.accountScope} / ${receipt.shareId}`, describeIntent: () => `${receipt.action} · ${receipt.manifestDigest}`
    }, `分享适配器核对原 operationId/shareId/manifestDigest，结果 ${saved.inspection.result}。`)
    scope.assertCurrent()
    const reconciled = resolved.snapshot.run?.effects?.find(item => item.id === effect.id)
    if (applied && reconciled?.status === 'confirmed' || !applied && reconciled?.status === 'abandoned' && reconciled.evidence.some(item => item.resolutionReceipt?.resolution === 'confirmed_not_applied')) return service.acceptInspection(id, scope)
    return receipt
  })
  ipcMain.handle('chat-share:cancel', (event, id: string) => service.cancel(id, scopeFor(event)))
  app.once('before-quit', () => service.dispose())
}
