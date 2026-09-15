const STORAGE_KEY = 'caogen.composer-drafts.v1'
const MAX_DRAFTS = 50
const MAX_TEXT_LENGTH = 200_000
const deletedDraftKeys = new Set<string>()
export const COMPOSER_DRAFTS_DELETED_EVENT = 'caogen:composer-drafts-deleted'

export function isDeletedComposerDraft(key: string): boolean { return deletedDraftKeys.has(key) }

/** Only called after the main process confirms permanent deletion. */
export function deleteComposerDrafts(storage: Storage, keys: readonly string[]): void {
  keys.forEach((key) => deletedDraftKeys.add(key))
  const raw = storage.getItem(STORAGE_KEY)
  const document = raw === null ? emptyDocument() : JSON.parse(raw) as StoredComposerDrafts
  if (!isRecord(document) || document.version !== 1 || !isRecord(document.drafts)) {
    throw new Error('任务已删除，但本地草稿格式无法识别，请清理应用缓存。')
  }
  for (const key of keys) delete document.drafts[key]
  if (Object.keys(document.drafts).length) storage.setItem(STORAGE_KEY, JSON.stringify(document))
  else storage.removeItem(STORAGE_KEY)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMPOSER_DRAFTS_DELETED_EVENT))
}

interface StoredComposerDraft {
  text: string
  updatedAt: number
}

interface StoredComposerDrafts {
  version: 1
  drafts: Record<string, StoredComposerDraft>
}

export function readComposerDraft(storage: Storage | undefined, sessionId: string | null): string {
  if (!storage || !sessionId || deletedDraftKeys.has(sessionId)) return ''
  return readDocument(storage).drafts[sessionId]?.text ?? ''
}

export function writeComposerDraft(
  storage: Storage | undefined,
  sessionId: string | null,
  text: string,
  now = Date.now()
): void {
  if (!storage || !sessionId || deletedDraftKeys.has(sessionId)) return
  const document = readDocument(storage)
  if (!text) delete document.drafts[sessionId]
  else document.drafts[sessionId] = { text: text.slice(0, MAX_TEXT_LENGTH), updatedAt: now }
  const drafts = Object.fromEntries(
    Object.entries(document.drafts)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_DRAFTS)
  )
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, drafts } satisfies StoredComposerDrafts))
  } catch {
    // Draft persistence must never block typing or sending.
  }
}

function readDocument(storage: Storage): StoredComposerDrafts {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '')
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.drafts)) return emptyDocument()
    const drafts: Record<string, StoredComposerDraft> = Object.create(null) as Record<string, StoredComposerDraft>
    for (const [sessionId, raw] of Object.entries(parsed.drafts)) {
      if (!sessionId || !isRecord(raw) || typeof raw.text !== 'string') continue
      if (!Number.isSafeInteger(raw.updatedAt) || Number(raw.updatedAt) < 0) continue
      drafts[sessionId] = {
        text: raw.text.slice(0, MAX_TEXT_LENGTH),
        updatedAt: Number(raw.updatedAt)
      }
    }
    return { version: 1, drafts }
  } catch {
    return emptyDocument()
  }
}

function emptyDocument(): StoredComposerDrafts {
  return { version: 1, drafts: Object.create(null) as Record<string, StoredComposerDraft> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
