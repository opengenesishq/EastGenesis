import { assertTaskExecutionEnvironment } from '../wsl/binding'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { sessionManager } from '../sessionManager'
import { getSettings } from '../settings'
import { normalizeWorkspaceBehavior } from '../../shared/workspace-behavior-types'
import { taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { launchExternalEditor, listExternalEditorChoices, resolveEditorWorkspaceFile, resolveExternalEditor, validateEditorProgram } from '../workspace-external-editor'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

function trusted(event: IpcMainInvokeEvent, sessionId?: string): BrowserWindow {
  assertTrustedWorkflowLedgerSender(event)
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || role !== 'main' && role !== 'task' || role === 'task' && (!sessionId || taskSessionForWindow(window) !== sessionId)) throw new Error('请从主工作台或原任务窗口操作。')
  return window
}
export function registerWorkspaceBehaviorIpc(): void {
  ipcMain.handle('workspace-behavior:editors', event => { trusted(event); return listExternalEditorChoices() })
  ipcMain.handle('workspace-behavior:choose-editor', async event => {
    const window = trusted(event), frame = event.senderFrame
    let navigated = false
    const changed = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean): void => { if (main && !inPlace) navigated = true }
    event.sender.on('did-start-navigation', changed)
    try {
      const result = await dialog.showOpenDialog(window, { title: '选择外部编辑器', properties: ['openFile'], ...(process.platform === 'darwin' ? { defaultPath: '/Applications', filters: [{ name: '应用', extensions: ['app'] }] } : process.platform === 'win32' ? { filters: [{ name: '程序', extensions: ['exe'] }] } : {}) })
      trusted(event)
      if (navigated || frame !== event.sender.mainFrame) throw new Error('设置页面已变化，请重新选择。')
      return result.canceled || !result.filePaths[0] ? null : validateEditorProgram(result.filePaths[0])
    } finally { if (!event.sender.isDestroyed()) event.sender.removeListener('did-start-navigation', changed) }
  })
  ipcMain.handle('workspace-behavior:open-editor', async (event, input: { sessionId: string; path: string }) => {
    if (!input || typeof input.sessionId !== 'string') throw new Error('当前任务无效。')
    trusted(event, input.sessionId)
    await sessionManager.whenInitialized(); trusted(event, input.sessionId)
    const meta = sessionManager.get(input.sessionId)?.meta
    if (!meta || meta.status === 'closed') throw new Error('原任务已关闭。')
    assertTaskExecutionEnvironment(meta)
    const binding = taskExecutionAuthorityBindingDigest(meta)
    const file = resolveEditorWorkspaceFile(meta.cwd, input.path)
    const editor = resolveExternalEditor(normalizeWorkspaceBehavior(getSettings().workspaceBehavior))
    trusted(event, input.sessionId)
    const current = sessionManager.get(input.sessionId)?.meta
    if (!current || current.status === 'closed' || taskExecutionAuthorityBindingDigest(current) !== binding) throw new Error('任务或目录已变化，请重新打开文件。')
    await launchExternalEditor(editor, file)
  })
}
