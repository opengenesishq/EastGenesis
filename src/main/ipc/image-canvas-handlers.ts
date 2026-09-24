import { app, BrowserWindow, ipcMain, nativeImage, type IpcMainInvokeEvent } from 'electron'
import type { TaskImageAnnotationInput } from '../../shared/image-canvas-types'
import { sessionManager } from '../sessionManager'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { studioResultSnapshotForSession } from './studio-result-handlers'
import { ImageCanvasService, type ImageCanvasContext } from '../image-canvas/image-canvas-service'
import { executePreparedImageAttachmentEffect } from '../attachmentEffect'
import { sessionImageAttachmentsRoot } from '../attachmentOps'

let instance: ImageCanvasService | undefined
const contextReads = new Map<string, Promise<ImageCanvasContext>>()
/** Share concurrent catalog reads across thumbnails; never reuse a completed observation. */
async function loadImageContext(sessionId: string): Promise<ImageCanvasContext> {
  const existing = contextReads.get(sessionId)
  if (existing) return existing
  const pending = (async () => {
    await sessionManager.whenInitialized()
    const found = sessionManager.get(sessionId)
    if (!found || found.meta.status === 'closed') throw new Error('原任务已关闭或不存在。')
    const meta = { ...found.meta }
    const result = meta.workspaceId ? await studioResultSnapshotForSession(sessionId) : undefined
    return { meta, transcript: sessionManager.getTranscript(sessionId), artifacts: result?.artifacts ?? [], runs: result?.runs ?? [] }
  })()
  contextReads.set(sessionId, pending)
  try { return await pending } finally { if (contextReads.get(sessionId) === pending) contextReads.delete(sessionId) }
}
function service(): ImageCanvasService {
  return instance ??= new ImageCanvasService(app.getPath('userData'), {
    load: loadImageContext,
    async stage(meta, prepared) {
      const result = await executePreparedImageAttachmentEffect({ sourceSessionId: meta.id, cwd: meta.cwd,
        projectId: meta.projectId, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId,
        rootDir: app.getPath('userData'), attachmentsRoot: sessionImageAttachmentsRoot(app.getPath('userData'), meta.id) }, prepared, 'user_file')
      if (!result.ok) throw new Error(result.error)
      return result
    },
    preview(prepared, thumbnail) {
      const image = nativeImage.createFromBuffer(prepared.data)
      if (image.isEmpty()) throw new Error('无法解码这张图片。')
      const { width, height } = image.getSize()
      const max = 200, ratio = Math.min(1, max / Math.max(width, height))
      return { dataUrl: thumbnail ? image.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }).toDataURL()
        : `data:${prepared.mime};base64,${prepared.data.toString('base64')}`, width, height }
    }
  })
}
export function registerImageCanvasIpc(): void {
  const owners = new Set<number>()
  const owner = (event: IpcMainInvokeEvent, sessionId: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender), role = win && desktopWindowRole(win)
    if (!win || win.isDestroyed() || !['main', 'task'].includes(role ?? '') || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('图片工作台只能从原任务窗口打开。')
    if (role === 'task' && taskSessionForWindow(win) !== sessionId) throw new Error('无法访问其他任务的图片。')
    if (!owners.has(event.sender.id)) {
      owners.add(event.sender.id)
      const id = event.sender.id
      event.sender.once('destroyed', () => { service().releaseOwner(id); owners.delete(id) })
    }
    return event.sender.id
  }
  const ids = (collectionId: unknown, imageId: unknown) => {
    if (typeof collectionId !== 'string' || collectionId.length > 100 || typeof imageId !== 'string' || !/^[a-f0-9]{64}$/.test(imageId)) throw new Error('图片身份参数无效。')
    return { collectionId, imageId }
  }
  ipcMain.handle('images:list', (event, sessionId: string) => service().list(owner(event, sessionId), sessionId))
  ipcMain.handle('images:read', (event, sessionId: string, collectionId: string, imageId: string, thumbnail?: boolean) => {
    const sender = owner(event, sessionId); ids(collectionId, imageId)
    if (thumbnail !== undefined && typeof thumbnail !== 'boolean') throw new Error('图片预览参数无效。')
    return service().read(sender, sessionId, collectionId, imageId, thumbnail)
  })
  ipcMain.handle('images:draft', (event, sessionId: string, collectionId: string, imageIds: string[]) => {
    const sender = owner(event, sessionId)
    if (typeof collectionId !== 'string' || !Array.isArray(imageIds)) throw new Error('图片草稿参数无效。')
    return service().draft(sender, sessionId, collectionId, imageIds)
  })
  ipcMain.handle('images:annotations', (event, sessionId: string, collectionId: string, imageId: string) => {
    const sender = owner(event, sessionId); ids(collectionId, imageId)
    return service().annotations(sender, sessionId, collectionId, imageId)
  })
  ipcMain.handle('images:annotate', (event, sessionId: string, collectionId: string, imageId: string, input: TaskImageAnnotationInput) => {
    const sender = owner(event, sessionId); ids(collectionId, imageId)
    return service().annotate(sender, sessionId, collectionId, imageId, input)
  })
}
