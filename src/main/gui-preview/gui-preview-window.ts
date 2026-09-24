import { app, BrowserWindow, ipcMain, nativeImage, screen, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sessionManager } from '../sessionManager'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { registerDesktopWindow } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { activateDesktopTask } from '../desktopNotify'
import { getSettings, subscribeSettingsChanges } from '../settings'
import { revokeGuiAutomationGrantsForSession } from '../permission/permission-manager'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { guiPreviewBinding, invalidateGuiPreview, latestGuiPreviewCaptureEvent, latestGuiPreviewEvent, subscribeGuiPreviewEvents, type GuiPreviewCapture } from './gui-preview-events'
import { GuiPreviewState, type GuiPreviewContext } from './gui-preview-state'
import { readGuiPreviewFrame } from './gui-preview-frame'
import type { GuiPreviewFrame, GuiPreviewSnapshot } from '../../shared/gui-preview-types'

interface PreviewEntry { win: BrowserWindow; state: GuiPreviewState; context: GuiPreviewContext; stopping: boolean }
const entries = new Map<string, PreviewEntry>()
const channels: string[] = []
const subscriptions: Array<() => void> = []
let mainWindow: (() => BrowserWindow | null) | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined

function currentContext(sessionId: string, previous?: GuiPreviewContext): GuiPreviewContext {
  const meta = sessionManager.get(sessionId)?.meta
  if (!meta) {
    if (!previous) throw new Error('请从原任务打开电脑操作画中画。')
    return { ...previous, taskStatus: 'closed', pendingApprovalCount: 0 }
  }
  let ownership: string, authorityRevision: number
  try {
    ownership = taskExecutionAuthorityBindingDigest(meta)
    authorityRevision = new TaskExecutionAuthorityStore(app.getPath('userData')).get(meta).revision
  } catch { ownership = 'unavailable'; authorityRevision = -1 }
  const settings = getSettings()
  return { binding: guiPreviewBinding(meta, ownership, taskRuntimeRegistry.get(sessionId)?.id, authorityRevision),
    title: meta.title, language: settings.language === 'en' ? 'en' : 'zh', taskStatus: meta.status,
    enabled: settings.guiAutomationEnabled === true && ownership !== 'unavailable',
    pendingApprovalCount: sessionManager.get(sessionId)?.pendingPermissions().filter(item => item.toolName.startsWith('gui_')).length ?? 0 }
}
function refresh(entry: PreviewEntry): GuiPreviewSnapshot {
  entry.context = currentContext(entry.context.binding.sessionId, entry.context)
  entry.state.update(entry.context)
  return entry.state.snapshot()
}
function publish(entry: PreviewEntry): GuiPreviewSnapshot {
  const snapshot = refresh(entry)
  if (!entry.win.isDestroyed() && !entry.win.webContents.isDestroyed()) entry.win.webContents.send('gui-preview:state-changed', snapshot)
  return snapshot
}
function trustedPage(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed() || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('画中画操作必须来自受信任的主页面。')
  const expected = new URL(process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  const actual = new URL(event.senderFrame.url)
  if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname) throw new Error('画中画页面已变化。')
  return win
}
function previewSender(event: IpcMainInvokeEvent): PreviewEntry {
  const win = trustedPage(event)
  const entry = [...entries.values()].find(item => item.win === win)
  if (!entry) throw new Error('此窗口不拥有电脑操作画中画。')
  return entry
}
function requireOriginalTask(entry: PreviewEntry): string {
  const snapshot = refresh(entry)
  if (!snapshot.available) throw new Error('原任务不可用或归属已变化，请回工作台打开。')
  return snapshot.sessionId
}
async function loadFrame(capture: GuiPreviewCapture): Promise<GuiPreviewFrame> {
  const bytes = await readGuiPreviewFrame(capture)
  const decoded = nativeImage.createFromBuffer(bytes)
  if (decoded.isEmpty()) throw new Error('截图无法解码。')
  const preview = decoded.resize({ width: Math.min(decoded.getSize().width, 1100) })
  if (preview.isEmpty()) throw new Error('截图预览为空。')
  return { dataUrl: preview.toDataURL(), sourceLabel: capture.sourceLabel, capturedAt: capture.capturedAt,
    width: capture.width, height: capture.height, sha256: capture.sha256 }
}

