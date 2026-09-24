import { app, BrowserWindow, ipcMain, screen, systemPreferences, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { sessionManager } from './sessionManager'
import { getSettings, subscribeSettingsChanges, updateSettings } from './settings'
import { openTaskWindowForSession } from './task-window'
import { registerDesktopWindow } from './desktop-window-registry'
import { DesktopCompanionOutbox } from './desktop-companion-outbox'
import { companionImages } from './companion-image-runtime'
import { voiceInputService } from './voice-input/runtime'
import { CompanionVoiceController } from './companion-voice'
import type { VoiceInputTranscriptionInput } from '../shared/voice-input-types'
import { normalizeDesktopCompanionSettings, desktopCompanionSize, clampCompanionBounds } from '../shared/desktop-companion-settings'
import type { DesktopCompanionDraftDelivery, DesktopCompanionNavigation, DesktopCompanionSnapshot } from '../shared/desktop-companion-types'

interface CompanionHost { getMainWindow(): BrowserWindow | null; showMainWindow(): BrowserWindow; onVisibilityChange?(): void }
let companion: BrowserWindow | null = null
let host: CompanionHost | undefined
let expanded = false
let selectedSessionId: string | undefined
let readyContents: WebContents | undefined
let navigation: DesktopCompanionNavigation | undefined
let outbox: DesktopCompanionOutbox | undefined
let initialized = false
let generation = 0
let lastError: string | undefined
const subscriptions: Array<() => void> = []
const channels: string[] = []
const observed = new WeakSet<WebContents>()
let publishTimer: ReturnType<typeof setTimeout> | undefined
let moveTimer: ReturnType<typeof setTimeout> | undefined
let deliveryTimer: ReturnType<typeof setInterval> | undefined
const preferences = () => normalizeDesktopCompanionSettings(getSettings().desktopCompanion)
const queue = () => outbox ??= new DesktopCompanionOutbox(join(app.getPath('userData'), 'desktop-companion', 'draft-outbox.json'))
const sessionMeta = (id: string) => sessionManager.get(id)?.meta
const companionVoice = new CompanionVoiceController(voiceInputService, owner => {
  if (!companion || companion.isDestroyed() || companion.webContents.id !== owner || !companion.isVisible() || !expanded || !preferences().enabled || !selectedSessionId) return undefined
  return sessionMeta(selectedSessionId)
})
function requireTask(id: unknown) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('任务标识无效。')
  const meta = sessionMeta(id)
  if (!meta || meta.status === 'closed') throw new Error('任务已关闭或不存在，请从主工作台打开后重试。')
  return meta
}

