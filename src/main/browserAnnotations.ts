import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeDurableFile } from './durable-file'

export interface BrowserAnnotationBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationViewport {
  width: number
  height: number
  deviceScaleFactor?: number
}

export interface BrowserAnnotation {
  id: string
  sessionId: string
  url: string
  title?: string
  selector?: string
  boundingBox?: BrowserAnnotationBoundingBox
  screenshotPath?: string
  note: string
  consoleErrors: string[]
  viewport?: BrowserAnnotationViewport
  createdAt: string
}

export interface BrowserAnnotationInput {
  id?: string
  sessionId: string
  url: string
  title?: string | null
  selector?: string | null
  boundingBox?: BrowserAnnotationBoundingBox | null
  screenshotPath?: string | null
  note: string
  consoleErrors?: string[] | null
  viewport?: BrowserAnnotationViewport | null
  createdAt?: string
}

export class BrowserAnnotationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserAnnotationValidationError'
  }
}

const MAX_CONSOLE_ERRORS = 200
const JSON_INDENT = 2
export const BROWSER_ANNOTATION_SCHEMA_VERSION = 1 as const
const BROWSER_ANNOTATION_FORMAT = 'caogen.browser-annotation.v1' as const
const SAFE_PATH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

export function normalizeAnnotation(input: BrowserAnnotationInput): BrowserAnnotation {
  if (!input || typeof input !== 'object') {
    throw new BrowserAnnotationValidationError('annotation 必须是对象')
  }

  const annotation: BrowserAnnotation = {
    id: normalizeOptionalId(input.id, 'id') ?? randomUUID(),
    sessionId: normalizePathId(input.sessionId, 'sessionId'),
    url: normalizeUrl(input.url),
    note: normalizeRequiredText(input.note, 'note'),
    consoleErrors: normalizeConsoleErrors(input.consoleErrors),
    createdAt: normalizeCreatedAt(input.createdAt)
  }

  const title = normalizeOptionalText(input.title, 'title')
  if (title !== undefined) annotation.title = title

  const selector = normalizeOptionalText(input.selector, 'selector')
  if (selector !== undefined) annotation.selector = selector

  const boundingBox = normalizeBoundingBox(input.boundingBox)
  if (boundingBox) annotation.boundingBox = boundingBox

  const screenshotPath = normalizeOptionalText(input.screenshotPath, 'screenshotPath')
  if (screenshotPath !== undefined) annotation.screenshotPath = screenshotPath

  const viewport = normalizeViewport(input.viewport)
  if (viewport) annotation.viewport = viewport

  return annotation
}

export async function saveAnnotation(rootDir: string, input: BrowserAnnotationInput): Promise<BrowserAnnotation> {
  const annotation = normalizeAnnotation(input)
  const root = resolveRootDir(rootDir)
  const sessionDir = sessionAnnotationsDir(root, annotation.sessionId)
  await mkdir(sessionDir, { recursive: true })

  const filePath = annotationJsonPath(root, annotation.sessionId, annotation.id)
  await atomicWriteText(filePath, `${JSON.stringify(storedAnnotation(annotation), null, JSON_INDENT)}\n`)
  return annotation
}

export async function listAnnotations(rootDir: string, sessionId: string): Promise<BrowserAnnotation[]> {
  const root = resolveRootDir(rootDir)
  const safeSessionId = normalizePathId(sessionId, 'sessionId')
  const sessionDir = sessionAnnotationsDir(root, safeSessionId)
  const names = await readdir(sessionDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })

  const annotations: BrowserAnnotation[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const id = normalizePathId(name.slice(0, -'.json'.length), 'annotationId')
    const filePath = annotationJsonPath(root, safeSessionId, id)
    const raw = await readFile(filePath, 'utf8')
    const parsed = parseStoredAnnotation(raw, filePath, safeSessionId, id)
    annotations.push(parsed.annotation)
    if (parsed.legacy) {
      await atomicWriteText(filePath, `${JSON.stringify(storedAnnotation(parsed.annotation), null, JSON_INDENT)}\n`)
    }
  }

  return annotations.sort(compareAnnotations)
}

export async function readAnnotation(
  rootDir: string,
  sessionId: string,
  annotationId: string
): Promise<BrowserAnnotation | null> {
  const root = resolveRootDir(rootDir)
  const safeSessionId = normalizePathId(sessionId, 'sessionId')
  const safeAnnotationId = normalizePathId(annotationId, 'annotationId')
  const filePath = annotationJsonPath(root, safeSessionId, safeAnnotationId)
  const raw = await readFile(filePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })

  if (raw === null) return null
  const parsed = parseStoredAnnotation(raw, filePath, safeSessionId, safeAnnotationId)
  if (parsed.legacy) {
    await atomicWriteText(filePath, `${JSON.stringify(storedAnnotation(parsed.annotation), null, JSON_INDENT)}\n`)
  }
  return parsed.annotation
}

function parseStoredAnnotation(
  raw: string,
  filePath: string,
  expectedSessionId: string,
  expectedId: string
): { annotation: BrowserAnnotation; legacy: boolean } {
  const value = parseJsonObject(raw, filePath)
  const legacy = !hasOwn(value, 'schemaVersion') && !hasOwn(value, 'format') && hasOwn(value, 'id')
  let input: unknown = value
  if (!legacy) {
    if (value.schemaVersion !== BROWSER_ANNOTATION_SCHEMA_VERSION || value.format !== BROWSER_ANNOTATION_FORMAT) {
      throw new BrowserAnnotationValidationError(`不支持的批注 schema 版本或格式: ${filePath}`)
    }
    const { schemaVersion: _schemaVersion, format: _format, ...annotation } = value
    input = annotation
  }
  if (!isRecord(input) || !hasOwn(input, 'id') || !hasOwn(input, 'createdAt')) {
    throw new BrowserAnnotationValidationError(`批注 JSON 缺少必需字段: ${filePath}`)
  }

  const annotation = normalizeAnnotation(input as unknown as BrowserAnnotationInput)
  if (annotation.sessionId !== expectedSessionId) {
    throw new BrowserAnnotationValidationError(`批注 sessionId 与路径不匹配: ${filePath}`)
  }
  if (annotation.id !== expectedId) {
    throw new BrowserAnnotationValidationError(`批注 id 与文件名不匹配: ${filePath}`)
  }
  return { annotation, legacy }
}

