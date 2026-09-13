import { normalizeOfficeIntent } from './office-revision/input'
import type { DocumentAttachmentView, ImageAttachmentView, SendMessagePayload } from '../shared/types'

export interface StableMessagePayload {
  officeRevisionIntent?: SendMessagePayload['officeRevisionIntent']
  text: string
  images: ImageAttachmentView[]
  documents: DocumentAttachmentView[]
  messageId?: string
}

export function normalizeStableMessagePayload(input: string | SendMessagePayload): StableMessagePayload {
  if (typeof input === 'string') return { text: input.trim(), images: [], documents: [] }
  const messageId = typeof input.messageId === 'string' ? input.messageId.trim() : ''
  return {
    text: typeof input.text === 'string' ? input.text.trim() : '',
    images: Array.isArray(input.images) ? input.images.filter(isImageAttachmentView) : [],
    documents: Array.isArray(input.documents) ? input.documents.filter(isDocumentAttachmentView) : [],
    ...(input.officeRevisionIntent === undefined ? {} : { officeRevisionIntent: normalizeOfficeIntent(input.officeRevisionIntent) }),
    ...(messageId ? { messageId } : {})
  }
}

function isDocumentAttachmentView(value: unknown): value is DocumentAttachmentView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.path === 'string' &&
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    record.name.length <= 1024 &&
    !record.name.includes('\0') &&
    !/[\r\n]/.test(record.name) &&
    !record.name.replace(/\\/g, '/').split('/').some((segment) => segment === '..') &&
    record.mime === 'text/plain; charset=utf-8' &&
    typeof record.bytes === 'number' &&
    Number.isFinite(record.bytes) &&
    typeof record.createdAt === 'string' &&
    (record.dataClass === 'S2' || record.dataClass === 'S3')
  )
}

function isImageAttachmentView(value: unknown): value is ImageAttachmentView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.path === 'string' &&
    typeof record.mime === 'string' &&
    typeof record.bytes === 'number' &&
    Number.isFinite(record.bytes) &&
    typeof record.createdAt === 'string'
  )
}
