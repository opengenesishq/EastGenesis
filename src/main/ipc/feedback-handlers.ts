import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { LocalFeedbackService } from '../feedback/local-feedback'
import { sessionManager } from '../sessionManager'
import { writeDurableFile } from '../durable-file'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

declare const __CAOGEN_APP_VERSION__: string

const feedback = new LocalFeedbackService({
  appInfo: () => ({ name: 'EastGenesis', version: typeof __CAOGEN_APP_VERSION__ === 'string' ? __CAOGEN_APP_VERSION__ : app.getVersion(),
    platform: process.platform, architecture: process.arch, build: app.isPackaged ? 'packaged' : 'development',
    electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }),
  session: id => sessionManager.get(id)?.meta,
  run: id => sessionManager.getTaskRun(id)
})
const observed = new WeakSet<Electron.WebContents>()

function owner(event: IpcMainInvokeEvent): BrowserWindow {
  assertTrustedWorkflowLedgerSender(event)
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) throw new Error('反馈窗口不可用。')
  if (!observed.has(event.sender)) {
    observed.add(event.sender)
    const id = event.sender.id
    event.sender.once('destroyed', () => feedback.clearOwner(id))
    event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) feedback.clearOwner(id) })
  }
  return window
}

export function registerFeedbackIpc(): void {
  ipcMain.handle('feedback:appInfo', event => { owner(event); return feedback.appInfo() })
  ipcMain.handle('feedback:preview', (event, input: unknown) => { owner(event); return feedback.preview(event.sender.id, input) })
  ipcMain.handle('feedback:export', (event, previewId: unknown) => {
    const window = owner(event)
    return feedback.export(event.sender.id, previewId, {
      choosePath: async filename => {
        const result = await dialog.showSaveDialog(window, { title: '导出本地反馈诊断文件', defaultPath: filename, filters: [{ name: 'JSON', extensions: ['json'] }] })
        return result.canceled ? undefined : result.filePath
      },
      assertOwner: () => { owner(event) },
      write: (path, json) => writeDurableFile(path, json, { mode: 0o600, replace: true })
    })
  })
}
