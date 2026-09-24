import { app } from 'electron'
import { isAbsolute, relative, resolve } from 'node:path'
import type { DocumentAttachmentView, ImageAttachmentView, SendMessagePayload } from '../../shared/types'
import { sessionImageAttachmentsRoot } from '../attachmentOps'
import { normalizeOfficeIntent } from '../office-revision/input'
import { normalizeGoalRevisionIntent } from '../../shared/session-goal-revision'
import { normalizeRequirementRevisionIntent } from '../../shared/session-requirement-revision'

export function attachmentRoot(sessionId: string): string {
  return sessionImageAttachmentsRoot(app.getPath('userData'), sessionId)
}

export function normalizeSendPayload(sessionId: string, raw: unknown): SendMessagePayload | null {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { text } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  const images = Array.isArray(record.images)
    ? record.images.filter((image): image is ImageAttachmentView => {
        return isImageAttachmentView(image) && isInsideAttachmentRoot(sessionId, image.path)
      })
    : []
  const documents = Array.isArray(record.documents)
    ? record.documents.filter((document): document is DocumentAttachmentView => {
        return isDocumentAttachmentView(document) &&
          isExpectedDocumentAttachmentPath(sessionId, document)
      })
    : []
  if (!text && images.length === 0 && documents.length === 0) return null
  return {
    text,
    ...(record.officeRevisionIntent === undefined ? {} : { officeRevisionIntent: normalizeOfficeIntent(record.officeRevisionIntent) }),
    ...(record.goalRevisionIntent === undefined ? {} : { goalRevisionIntent: normalizeGoalRevisionIntent(record.goalRevisionIntent) }),
    ...(record.requirementRevisionIntent === undefined ? {} : { requirementRevisionIntent: normalizeRequirementRevisionIntent(record.requirementRevisionIntent) }),
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {})
  }
}

export function isInsideAttachmentRoot(sessionId: string, fullPath: string): boolean {
  const root = resolve(attachmentRoot(sessionId))
  const target = resolve(fullPath)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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

function isDocumentAttachmentView(value: unknown): value is DocumentAttachmentView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.hash === 'string' &&
    record.id === record.hash &&
    /^[a-f0-9]{64}$/.test(record.hash) &&
    typeof record.path === 'string' &&
    typeof record.name === 'string' &&
    isSafeDocumentAttachmentName(record.name) &&
    record.mime === 'text/plain; charset=utf-8' &&
    typeof record.bytes === 'number' &&
    Number.isFinite(record.bytes) &&
    typeof record.createdAt === 'string' &&
    (record.dataClass === 'S2' || record.dataClass === 'S3')
  )
}

function isSafeDocumentAttachmentName(name: string): boolean {
  const normalized = name.replace(/\\/g, '/')
  return name.length > 0 &&
    name.length <= 1024 &&
    !isAbsolute(name) &&
    !name.includes('\0') &&
    !/[\r\n]/.test(name) &&
    !normalized.split('/').some((segment) => segment === '..')
}

function isExpectedDocumentAttachmentPath(
  sessionId: string,
  document: DocumentAttachmentView
): boolean {
  const expected = resolve(attachmentRoot(sessionId), 'documents', document.dataClass, `${document.hash}.txt`)
  return resolve(document.path) === expected
}
