import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { SessionInputRecord } from '../../shared/session-input-types'
import type { SessionInputFollowUp } from '../../shared/session-follow-up'

interface Permit { root: string; sessionId: string; messageId: string; sessionCreatedAt: number; active: boolean }
const permits = new Map<string, Permit>()
const dispatches = new Map<string, string>()
const dispatchKey = (root: string, sessionId: string, messageId: string): string => JSON.stringify([resolve(root), sessionId, messageId])

export function armSessionFollowUp(root: string, meta: SessionMeta, messageId: string, behavior: SessionInputFollowUp['behavior']): SessionInputFollowUp {
  if (!Number.isFinite(meta.createdAt)) throw new Error('原任务身份缺少创建时间，不能自动继续')
  const token = randomUUID()
  permits.set(token, { root: resolve(root), sessionId: meta.id, messageId, sessionCreatedAt: meta.createdAt, active: true })
  return { behavior, token, sessionCreatedAt: meta.createdAt, state: 'armed' }
}

export function isSessionFollowUpActive(root: string, record: SessionInputRecord, meta?: SessionMeta): boolean {
  const followUp = record.followUp
  const permit = followUp ? permits.get(followUp.token) : undefined
  return Boolean(permit?.active && permit.root === resolve(root) && permit.sessionId === record.sessionId &&
    permit.messageId === record.messageId && permit.sessionCreatedAt === followUp?.sessionCreatedAt &&
    meta?.id === record.sessionId && meta.createdAt === permit.sessionCreatedAt)
}

/** Call synchronously at the entry of every explicit stop, before any await. */
export function pauseSessionFollowUps(root: string, sessionId: string, preserveMessageId?: string): void {
  for (const [token, permit] of permits) {
    if (permit.root === resolve(root) && permit.sessionId === sessionId && permit.messageId !== preserveMessageId) permits.delete(token)
  }
}

export function withdrawSessionFollowUp(record: SessionInputRecord): void {
  if (record.followUp) permits.delete(record.followUp.token)
}

export function beginSessionFollowUpDispatch(root: string, record: SessionInputRecord, meta?: SessionMeta): () => void {
  if (!isSessionFollowUpActive(root, record, meta)) throw new Error('自动继续已暂停，请手动继续此补充要求')
  const key = dispatchKey(root, record.sessionId, record.messageId)
  dispatches.set(key, record.followUp!.token)
  return () => { dispatches.delete(key); withdrawSessionFollowUp(record) }
}

/** Also checked immediately before the execution engine receives the message. */
export function assertSessionFollowUpMessageCurrent(root: string, sessionId: string, messageId: string | undefined, meta?: SessionMeta): void {
  if (!messageId) return
  const token = dispatches.get(dispatchKey(root, sessionId, messageId))
  if (!token) return // Explicit manual sends keep the existing authorization path.
  const permit = permits.get(token)
  if (!permit?.active || !meta || meta.id !== sessionId || meta.createdAt !== permit.sessionCreatedAt) {
    throw new Error('自动继续已被暂停或原任务身份已变化，已阻止提交')
  }
}
