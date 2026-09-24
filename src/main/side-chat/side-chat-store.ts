import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFileSync } from '../durable-file'
import type { SessionMeta } from '../../shared/types'
import type { SideChatBinding } from '../../shared/side-chat-types'
import type { ProjectResourceContext } from '../project-workspace/resource-context'

export interface SideChatSnapshot {
  source: Pick<SessionMeta, 'id' | 'createdAt' | 'cwd' | 'workspaceId' | 'goalId' | 'workItemId' | 'projectId' | 'sdkSessionId'>
  sourceTitle: string
  capturedAt: number
  boundarySeq: number
  boundaryEventId: string
  text: string
  omittedCount: number
  resourceContext: ProjectResourceContext
  digest: string
}
export interface SideChatRecord {
  schemaVersion: 1
  id: string
  sessionId: string
  requestId: string
  binding: SideChatBinding
  snapshot: SideChatSnapshot
  workspaceId?: string
  projectId?: string
  unassigned?: boolean
  goalId?: string
  workItemId?: string
  cwd: string
  title: string
  providerId: string
  model: string
  routingScope?: SessionMeta['routingScope']
  routingControl?: SessionMeta['routingControl']
  businessLineId?: string
  driveMode?: SessionMeta['driveMode']
  budgetUsd?: number
  sessionCreatedAt?: number
  sdkSessionId?: string
  closed: boolean
  error?: string
}
export function sideChatDigest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` }
export function sideChatId(sourceId: string, requestId: string): string {
  const h = createHash('sha256').update(`side-chat-v1\0${sourceId}\0${requestId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export function checkedSideChatId(id: string): string {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('侧聊标识无效。')
  return id
}
export function sideChatRecordPath(root: string, id: string): string { return join(root, 'private', 'side-chats', `${checkedSideChatId(id)}.json`) }
export function getSideChatRecord(root: string, id: string): SideChatRecord | undefined {
  const path = sideChatRecordPath(root, id)
  if (!existsSync(path)) return undefined
  const record = JSON.parse(readFileSync(path, 'utf8')) as SideChatRecord
  if (!record || record.schemaVersion !== 1 || record.id !== id || record.binding?.sideChatId !== id ||
      record.binding.policy !== 'context_only_v1' || record.binding.schemaVersion !== 1 ||
      record.binding.sourceSessionId !== record.snapshot?.source?.id || record.binding.sourceSessionCreatedAt !== record.snapshot?.source?.createdAt ||
      record.binding.snapshotDigest !== record.snapshot?.digest || snapshotDigest(record.snapshot) !== record.snapshot.digest ||
      typeof record.sessionId !== 'string' || !record.sessionId ||
      typeof record.cwd !== 'string' || typeof record.closed !== 'boolean') throw new Error('侧聊上下文或身份记录损坏，已阻止继续。')
  return record
}
export function snapshotDigest(snapshot: Omit<SideChatSnapshot, 'digest'> | SideChatSnapshot): string {
  const { digest: _digest, ...content } = snapshot as SideChatSnapshot
  return sideChatDigest(content)
}
export function saveSideChatRecord(root: string, record: SideChatRecord): void {
  writeDurableFileSync(sideChatRecordPath(root, record.id), JSON.stringify(record))
}
export function listSideChatRecords(root: string): SideChatRecord[] {
  let names: string[]
  try { names = readdirSync(join(root, 'private', 'side-chats')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => getSideChatRecord(root, name.slice(0, -5))!)
}
export function sideChatFilesForSessions(root: string, sessionIds: Iterable<string>): string[] {
  const ids = new Set(sessionIds)
  return listSideChatRecords(root).filter((record) => ids.has(record.id) || ids.has(record.snapshot.source.id))
    .map((record) => sideChatRecordPath(root, record.id))
}
export function purgeSideChatRecords(root: string, sessionIds: Iterable<string>): string[] {
  const paths = sideChatFilesForSessions(root, sessionIds)
  for (const path of paths) unlinkSync(path)
  return paths
}
