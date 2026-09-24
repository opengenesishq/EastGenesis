import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { TranscriptEntry } from '../../shared/types'
import type { TaskSourceItem, TaskSourcePreview } from '../../shared/task-source-types'
import { imageAttachmentReferenceHash } from '../../shared/attachment-types'
import { prepareImageAttachmentBytes, sessionImageAttachmentsRoot } from '../attachmentOps'
import { detectPreviewKind, prepareOfficeText, preparePdfText } from '../previewOps'

export interface SourceFile { item: TaskSourceItem; path?: string; attachmentImage?: boolean }
export const sourceDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sourceContentHash = (value: string | undefined): string | undefined => value?.match(/^(?:sha256:)?([a-f0-9]{64})$/)?.[1]
const imageExtensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const mimeByExtension: Record<string, string> = Object.fromEntries(Object.entries(imageExtensions).map(([mime, extension]) => [extension, mime]))
const MAX_ITEMS = 500

async function ordinaryDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('附件目录包含符号链接或不是普通目录。')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function fileAvailability(path: string, expectedBytes?: number): Promise<{ bytes?: number; unavailableReason?: string }> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) return { unavailableReason: '附件路径包含符号链接或不是普通文件。' }
    if (expectedBytes !== undefined && info.size !== expectedBytes) return { bytes: expectedBytes, unavailableReason: '附件大小与发送记录不一致。' }
    return { bytes: info.size }
  } catch (error) {
    return { unavailableReason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? '原附件文件已不存在。' : '原附件暂时无法读取。' }
  }
}

/** Only inventories this task's frozen vault, never cwd or arbitrary renderer paths. */
export async function taskAttachmentSources(root: string, sessionId: string, transcript: TranscriptEntry[]): Promise<{ sources: SourceFile[]; warnings: string[] }> {
  const sources = new Map<string, SourceFile>(), warnings: string[] = [], vault = sessionImageAttachmentsRoot(root, sessionId)
  const knownPaths = new Set<string>()
  for (const entry of transcript) {
    if (entry.event.kind !== 'user-message') continue
    for (const reference of entry.event.attachments ?? []) {
      const hash = imageAttachmentReferenceHash(reference), extension = imageExtensions[reference.mime]
      const path = hash && extension ? join(vault, `${hash}.${extension}`) : undefined
      const id = sourceDigest(['attachment', hash ?? reference.id, reference.mime])
      if (path) knownPaths.add(path)
      if (sources.size >= MAX_ITEMS && !sources.has(id)) continue
      const availability = path ? await fileAvailability(path, reference.bytes) : { unavailableReason: '旧附件缺少可核对的内容摘要或受支持的格式。' }
      sources.set(id, { path, attachmentImage: true, item: { id, kind: 'attachment', provenance: 'message_attachment',
        title: `图片 ${hash?.slice(0, 10) ?? reference.id.slice(0, 10)}`, digest: hash ? `sha256:${hash}` : undefined,
        mime: reference.mime, bytes: reference.bytes, ...availability } })
    }
  }
  let truncated = sources.size >= MAX_ITEMS
  try {
    if (await ordinaryDirectory(vault)) {
      const groups = [{ path: vault, document: false }, { path: join(vault, 'documents', 'S2'), document: true }, { path: join(vault, 'documents', 'S3'), document: true }]
      for (const group of groups) {
        if (!await ordinaryDirectory(group.path)) continue
        const names = (await readdir(group.path)).sort()
        for (const name of names) {
          const match = name.match(group.document ? /^([a-f0-9]{64})\.txt$/ : /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/)
          if (!match) continue
          const path = join(group.path, name)
          if (knownPaths.has(path)) continue
          if (sources.size >= MAX_ITEMS) { truncated = true; break }
          const hash = match[1], mime = group.document ? 'text/plain; charset=utf-8' : mimeByExtension[match[2]]
          const id = sourceDigest(['imported-attachment', hash, mime, group.document ? group.path.slice(-2) : 'image'])
          sources.set(id, { path, attachmentImage: !group.document, item: { id, kind: 'attachment', provenance: 'imported_attachment',
            title: group.document ? `文档 ${hash.slice(0, 10)}.txt` : `图片 ${hash.slice(0, 10)}`, digest: `sha256:${hash}`, mime,
            ...await fileAvailability(path) } })
        }
      }
    }
  } catch { warnings.push('部分任务附件目录无法读取，未扫描其他目录。') }
  if (truncated) warnings.push('附件较多，此处最多显示 500 项。')
  return { sources: [...sources.values()], warnings }
}

/** Reads once, checks identity and digest, then parses those same bytes. */
export async function verifiedSourcePreview(source: SourceFile): Promise<TaskSourcePreview> {
  const hash = sourceContentHash(source.item.digest), path = source.path
  if (!path || !isAbsolute(path) || !hash) throw new Error('资料缺少可核对的本地文件或内容摘要。')
  const kind = detectPreviewKind(path), maxBytes = kind.mode === 'text' && kind.type !== 'office' ? 1_000_000 : 20_000_000
  if (await realpath(path) !== resolve(path)) throw new Error('资料路径包含符号链接，无法核对原文件。')
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes) || (source.item.bytes !== undefined && before.size !== BigInt(source.item.bytes))) throw new Error('资料文件类型或大小已变化，或超过预览限制。')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let data: Buffer
  try {
    const opened = await handle.stat({ bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('资料文件正在变化，请重试。')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    data = buffer.subarray(0, offset)
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true })
    if (BigInt(data.length) !== before.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.dev !== after.dev || current.ino !== after.ino || await realpath(path) !== resolve(path) || createHash('sha256').update(data).digest('hex') !== hash) throw new Error('资料内容与登记版本不一致，请刷新并核对原文件。')
  } finally { await handle.close() }
  if (source.attachmentImage) prepareImageAttachmentBytes(data, { mime: source.item.mime })
  const base: TaskSourcePreview = { ok: true, path, ...kind, bytes: data.byteLength, mtimeMs: Number(before.mtimeMs) }
  if (kind.mode === 'unsupported') return base
  if (kind.mode === 'asset') return { ...base, dataUrl: `data:${kind.mime};base64,${data.toString('base64')}`, ...(kind.type === 'pdf' ? { content: preparePdfText(data) } : {}) }
  if (kind.type === 'office') return { ...base, content: prepareOfficeText(data, path) }
  if (data.includes(0)) throw new Error('资料不是可预览的文本。')
  return { ...base, content: new TextDecoder('utf-8', { fatal: true }).decode(data) }
}
