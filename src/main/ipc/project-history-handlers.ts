import { BrowserWindow, app, ipcMain } from 'electron'
import { historyBelongsToProject, type ProjectHistoryArchiveInput } from '../../shared/project-history'
import { desktopWindowRole } from '../desktop-window-registry'
import { listHistory, setHistoriesArchived } from '../history'
import { listProjects } from '../projects'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerProjectHistoryIpc(): void {
  ipcMain.handle('history:archiveProject', async (event, input: ProjectHistoryArchiveInput) => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || desktopWindowRole(win) !== 'main') throw new Error('请在主工作台管理项目任务。')
    if (!input || !input.scope || !['canonical', 'legacy'].includes(input.scope.kind) ||
      typeof input.scope.id !== 'string' || !input.scope.id || typeof input.archived !== 'boolean' ||
      !Array.isArray(input.historyIds) || input.historyIds.length > 10000 ||
      input.historyIds.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('项目归档参数无效。')
    let legacyPath: string | undefined
    if (input.scope.kind === 'canonical') {
      const workspace = await (await openProjectWorkspaceStore(app.getPath('userData'))).getWorkspace(input.scope.id)
      if (!workspace || workspace.status === 'deleted') throw new Error('项目已移除，请刷新后重试。')
    } else {
      const project = listProjects().find(item => item.id === input.scope.id)
      if (!project) throw new Error('项目已移除，请刷新后重试。')
      legacyPath = project.path
    }
    const requested = new Set(input.historyIds)
    const eligible = listHistory().filter(entry => requested.has(entry.id) && historyBelongsToProject(entry, input.scope, legacyPath))
    const eligibleIds = new Set(eligible.map(entry => entry.id))
    const changedIds = setHistoriesArchived([...eligibleIds], input.archived)
    return { changedIds, skippedIds: [...requested].filter(id => !eligibleIds.has(id)) }
  })
}
