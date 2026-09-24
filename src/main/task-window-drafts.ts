import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { RemoteWelcomeDraft, RemoteWelcomeDraftInput, RemoteWelcomeDraftReceipt } from '../shared/task-window-types'
import type { RemoteHostExpectedConnection, RemoteHostView } from '../shared/remote-host-types'
import { canonicalJson } from './project-workspace/codec'
import { writeDurableFileSync } from './durable-file'

interface StoredDraft extends RemoteWelcomeDraftReceipt {
  digest: string
  sourceSessionId: string
  createdAt: number
  draft?: RemoteWelcomeDraftInput
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error('草稿标识无效。')
  return value
}
const fingerprint = /^sha256:[a-f0-9]{64}$/
const sha = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')
const boundId = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error('远端草稿身份无效。')
  return value
}
function normalizeConnection(value: RemoteHostExpectedConnection): RemoteHostExpectedConnection {
  if (!value || typeof value.origin !== 'string' || value.origin.length > 2048 || !fingerprint.test(value.spkiFingerprint)) throw new Error('远端草稿连接身份无效。')
  const url = new URL(value.origin)
  if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password) throw new Error('远端草稿连接地址无效。')
  const connection: RemoteHostExpectedConnection = { projectId: boundId(value.projectId), deviceId: boundId(value.deviceId), origin: value.origin, spkiFingerprint: value.spkiFingerprint }
  if (value.ssh) {
    const ssh = value.ssh
    if (!Number.isSafeInteger(ssh.sshHostRevision) || ssh.sshHostRevision < 0 || !/^[a-f0-9]{64}$/.test(ssh.sshConfigDigest) || ssh.httpsOrigin !== value.origin) throw new Error('远端草稿 SSH 绑定无效。')
    connection.ssh = { sshHostId: identifier(ssh.sshHostId), sshHostRevision: ssh.sshHostRevision, sshConfigDigest: ssh.sshConfigDigest, httpsOrigin: ssh.httpsOrigin }
  }
  return connection
}
export function normalizeRemoteWelcomeDraft(value: RemoteWelcomeDraftInput): RemoteWelcomeDraftInput {
  if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20_000 || value.text.includes('\0')) throw new Error('请保留 20,000 字符以内的非空远端任务草稿。')
  return { requestId: identifier(value.requestId), text: value.text, hostId: identifier(value.hostId), expectedConnection: normalizeConnection(value.expectedConnection) }
}
export function assertRemoteWelcomeDraftHost(input: RemoteWelcomeDraftInput, host: RemoteHostView | undefined): void {
  if (!host || host.id !== input.hostId || !host.projectId || !host.deviceId || !['paired', 'expired'].includes(host.status)) throw new Error('原远端连接不可用，请重新选择。')
  const current = normalizeConnection({ projectId: host.projectId, deviceId: host.deviceId, origin: host.identity.origin, spkiFingerprint: host.identity.spkiFingerprint, ...(host.ssh ? { ssh: host.ssh } : {}) })
  if (canonicalJson(current) !== canonicalJson(input.expectedConnection)) throw new Error('远端主机或项目身份已变化，草稿未交接。')
}

/** The queue only transfers unsent text; it never creates a Session or remote command. */
export class RemoteWelcomeDraftStore {
  constructor(private readonly path: string) {}
  private read(): StoredDraft[] {
    let raw: string
    try { raw = readFileSync(this.path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    if (raw.length > 5 * 1024 * 1024) throw new Error('跨窗口草稿记录超过可读取范围。')
    const data = JSON.parse(raw)
    if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 5000) throw new Error('跨窗口草稿记录无法读取。')
    const seen = new Set<string>()
    for (const row of data.items as StoredDraft[]) {
      identifier(row.requestId); identifier(row.sourceSessionId)
      if (seen.has(row.requestId) || !Number.isSafeInteger(row.createdAt) || !['pending', 'delivered'].includes(row.status) || !/^[a-f0-9]{64}$/.test(row.digest)) throw new Error('跨窗口草稿记录损坏。')
      seen.add(row.requestId)
      if (row.status === 'pending' && (!row.draft || row.draft.requestId !== row.requestId || sha({ sourceSessionId: row.sourceSessionId, draft: normalizeRemoteWelcomeDraft(row.draft) }) !== row.digest)) throw new Error('跨窗口草稿内容无法核对。')
    }
    return data.items
  }
  private write(items: StoredDraft[]): void { writeDurableFileSync(this.path, JSON.stringify({ version: 1, items }), { mode: 0o600 }) }
  enqueue(raw: RemoteWelcomeDraftInput, sourceSessionId: string): RemoteWelcomeDraftReceipt {
    const draft = normalizeRemoteWelcomeDraft(raw), source = identifier(sourceSessionId), items = this.read()
    const digest = sha({ sourceSessionId: source, draft }), existing = items.find(row => row.requestId === draft.requestId)
    if (existing) {
      if (existing.digest !== digest) throw new Error('原草稿交付标识不能用于另一内容、任务或主机。')
      return { requestId: existing.requestId, status: existing.status }
    }
    if (items.filter(row => row.status === 'pending').length >= 20 || items.length >= 5000) throw new Error('跨窗口草稿队列已满，请先在主窗口处理。')
    items.push({ requestId: draft.requestId, status: 'pending', createdAt: Date.now(), sourceSessionId: source, digest, draft })
    this.write(items)
    return { requestId: draft.requestId, status: 'pending' }
  }
  pending(): RemoteWelcomeDraft[] {
    return this.read().filter(row => row.status === 'pending').map(row => ({ ...row.draft!, sourceSessionId: row.sourceSessionId, createdAt: row.createdAt }))
  }
  acknowledge(requestId: string): void {
    identifier(requestId)
    const items = this.read(), row = items.find(item => item.requestId === requestId)
    if (!row) throw new Error('原草稿不存在。')
    if (row.status === 'delivered') return
    row.status = 'delivered'; delete row.draft
    this.write(items)
  }
}