export function registerGuiPreviewWindows(getMainWindow: () => BrowserWindow | null): void {
  if (mainWindow) throw new Error('电脑操作画中画已注册。')
  mainWindow = getMainWindow
  const handle = (name: string, run: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    const channel = `gui-preview:${name}`; channels.push(channel); ipcMain.handle(channel, run)
  }
  handle('open', async (event, id: unknown) => {
    const win = trustedPage(event)
    if (typeof id !== 'string' || !id || id.length > 200 ||
      (win !== mainWindow?.() && taskSessionForWindow(win) !== id)) throw new Error('只能从工作台或原任务窗口打开画中画。')
    await sessionManager.whenInitialized()
    await openPreview(id)
  })
  handle('state', event => refresh(previewSender(event)))
  handle('close', event => { previewSender(event).win.close() })
  handle('open-task', event => { activateDesktopTask(requireOriginalTask(previewSender(event))) })
  handle('pause', (event, expectedRunId: unknown) => stop(previewSender(event), false, expectedRunId))
  handle('take-over', (event, expectedRunId: unknown) => stop(previewSender(event), true, expectedRunId))
  subscriptions.push(subscribeGuiPreviewEvents(event => {
    const targets = event.kind === 'invalidated'
      ? [...entries.values()].filter(entry => !event.sessionId || entry.context.binding.sessionId === event.sessionId)
      : [entries.get(event.invocation.binding.sessionId)].filter((entry): entry is PreviewEntry => Boolean(entry))
    for (const entry of targets) {
      void entry.state.accept(event, loadFrame, () => currentContext(entry.context.binding.sessionId, entry.context))
        .then(() => { if (entries.get(entry.context.binding.sessionId) === entry) publish(entry) })
        .catch(() => { entry.state.invalidate('电脑操作预览暂不可用。'); publish(entry) })
    }
  }), sessionManager.subscribe(({ sessionId }) => {
    const meta = sessionManager.get(sessionId)?.meta
    if (!meta || meta.status === 'closed') invalidateGuiPreview(sessionId)
    const entry = entries.get(sessionId); if (entry) publish(entry)
  }), subscribeSettingsChanges(() => {
    if (!getSettings().guiAutomationEnabled) invalidateGuiPreview()
    for (const entry of entries.values()) publish(entry)
  }))
  // Revalidate task authority even when a permission edit has no Session event. No capture occurs.
  refreshTimer = setInterval(() => { for (const entry of entries.values()) publish(entry) }, 1000)
  refreshTimer.unref()
}

async function stop(entry: PreviewEntry, takeOver: boolean, expectedRunId: unknown): Promise<GuiPreviewSnapshot> {
  const sessionId = requireOriginalTask(entry)
  if (expectedRunId !== entry.context.binding.runId) throw new Error('任务运行已变化，请刷新画中画后重试。')
  const stoppedBinding = { ...entry.context.binding }
  if (entry.stopping) throw new Error('正在等待当前执行器停止。')
  entry.state.startStopping(); entry.stopping = true
  invalidateGuiPreview(sessionId)
  revokeGuiAutomationGrantsForSession(sessionId)
  publish(entry)
  try {
    await sessionManager.interrupt(sessionId)
    const live = currentContext(sessionId, entry.context)
    if (live.binding.ownership !== stoppedBinding.ownership) {
      entry.state.update(live)
      throw new Error('任务归属已变化，接管已停止。')
    }
    if (live.binding.runId === stoppedBinding.runId) {
      invalidateGuiPreview(sessionId)
      entry.state.stoppedResult()
    } else {
      entry.state.update(live)
      entry.state.invalidate('原运行的停止请求已处理；任务运行已变化，请回原任务核对。')
    }
    if (takeOver) activateDesktopTask(sessionId)
  } catch (error) {
    entry.state.stoppedResult(error instanceof Error ? error.message : String(error))
  } finally { entry.stopping = false }
  return publish(entry)
}

async function openPreview(sessionId: string): Promise<void> {
  const context = currentContext(sessionId)
  if (context.taskStatus === 'closed' || context.binding.ownership === 'unavailable') throw new Error('任务已关闭或工作目录不可用。')
  const existing = entries.get(sessionId)
  if (existing && !existing.win.isDestroyed()) { publish(existing); existing.win.show(); existing.win.focus(); return }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(460, area.width), height = Math.min(454, area.height)
  const win = new BrowserWindow({ width, height, x: area.x + area.width - width - 20, y: area.y + area.height - height - 20,
    minWidth: 360, minHeight: 350, title: 'EastGenesis · 电脑操作', show: false, frame: false,
    backgroundColor: '#17191d', resizable: true, maximizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, partition: `caogen-gui-preview-${sessionId}`, additionalArguments: ['--caogen-gui-preview'] } })
  const entry: PreviewEntry = { win, state: new GuiPreviewState(context), context, stopping: false }
  entries.set(sessionId, entry); registerDesktopWindow(win, 'gui-preview')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.on('closed', () => {
    entry.state.invalidate('画中画已关闭。', true)
    if (entries.get(sessionId) === entry) entries.delete(sessionId)
  })
  try {
    const url = process.env.ELECTRON_RENDERER_URL
    await (url ? win.loadURL(url) : win.loadFile(join(__dirname, '../renderer/index.html')))
    if (win.isDestroyed()) return
    const capture = latestGuiPreviewCaptureEvent(sessionId)
    if (capture) await entry.state.accept(capture, loadFrame, () => currentContext(sessionId, entry.context))
    const latest = latestGuiPreviewEvent(sessionId)
    if (latest && latest !== capture) await entry.state.accept(latest, loadFrame, () => currentContext(sessionId, entry.context))
    if (!win.isDestroyed()) { publish(entry); win.showInactive() }
  } catch (error) {
    if (!win.isDestroyed()) win.destroy()
    throw error
  }
}

export function disposeGuiPreviewWindows(): void {
  for (const off of subscriptions.splice(0)) off()
  for (const channel of channels.splice(0)) ipcMain.removeHandler(channel)
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = undefined
  for (const entry of entries.values()) { entry.state.invalidate('应用正在退出。', true); entry.win.destroy() }
  entries.clear(); invalidateGuiPreview(); mainWindow = undefined
}
