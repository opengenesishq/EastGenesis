import type { OutboundContextItemView, SendMessagePayload, SessionMeta, TranscriptEntry } from '../shared/types'
import { buildPortableConversationReplay, type PortableConversationReplay } from './conversation-ledger-replay'
import { buildProviderNeutralContextDigest } from './task/provider-neutral-context'
import { completedToolReplay } from './completed-tool-replay'
import { digest } from './task/workflow-ledger-canonical'
import { ModelContextHandoffError } from './model/context-handoff-error'

export function prepareRuntimeContinuationContext(entries: TranscriptEntry[], payload?: SendMessagePayload) {
  const hasWork = entries.some(({ event }) => ['tool-start', 'tool-result', 'permission-request', 'permission-resolved'].includes(event.kind) ||
    (event.kind === 'assistant-message' && event.blocks.some(block => block.type !== 'text')))
  if (!hasWork) {
    assertPortableTextBoundary(entries, payload)
    return { contextDigest: buildProviderNeutralContextDigest({ entries }) }
  }
  completedToolReplay(entries, payload)
  return { contextMode: 'completed_tools_v1' as const, contextDigest: `sha256:${digest(entries)}` }
}

/** This first migration boundary is deliberately lossless text only, not a best-effort summary. */
export function assertPortableTextBoundary(entries: TranscriptEntry[], payload?: SendMessagePayload): PortableConversationReplay {
  if (payload?.images?.length || payload?.documents?.length) blocked('本轮含附件')
  if (!entries.length || entries.length > 900) blocked('会话账本为空或超出完整重放范围')
  const messages = entries.filter(({ event }) => validateTextEvent(event))
  const lastTurn = entries.filter((entry) => entry.event.kind === 'user-message' || entry.event.kind === 'turn-result').at(-1)
  if (lastTurn?.event.kind !== 'turn-result' || lastTurn.event.isError) blocked('上一文本回合尚未成功结束')
  const replay = buildPortableConversationReplay(entries, undefined, { providerNeutral: true })
  const semanticCount = messages.length + entries.filter(({ event }) => event.kind === 'checkpoint').length
  if (!replay || replay.attachmentCount || replay.eventCount !== semanticCount || replay.characters > 40_000) {
    blocked('上下文无法完整无损重放')
  }
  if (messages.some(({ event }) => !replay.text.includes(messageText(event)))) blocked('重放改变了原始文本')
  return replay
}

function messageText(event: TranscriptEntry['event']): string {
  if (event.kind === 'user-message') return event.text
  return event.kind === 'assistant-message' ? event.blocks.map((block) => block.type === 'text' ? block.text : '').join('') : ''
}

function validateTextEvent(event: TranscriptEntry['event']): boolean {
  if (event.kind === 'user-message') {
    if (event.attachments?.length || event.text.length > 4_000) blocked('历史含附件或超长消息')
    return true
  }
  if (event.kind === 'assistant-message') {
    if (event.blocks.some((block) => block.type !== 'text')) blocked('历史含工具调用或协议专属思考内容')
    const text = event.blocks.map((block) => block.type === 'text' ? block.text : '').join('')
    if (text.length > 4_000) blocked('历史含超长回答')
    return true
  }
  if (['tool-start', 'tool-result', 'permission-request', 'permission-resolved', 'checkpoint-restore'].includes(event.kind)) blocked('历史含工具、审批或回退上下文')
  if (event.kind === 'hook-event' && event.event === 'context-compressed') blocked('历史已压缩，无法证明无损交接')
  return false
}

export function validateRuntimeContinuationContext(meta: SessionMeta, entries: TranscriptEntry[]): void {
  const record = meta.runtimeContinuation
  if (!record) return
  if (!validContinuationRecord(record) || record.toEngine !== meta.engine) blocked('交接记录不完整')
  const prefix = entries.filter((entry) => entry.seq <= record.boundarySeq)
  if (record.contextMode) completedToolReplay(prefix)
  else assertPortableTextBoundary(prefix)
  const actual = record.contextMode ? `sha256:${digest(prefix)}` : buildProviderNeutralContextDigest({ entries: prefix })
  if (prefix.at(-1)?.seq !== record.boundarySeq || actual !== record.contextDigest) {
    blocked('交接边界与持久账本不一致')
  }
}

function validContinuationRecord(record: NonNullable<SessionMeta['runtimeContinuation']>): boolean {
  return record.schemaVersion === 1 && typeof record.id === 'string' && record.id.length > 0 &&
    (record.contextMode === undefined || record.contextMode === 'completed_tools_v1') &&
    ['prepared', 'committed'].includes(record.state) && ['openai', 'anthropic', 'gemini'].includes(record.fromEngine) &&
    Number.isSafeInteger(record.boundarySeq) && record.boundarySeq > 0 && Number.isFinite(record.createdAt) &&
    typeof record.providerId === 'string' && typeof record.model === 'string' && /^sha256:[a-f0-9]{64}$/.test(record.contextDigest)
}

export function runtimeConversationReplay(meta: SessionMeta, entries: TranscriptEntry[], currentMessageId?: string) {
  validateRuntimeContinuationContext(meta, entries)
  if (meta.runtimeContinuation?.contextMode === 'completed_tools_v1') {
    const boundary = completedReplayBoundary(meta, entries)
    const source = completedToolReplay(entries.filter(entry => entry.seq <= boundary))
    const later = buildPortableConversationReplay(entries.filter(entry => entry.seq > boundary), currentMessageId, { providerNeutral: true })
    if (!later) return source
    const text = `${source.text}\n\n${later.text}`
    return { text, characters: text.length, attachmentCount: later.attachmentCount, eventCount: source.eventCount + later.eventCount, toolResultsIncluded: true }
  }
  return buildPortableConversationReplay(entries, currentMessageId, { providerNeutral: Boolean(meta.runtimeContinuation) })
}

/** Register the additional historical tool data in the same outbound gate used
 * by task files and handoffs. This item never authorizes another tool action. */
export function runtimeContinuationContextItems(meta: SessionMeta, entries: TranscriptEntry[], includeLaterCompleted = false): OutboundContextItemView[] {
  if (meta.runtimeContinuation?.contextMode !== 'completed_tools_v1') return []
  validateRuntimeContinuationContext(meta, entries)
  const boundary = includeLaterCompleted ? completedReplayBoundary(meta, entries) : meta.runtimeContinuation.boundarySeq
  const replay = completedToolReplay(entries.filter(entry => entry.seq <= boundary))
  return [{ id: 'context:completed-work', kind: 'workflow_context', label: 'Completed tool observations',
    dataClass: 'S4', egressPolicy: 'allow', decision: 'included', bytes: Buffer.byteLength(replay.text), digest: `sha256:${digest(replay.text)}` }]
}

function completedReplayBoundary(meta: SessionMeta, entries: TranscriptEntry[]): number {
  const lastCompleted = entries.filter(entry => entry.event.kind === 'turn-result' && !entry.event.isError).at(-1)?.seq ?? 0
  return Math.max(meta.runtimeContinuation!.boundarySeq, lastCompleted)
}

function blocked(reason: string): never {
  throw new ModelContextHandoffError(`跨协议续聊已阻止：${reason}；原会话仍保留，可固定原厂商模型继续。`, undefined)
}
