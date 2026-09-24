import type { SendMessagePayload } from '../../../shared/types'
import { COMPOSER_DRAFTS_DELETED_EVENT, isDeletedComposerDraft } from './composer-draft-persistence'

export interface ComposerDraftAddition {
  payload: SendMessagePayload
  imagePreviews?: Record<string, string>
  imageNames?: Record<string, string>
}

export const COMPOSER_DRAFT_ADDED_EVENT = 'caogen:composer-draft-added'
const pending = new Map<string, ComposerDraftAddition[]>()
if (typeof window !== 'undefined') window.addEventListener(COMPOSER_DRAFTS_DELETED_EVENT, () => {
  for (const sessionId of pending.keys()) if (isDeletedComposerDraft(sessionId)) pending.delete(sessionId)
})

/** Local draft delivery only. This module cannot execute or send a task. */
export function appendComposerDraft(sessionId: string, addition: ComposerDraftAddition): void {
  if (!sessionId || isDeletedComposerDraft(sessionId)) throw new Error('目标任务已删除，请重新选择。')
  pending.set(sessionId, [...pending.get(sessionId) ?? [], addition])
  window.dispatchEvent(new Event(COMPOSER_DRAFT_ADDED_EVENT))
}

export function takeComposerDraftAdditions(sessionId: string): ComposerDraftAddition[] {
  const additions = pending.get(sessionId) ?? []
  pending.delete(sessionId)
  return isDeletedComposerDraft(sessionId) ? [] : additions
}
