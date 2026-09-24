import type { SessionMeta, TranscriptEntry } from '../../shared/types'
import type { SideChatMessage } from '../../shared/side-chat-types'
import type { ProjectResourceContext } from '../project-workspace/resource-context'
import { buildPortableConversationReplay } from '../conversation-ledger-replay'
import { snapshotDigest, type SideChatSnapshot } from './side-chat-store'

/** Captures observations only. Incomplete tools are never replayed as executable requests. */
export function captureSideChatSnapshot(meta: SessionMeta, entries: TranscriptEntry[], resources: ProjectResourceContext): SideChatSnapshot {
  if (meta.status === 'closed' || meta.sideChat) throw new Error('请从原任务打开侧聊；侧聊不能递归创建侧聊。')
  const observed = entries.filter(({ event }) => event.kind === 'user-message' || event.kind === 'assistant-message' ||
    event.kind === 'turn-result' || event.kind === 'tool-result')
  const replay = buildPortableConversationReplay(observed, undefined, { providerNeutral: true })
  const boundary = entries.at(-1)
  const body = {
    source: { id: meta.id, createdAt: meta.createdAt, cwd: meta.cwd, workspaceId: meta.workspaceId, goalId: meta.goalId,
      workItemId: meta.workItemId, projectId: meta.projectId, sdkSessionId: meta.sdkSessionId },
    sourceTitle: meta.title, capturedAt: Date.now(), boundarySeq: boundary?.seq ?? 0, boundaryEventId: boundary?.eventId ?? '',
    text: replay?.text ?? '原任务尚无完整对话记录。', omittedCount: Math.max(0, observed.length - (replay?.eventCount ?? 0)),
    resourceContext: structuredClone(resources)
  }
  return { ...body, digest: snapshotDigest(body) }
}
export function sideChatMessages(entries: TranscriptEntry[]): SideChatMessage[] {
  const messages: SideChatMessage[] = []
  let answer = ''
  let pendingId = ''
  let occurredAt = 0
  for (const entry of entries) {
    const event = entry.event
    if (event.kind === 'user-message') {
      answer = ''; pendingId = ''; occurredAt = entry.occurredAt ?? 0
      messages.push({ id: event.messageId ?? entry.eventId ?? `user-${entry.seq}`, role: 'user', text: event.text, createdAt: occurredAt, complete: true })
    } else if (event.kind === 'assistant-message') {
      const text = event.blocks.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('')
      if (text) { answer += `${answer ? '\n\n' : ''}${text}`; pendingId = entry.eventId ?? `answer-${entry.seq}`; occurredAt = entry.occurredAt ?? occurredAt }
    } else if (event.kind === 'turn-result') {
      messages.push({ id: entry.eventId ?? `result-${entry.seq}`, role: 'assistant', text: event.resultText || answer || (event.isError ? '侧聊请求失败。' : '本轮没有返回文本。'),
        createdAt: entry.occurredAt ?? occurredAt, complete: true, isError: event.isError })
      answer = ''; pendingId = ''
    }
  }
  if (answer) messages.push({ id: pendingId, role: 'assistant', text: answer, createdAt: occurredAt, complete: false })
  return messages
}
