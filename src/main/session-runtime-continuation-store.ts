import { readFileSync } from 'node:fs'
import { app } from 'electron'
import type { SessionMeta } from '../shared/types'
import { activeSessionRecordsFromDocument, activeSessionRegistryDocument } from './active-session-registry-format'
import { writeDurableFileSync } from './durable-file'
import { readTranscriptEntriesStrict } from './transcript'
import { validateRuntimeContinuationContext } from './session-runtime-continuation-context'
import { runtimeContinuationReceiptPath } from './session-runtime-continuation-path'

function receiptPath(sessionId: string): string {
  return runtimeContinuationReceiptPath(app.getPath('userData'), sessionId)
}

/** The commit receipt wins over older history/registry projections after a crash. No prompt is stored or replayed. */
export function persistRuntimeContinuation(meta: SessionMeta): void {
  if (meta.runtimeContinuation?.state !== 'committed' || !meta.sdkSessionId) throw new Error('交接尚未准备完成')
  validateRuntimeContinuationContext(meta, readTranscriptEntriesStrict(meta.sdkSessionId))
  writeDurableFileSync(receiptPath(meta.id), JSON.stringify(activeSessionRegistryDocument([{ ...meta }])))
}

export function restoreRuntimeContinuation(meta: SessionMeta): void {
  if (meta.runtimeContinuation?.state === 'prepared') return
  let contents: string
  try { contents = readFileSync(receiptPath(meta.id), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const [committed] = activeSessionRecordsFromDocument<SessionMeta>(JSON.parse(contents))
  const record = committed?.runtimeContinuation
  if (!record || record.state !== 'committed' || committed.id !== meta.id || committed.sdkSessionId !== meta.sdkSessionId) {
    throw new Error('运行时交接记录身份不匹配')
  }
  validateRuntimeContinuationContext(committed, readTranscriptEntriesStrict(committed.sdkSessionId!))
  if (record.id === meta.runtimeContinuation?.id || record.createdAt < (meta.runtimeContinuation?.createdAt ?? 0)) return
  if (meta.model !== 'auto' || meta.routingScope !== 'global') throw new Error('旧会话固定目标与持久自动交接冲突，请恢复最新会话')
  for (const key of ['workspaceId', 'goalId', 'workItemId', 'businessLineId', 'createdAt'] as const) {
    if (committed[key] !== meta[key]) throw new Error(`运行时交接归属不匹配：${key}`)
  }
  Object.assign(meta, {
    engine: committed.engine, providerId: committed.providerId, modelRoutingDecision: committed.modelRoutingDecision,
    runtimeContinuation: record, responsesContext: undefined, resumeSessionAt: undefined,
    costUsd: Math.max(meta.costUsd, committed.costUsd), usage: {
      input: Math.max(meta.usage.input, committed.usage.input), output: Math.max(meta.usage.output, committed.usage.output),
      cacheRead: Math.max(meta.usage.cacheRead, committed.usage.cacheRead), cacheCreation: Math.max(meta.usage.cacheCreation, committed.usage.cacheCreation)
    }
  })
  validateRuntimeContinuationContext(meta, readTranscriptEntriesStrict(meta.sdkSessionId!))
}

/** A failed publish/fsync can leave a durable receipt. Never let a stale live engine send past it. */
export function assertRuntimeContinuationAligned(meta: SessionMeta): void {
  const restored = { ...meta }
  restoreRuntimeContinuation(restored)
  if (restored.runtimeContinuation?.id !== meta.runtimeContinuation?.id) {
    throw new Error('运行时交接已有持久记录，当前实例尚未对齐；请恢复会话后继续。')
  }
}
