import { taskWindowSessionId } from '../task-window-context'

const STORAGE_KEY = 'caogen.composer-drafts.v1'
const TASK_WINDOW_STORAGE_KEY = 'caogen.task-window-composer-drafts.v1'
const DELETION_KEY = 'caogen.composer-drafts-deleted.v1'
const MAX_DRAFTS = 50
const MAX_TEXT_LENGTH = 200_000
const deletedDraftKeys = new Set<string>()
export const COMPOSER_DRAFTS_DELETED_EVENT = 'caogen:composer-drafts-deleted'
export const COMPOSER_DRAFT_DELIVERED_EVENT = 'caogen:composer-draft-delivered'
const MAX_DELIVERY_RECEIPTS = 2000

// Existing editors in other windows must discard deleted drafts as well.
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== DELETION_KEY || !event.newValue) return
  try {
    const value: unknown = JSON.parse(event.newValue)
    if (!isRecord(value) || !Array.isArray(value.keys)) return
    for (const key of value.keys) if (typeof key === 'string') deletedDraftKeys.add(key)
    window.dispatchEvent(new Event(COMPOSER_DRAFTS_DELETED_EVENT))
  } catch { /* A corrupt deletion notice must not break another window. */ }
})

export function isDeletedComposerDraft(key: string): boolean { return deletedDraftKeys.has(key) }

/** Only called after the main process confirms permanent deletion. */
export function deleteComposerDrafts(storage: Storage, keys: readonly string[]): void {
  keys.forEach((key) => deletedDraftKeys.add(key))
  const storageKeys = new Set([STORAGE_KEY, TASK_WINDOW_STORAGE_KEY])
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(`${TASK_WINDOW_STORAGE_KEY}:`)) storageKeys.add(key)
  }
  for (const storageKey of storageKeys) {
    const raw = storage.getItem(storageKey)
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.drafts)) throw new Error('invalid')
      } catch {
        throw new Error('任务已删除，但本地草稿格式无法识别，请清理应用缓存。')
      }
    }
    const document = raw === null ? emptyDocument() : readDocumentForKey(storage, storageKey)
    if (!isRecord(document) || document.version !== 1 || !isRecord(document.drafts)) {
      throw new Error('任务已删除，但本地草稿格式无法识别，请清理应用缓存。')
    }
    for (const key of keys) {
      delete document.drafts[key]
      for (const [deliveryId, receipt] of Object.entries(document.deliveries)) if (receipt.sessionId === key) delete document.deliveries[deliveryId]
    }
    if (Object.keys(document.drafts).length) storage.setItem(storageKey, JSON.stringify(document))
    else storage.removeItem(storageKey)
  }
  storage.setItem(DELETION_KEY, JSON.stringify({ keys, nonce: `${Date.now()}:${Math.random()}` }))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMPOSER_DRAFTS_DELETED_EVENT))
}

interface StoredComposerDraft {
  text: string
  updatedAt: number
}

interface StoredComposerDrafts {
  version: 1
  drafts: Record<string, StoredComposerDraft>
  deliveries: Record<string, { sessionId: string; receivedAt: number }>
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
    storage.setItem(draftStorageKey(), JSON.stringify({ version: 1, drafts, deliveries: document.deliveries } satisfies StoredComposerDrafts))
  } catch {
    // Draft persistence must never block typing or sending.
  }
}

function readDocument(storage: Storage): StoredComposerDrafts {
  return readDocumentForKey(storage, draftStorageKey())
}

function readDocumentForKey(storage: Storage, key: string): StoredComposerDrafts {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '')
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
    const deliveries: Record<string, { sessionId: string; receivedAt: number }> = Object.create(null) as Record<string, { sessionId: string; receivedAt: number }>
    if (isRecord(parsed.deliveries)) for (const [deliveryId, raw] of Object.entries(parsed.deliveries)) {
      if (!deliveryId || !isRecord(raw) || typeof raw.sessionId !== 'string' || !Number.isSafeInteger(raw.receivedAt)) continue
      deliveries[deliveryId] = { sessionId: raw.sessionId, receivedAt: Number(raw.receivedAt) }
    }
    return { version: 1, drafts, deliveries }
  } catch {
    return emptyDocument()
  }
}

function emptyDocument(): StoredComposerDrafts {
  return { version: 1, drafts: Object.create(null) as Record<string, StoredComposerDraft>, deliveries: Object.create(null) as Record<string, { sessionId: string; receivedAt: number }> }
}

/** Durable, idempotent text delivery used by side-chat adoption and the companion. */
export function appendPersistentComposerDraft(
  storage: Storage | undefined,
  sessionId: string,
  text: string,
  deliveryId: string,
  now = Date.now()
): { text: string; duplicate: boolean } {
  if (!storage || !sessionId || !deliveryId || !text) throw new Error('草稿接收参数无效。')
  if (deletedDraftKeys.has(sessionId)) throw new Error('任务已删除，不能写入草稿。')
  if (text.length > MAX_TEXT_LENGTH) throw new Error('交付文字超过草稿上限。')
  const document = readDocument(storage)
  const receipt = document.deliveries[deliveryId]
  if (receipt) {
    if (receipt.sessionId !== sessionId) throw new Error('交付 ID 已绑定其他任务。')
    return { text: document.drafts[sessionId]?.text ?? '', duplicate: true }
  }
  const current = document.drafts[sessionId]?.text ?? ''
  const next = current ? `${current}\n\n${text}` : text
  if (next.length > MAX_TEXT_LENGTH) throw new Error('加入后草稿超过 200,000 字符上限。')
  document.drafts[sessionId] = { text: next, updatedAt: now }
  document.deliveries[deliveryId] = { sessionId, receivedAt: now }
  const receipts = Object.entries(document.deliveries).sort((a, b) => b[1].receivedAt - a[1].receivedAt)
  document.deliveries = Object.fromEntries(receipts.slice(0, MAX_DELIVERY_RECEIPTS))
  // Unlike ordinary typing, failure must reach the caller and prevent an ack.
  storage.setItem(draftStorageKey(), JSON.stringify(document satisfies StoredComposerDrafts))
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(COMPOSER_DRAFT_DELIVERED_EVENT, { detail: { sessionId } }))
  return { text: next, duplicate: false }
}

function draftStorageKey(): string {
  const sessionId = taskWindowSessionId()
  // Different detached tasks never read/modify the same serialized document.
  return sessionId ? `${TASK_WINDOW_STORAGE_KEY}:${sessionId}` : STORAGE_KEY
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
