import {
  BrowserWindow,
  app,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  systemPreferences
} from 'electron'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { saveImageAttachmentBytes } from '../attachmentOps'
import { ocrImage } from '../imageOcr'
import { assertTrustedWorkflowLedgerSender } from '../ipc/workflow-ledger-handlers'
import { sessionManager } from '../sessionManager'
import { getSettings } from '../settings'
import { shortcutFor } from '../../shared/desktop-shortcuts'
import type {
  ImageAttachmentView,
  QuickbarClipboardInput,
  QuickbarContextResult,
  QuickbarEvent,
  QuickbarEventSource,
  QuickbarFileInput,
  QuickbarPayloadResult,
  QuickbarScreenshotInput,
  QuickbarState,
  QuickbarWindowContext,
  SendMessagePayload
} from '../../shared/types'

const DEFAULT_ACCELERATOR = shortcutFor('quickbar')!
const QUICKBAR_FILE_LIMIT = 40

interface QuickbarControllerOptions {
  getMainWindow?: () => BrowserWindow | null
  showMainWindow?: () => void
}

interface FileContext {
  path: string
  kind: 'file' | 'directory' | 'other'
  exists: boolean
  bytes?: number
  error?: string
}

class QuickbarController {
  private options: QuickbarControllerOptions = {}
  private visible = false
  private accelerator = DEFAULT_ACCELERATOR
  private registered = false
  private registrationError: string | undefined

  configure(options: QuickbarControllerOptions): void {
    this.options = { ...this.options, ...options }
  }

  registerGlobalShortcut(): QuickbarState {
    this.unregisterGlobalShortcut()
    const configured = shortcutFor('quickbar', getSettings().desktopShortcuts)
    if (!configured) { this.accelerator = ''; this.registrationError = undefined; return this.getState() }
    const candidates = [configured]
    for (const candidate of candidates) {
      const ok = globalShortcut.register(candidate, () => {
        this.setVisible(!this.visible, 'global-shortcut')
      })
      if (ok) {
        this.accelerator = candidate
        this.registered = true
        this.registrationError = undefined
        return this.getState()
      }
    }
    this.accelerator = configured
    this.registered = false
    this.registrationError = `Quickbar 全局快捷键注册失败：系统可能已占用 ${configured}。请在设置中更换快捷键。`
    return this.getState()
  }

  unregisterGlobalShortcut(): void {
    if (this.registered && this.accelerator && globalShortcut.isRegistered(this.accelerator)) globalShortcut.unregister(this.accelerator)
    this.registered = false
  }

  dispose(): void {
    this.unregisterGlobalShortcut()
  }

  getState(): QuickbarState {
    return {
      visible: this.visible,
      accelerator: this.accelerator,
      registered: this.registered,
      platform: process.platform,
      ...(process.platform === 'darwin' ? { screenCapturePermission: systemPreferences.getMediaAccessStatus('screen') } : {}),
      ...(this.registrationError ? { registrationError: this.registrationError } : {})
    }
  }

  setVisible(visible: boolean, source: QuickbarEventSource): QuickbarState {
    this.visible = visible
    if (visible) this.options.showMainWindow?.()
    this.emit({ kind: 'visibility', visible, source })
    return this.getState()
  }

  private emit(event: QuickbarEvent): void {
    const win = this.options.getMainWindow?.() ?? BrowserWindow.getAllWindows()[0] ?? null
    if (!win || win.isDestroyed()) return
    win.webContents.send('quickbar:event', event)
  }
}

export const quickbarController = new QuickbarController()

export function configureQuickbar(options: QuickbarControllerOptions): void {
  quickbarController.configure(options)
}

export function registerQuickbarGlobalShortcut(): QuickbarState {
  return quickbarController.registerGlobalShortcut()
}

export function disposeQuickbar(): void {
  quickbarController.dispose()
}