function snapshot(): DesktopCompanionSnapshot {
  const tasks = sessionManager.list().filter(meta => meta.status !== 'closed').map(meta => ({ sessionId: meta.id,
    title: meta.title, status: meta.status, pendingApprovalCount: sessionManager.get(meta.id)?.pendingPermissions().length ?? 0 }))
  if (!tasks.some(task => task.sessionId === selectedSessionId)) selectedSessionId = tasks[0]?.sessionId
  tasks.sort((a, b) => Number(b.sessionId === selectedSessionId) - Number(a.sessionId === selectedSessionId) ||
    Number(b.pendingApprovalCount > 0 || b.status === 'error') - Number(a.pendingApprovalCount > 0 || a.status === 'error'))
  let deliveries: DesktopCompanionSnapshot['deliveries'] = []
  try { deliveries = queue().receipts() } catch (error) { lastError = errorText(error) }
  return { language: getSettings().language === 'en' ? 'en' : 'zh', expanded, selectedSessionId, tasks,
    runningCount: tasks.filter(task => task.status === 'running' || task.status === 'starting').length,
    attentionCount: tasks.filter(task => task.pendingApprovalCount > 0 || task.status === 'error').length,
    settings: preferences(), deliveries, error: lastError }
}
function publish(): DesktopCompanionSnapshot {
  const state = snapshot()
  companionVoice.prune()
  if (companion && !companion.isDestroyed()) companion.webContents.send('desktop-companion:state', state)
  return state
}
function schedulePublish(): void {
  if (publishTimer) return
  publishTimer = setTimeout(() => { publishTimer = undefined; publish(); deliver() }, 100)
}
function trustedSender(event: IpcMainInvokeEvent, role: 'companion' | 'main'): void {
  const win = role === 'companion' ? companion : host?.getMainWindow()
  if (!win || win.isDestroyed() || event.sender !== win.webContents || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('随侍操作来自其他窗口。')
  const expected = new URL(process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  const actual = new URL(event.senderFrame.url)
  if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname) throw new Error('随侍页面已变化，已拒绝操作。')
}
function sendNavigation(target: 'main' | 'palace', sessionId?: string): void {
  navigation = { requestId: randomUUID(), target, sessionId }
  host?.showMainWindow()
  deliver()
}
function deliver(): void {
  if (!initialized) return
  try {
    const pending = queue().pending(sessionMeta)
    const win = host?.getMainWindow()
    if (!win || win.isDestroyed() || readyContents !== win.webContents || win.webContents.isLoadingMainFrame()) return
    if (navigation) win.webContents.send('desktop-companion:navigate', navigation)
    // One at a time: all appends share the main window's durable draft document.
    if (pending[0]) win.webContents.send('desktop-companion:draft', pending[0])
  } catch (error) { lastError = errorText(error); publish() }
}

export function registerDesktopCompanion(options: CompanionHost): void {
  if (host) throw new Error('随侍已注册。')
  host = options
  const currentGeneration = ++generation
  const handle = (name: string, role: 'companion' | 'main', action: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    const channel = `desktop-companion:${name}`
    channels.push(channel)
    ipcMain.handle(channel, (event, ...args) => { trustedSender(event, role); return action(event, ...args) })
  }
  handle('get-state', 'companion', () => snapshot())
  handle('voice-prepare', 'companion', (event, id: string) => companionVoice.prepare(event.sender.id, id))
  handle('voice-permission', 'companion', event => companionVoice.permission(event.sender.id, () => process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : Promise.resolve(true)))
  handle('voice-transcribe', 'companion', (event, input: VoiceInputTranscriptionInput) => companionVoice.transcribe(event.sender.id, input))
  handle('voice-cancel', 'companion', (event, id: string) => companionVoice.cancel(event.sender.id, id))
  handle('get-figure', 'companion', () => {
    const id = preferences().imageId
    if (!id) return null
    const image = companionImages().preview(id)
    return { dataUrl: image.dataUrl, name: image.asset.name }
  })
  handle('select-task', 'companion', (_event, id: unknown) => { selectedSessionId = requireTask(id).id; return publish() })
  handle('set-expanded', 'companion', (_event, value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('展开状态无效。')
    expanded = value; resizeCompanion(); return publish()
  })
  handle('hide', 'companion', () => { updateSettings({ desktopCompanion: { ...preferences(), enabled: false } }) })
  handle('set-mode', 'companion', (_event, mode: unknown) => {
    if (mode !== 'figure' && mode !== 'mini') throw new Error('随侍显示方式无效。')
    updateSettings({ desktopCompanion: { ...preferences(), mode } })
  })
  handle('open-main', 'companion', (_event, target: unknown) => {
    if (target !== 'palace' && target !== 'main') throw new Error('工作台入口无效。')
    sendNavigation(target, selectedSessionId && sessionMeta(selectedSessionId)?.status !== 'closed' ? selectedSessionId : undefined)
  })
  handle('open-task', 'companion', async (_event, id: unknown, target: unknown) => {
    const meta = requireTask(id)
    if (target === 'detached') { await openTaskWindowForSession(meta.id); return }
    if (target !== 'main') throw new Error('窗口入口无效。')
    sendNavigation('main', meta.id)
  })
  handle('submit-draft', 'companion', (_event, input: { requestId: string; sessionId: string; text: string }) => {
    const receipt = queue().enqueue(input, requireTask(input?.sessionId))
    selectedSessionId = receipt.sessionId
    sendNavigation('main', receipt.sessionId)
    publish(); return receipt
  })
  handle('receiver-ready', 'main', event => {
    readyContents = event.sender
    if (!observed.has(event.sender)) {
      const contents = event.sender
      observed.add(contents)
      const reset = (): void => { if (readyContents === contents) readyContents = undefined }
      contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) reset() })
      contents.once('destroyed', reset)
      contents.on('render-process-gone', reset)
    }
    deliver()
  })
  handle('navigation-ack', 'main', (_event, id: unknown) => { if (navigation?.requestId === id) navigation = undefined })
  handle('draft-ack', 'main', (_event, input: DesktopCompanionDraftDelivery) => {
    // Revalidate ownership after the asynchronous receiver write.
    queue().pending(sessionMeta)
    queue().acknowledge(input); publish(); deliver()
  })
  subscriptions.push(sessionManager.subscribe(schedulePublish), subscribeSettingsChanges(() => {
    if (initialized) applyPreferences()
  }))
  const displayChanged = (): void => { resizeCompanion(); savePosition() }
  screen.on('display-removed', displayChanged); screen.on('display-metrics-changed', displayChanged)
  subscriptions.push(() => { screen.removeListener('display-removed', displayChanged); screen.removeListener('display-metrics-changed', displayChanged) })
  void sessionManager.whenInitialized().then(() => {
    if (!host || generation !== currentGeneration) return
    initialized = true; applyPreferences(); deliver()
    deliveryTimer = setInterval(deliver, 2000); deliveryTimer.unref()
  }).catch(error => { lastError = errorText(error) })
}

