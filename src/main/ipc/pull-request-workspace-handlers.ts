import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { PullRequestReviewDraftInput, PullRequestWorkspaceListInput, PullRequestWorkspaceReadInput } from '../../shared/pull-request-workspace-types'
import { sessionManager } from '../sessionManager'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { getPullRequestWorkspaceService } from '../git/pull-request-workspace-runtime'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

function trusted(event: IpcMainInvokeEvent, sessionId: string): void {
  assertTrustedWorkflowLedgerSender(event)
  const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
  if (!window || window.isDestroyed() || (role !== 'main' && role !== 'task') || role === 'task' && taskSessionForWindow(window) !== sessionId) throw new Error('请从主工作台或原任务窗口打开 PR/MR 工作区')
}
export function registerPullRequestWorkspaceIpc(): void {
  const invoke = async <T>(event: IpcMainInvokeEvent, id: string, operation: () => T | Promise<T>): Promise<T> => {
    trusted(event, id); await sessionManager.whenInitialized(); trusted(event, id)
    const result = await operation(); trusted(event, id); return result
  }
  const service = () => getPullRequestWorkspaceService(app.getPath('userData'))
  ipcMain.handle('pr-workspace:inspect', (event, id: string) => invoke(event, id, () => service().inspect(id)))
  ipcMain.handle('pr-workspace:list', (event, id: string, input: PullRequestWorkspaceListInput) => invoke(event, id, () => service().list(id, input)))
  ipcMain.handle('pr-workspace:read', (event, id: string, input: PullRequestWorkspaceReadInput) => invoke(event, id, () => service().read(id, input)))
  ipcMain.handle('pr-workspace:prepare-review-draft', (event, id: string, input: PullRequestReviewDraftInput) => invoke(event, id, () => service().prepareReviewDraft(id, input)))
}
