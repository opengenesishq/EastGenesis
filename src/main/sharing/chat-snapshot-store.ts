import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatShareAdapter, ChatShareOperationPreview, ChatShareReceipt, ChatSnapshotMessage, ChatSnapshotView } from '../../shared/chat-snapshot-share-types'
import type { SiteDeploymentTarget } from '../../shared/site-deployment-types'
import { writeDurableFileSync } from '../durable-file'
import { chatShareBytesDigest, chatShareDigest } from './chat-snapshot-projection'
import type { ChatShareRequest } from './chat-share-protocol'

export interface ChatSnapshotOwner { id: string; createdAt: number; cwd: string; workspaceId?: string; goalId?: string; workItemId?: string }
export interface StoredChatSnapshot { view: ChatSnapshotView; owner: ChatSnapshotOwner; sourceDigest: string; messages: ChatSnapshotMessage[]; htmlDigest: string; paths: string[] }
export interface StoredChatShareAdapter { view: ChatShareAdapter; target: SiteDeploymentTarget }
export interface StoredChatSharePreview {
  view: ChatShareOperationPreview; adapter: StoredChatShareAdapter; request: ChatShareRequest
  executableDigest: string; environmentDigest: string; authorityKey: string; ownerWindow: number
}
export interface StoredChatShareReceipt { view: ChatShareReceipt; preview: StoredChatSharePreview; inspection?: { result: 'applied' | 'not_applied'; response: import('./chat-share-protocol').ChatShareResponse } }
export interface ChatShareDocument { version: 1; snapshots: StoredChatSnapshot[]; adapters: StoredChatShareAdapter[]; receipts: StoredChatShareReceipt[] }
export class ChatSnapshotStore {
  readonly directory: string
  readonly adapterCwd: string
  private readonly statePath: string
  constructor(root: string) {
    this.directory = join(realpathSync(root), 'chat-snapshot-shares')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('分享数据目录不能为符号链接。')
    this.statePath = join(this.directory, 'state.json')
    this.adapterCwd = join(this.directory, 'adapter-work')
    mkdirSync(this.adapterCwd, { recursive: true, mode: 0o700 })
    if (lstatSync(this.adapterCwd).isSymbolicLink()) throw new Error('适配器工作目录无效。')
  }
  read(): ChatShareDocument {
    let raw: string
    try {
      const info = lstatSync(this.statePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32*1024*1024) throw new Error('分享台账大小或类型无效。')
      raw = readFileSync(this.statePath, 'utf8')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, snapshots: [], adapters: [], receipts: [] }; throw error }
    const envelope = JSON.parse(raw) as { digest: string; document: ChatShareDocument }, value = envelope.document
    if (!value || value.version !== 1 || !Array.isArray(value.snapshots) || !Array.isArray(value.adapters) || !Array.isArray(value.receipts) || chatShareDigest(value) !== envelope.digest) throw new Error('分享台账完整性检查失败，原文件已保留。')
    return value
  }
  write(document: ChatShareDocument): void {
    const value = `${JSON.stringify({ digest: chatShareDigest(document), document })}\n`
    if (Buffer.byteLength(value) > 32*1024*1024) throw new Error('分享台账超过 32 MiB，请先导出保留记录。')
    writeDurableFileSync(this.statePath, value)
  }
  bundle(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('快照标识无效。')
    const directory = join(this.directory, 'bundles', id)
    return directory
  }
  saveHtml(id: string, html: string): void {
    const directory = this.bundle(id)
    mkdirSync(join(this.directory, 'bundles'), { recursive: true, mode: 0o700 })
    if (lstatSync(join(this.directory, 'bundles')).isSymbolicLink()) throw new Error('快照目录无效。')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error('快照目录无效。')
    writeDurableFileSync(join(directory, 'index.html'), html, { replace: false })
  }
  readHtml(snapshot: StoredChatSnapshot): string {
    const directory = this.bundle(snapshot.view.id)
    if (lstatSync(join(this.directory, 'bundles')).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) throw new Error('快照目录已变化。')
    const names = readdirSync(directory)
    if (names.length !== 1 || names[0] !== 'index.html') throw new Error('公开快照目录包含额外文件，已阻止发布。')
    const path = join(directory, 'index.html'), info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16*1024*1024) throw new Error('快照文件类型或大小已变化。')
    const html = readFileSync(path, 'utf8')
    if (chatShareBytesDigest(html) !== snapshot.htmlDigest || Buffer.byteLength(html) !== snapshot.view.bytes) throw new Error('快照内容摘要不匹配。')
    return html
  }
}
