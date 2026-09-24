import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { COMPOSER_DRAFT_DELIVERED_EVENT, COMPOSER_DRAFTS_DELETED_EVENT, isDeletedComposerDraft, readComposerDraft, writeComposerDraft } from '../../store/composer-draft-persistence'

interface SessionDraftState {
  sessionId: string | null
  text: string
}

export function useSessionComposerDraft(sessionId: string | null): [string, Dispatch<SetStateAction<string>>] {
  const storage = browserStorage()
  const [draft, setDraft] = useState<SessionDraftState>(() => ({
    sessionId,
    text: readComposerDraft(storage, sessionId)
  }))
  const text = draft.sessionId === sessionId ? draft.text : readComposerDraft(storage, sessionId)

  useEffect(() => {
    if (draft.sessionId === sessionId) return
    setDraft({ sessionId, text: readComposerDraft(storage, sessionId) })
  }, [draft.sessionId, sessionId, storage])

  useEffect(() => {
    const clear = (): void => {
      if (sessionId && isDeletedComposerDraft(sessionId)) setDraft({ sessionId, text: '' })
    }
    window.addEventListener(COMPOSER_DRAFTS_DELETED_EVENT, clear)
    return () => window.removeEventListener(COMPOSER_DRAFTS_DELETED_EVENT, clear)
  }, [sessionId])

  useEffect(() => {
    const reload = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      if (!sessionId || detail?.sessionId !== sessionId || isDeletedComposerDraft(sessionId)) return
      const persisted = readComposerDraft(storage, sessionId)
      setDraft(current => current.sessionId === sessionId && current.text === persisted ? current : { sessionId, text: persisted })
    }
    window.addEventListener(COMPOSER_DRAFT_DELIVERED_EVENT, reload)
    return () => window.removeEventListener(COMPOSER_DRAFT_DELIVERED_EVENT, reload)
  }, [sessionId, storage])

  const setText = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    setDraft((current) => {
      const base = current.sessionId === sessionId
        ? current.text
        : readComposerDraft(storage, sessionId)
      const next = sessionId && isDeletedComposerDraft(sessionId) ? '' : typeof action === 'function' ? action(base) : action
      writeComposerDraft(storage, sessionId, next)
      return { sessionId, text: next }
    })
  }, [sessionId, storage])

  return [text, setText]
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
