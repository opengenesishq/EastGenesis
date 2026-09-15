import { ipcMain } from 'electron'
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
    async (_event, id: string, options?: { cols?: number; rows?: number; reuse?: boolean }) => {
      const session = dependencies.getSessionMeta(id)
      if (!session) return { ok: false, error: '会话不存在' }
      await dependencies.assertExecutionAuthorized(session.id, '启动终端')
      return startTerminalWithEffect({
        sourceSessionId: session.id,
        projectId: session.projectId,
        cwd: session.cwd
      }, dependencies.manager, {
        cols: options?.cols,
        rows: options?.rows,
        reuse: options?.reuse
      }, executeInteractiveOperationEffect)
    }
  )

  ipcMain.handle('terminals:write', async (_event, id: string, data: string) => {
    await authorizeExistingTerminalMutation(dependencies, id, '向终端写入输入')
    return writeTerminalWithEffect(
      dependencies.manager,
      id,
      typeof data === 'string' ? data : '',
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('terminals:resize', async (_event, id: string, cols: number, rows: number) => {
    await authorizeExistingTerminalMutation(dependencies, id, '调整终端尺寸')
    return resizeTerminalWithEffect(
      dependencies.manager,
      id,
      cols,
      rows,
      executeInteractiveOperationEffect
    )
  })

  ipcMain.handle('terminals:close', async (_event, id: string) => {
    await authorizeExistingTerminalMutation(dependencies, id, '关闭终端')
    return closeTerminalWithEffect(dependencies.manager, id, executeInteractiveOperationEffect)
  })
}

async function authorizeExistingTerminalMutation(
  dependencies: TerminalMutationIpcDependencies,
  terminalId: string,
  action: string
): Promise<void> {
  const sourceSessionId = dependencies.manager.get(terminalId)?.sessionId
  if (sourceSessionId) await dependencies.assertExecutionAuthorized(sourceSessionId, action)
}
