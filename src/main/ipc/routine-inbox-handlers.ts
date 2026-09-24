import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { RoutineInboxMarkInput, RoutineInboxQuery } from '../../shared/routine-inbox-types'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { sessionManager } from '../sessionManager'
import { getRoutineInboxService } from '../routines/routine-inbox-runtime'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

function ownerFor(event: IpcMainInvokeEvent) {
  assertTrustedWorkflowLedgerSender(event)
  const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
  if (!win || win.isDestroyed() || role !== 'main' && role !== 'task') throw new Error('请从工作台或原任务窗口打开定时运行。')
  const scope = role === 'task' ? taskSessionForWindow(win) : undefined
  if (role === 'task' && !scope) throw new Error('独立任务窗口身份不可用。')
  return { win, scope, owner: event.sender.id }
}
export function registerRoutineInboxIpc(): void {
  const owners = new Set<number>(), service = () => getRoutineInboxService(app.getPath('userData'))
  const invoke = async <T>(event: IpcMainInvokeEvent, operation: (owner: number, scope?: string) => T | Promise<T>): Promise<T> => {
    const before = ownerFor(event)
    await sessionManager.whenInitialized()
    const after = ownerFor(event)
    if (before.owner !== after.owner || before.scope !== after.scope) throw new Error('窗口任务已变化，请重新打开。')
    const result = await operation(after.owner, after.scope)
    const current = ownerFor(event)
    if (current.owner !== after.owner || current.scope !== after.scope) throw new Error('窗口任务已变化，请重新打开。')
    return result
  }
  ipcMain.handle('routine-inbox:list', (event, input?: RoutineInboxQuery) => invoke(event, (owner, scope) => {
    if (!owners.has(owner)) {
      owners.add(owner)
      event.sender.once('destroyed', () => { service().releaseOwner(owner); owners.delete(owner) })
    }
    return service().list(owner, input, scope)
  }))
  ipcMain.handle('routine-inbox:read', (event, snapshotId: string, runId: string) => invoke(event, (owner, scope) => service().read(owner, snapshotId, runId, scope)))
  ipcMain.handle('routine-inbox:resolve', (event, snapshotId: string, runId: string) => invoke(event, (owner, scope) => service().resolve(owner, snapshotId, runId, scope)))
  ipcMain.handle('routine-inbox:mark', (event, input: RoutineInboxMarkInput) => invoke(event, (owner, scope) => {
    service().mark(owner, input, scope)
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && ['main','task'].includes(desktopWindowRole(win) ?? '')) win.webContents.send('routine-inbox:changed')
  }))
}
