import type { TranscriptEntry } from '../shared/types'
import type { ChatMessage } from './openAiEngineTypes'

/** Legacy chat restoration projection; cross-protocol transfers validate their full ledger separately. */
export function rebuildOpenAiTextHistory(entries: TranscriptEntry[]): ChatMessage[] {
  const history: ChatMessage[] = []
  for (const { event } of entries) {
    if (event.kind === 'user-message' && event.text) history.push({ role: 'user', content: event.text })
    else if (event.kind === 'assistant-message') {
      const text = event.blocks.map((block) => block.type === 'text' ? block.text : '').join('').trim()
      if (text) history.push({ role: 'assistant', content: text })
    }
  }
  return history
}
