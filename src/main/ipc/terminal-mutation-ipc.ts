import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { assertTerminalWindowOwner } from '../terminal-workspace-policy'
import type { SessionMeta } from '../../shared/types'
import {
  closeTerminalWithEffect,
  resizeTerminalWithEffect,
  startTerminalWithEffect,
  type TerminalEffectManager,
  writeTerminalWithEffect
} from '../terminalEffect'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'

export interface TerminalMutationIpcDependencies {
  assertExecutionAuthorized(id: string, action: string): void | Promise<void>
  getSessionMeta(id: string): SessionMeta | undefined
  manager: TerminalEffectManager
}

export function registerTerminalMutationIpc(dependencies: TerminalMutationIpcDependencies): void {
  ipcMain.handle(
    'terminals:start',
    async (event, id: string, options?: { cols?: number; rows?: number; reuse?: boolean }) => {
      assertTrustedWorkflowLedgerSender(event)
      const session = dependencies.getSessionMeta(id)
      if (!session) return { ok: false, error: '会话不存在' }
      await dependencies.assertExecutionAuthorized(session.id, '启动终端')
      return startTerminalWithEffect({
        sourceSessionId: session.id,
        projectId: session.projectId,
        cwd: session.cwd,
        executionEnvironment: session.executionEnvironment
      }, dependencies.manager, {
        cols: options?.cols,
        rows: options?.rows,
        reuse: options?.reuse
      }, executeInteractiveOperationEffect)
    }
  )

  ipcMain.handle('terminals:write', async (event, id: string, data: string) => {
    await authorizeExistingTerminalMutation(dependencies, event, id, '向终端写入输入')
    return writeTerminalWithEffect(
      dependencies.manager,
      id,
      typeof data === 'string' ? data : '',
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('terminals:resize', async (event, id: string, cols: number, rows: number) => {
    await authorizeExistingTerminalMutation(dependencies, event, id, '调整终端尺寸')
    return resizeTerminalWithEffect(
      dependencies.manager,
      id,
      cols,
      rows,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('terminals:close', async (event, id: string) => {
    await authorizeExistingTerminalMutation(dependencies, event, id, '关闭终端')
    return closeTerminalWithEffect(dependencies.manager, id, executeInteractiveOperationEffect)
  })
}

async function authorizeExistingTerminalMutation(
  dependencies: TerminalMutationIpcDependencies,
  event: IpcMainInvokeEvent,
  terminalId: string,
  action: string
): Promise<void> {
  assertTrustedWorkflowLedgerSender(event)
  const terminal = dependencies.manager.get(terminalId)
  assertTerminalWindowOwner(terminal, event.sender.id)
  const sourceSessionId = terminal?.sessionId
  if (sourceSessionId) await dependencies.assertExecutionAuthorized(sourceSessionId, action)
}
