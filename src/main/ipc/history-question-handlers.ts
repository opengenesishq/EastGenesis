import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BrowserHistoryRecord } from '../../shared/browser-preferences-types'
import { HistoryQuestionService } from '../computer-history/question-service'
import { browserManagement } from '../browser-management/service'
import { sessionManager } from '../sessionManager'
import { listHistory } from '../history'
import { desktopWindowRole } from '../desktop-window-registry'
import { existingComputerHistory } from './computer-history-handlers'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export function registerHistoryQuestionIpc(): void {
  const service = new HistoryQuestionService({ task: id => { const meta = sessionManager.get(id)?.meta; return meta ? { ...meta, archived: listHistory().find(entry => entry.id === id)?.archived } : undefined },
    sources: refs => {
      const computer = refs.filter(ref => ref.kind === 'computer').flatMap(ref => existingComputerHistory().query({ recordId: ref.id, limit: 1 }).records)
      const browser: BrowserHistoryRecord[] = [], browserIds = new Set(refs.filter(ref => ref.kind === 'browser').map(ref => ref.id))
      if (!browserIds.size) return { computer, browser, browserEnabled: false }
      const store = browserManagement().store, browserEnabled = store.getPreferences().preferences.recordHistory
      if (browserEnabled) {
        let before: number | undefined
        for (let page = 0; page < 26 && browser.length < browserIds.size; page++) {
          const result = store.listHistory({ limit: 200, before })
          browser.push(...result.items.filter(item => browserIds.has(item.id)))
          if (result.nextBefore === undefined) break
          before = result.nextBefore
        }
      }
      return { computer, browser, browserEnabled }
    } })
  const observed = new WeakSet<Electron.WebContents>()
  function access(event: IpcMainInvokeEvent): void {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || desktopWindowRole(win) !== 'main') throw new Error('请在主工作台选择历史并准备任务草稿。')
    if (!observed.has(event.sender)) {
      observed.add(event.sender)
      event.sender.once('destroyed', () => service.clearOwner(event.sender.id))
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) service.clearOwner(event.sender.id) })
    }
  }
  ipcMain.handle('history-question:preview', async (event, input: unknown) => { access(event); await sessionManager.whenInitialized(); access(event); return service.preview(event.sender.id, input) })
  ipcMain.handle('history-question:deliver', (event, input: unknown) => { access(event); return service.deliver(event.sender.id, input) })
}
