import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { sessionManager } from '../sessionManager'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { studioResultSnapshotForSession } from './studio-result-handlers'
import { TaskSourceService, taskSourceKey, type TaskSourceContext } from '../source-panel/task-source-service'

let instance: TaskSourceService | undefined
async function loadContext(sessionId: string): Promise<TaskSourceContext> {
  await sessionManager.whenInitialized()
  const found = sessionManager.get(sessionId)
  if (!found || found.meta.status === 'closed') throw new Error('原任务已关闭或不存在。')
  const meta = { ...found.meta }, result = meta.workspaceId ? await studioResultSnapshotForSession(sessionId) : undefined
  const current = sessionManager.get(sessionId)
  if (!current || current.meta.status === 'closed' || taskSourceKey(current.meta) !== taskSourceKey(meta)) throw new Error('读取资料期间任务归属已变化，请刷新。')
  return { meta, transcript: sessionManager.getTranscript(sessionId), artifacts: result?.artifacts ?? [], evidence: result?.evidence ?? [], runs: result?.runs ?? [] }
}
function service(): TaskSourceService { return instance ??= new TaskSourceService(app.getPath('userData'), loadContext) }

export function registerTaskSourceIpc(): void {
  const owners = new Map<number, number>()
  let nextOwner = 1
  function owner(event: IpcMainInvokeEvent, sessionId: unknown): number {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
    if (!win || win.isDestroyed() || !['main', 'task'].includes(role ?? '') || typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sessionId)) throw new Error('资料只能从原任务窗口打开。')
    if (role === 'task' && taskSessionForWindow(win) !== sessionId) throw new Error('无法访问其他任务的资料。')
    if (!owners.has(event.sender.id)) {
      const id = event.sender.id
      owners.set(id, nextOwner++)
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (!isMainFrame) return
        const previous = owners.get(id)
        if (previous !== undefined) service().releaseOwner(previous)
        owners.set(id, nextOwner++)
      })
      event.sender.once('destroyed', () => {
        const previous = owners.get(id)
        if (previous !== undefined) service().releaseOwner(previous)
        owners.delete(id)
      })
    }
    return owners.get(event.sender.id)!
  }
  function assertOwner(event: IpcMainInvokeEvent, sessionId: string, expected: number): void {
    if (owner(event, sessionId) !== expected) throw new Error('资料窗口已刷新，请重试。')
  }
  function ids(collectionId: unknown, sourceId: unknown): void {
    if (typeof collectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(collectionId) || typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId)) throw new Error('资料身份参数无效。')
  }
  ipcMain.handle('task-sources:list', async (event, sessionId: string) => {
    const sender = owner(event, sessionId)
    const result = await service().list(sender, sessionId)
    assertOwner(event, sessionId, sender)
    return result
  })
  ipcMain.handle('task-sources:read', async (event, sessionId: string, collectionId: string, sourceId: string) => {
    const sender = owner(event, sessionId); ids(collectionId, sourceId)
    const result = await service().read(sender, sessionId, collectionId, sourceId)
    assertOwner(event, sessionId, sender)
    return result
  })
  ipcMain.handle('task-sources:url', async (event, sessionId: string, collectionId: string, sourceId: string) => {
    const sender = owner(event, sessionId); ids(collectionId, sourceId)
    const result = await service().url(sender, sessionId, collectionId, sourceId)
    assertOwner(event, sessionId, sender)
    return result
  })
}