function applyPreferences(): void {
  if (preferences().enabled) showDesktopCompanion()
  else companion?.hide()
  host?.onVisibilityChange?.()
  publish()
}
function resizeCompanion(): void {
  if (!companion || companion.isDestroyed()) return
  const before = companion.getBounds(), size = desktopCompanionSize(preferences().size, expanded, preferences().mode)
  const area = screen.getDisplayMatching(before).workArea
  const next = clampCompanionBounds({ x: before.x + before.width - size.width, y: before.y + before.height - size.height, ...size }, area)
  if (JSON.stringify(before) !== JSON.stringify(next)) companion.setBounds(next)
}
function savePosition(): void {
  if (!companion || companion.isDestroyed() || !initialized) return
  const bounds = companion.getBounds(), prefs = preferences(), displayId = String(screen.getDisplayMatching(bounds).id)
  if (prefs.position?.x === bounds.x && prefs.position?.y === bounds.y && prefs.displayId === displayId) return
  try { updateSettings({ desktopCompanion: { ...prefs, position: { x: bounds.x, y: bounds.y }, displayId } }) }
  catch (error) { lastError = errorText(error); publish() }
}
export function showDesktopCompanion(): void {
  if (!host || !initialized) return
  if (companion && !companion.isDestroyed()) { resizeCompanion(); companion.showInactive(); return }
  const prefs = preferences(), size = desktopCompanionSize(prefs.size, expanded, prefs.mode)
  const display = screen.getAllDisplays().find(item => String(item.id) === prefs.displayId) ?? screen.getPrimaryDisplay()
  const area = display.workArea
  const bounds = clampCompanionBounds({ ...size, x: prefs.position?.x ?? area.x + area.width - size.width - 24,
    y: prefs.position?.y ?? area.y + area.height - size.height - 24 }, area)
    const win = new BrowserWindow({ ...bounds, title: 'EastGenesis · 随侍', show: false, frame: false, transparent: true,
    resizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, partition: 'persist:caogen-companion', additionalArguments: ['--caogen-desktop-companion'] } })
  companion = win
  registerDesktopWindow(win, 'companion')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === win.webContents && permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio' && companionVoice.permitsMicrophone(contents.id))
  })
  win.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === win.webContents && permission === 'media' && details.mediaType === 'audio' && companionVoice.permitsMicrophone(contents.id))
  const cancelVoice = (): void => companionVoice.cancelOwner(win.webContents.id)
  win.on('hide', () => { cancelVoice(); expanded = false; publish() })
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => { if (main && !inPlace) cancelVoice() })
  const voiceOwner = win.webContents.id
  win.webContents.once('destroyed', () => companionVoice.cancelOwner(voiceOwner))
  win.on('move', () => { if (moveTimer) clearTimeout(moveTimer); moveTimer = setTimeout(savePosition, 250) })
  win.on('closed', () => { if (companion === win) companion = null })
  const url = process.env.ELECTRON_RENDERER_URL
  void (url ? win.loadURL(url) : win.loadFile(join(__dirname, '../renderer/index.html'))).then(() => {
    if (!win.isDestroyed() && preferences().enabled) { win.showInactive(); publish() }
  }).catch(error => { lastError = errorText(error); if (!win.isDestroyed()) win.destroy() })
}
export function disposeDesktopCompanion(): void {
  generation++; initialized = false
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
  for (const channel of channels.splice(0)) ipcMain.removeHandler(channel)
  if (publishTimer) clearTimeout(publishTimer)
  if (moveTimer) clearTimeout(moveTimer)
  if (deliveryTimer) clearInterval(deliveryTimer)
  publishTimer = undefined; moveTimer = undefined; deliveryTimer = undefined
  companion?.destroy(); companion = null; host = undefined; readyContents = undefined; outbox = undefined; navigation = undefined
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
