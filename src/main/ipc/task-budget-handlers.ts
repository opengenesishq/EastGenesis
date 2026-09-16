import { app, ipcMain } from 'electron'
import { readTaskBudget } from '../budget/task-budget-projection'
import { listHistory } from '../history'
import { sessionManager } from '../sessionManager'
import { sessionReadyHandler } from './session-ready-handler'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerTaskBudgetIpc(): void {
  ipcMain.handle('taskBudget:get', sessionReadyHandler((event, id: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f]/.test(id)) throw new Error('任务身份无效。')
    const sessions = sessionManager.list(), meta = sessions.find(session => session.id === id)
    if (!meta) throw new Error('请先打开原始任务。')
    return readTaskBudget(meta, [...listHistory(), ...sessions], app.getPath('userData'))
  }))
}
