import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { WorktreePullRequestDraftPrepareInput, WorktreePullRequestDraftSaveInput } from '../../shared/worktree-pr-draft-types'
import { sessionManager } from '../sessionManager'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { getWorktreePullRequestDraftService } from '../git/worktree-pr-draft-runtime'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

function trusted(event: IpcMainInvokeEvent, sessionId: string): void {
  assertTrustedWorkflowLedgerSender(event)
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || (role !== 'main' && role !== 'task') || role === 'task' && taskSessionForWindow(window) !== sessionId) throw new Error('请从主工作台或原任务窗口准备 PR。')
}
export function registerWorktreePullRequestDraftIpc(): void {
  ipcMain.handle('worktree-pr-draft:prepare', async (event, id: string, input?: WorktreePullRequestDraftPrepareInput) => {
    trusted(event, id); await sessionManager.whenInitialized(); trusted(event, id)
    const result = await getWorktreePullRequestDraftService(app.getPath('userData')).prepare(id, input)
    trusted(event, id); return result
  })
  ipcMain.handle('worktree-pr-draft:save', async (event, id: string, input: WorktreePullRequestDraftSaveInput) => {
    trusted(event, id); await sessionManager.whenInitialized(); trusted(event, id)
    const result = await getWorktreePullRequestDraftService(app.getPath('userData')).save(id, input)
    trusted(event, id); return result
  })
}
