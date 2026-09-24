import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { configureTaskHandoffService } from '../task-handoff/service'
import { captureTaskHandoffBundle, assertTaskHandoffSourceCurrent, validateTaskHandoffBundle, previewTaskHandoffImport, importTaskHandoffBundle } from '../task-handoff/task-bundle'
import { getRemoteHostService } from '../remote-hosts/runtime'
import { sessionManager } from '../sessionManager'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'

export function registerTaskHandoffIpc(): void {
  const root = app.getPath('userData')
  const service = configureTaskHandoffService(root, {
    getSession: id => sessionManager.get(id)?.meta,
    stopAndReconcile: id => sessionManager.prepareHostHandoff(id),
    beforeImport: id => sessionManager.evictHostHandoffSession(id),
    capture: id => captureTaskHandoffBundle(root, id), validate: validateTaskHandoffBundle,
    assertSourceCurrent: bundle => assertTaskHandoffSourceCurrent(root, bundle),
    previewImport: (bundle, cwd) => previewTaskHandoffImport(root, bundle, cwd),
    importBundle: (bundle, cwd) => importTaskHandoffBundle(root, bundle, cwd),
    request: (id, action, payload) => getRemoteHostService().requestTaskHandoff(id, action, payload)
  })
  const windowFor = (event: IpcMainInvokeEvent, sessionId?: string): BrowserWindow => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
    if (!win || win.isDestroyed() || !['main', 'task'].includes(role ?? '') || role === 'task' && (!sessionId || taskSessionForWindow(win) !== sessionId)) throw new Error('请从原任务或主工作台操作移交。')
    return win
  }
  const ownedOperation = (event: IpcMainInvokeEvent, id: string): void => {
    const row = service.list().find(item => item.id === id)
    if (!row) throw new Error('原移交记录不存在。')
    windowFor(event, row.identity.sessionId)
  }
  ipcMain.handle('task-handoff:list', (event, sessionId?: string) => { windowFor(event, sessionId); return service.list(sessionId) })
  ipcMain.handle('task-handoff:targets', (event, hostId: string, sessionId: string) => { windowFor(event, sessionId); return service.targets(hostId) })
  ipcMain.handle('task-handoff:prepare', (event, input) => { windowFor(event, input?.sessionId); return service.prepare(input) })
  ipcMain.handle('task-handoff:commit', (event, input) => { ownedOperation(event, input?.id); return service.commit(input.id, input.previewDigest) })
  ipcMain.handle('task-handoff:reconcile', (event, id: string) => { ownedOperation(event, id); return service.reconcile(id) })
  ipcMain.handle('task-handoff:cancel', (event, id: string) => { ownedOperation(event, id); return service.cancel(id) })
  ipcMain.handle('task-handoff:destinations', event => { windowFor(event); return service.localDestinations() })
  ipcMain.handle('task-handoff:destination-revoke', (event, id: string) => { windowFor(event); service.destinations.revoke(id) })
  ipcMain.handle('task-handoff:destination-renew', (event, id: string) => { windowFor(event); service.destinations.renew(id) })
  ipcMain.handle('task-handoff:destination-add', async event => {
    const win = windowFor(event)
    const picked = await dialog.showOpenDialog(win, { title: '允许接收移交任务的目录', properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return undefined
    windowFor(event)
    const grant = service.destinations.add(picked.filePaths[0])
    return service.localDestinations().find(row => row.id === grant.id)
  })
}
