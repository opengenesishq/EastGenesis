import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { sessionManager } from './sessionManager'
import { registerDesktopWindow } from './desktop-window-registry'
import { activateDesktopTask } from './desktopNotify'
import { assertTrustedWorkflowLedgerSender } from './ipc/workflow-ledger-handlers'
import type { RemoteWelcomeDraftInput, TaskWindowState } from '../shared/task-window-types'
import { RemoteWelcomeDraftStore, assertRemoteWelcomeDraftHost, normalizeRemoteWelcomeDraft } from './task-window-drafts'
import { getRemoteHostService } from './remote-hosts/runtime'

const windows = new Map<string, BrowserWindow>()
let opener: ((id: string) => Promise<TaskWindowState>) | undefined

/** Each live Session has at most one detached view. Execution belongs to SessionManager. */
export function registerTaskWindows(getMainWindow: () => BrowserWindow | null): void {
  opener = (id) => openWindow(id, getMainWindow)
  const drafts = new RemoteWelcomeDraftStore(join(app.getPath('userData'), 'private', 'remote-welcome-drafts.json'))
  function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame ||
      (win !== getMainWindow() && ![...windows.values()].includes(win))) {
    throw new Error('任务窗口只能从 EastGenesis 工作台操作。')
    }
    return win
  }

  ipcMain.handle('task-window:open', async (event, id: unknown) => {
    senderWindow(event)
    await sessionManager.whenInitialized()
    return openWindow(requireSession(id), getMainWindow)
  })
  ipcMain.handle('task-window:state', (event) => stateOf(senderWindow(event)))
  ipcMain.handle('task-window:pin', (event, value: unknown) => {
    const win = senderWindow(event)
    if (!sessionForWindow(win)) throw new Error('请先在独立窗口中打开任务。')
    if (typeof value !== 'boolean') throw new Error('置顶状态无效。')
    win.setAlwaysOnTop(value)
    const state = stateOf(win)
    win.webContents.send('task-window:state-changed', state)
    return state
  })
  ipcMain.handle('task-window:show-main', (event, id: unknown) => {
    senderWindow(event)
    activateDesktopTask(requireSession(id))
  })
  ipcMain.handle('task-window:remote-draft-send', async (event, value: RemoteWelcomeDraftInput) => {
    const source = sessionForWindow(senderWindow(event)), main = getMainWindow()
    if (!source || !main || main.isDestroyed()) throw new Error('请从独立任务窗口交接到可用主窗口。')
    requireSession(source)
    const input = normalizeRemoteWelcomeDraft(value)
    const hosts = await getRemoteHostService().listRemoteHosts()
    if (sessionForWindow(senderWindow(event)) !== source || main !== getMainWindow() || main.isDestroyed()) throw new Error('窗口已变化，草稿未交接。')
    assertRemoteWelcomeDraftHost(input, hosts.hosts.find(host => host.id === input.hostId))
    const receipt = drafts.enqueue(input, source)
    if (main.isMinimized()) main.restore()
    main.show(); main.focus(); main.webContents.send('task-window:remote-drafts-changed')
    return receipt
  })
  ipcMain.handle('task-window:remote-drafts', event => {
    if (senderWindow(event) !== getMainWindow()) throw new Error('请在主窗口接收草稿。')
    return drafts.pending()
  })
  ipcMain.handle('task-window:remote-draft-ack', (event, requestId: string) => {
    if (senderWindow(event) !== getMainWindow()) throw new Error('请在主窗口确认草稿。')
    drafts.acknowledge(requestId)
    getMainWindow()?.webContents.send('task-window:remote-drafts-changed')
  })
  sessionManager.subscribe(({ sessionId }) => {
    const win = windows.get(sessionId)
    if (!win || win.isDestroyed()) return
    const title = titleFor(sessionId)
    if (win.getTitle() !== title) win.setTitle(title)
    const state = stateOf(win)
    if (!state.available) win.webContents.send('task-window:state-changed', state)
  })
}

/** Used by the desktop companion's bounded main-process controller. */
export async function openTaskWindowForSession(id: string): Promise<TaskWindowState> {
  if (!opener) throw new Error('独立任务窗口尚未初始化。')
  await sessionManager.whenInitialized()
  return opener(requireSession(id))
}

async function openWindow(sessionId: string, getMainWindow: () => BrowserWindow | null): Promise<TaskWindowState> {
  const existing = windows.get(sessionId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return stateOf(existing)
  }
  const win = new BrowserWindow({
      width: 1100, height: 820, minWidth: 600, minHeight: 520,
      title: titleFor(sessionId), backgroundColor: '#1a1a2e', show: false,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        additionalArguments: [`--caogen-task-window=${sessionId}`]
      }
  })
    windows.set(sessionId, win)
    registerDesktopWindow(win, 'task')
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.once('closed', () => { if (windows.get(sessionId) === win) windows.delete(sessionId) })
    try {
      const rendererUrl = process.env.ELECTRON_RENDERER_URL
      if (rendererUrl) {
        await win.loadURL(rendererUrl)
      } else {
        await win.loadFile(join(__dirname, '../renderer/index.html'))
      }
      if (!win.isDestroyed()) { win.show(); win.focus() }
    } catch (error) {
      if (!win.isDestroyed()) win.destroy()
      throw error
    }
  return stateOf(win)
}

function requireSession(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !value ||
    !sessionManager.get(value) || sessionManager.get(value)?.meta.status === 'closed') {
    throw new Error('任务已关闭或不存在，请从历史记录中打开后重试。')
  }
  return value
}

export function taskSessionForWindow(win: BrowserWindow): string | undefined {
  return [...windows.entries()].find(([, candidate]) => candidate === win)?.[0]
}

const sessionForWindow = taskSessionForWindow

function stateOf(win: BrowserWindow): TaskWindowState {
  const sessionId = sessionForWindow(win) ?? null
  const meta = sessionId ? sessionManager.get(sessionId)?.meta : undefined
  return { sessionId, alwaysOnTop: !win.isDestroyed() && win.isAlwaysOnTop(),
    available: sessionId === null || Boolean(meta && meta.status !== 'closed') }
}

function titleFor(sessionId: string): string {
  const title = sessionManager.get(sessionId)?.meta.title ?? '任务已关闭'
    return `${title.replace(/[\r\n\0]/g, ' ').slice(0, 180)} · EastGenesis`
}
