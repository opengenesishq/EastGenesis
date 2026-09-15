import { app, ipcMain } from 'electron'
import type { PreparationPermissionMutation } from '../../shared/preparation-permission-types'
import { sessionManager } from '../sessionManager'
import { PreparationPermissionStore } from '../permission/preparation-permission-store'
import { writeSessionAuditLog } from '../permission/audit-log'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { sessionReadyHandler } from './session-ready-handler'

export function registerPreparationPermissionIpc(): void {
  const store = new PreparationPermissionStore(app.getPath('userData'))
  const currentMeta = (id: string) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('会话身份无效。')
    const meta = sessionManager.get(id)?.meta
    if (!meta) throw new Error('会话不存在，请先打开原始任务。')
    return meta
  }
  ipcMain.handle('preparationPermission:get', sessionReadyHandler((event, id: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return store.get(currentMeta(id))
  }))
  for (const operation of ['grant', 'revoke'] as const) {
    ipcMain.handle(`preparationPermission:${operation}`, sessionReadyHandler((event, id: string, input: PreparationPermissionMutation) => {
      assertTrustedWorkflowLedgerSender(event)
      const meta = currentMeta(id)
      const result = store[operation](meta, input, `local-user:webcontents-${event.sender.id}`)
      writeSessionAuditLog({ ...meta, taskStrategy: 'plan' }, {
        action: operation === 'grant' ? 'allow' : 'deny', source: 'user', toolName: 'preparation_permission',
        input: { operation, revision: result.revision, directory: result.directory },
        message: operation === 'grant' ? '用户授权独立准备区 write_file。' : '用户撤销独立准备区写入授权。'
      })
      return result
    }))
  }
}
