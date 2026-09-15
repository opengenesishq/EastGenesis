import type { AgentEvent, SendMessagePayload, SessionMeta, UserMessageAttachmentView } from '../shared/types'
import { officeRevisionUserMessageText } from './office-revision/intent'
import { messagePayloadDigest } from './message-payload-digest'

/** The model payload retains the authorized revision intent; the transcript shows the user's original text. */
export function emitNativeUserMessage(input: {
  meta: SessionMeta; payload: SendMessagePayload; messageId: string
  attachments?: UserMessageAttachmentView[]; emit: (event: AgentEvent) => void
}): void {
  const text = officeRevisionUserMessageText(input.meta.id, input.payload.text)
  input.emit({ kind: 'user-message', text, messageId: input.messageId, attachments: input.attachments,
    payloadDigest: messagePayloadDigest({ ...input.payload, text }) })
  if (input.meta.title !== '新会话' || !text.trim()) return
  input.meta.title = text.trim().replace(/\s+/g, ' ').slice(0, 40)
  input.emit({ kind: 'meta', meta: { ...input.meta } })
}