function parseJsonObject(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new BrowserAnnotationValidationError(`批注 JSON 无法解析: ${filePath}: ${errorMessage(err)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BrowserAnnotationValidationError(`批注 JSON 必须是对象: ${filePath}`)
  }
  return parsed as Record<string, unknown>
}

function normalizeUrl(value: unknown): string {
  const text = normalizeRequiredText(value, 'url')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new BrowserAnnotationValidationError('url 必须是有效的绝对 URL')
  }
  if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) {
    throw new BrowserAnnotationValidationError('url 仅支持 http、https 或 file 协议')
  }
  return url.href
}

function normalizeConsoleErrors(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new BrowserAnnotationValidationError('consoleErrors 必须是字符串数组')
  }

  const normalized = value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new BrowserAnnotationValidationError(`consoleErrors[${index}] 必须是字符串`)
    }
    return entry
  })

  return normalized.slice(-MAX_CONSOLE_ERRORS)
}

function normalizeBoundingBox(value: unknown): BrowserAnnotationBoundingBox | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    throw new BrowserAnnotationValidationError('boundingBox 必须是对象')
  }

  return {
    x: normalizeFiniteNumber(value.x, 'boundingBox.x'),
    y: normalizeFiniteNumber(value.y, 'boundingBox.y'),
    width: normalizeFiniteNumber(value.width, 'boundingBox.width', 0),
    height: normalizeFiniteNumber(value.height, 'boundingBox.height', 0)
  }
}

function normalizeViewport(value: unknown): BrowserAnnotationViewport | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    throw new BrowserAnnotationValidationError('viewport 必须是对象')
  }

  const viewport: BrowserAnnotationViewport = {
    width: normalizeFiniteNumber(value.width, 'viewport.width', Number.MIN_VALUE),
    height: normalizeFiniteNumber(value.height, 'viewport.height', Number.MIN_VALUE)
  }

  if (hasOwn(value, 'deviceScaleFactor') && value.deviceScaleFactor !== undefined) {
    viewport.deviceScaleFactor = normalizeFiniteNumber(
      value.deviceScaleFactor,
      'viewport.deviceScaleFactor',
      Number.MIN_VALUE
    )
  }

  return viewport
}

function normalizeCreatedAt(value: unknown): string {
  if (value === undefined) return new Date().toISOString()
  if (typeof value !== 'string') {
    throw new BrowserAnnotationValidationError('createdAt 必须是字符串')
  }
  const normalized = value.trim()
  if (!normalized) throw new BrowserAnnotationValidationError('createdAt 不能为空')

  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) {
    throw new BrowserAnnotationValidationError('createdAt 必须是有效时间')
  }
  return new Date(timestamp).toISOString()
}

function normalizeFiniteNumber(value: unknown, field: string, min?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserAnnotationValidationError(`${field} 必须是有限数字`)
  }
  if (min !== undefined && value < min) {
    throw new BrowserAnnotationValidationError(`${field} 不能小于 ${min}`)
  }
  return value
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new BrowserAnnotationValidationError(`${field} 必须是字符串`)
  }
  if (value.includes('\0')) {
    throw new BrowserAnnotationValidationError(`${field} 包含非法字符`)
  }
  const normalized = value.trim()
  if (!normalized) throw new BrowserAnnotationValidationError(`${field} 不能为空`)
  return normalized
}

function normalizeOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return normalizeRequiredText(value, field)
}

function normalizeOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return normalizePathId(value, field)
}

function normalizePathId(value: unknown, field: string): string {
  const normalized = normalizeRequiredText(value, field)
  if (!SAFE_PATH_ID_RE.test(normalized)) {
    throw new BrowserAnnotationValidationError(`${field} 包含非法字符`)
  }
  return normalized
}

function resolveRootDir(rootDir: string): string {
  const root = normalizeRequiredText(rootDir, 'rootDir')
  return path.resolve(root)
}

function sessionAnnotationsDir(root: string, sessionId: string): string {
  const dir = path.join(root, normalizePathId(sessionId, 'sessionId'))
  ensureInsideRoot(root, dir)
  return dir
}

function annotationJsonPath(root: string, sessionId: string, annotationId: string): string {
  const filePath = path.join(sessionAnnotationsDir(root, sessionId), `${normalizePathId(annotationId, 'annotationId')}.json`)
  ensureInsideRoot(root, filePath)
  return filePath
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await writeDurableFile(filePath, content)
}

function storedAnnotation(annotation: BrowserAnnotation): Record<string, unknown> {
  return {
    schemaVersion: BROWSER_ANNOTATION_SCHEMA_VERSION,
    format: BROWSER_ANNOTATION_FORMAT,
    ...annotation
  }
}

function ensureInsideRoot(root: string, fullPath: string): void {
  const relativePath = path.relative(root, fullPath)
  if (relativePath === '') return
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return
  throw new BrowserAnnotationValidationError('批注路径越过了存储目录边界')
}

function compareAnnotations(a: BrowserAnnotation, b: BrowserAnnotation): number {
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
