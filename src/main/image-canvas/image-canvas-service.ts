import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ImageAttachmentView, PreviewAnnotation, SessionMeta, TranscriptEntry, UserMessageAttachmentView } from '../../shared/types'
import type { StudioResultArtifact, StudioResultRun } from '../../shared/studio-result-types'
import { imageAttachmentReferenceHash } from '../../shared/attachment-types'
import type { TaskImageAnnotationInput, TaskImageAsset, TaskImageCollection, TaskImageDraft, TaskImageItem } from '../../shared/image-canvas-types'
import { DEFAULT_MAX_IMAGE_BYTES, imageAttachmentRefToContentBlock, prepareImageAttachmentBytes, sessionImageAttachmentsRoot, type PreparedImageAttachment } from '../attachmentOps'
import { listPreviewAnnotations, savePreviewAnnotation } from '../previewAnnotations'

type CanvasMeta = Pick<SessionMeta, 'id' | 'createdAt' | 'cwd' | 'sdkSessionId' | 'workspaceId' | 'projectId' | 'goalId' | 'workItemId' | 'status'>
export interface ImageCanvasContext { meta: CanvasMeta; transcript: TranscriptEntry[]; artifacts: StudioResultArtifact[]; runs: StudioResultRun[]; warnings?: string[] }
export interface ImageCanvasDependencies {
  load(sessionId: string): Promise<ImageCanvasContext>
  stage(meta: CanvasMeta, prepared: PreparedImageAttachment): Promise<ImageAttachmentView>
  preview(prepared: PreparedImageAttachment, thumbnail: boolean): Omit<TaskImageAsset, 'imageId'>
}
interface ImageSource { item: TaskImageItem; attachment?: UserMessageAttachmentView; path?: string }
interface Collection { owner: number; sessionId: string; taskKey: string; sources: ImageSource[]; expiresAt: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const contentHash = (value: string | undefined) => value?.match(/^(?:sha256:)?([a-f0-9]{64})$/)?.[1]
const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }
export function imageCanvasTaskKey(meta: CanvasMeta): string { return digest([meta.id, meta.createdAt, meta.cwd, meta.sdkSessionId, meta.workspaceId ?? meta.projectId, meta.goalId, meta.workItemId]) }
export function validateImageCanvasAnnotation(input: TaskImageAnnotationInput): TaskImageAnnotationInput {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['note', 'boundingBox'].includes(key)) || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 8000) throw new Error('请填写 1 至 8000 字的批注。')
  const box = input.boundingBox
  if (box && (Object.keys(box).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
    ![box.x, box.y, box.width, box.height].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
    box.width <= 0 || box.height <= 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001)) throw new Error('图片批注区域无效。')
  return { note: input.note.trim(), ...(box ? { boundingBox: { ...box } } : {}) }
}
export class ImageCanvasService {
  private readonly collections = new Map<string, Collection>()
  constructor(private readonly root: string, private readonly deps: ImageCanvasDependencies, private readonly now = Date.now) {}
  async list(owner: number, sessionId: string): Promise<TaskImageCollection> {
    const context = await this.deps.load(sessionId), sources = sourcesFor(context)
    this.requireLive(context, sessionId)
    for (const [id, item] of this.collections) if (item.expiresAt <= this.now()) this.collections.delete(id)
    const owned = [...this.collections].filter(([, item]) => item.owner === owner)
    for (const [id] of owned.slice(0, Math.max(0, owned.length - 15))) this.collections.delete(id)
    const collectionId = randomUUID(), taskKey = imageCanvasTaskKey(context.meta)
    this.collections.set(collectionId, { owner, sessionId, taskKey, sources: sources.slice(0, 500), expiresAt: this.now() + 10 * 60_000 })
    return { collectionId, taskKey, sessionId, images: sources.slice(0, 500).map(source => source.item), warnings: [...context.warnings ?? [], ...(sources.length > 500 ? ['图片超过 500 张，此处显示前 500 张。'] : [])] }
  }
  async read(owner: number, sessionId: string, collectionId: string, imageId: string, thumbnail = false): Promise<TaskImageAsset> {
    const { source, context } = await this.current(owner, sessionId, collectionId, imageId)
    const prepared = await this.bytes(source, sessionId)
    await this.checkTask(context, sessionId)
    return { imageId, ...this.deps.preview(prepared, thumbnail) }
  }
  async draft(owner: number, sessionId: string, collectionId: string, ids: string[]): Promise<TaskImageDraft> {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('每次选择 1 至 16 张图片。')
    const frozen = this.collection(owner, sessionId, collectionId)
    const prepared: Array<{ source: ImageSource; bytes: PreparedImageAttachment; context: ImageCanvasContext }> = []
    let totalBytes = 0
    // Verify every source before any attachment staging can occur.
    for (const id of ids) {
      const current = await this.current(owner, sessionId, collectionId, id)
      const bytes = await this.bytes(current.source, sessionId)
      totalBytes += bytes.bytes
      if (totalBytes > 32 * 1024 * 1024) throw new Error('所选图片总大小超过 32 MB，请减少图片数量。')
      prepared.push({ ...current, bytes })
    }
    const images: ImageAttachmentView[] = [], imagePreviews: Record<string, string> = {}, references: TaskImageDraft['references'] = []
    for (const value of prepared) {
      await this.checkTask(value.context, sessionId)
      let attachment = images.find(image => image.hash === value.bytes.hash)
      if (!attachment) {
        // Existing attachments retain their exact object identity and file reference.
        attachment = value.source.attachment ? { id: value.bytes.hash, hash: value.bytes.hash,
          path: join(sessionImageAttachmentsRoot(this.root, sessionId), `${value.bytes.hash}${extensions[value.bytes.mime]}`),
          mime: value.bytes.mime, bytes: value.bytes.bytes, createdAt: new Date(this.now()).toISOString() }
          : await this.deps.stage(value.context.meta, value.bytes)
        images.push(attachment)
        imagePreviews[attachment.id] = this.deps.preview(value.bytes, true).dataUrl
      }
      references.push({ imageId: value.source.item.id, attachmentId: attachment.id, title: value.source.item.title,
        sourcePath: value.source.item.sourcePath, artifactId: value.source.item.artifactId, version: value.source.item.version, digest: `sha256:${value.bytes.hash}` })
    }
    await this.checkTask(prepared[0].context, sessionId)
    return { sessionId, taskKey: frozen.taskKey, images, imagePreviews, references }
  }
  async annotations(owner: number, sessionId: string, collectionId: string, imageId: string): Promise<PreviewAnnotation[]> {
    await this.current(owner, sessionId, collectionId, imageId)
    return listPreviewAnnotations(join(this.root, 'preview-annotations'), sessionId, annotationPath(imageId))
  }
  async annotate(owner: number, sessionId: string, collectionId: string, imageId: string, raw: TaskImageAnnotationInput): Promise<PreviewAnnotation> {
    const input = validateImageCanvasAnnotation(raw), { source, context } = await this.current(owner, sessionId, collectionId, imageId)
    await this.bytes(source, sessionId)
    await this.checkTask(context, sessionId)
    return savePreviewAnnotation(join(this.root, 'preview-annotations'), sessionId, {
      sessionId, path: annotationPath(imageId), type: 'image', mime: source.item.mime, note: input.note,
      boundingBox: input.boundingBox, locator: { selector: `image-canvas:${imageId}:normalized`, quote: source.item.digest }
    })
  }
  releaseOwner(owner: number): void { for (const [id, item] of this.collections) if (item.owner === owner) this.collections.delete(id) }
  private collection(owner: number, sessionId: string, id: string): Collection {
    const found = this.collections.get(id)
    if (!found || found.owner !== owner || found.sessionId !== sessionId || found.expiresAt <= this.now()) throw new Error('图片集合已过期或不属于此任务窗口，请刷新。')
    found.expiresAt = this.now() + 10 * 60_000
    return found
  }
  private async current(owner: number, sessionId: string, collectionId: string, imageId: string) {
    const collection = this.collection(owner, sessionId, collectionId), context = await this.deps.load(sessionId)
    this.requireLive(context, sessionId)
    if (imageCanvasTaskKey(context.meta) !== collection.taskKey) throw new Error('原任务归属已变化，请重新打开图片工作台。')
    const frozen = collection.sources.find(value => value.item.id === imageId)
    const source = sourcesFor(context).find(value => value.item.id === imageId)
    if (!frozen || !source || digest(frozen) !== digest(source)) throw new Error('图片来源或版本已变化，请刷新集合。')
    if (source.item.unavailableReason) throw new Error(source.item.unavailableReason)
    return { source, context }
  }
  private requireLive(context: ImageCanvasContext, sessionId: string): void {
    if (context.meta.id !== sessionId || context.meta.status === 'closed') throw new Error('原任务已关闭，无法继续操作图片。')
  }
  private async checkTask(previous: ImageCanvasContext, sessionId: string): Promise<void> {
    const current = await this.deps.load(sessionId)
    this.requireLive(current, sessionId)
    if (imageCanvasTaskKey(previous.meta) !== imageCanvasTaskKey(current.meta)) throw new Error('原任务归属已变化，未加入草稿。')
  }
  private async bytes(source: ImageSource, sessionId: string): Promise<PreparedImageAttachment> {
    if (source.attachment) {
      const block = imageAttachmentRefToContentBlock(source.attachment, sessionImageAttachmentsRoot(this.root, sessionId)) as { source: { data: string; media_type: string } }
      return prepareImageAttachmentBytes(block.source.data, { mime: block.source.media_type })
    }
    if (!source.path || !isAbsolute(source.path) || !contentHash(source.item.digest)) throw new Error('图片没有可核对的本地文件版本。')
    const data = await readVerifiedImageFile(source.path, source.item.bytes, contentHash(source.item.digest)!)
    return prepareImageAttachmentBytes(data, { mime: source.item.mime })
  }
}
function annotationPath(imageId: string): string {
  if (!/^[a-f0-9]{64}$/.test(imageId)) throw new Error('图片身份无效。')
  return `image-canvas/${imageId}.image`
}
function sourcesFor(context: ImageCanvasContext): ImageSource[] {
  const result = new Map<string, ImageSource>()
  for (const entry of context.transcript) {
    if (entry.event.kind !== 'user-message') continue
    for (const recorded of entry.event.attachments ?? []) {
      if (!recorded.mime.startsWith('image/')) continue
      // Only a digest-shaped historical ID can fill a missing hash. bytes() still
      // checks task-local path, file type, MIME signature, size and SHA-256.
      const attachment = { ...recorded, hash: imageAttachmentReferenceHash(recorded) }
      const id = digest(['attachment', attachment.id, attachment.hash, attachment.mime, attachment.bytes])
      if (result.has(id)) continue
      result.set(id, { attachment, item: { id, source: 'attachment', attachmentId: attachment.id, title: `图片 ${result.size + 1}`,
        digest: attachment.hash ? `sha256:${attachment.hash}` : undefined, mime: attachment.mime, bytes: attachment.bytes,
        unavailableReason: !contentHash(attachment.hash) ? '这张旧图片没有持久内容摘要，无法安全恢复，请重新添加。' : !extensions[attachment.mime] ? '暂不支持这种图片格式。' : undefined } })
    }
  }
  const runs = new Set(context.runs.filter(run => run.sessionId === context.meta.id).map(run => run.id))
  for (const artifact of context.artifacts) {
    if (!(artifact.runId && runs.has(artifact.runId)) && !(context.meta.workItemId && artifact.workItemId === context.meta.workItemId)) continue
    const location = artifact.locations.find(value => value.availability === 'available' && value.path && ['workspace_file', 'artifact_store', 'local_file'].includes(value.kind))
      ?? artifact.locations.find(value => value.availability === 'available' && value.path)
    const mime = artifact.mediaType ?? location?.mediaType ?? ''
    if (!mime.startsWith('image/')) continue
    const id = digest(['artifact', artifact.id, artifact.version, artifact.digest, location?.id, location?.path])
    result.set(id, { path: location?.path, item: { id, source: 'artifact', artifactId: artifact.id, version: artifact.version, digest: artifact.digest,
      title: artifact.title, sourcePath: location?.path, mime, bytes: location?.sizeBytes ?? 0,
      unavailableReason: !extensions[mime] ? '暂不支持这种图片格式。' : !location?.path ? '图片没有可用的本地文件。' : !contentHash(artifact.digest) ? '图片缺少可核对的内容摘要。' : location.checksum && contentHash(location.checksum) !== contentHash(artifact.digest) ? '图片位置与成果摘要不一致。' : undefined } })
  }
  return [...result.values()]
}
async function readVerifiedImageFile(path: string, expectedBytes: number, hash: string): Promise<Buffer> {
  if (expectedBytes <= 0 || expectedBytes > DEFAULT_MAX_IMAGE_BYTES) throw new Error('图片大小无效或超过 5 MB。')
  if (await realpath(path) !== resolve(path)) throw new Error('图片路径包含符号链接，无法核对原文件。')
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expectedBytes)) throw new Error('图片文件类型或大小已变化。')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('图片文件正在变化，请重试。')
    const buffer = Buffer.alloc(expectedBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const data = buffer.subarray(0, offset), after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true })
    if (data.length !== expectedBytes || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.dev !== after.dev || current.ino !== after.ino || await realpath(path) !== resolve(path) || createHash('sha256').update(data).digest('hex') !== hash) throw new Error('图片内容已变化，未使用这个旧版本。')
    return data
  } finally { await handle.close() }
}
