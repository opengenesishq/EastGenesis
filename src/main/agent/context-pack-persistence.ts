import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFileSync } from '../durable-file'
import type { ChatMessage } from '../openAiEngineTypes'

export interface PersistedContextPack {
  schemaVersion: 1
  sessionId: string
  sourceMessageCount: number
  boundarySeq: number
  summary: string
  recent: ChatMessage[]
  digest: string
  savedAt: number
}

export function contextPackPath(rootDir: string, sessionId: string): string {
  return join(rootDir, 'context-packs', `${sha256(sessionId)}.json`)
}

export function persistContextPack(
  rootDir: string,
  sessionId: string,
  input: { sourceMessageCount: number; boundarySeq: number; summary: string; recent: ChatMessage[] }
): PersistedContextPack {
  const body = {
    schemaVersion: 1 as const,
    sessionId: required(sessionId, 'sessionId'),
    sourceMessageCount: positiveInteger(input.sourceMessageCount, 'sourceMessageCount'),
    boundarySeq: positiveInteger(input.boundarySeq, 'boundarySeq'),
    summary: required(input.summary, 'summary'),
    recent: input.recent.map(cloneMessage),
    savedAt: Date.now()
  }
  const record: PersistedContextPack = { ...body, digest: digest(body) }
  writeDurableFileSync(contextPackPath(rootDir, sessionId), `${JSON.stringify(record)}\n`)
  return record
}

export function restoreContextPack(rootDir: string, sessionId: string): PersistedContextPack | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(contextPackPath(rootDir, sessionId), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.sessionId !== sessionId ||
      !Number.isSafeInteger(parsed.sourceMessageCount) || parsed.sourceMessageCount < 1 ||
      !Number.isSafeInteger(parsed.boundarySeq) || parsed.boundarySeq < 1 ||
      typeof parsed.summary !== 'string' || !parsed.summary.trim() ||
      !Array.isArray(parsed.recent) || typeof parsed.savedAt !== 'number' ||
      typeof parsed.digest !== 'string') {
    throw new Error('Context Pack 持久记录格式无效')
  }
  const { digest: savedDigest, ...body } = parsed
  if (savedDigest !== digest(body)) throw new Error('Context Pack 持久记录摘要不匹配')
  return {
    schemaVersion: 1,
    sessionId,
    sourceMessageCount: parsed.sourceMessageCount,
    boundarySeq: parsed.boundarySeq,
    summary: parsed.summary,
    recent: parsed.recent.map(parseMessage),
    digest: savedDigest,
    savedAt: parsed.savedAt
  }
}

function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || !['user', 'assistant', 'tool', 'system'].includes(String(value.role)) ||
      (typeof value.content !== 'string' && value.content !== null && !Array.isArray(value.content))) {
    throw new Error('Context Pack recent 消息格式无效')
  }
  return cloneMessage(value as ChatMessage)
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    role: message.role,
    content: typeof message.content === 'string' || message.content === null
      ? message.content
      : structuredClone(message.content),
    ...(message.tool_calls ? { tool_calls: structuredClone(message.tool_calls) } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function required(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Context Pack ${label} is required`)
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Context Pack ${label} must be a positive integer`)
  return value
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
