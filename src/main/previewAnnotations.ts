import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeDurableFile } from './durable-file'
import type {
  BrowserAnnotationBoundingBox,
  PreviewAnnotation,
  PreviewAnnotationInput,
  PreviewAnnotationLocator,
  PreviewType
} from '../shared/types'

export class PreviewAnnotationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewAnnotationValidationError'
  }
}

const JSON_INDENT = 2
export const PREVIEW_ANNOTATION_SCHEMA_VERSION = 1 as const
const PREVIEW_ANNOTATION_FORMAT = 'caogen.preview-annotation.v1' as const
const SAFE_PATH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const PREVIEW_TYPES = new Set<PreviewType>(['html', 'markdown', 'text', 'csv', 'json', 'image', 'pdf', 'office', 'unknown'])

export async function savePreviewAnnotation(
  rootDir: string,
  input: PreviewAnnotationInput
): Promise<PreviewAnnotation>
export async function savePreviewAnnotation(
  rootDir: string,
  sessionId: string,
  input: PreviewAnnotationInput
): Promise<PreviewAnnotation>
export async function savePreviewAnnotation(
  rootDir: string,
  sessionOrInput: string | PreviewAnnotationInput,
  maybeInput?: PreviewAnnotationInput
): Promise<PreviewAnnotation> {
  const input = normalizeSaveArgs(sessionOrInput, maybeInput)
  const annotation = normalizePreviewAnnotation(input.sessionId, input)
  const filePath = annotationJsonPath(resolveRootDir(rootDir), annotation.sessionId, annotation.id)
  await atomicWriteText(filePath, `${JSON.stringify(storedAnnotation(annotation), null, JSON_INDENT)}\n`)
  return annotation
}

export async function listPreviewAnnotations(
  rootDir: string,
  sessionId: string,
  filePath?: string
): Promise<PreviewAnnotation[]> {
  const root = resolveRootDir(rootDir)
  const safeSessionId = normalizePathId(sessionId, 'sessionId')
  const sessionDir = sessionAnnotationsDir(root, safeSessionId)
  const names = await readdir(sessionDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const normalizedPath = filePath ? normalizeProjectRelativePath(filePath) : undefined
  const annotations: PreviewAnnotation[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const id = normalizePathId(name.slice(0, -'.json'.length), 'annotationId')
    const raw = await readFile(annotationJsonPath(root, safeSessionId, id), 'utf8')
    const parsed = parseStoredAnnotation(raw, safeSessionId, id)
    if (!normalizedPath || parsed.annotation.path === normalizedPath) annotations.push(parsed.annotation)
    if (parsed.legacy) {
      await atomicWriteText(annotationJsonPath(root, safeSessionId, id), `${JSON.stringify(storedAnnotation(parsed.annotation), null, JSON_INDENT)}\n`)
    }
  }
  return annotations.sort(compareAnnotations)
}

export function normalizePreviewAnnotation(
  sessionId: string,
  input: PreviewAnnotationInput
): PreviewAnnotation {
  if (!input || typeof input !== 'object') {
    throw new PreviewAnnotationValidationError('annotation 必须是对象')
  }
  const safeSessionId = normalizePathId(sessionId, 'sessionId')
  if (normalizePathId(input.sessionId, 'sessionId') !== safeSessionId) {
    throw new PreviewAnnotationValidationError('input.sessionId 与会话不匹配')
  }

  const annotation: PreviewAnnotation = {
    id: normalizeOptionalId(input.id, 'id') ?? randomUUID(),
    sessionId: safeSessionId,
    path: normalizeProjectRelativePath(input.path),
    note: normalizeRequiredText(input.note, 'note'),
    createdAt: normalizeCreatedAt(input.createdAt)
  }

  const type = normalizePreviewType(input.type)
  if (type) annotation.type = type

  const mime = normalizeOptionalText(input.mime, 'mime')
  if (mime !== undefined) annotation.mime = mime

  const locator = normalizeLocator(input.locator)
  if (locator) annotation.locator = locator

  const boundingBox = normalizeBoundingBox(input.boundingBox)
  if (boundingBox) annotation.boundingBox = boundingBox

  const screenshotPath = normalizeOptionalText(input.screenshotPath, 'screenshotPath')
  if (screenshotPath !== undefined) annotation.screenshotPath = screenshotPath

  return annotation
}

function normalizeSaveArgs(
  sessionOrInput: string | PreviewAnnotationInput,
  maybeInput?: PreviewAnnotationInput
): PreviewAnnotationInput {
  if (typeof sessionOrInput !== 'string') return sessionOrInput
  if (!maybeInput || typeof maybeInput !== 'object') {
    throw new PreviewAnnotationValidationError('annotation 必须是对象')
  }
  return {
    ...maybeInput,
    sessionId: sessionOrInput
  }
}

function parseStoredAnnotation(raw: string, sessionId: string, annotationId: string): { annotation: PreviewAnnotation; legacy: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new PreviewAnnotationValidationError(`preview annotation JSON 无法解析:${errorMessage(err)}`)
  }
  if (!isRecord(parsed)) throw new PreviewAnnotationValidationError('preview annotation JSON 必须是对象')
  const legacy = !hasOwn(parsed, 'schemaVersion') && !hasOwn(parsed, 'format') && hasOwn(parsed, 'id')
  let input: unknown = parsed
  if (!legacy) {
    if (parsed.schemaVersion !== PREVIEW_ANNOTATION_SCHEMA_VERSION || parsed.format !== PREVIEW_ANNOTATION_FORMAT) {
      throw new PreviewAnnotationValidationError('不支持的 preview annotation schema 版本或格式')
    }
    const { schemaVersion: _schemaVersion, format: _format, ...annotation } = parsed
    input = annotation
  }
  const annotation = normalizePreviewAnnotation(sessionId, input as PreviewAnnotationInput)
  if (annotation.id !== annotationId) {
    throw new PreviewAnnotationValidationError('annotation id 与文件名不匹配')
  }
  return { annotation, legacy }
}

