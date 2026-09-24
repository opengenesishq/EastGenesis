import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { activityService, observeActivity, readActivityRecord } from '../activity/activity-runtime'
import { sessionManager } from '../sessionManager'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import type { TaskActivityMarkInput } from '../../shared/activity-types'

function ownerFor(event: IpcMainInvokeEvent) {
  assertTrustedWorkflowLedgerSender(event)
  const win = BrowserWindow.fromWebContents(event.sender)
  const role = win && desktopWindowRole(win)
  if (!win || win.isDestroyed() || !['main', 'task'].includes(role ?? '')) throw new Error('活动只能从 EastGenesis 任务窗口操作。')
  const sessionId = role === 'task' ? taskSessionForWindow(win) : undefined
  if (role === 'task' && !sessionId) throw new Error('独立任务窗口身份不可用。')
  return { win, sessionId, owner: event.sender.id }
}
let queued: ReturnType<typeof setTimeout> | undefined
function broadcast(): void {
  if (queued) return
  queued = setTimeout(() => {
    queued = undefined
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && ['main', 'task'].includes(desktopWindowRole(win) ?? '')) win.webContents.send('activity:changed')
    }
  }, 1000)
}
export function registerActivityIpc(): void {
  const owners = new Set<number>()
  ipcMain.handle('activity:list', async event => {
    const { owner, win, sessionId } = ownerFor(event)
    if (!owners.has(owner)) {
      owners.add(owner)
      win.webContents.once('destroyed', () => { activityService().releaseOwner(owner); owners.delete(owner) })
    }
    await sessionManager.whenInitialized()
    return activityService().list(owner, sessionId)
  })
  ipcMain.handle('activity:mark', (event, input: TaskActivityMarkInput) => {
    const { owner, sessionId } = ownerFor(event)
    activityService().mark(owner, input, sessionId); broadcast()
  })
  ipcMain.handle('activity:resolve', async (event, snapshotId: unknown, itemId: unknown) => {
    const { owner, sessionId } = ownerFor(event)
    if (typeof snapshotId !== 'string' || typeof itemId !== 'string') throw new Error('活动跳转参数无效。')
    return activityService().resolve(owner, snapshotId, itemId, sessionId)
  })
  ipcMain.handle('activity:record', async (event, snapshotId: unknown, itemId: unknown) => {
    const { owner, sessionId } = ownerFor(event)
    if (typeof snapshotId !== 'string' || typeof itemId !== 'string') throw new Error('活动记录参数无效。')
    return readActivityRecord(owner, snapshotId, itemId, sessionId)
  })
  sessionManager.subscribe(payload => { if (observeActivity(payload)) broadcast() })
}
