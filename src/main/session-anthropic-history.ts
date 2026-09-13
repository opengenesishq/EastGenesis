import type { SessionMeta, TranscriptEntry } from '../shared/types'
import { rebuildAnthropicHistory, rebuildPortableAnthropicHistory, type AnthropicImageResolver } from './anthropic-history'
import { runtimeConversationReplay, validateRuntimeContinuationContext } from './session-runtime-continuation-context'
import type { AnthropicMessagesMessage } from './anthropicMessagesAdapter'

export function rebuildSessionAnthropicHistory(
  meta: SessionMeta, entries: TranscriptEntry[], resolveImage: AnthropicImageResolver
): AnthropicMessagesMessage[] {
  const boundary = meta.runtimeContinuation?.boundarySeq
  if (boundary) {
    validateRuntimeContinuationContext(meta, entries)
    const prefix = entries.filter((entry) => entry.seq <= boundary)
    const replay = runtimeConversationReplay(meta, prefix)!
    // Earlier observations are plain user context, never native tool calls or approvals.
    return [{ role: 'user', content: [{ type: 'text', text: replay.text }] },
      ...rebuildAnthropicHistory(entries.filter((entry) => entry.seq > boundary), resolveImage)]
  }
  return meta.conversationForkSourceSdkSessionId
    ? rebuildPortableAnthropicHistory(entries)
    : rebuildAnthropicHistory(entries, resolveImage)
}