function resolveRootDir(rootDir: string): string {
  return path.resolve(normalizeRequiredText(rootDir, 'rootDir'))
}

function sessionAnnotationsDir(root: string, sessionId: string): string {
  const dir = path.join(root, normalizePathId(sessionId, 'sessionId'))
  ensureInsideRoot(root, dir)
  return dir
}

function annotationJsonPath(root: string, sessionId: string, annotationId: string): string {
  const filePath = path.join(
    sessionAnnotationsDir(root, sessionId),
    `${normalizePathId(annotationId, 'annotationId')}.json`
  )
  ensureInsideRoot(root, filePath)
  return filePath
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await writeDurableFile(filePath, content)
}

function storedAnnotation(annotation: PreviewAnnotation): Record<string, unknown> {
  return {
    schemaVersion: PREVIEW_ANNOTATION_SCHEMA_VERSION,
    format: PREVIEW_ANNOTATION_FORMAT,
    ...annotation
  }
}

function normalizeProjectRelativePath(value: unknown): string {
  const raw = normalizeRequiredText(value, 'path').replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(raw) || path.posix.isAbsolute(raw)) {
    throw new PreviewAnnotationValidationError('path 必须是项目内相对路径')
  }
  const parts = raw.split('/')
  if (parts.includes('..')) {
    throw new PreviewAnnotationValidationError('path 必须是项目内相对路径')
  }
  const normalized = path.posix.normalize(raw)
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new PreviewAnnotationValidationError('path 必须是项目内相对路径')
  }
  return normalized
}

function normalizePreviewType(value: unknown): PreviewType | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !PREVIEW_TYPES.has(value as PreviewType)) {
    throw new PreviewAnnotationValidationError('type 不是有效预览类型')
  }
  return value as PreviewType
}

function normalizeLocator(value: unknown): PreviewAnnotationLocator | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new PreviewAnnotationValidationError('locator 必须是对象')
  const locator: PreviewAnnotationLocator = {}
  if (hasOwn(value, 'page') && value.page !== undefined) locator.page = normalizeNonNegativeInt(value.page, 'locator.page')
  if (hasOwn(value, 'row') && value.row !== undefined) locator.row = normalizeNonNegativeInt(value.row, 'locator.row')
  if (hasOwn(value, 'column') && value.column !== undefined) {
    locator.column = normalizeNonNegativeInt(value.column, 'locator.column')
  }
  const quote = normalizeOptionalText(value.quote, 'locator.quote')
  if (quote !== undefined) locator.quote = quote
  const selector = normalizeOptionalText(value.selector, 'locator.selector')
  if (selector !== undefined) locator.selector = selector
  return Object.keys(locator).length > 0 ? locator : undefined
}

function normalizeBoundingBox(value: unknown): BrowserAnnotationBoundingBox | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new PreviewAnnotationValidationError('boundingBox 必须是对象')
  return {
    x: normalizeFiniteNumber(value.x, 'boundingBox.x'),
    y: normalizeFiniteNumber(value.y, 'boundingBox.y'),
    width: normalizeFiniteNumber(value.width, 'boundingBox.width', 0),
    height: normalizeFiniteNumber(value.height, 'boundingBox.height', 0)
  }
}

function normalizeCreatedAt(value: unknown): string {
  if (value === undefined) return new Date().toISOString()
  if (typeof value !== 'string') throw new PreviewAnnotationValidationError('createdAt 必须是字符串')
  const trimmed = value.trim()
  const timestamp = Date.parse(trimmed)
  if (!trimmed || !Number.isFinite(timestamp)) {
    throw new PreviewAnnotationValidationError('createdAt 必须是有效时间')
  }
  return new Date(timestamp).toISOString()
}

function normalizeOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return normalizePathId(value, field)
}

function normalizePathId(value: unknown, field: string): string {
  const text = normalizeRequiredText(value, field)
  if (!SAFE_PATH_ID_RE.test(text)) throw new PreviewAnnotationValidationError(`${field} 包含非法字符`)
  return text
}

function normalizeOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return normalizeRequiredText(value, field)
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new PreviewAnnotationValidationError(`${field} 必须是字符串`)
  if (value.includes('\0')) throw new PreviewAnnotationValidationError(`${field} 包含非法字符`)
  const text = value.trim()
  if (!text) throw new PreviewAnnotationValidationError(`${field} 不能为空`)
  return text
}

function normalizeFiniteNumber(value: unknown, field: string, min?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PreviewAnnotationValidationError(`${field} 必须是有限数字`)
  }
  if (min !== undefined && value < min) throw new PreviewAnnotationValidationError(`${field} 不能小于 ${min}`)
  return value
}

function normalizeNonNegativeInt(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new PreviewAnnotationValidationError(`${field} 必须是非负整数`)
  }
  return Number(value)
}

function ensureInsideRoot(root: string, fullPath: string): void {
  const relativePath = path.relative(root, fullPath)
  if (relativePath === '') return
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return
  throw new PreviewAnnotationValidationError('批注路径越过了存储目录边界')
}

function compareAnnotations(a: PreviewAnnotation, b: PreviewAnnotation): number {
  const byCreatedAt = b.createdAt.localeCompare(a.createdAt)
  if (byCreatedAt !== 0) return byCreatedAt
  return a.id.localeCompare(b.id)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