export function registerQuickbarIpc(): void {
  ipcMain.handle('quickbar:getState', (event) => { assertTrustedWorkflowLedgerSender(event); return quickbarController.getState() })
  ipcMain.handle('quickbar:setVisible', (event, visible: boolean) => {
    assertTrustedWorkflowLedgerSender(event)
    return quickbarController.setVisible(visible === true, 'renderer')
  })
  ipcMain.handle('quickbar:getWindowContext', (event, cwd?: string, sourceId?: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return getQuickbarWindowContext(cwd, sourceId)
  })
  ipcMain.handle('quickbar:readClipboard', (event, input?: QuickbarClipboardInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return readQuickbarClipboard(input)
  })
  ipcMain.handle('quickbar:captureScreenshot', (event, input: QuickbarScreenshotInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return captureQuickbarScreenshot(input)
  })
  ipcMain.handle('quickbar:pickFiles', async (event) => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openFile', 'openDirectory', 'multiSelections']
        })
      : await dialog.showOpenDialog({
          properties: ['openFile', 'openDirectory', 'multiSelections']
        })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('quickbar:prepareFiles', (event, input: QuickbarFileInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return prepareQuickbarFiles(input)
  })
}

export async function getQuickbarWindowContext(
  cwd?: string,
  sourceId?: string
): Promise<QuickbarContextResult> {
  const resolvedCwd = resolveCwd(cwd)
  try {
    // Enumerate names only. Opening Quickbar must not capture pixels or AX text.
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    const windows: QuickbarWindowContext[] = sources.map(source => ({ id: source.id, name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window', platform: 'electron' }))
    const current = sourceId ? windows.find(item => item.id === sourceId) : undefined
    return {
      ok: true,
      cwd: resolvedCwd,
      capturedAt: Date.now(),
      ...(current ? { current } : {}),
      windows
    }
  } catch (err) {
    return {
      ok: false,
      cwd: resolvedCwd,
      capturedAt: Date.now(),
      windows: [],
      error: errorMessage(err)
    }
  }
}

export async function readQuickbarClipboard(
  input: QuickbarClipboardInput = {}
): Promise<QuickbarPayloadResult> {
  const text = clipboard.readText().trim()
  if (!text) return { ok: false, error: '剪贴板没有可投递的文本内容' }
  const context = input.includeWindowContext === false ? undefined : await getQuickbarWindowContext(input.cwd)
  const payload: SendMessagePayload = {
    text: [
  '[EastGenesis Quickbar 剪贴板上下文]',
      contextLines(context),
      input.note?.trim() ? `备注: ${input.note.trim()}` : '',
      '',
      text
    ]
      .filter(Boolean)
      .join('\n')
  }
  return { ok: true, payload, ...(context ? { context } : {}) }
}

export async function captureQuickbarScreenshot(
  input: QuickbarScreenshotInput
): Promise<QuickbarPayloadResult> {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : ''
  const session = sessionId ? sessionManager.get(sessionId) : undefined
  if (!session || session.meta.status === 'closed') return { ok: false, error: '截图需要一个仍然存在的目标任务。' }
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
  const expectedName = typeof input.expectedSourceName === 'string' ? input.expectedSourceName : ''
  if (!sourceId || !expectedName) return { ok: false, error: '请明确选择要截取的窗口或屏幕。' }
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 3840, height: 2160 }, fetchWindowIcons: false })
    const source = sources.find(item => item.id === sourceId)
    if (!source || source.name !== expectedName) return { ok: false, error: '所选窗口已关闭或来源发生变化，请刷新并重新选择。' }
  if (!source.thumbnail || source.thumbnail.isEmpty()) return { ok: false, error: '截图为空。请检查系统屏幕录制权限，必要时重新启动 EastGenesis。' }
    if (!sessionManager.get(sessionId) || sessionManager.get(sessionId)?.meta.status === 'closed') return { ok: false, error: '目标任务已关闭，截图未附加。' }
    const requestedWidth = typeof input.maxWidth === 'number' && Number.isFinite(input.maxWidth) ? input.maxWidth : 1440
    const width = Math.min(source.thumbnail.getSize().width, Math.max(320, Math.min(3840, Math.floor(requestedWidth))))
    const screenshot = source.thumbnail.resize({ width })
    if (screenshot.isEmpty()) return { ok: false, error: '截图数据不可用，请重新选择。' }
    const copied = await saveImageAttachmentBytes(screenshot.toPNG(), attachmentRoot(sessionId), { mime: 'image/png' })
    if (!copied.ok) return copied
    const ocr = input.includeOcr === true ? await ocrImage(copied.path) : undefined
    if (!sessionManager.get(sessionId) || sessionManager.get(sessionId)?.meta.status === 'closed') return { ok: false, error: '目标任务已关闭，截图未附加。' }
    const { ok: _ok, ...image } = copied
    const selected: QuickbarWindowContext = { id: source.id, name: source.name, kind: source.id.startsWith('screen:') ? 'screen' : 'window', platform: 'electron' }
    const context: QuickbarContextResult = { ok: true, cwd: session.meta.cwd, capturedAt: Date.now(), current: selected, windows: [selected] }
    const size = screenshot.getSize()
    const payload: SendMessagePayload = {
      text: [input.note?.trim(), `截图来源：${source.name}`, `尺寸：${size.width} × ${size.height}`,
        ocr?.ok && ocr.text ? `截图文字识别（${ocr.engine ?? '本机 OCR'}，可能有误）：\n${ocr.text}` : ''].filter(Boolean).join('\n\n'),
      images: [image as ImageAttachmentView]
    }
    return { ok: true, sessionId, payload, screenshotPath: copied.path, context,
      imagePreviews: { [image.id]: screenshot.resize({ width: Math.min(360, size.width) }).toDataURL() },
      ...(ocr && !ocr.ok ? { warning: ocr.error || '未识别到文字，截图已加入草稿。' } : {}) }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export async function prepareQuickbarFiles(input: QuickbarFileInput): Promise<QuickbarPayloadResult> {
  const cwd = resolveCwd(input.cwd)
  const paths = Array.isArray(input.paths) ? input.paths : []
  const files = paths
    .flatMap((raw) => normalizePathListItem(raw, cwd))
    .slice(0, QUICKBAR_FILE_LIMIT)
    .map(fileContext)
  if (files.length === 0) return { ok: false, error: '没有可投递的文件路径' }

  const context = input.includeWindowContext === false ? undefined : await getQuickbarWindowContext(cwd)
  const payload: SendMessagePayload = {
    text: [
  '[EastGenesis Quickbar 文件路径上下文]',
      `工作目录: ${cwd}`,
      contextLines(context),
      input.note?.trim() ? `备注: ${input.note.trim()}` : '',
      '',
      ...files.map(formatFileContext),
      '',
      '请根据这些本机路径加载或检查相关文件。'
    ]
      .filter(Boolean)
      .join('\n')
  }
  return { ok: true, payload, files, ...(context ? { context } : {}) }
}

function attachmentRoot(sessionId: string): string {
  return resolve(app.getPath('userData'), 'attachments', sessionId)
}

function resolveCwd(cwd?: string, sessionId?: string): string {
  const sessionCwd = sessionId ? sessionManager.get(sessionId)?.meta.cwd : undefined
  const raw = cwd?.trim() || sessionCwd || homedir()
  return resolve(raw)
}

function contextLines(context: QuickbarContextResult | undefined): string {
  const current = context?.current
  if (!current) return ''
  const name = current.title || current.name
  const owner = current.processName ? ` (${current.processName})` : ''
  return `当前窗口: ${name}${owner}`
}

function normalizePathListItem(raw: string, cwd: string): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const withoutFileScheme = item.startsWith('file://') ? decodeURIComponent(new URL(item).pathname) : item
      return resolve(cwd, withoutFileScheme)
    })
}

function fileContext(path: string): FileContext {
  try {
    if (path.includes('\0')) return { path, kind: 'other', exists: false, error: '路径包含非法字符' }
    const info = statSync(path)
    return {
      path,
      kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
      exists: true,
      ...(info.isFile() ? { bytes: info.size } : {})
    }
  } catch (err) {
    return { path, kind: 'other', exists: false, error: errorMessage(err) }
  }
}

function formatFileContext(item: FileContext): string {
  const label = item.exists ? item.kind : 'missing'
  const bytes = typeof item.bytes === 'number' ? `, ${item.bytes} bytes` : ''
  const error = item.error ? `, ${item.error}` : ''
  return `- ${item.path} (${label}${bytes}${error})`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
