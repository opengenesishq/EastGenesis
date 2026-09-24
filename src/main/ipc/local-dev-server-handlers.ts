import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import type { LocalDevServerStart } from '../../shared/local-dev-server-types'
import { sessionManager } from '../sessionManager'
import { readCurrentPermissionSettings, subscribeSettingsChanges } from '../settings'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { formalFileWriteGuard } from '../permission/limited-file-execution'
import { evaluateToolPermission } from '../permission/tool-permission'
import { TaskExecutionAuthorityStore } from '../permission/task-execution-authority-store'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { devServerOperationId, LocalDevServerService } from '../sites/local-dev-server-service'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function trusted(event: IpcMainInvokeEvent, sessionId: unknown): asserts sessionId is string {
  assertTrustedWorkflowLedgerSender(event)
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || sessionId.includes('\0')) throw new Error('任务身份无效。')
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || (role !== 'main' && role !== 'task')) throw new Error('开发服务只能从工作台或原任务窗口操作。')
  if (role === 'task' && taskSessionForWindow(window) !== sessionId) throw new Error('开发服务不属于此任务窗口。')
}

export function registerLocalDevServerIpc(): void {
  const contexts = new Map<string, { event: IpcMainInvokeEvent; requestId: string; cancelled: boolean }>()
  const service = new LocalDevServerService({
    root: () => app.getPath('userData'), session: id => sessionManager.get(id)?.meta,
    authorize: async (meta, config, assertOwner) => {
      const root = app.getPath('userData'), input = { command: config.command }
      const revision = new TaskExecutionAuthorityStore(root).get(meta).revision
      const initialTaskRun = sessionManager.getTaskRun(meta.id)
      const guard = formalFileWriteGuard('bash', input, config.cwd, { rootDir: root, sessionMeta: meta, sessionId: meta.id, taskExecutionAuthorityRevision: revision })
      const check = async (): Promise<void> => {
        assertOwner(); guard()
        await sessionManager.assertInteractiveExecutionAuthorized(meta.id, '运行任务开发服务')
        assertOwner(); guard()
        const currentTaskRun = sessionManager.getTaskRun(meta.id)
        if (currentTaskRun?.status === 'cancelled' && (currentTaskRun.id !== initialTaskRun?.id || initialTaskRun?.status !== 'cancelled')) throw new Error('原任务运行已取消。')
      }
      await check()
      const decision = evaluateToolPermission(readCurrentPermissionSettings(root), { toolName: 'bash', input, cwd: config.cwd })
      if (decision.kind === 'deny') throw new Error(decision.reason)
      if (decision.kind !== 'allow' && meta.permissionMode !== 'bypassPermissions') {
        const event = contexts.get(meta.id)?.event
        if (!event) throw new Error('启动窗口已不可用。')
        trusted(event, meta.id)
        const window = BrowserWindow.fromWebContents(event.sender)!
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '启动开发服务', message: '执行当前任务的开发服务命令',
          detail: `任务：${meta.title}\n工作目录：${config.cwd}\n完整命令：${config.command}\n预览地址：${config.url}\n服务会持续运行，直到你停止服务、关闭原窗口或撤销任务授权。命令自身决定监听范围，请使用项目的本机监听选项。`,
          buttons: ['取消', '启动此命令'], defaultId: 0, cancelId: 0, noLink: true })
        if (answer.response !== 1) throw new Error('用户取消了开发服务启动。')
      }
      await check()
      return check
    },
    perform: async (action, meta, run, execute) => {
      const toolName = action === 'start' ? 'terminal_start' : 'terminal_close'
      const outcome = await executeInteractiveOperationEffect({ rootDir: app.getPath('userData'), operationId: devServerOperationId(meta.id, run.id, action), kind: 'terminal_action',
        title: action === 'start' ? '启动开发服务' : '停止开发服务', sourceSessionId: meta.id,
        projectId: meta.projectId, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId,
        cwd: run.config.cwd, toolName,
        toolInput: { sourceKind: 'local_dev_server', requestId: run.id, commandDigest: digest(run.config.command), cwdDigest: digest(run.config.cwd), urlDigest: digest(run.config.url) },
        execute: async effect => {
          if (effect.target.kind !== 'unsupported' || effect.target.toolName !== toolName) throw new Error('开发服务操作与执行回执不匹配。')
          await execute(); return { applied: true, requestId: run.id }
        }, isSuccess: result => result.applied, resultSummary: result => JSON.stringify(result) })
      if (outcome.status !== 'completed' || !outcome.value?.applied) throw new Error(outcome.status === 'waiting_reconciliation' ? `服务操作回执待核对（${outcome.operationId}）。` : outcome.status === 'failed' ? outcome.error : '服务操作回执缺失。')
      return outcome.operationId
    }
  })
  const watched = new WeakSet<Electron.WebContents>()
  function observe(event: IpcMainInvokeEvent): void {
    if (watched.has(event.sender)) return
    watched.add(event.sender)
    const stop = (): void => {
      for (const context of contexts.values()) if (context.event.sender.id === event.sender.id) context.cancelled = true
      service.stopOwner(event.sender.id)
    }
    event.sender.once('destroyed', stop)
    event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) stop() })
  }
  ipcMain.handle('local-dev-server:get', async (event, id: unknown) => { trusted(event, id); await sessionManager.whenInitialized(); trusted(event, id); return service.get(id) })
  ipcMain.handle('local-dev-server:start', async (event, input: LocalDevServerStart) => {
    trusted(event, input?.sessionId); observe(event)
    if (contexts.has(input.sessionId)) throw new Error('原任务已有开发服务启动请求。')
    const context = { event, requestId: input.requestId, cancelled: false }
    contexts.set(input.sessionId, context)
    const assertCurrent = (): void => { trusted(event, input.sessionId); if (context.cancelled) throw new Error('开发服务启动已取消。') }
    try { await sessionManager.whenInitialized(); assertCurrent(); return await service.start(event.sender.id, input, assertCurrent) }
    finally { contexts.delete(input.sessionId) }
  })
  ipcMain.handle('local-dev-server:stop', (event, id: unknown, requestId: unknown) => {
    trusted(event, id)
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new Error('服务运行身份无效。')
    const context = contexts.get(id)
    if (context?.requestId === requestId) context.cancelled = true
    return service.stop(id, requestId)
  })
  const timer = setInterval(() => { void service.refresh() }, 1500); timer.unref()
  const unsubscribe = sessionManager.subscribe(({ sessionId }) => { void service.refresh(sessionId) })
  const unsubscribeSettings = subscribeSettingsChanges(() => { void service.refresh() })
  app.once('before-quit', () => { clearInterval(timer); unsubscribe(); unsubscribeSettings(); service.dispose() })
}
