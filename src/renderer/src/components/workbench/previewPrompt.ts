import { truncate } from './previewUtils'
import type { OfficePreviewUnit } from './officePreviewUtils'

export interface PreviewPromptValue {
  ok?: boolean
  error?: string
  path?: string
  type?: string
  mode?: string
  mime?: string
  bytes?: number
  content?: unknown
}

export interface PreviewPromptAnnotation {
  note: string
  createdAt?: string
  path?: string
  locator?: unknown
}

export interface PreviewPromptOptions {
  maxContentChars?: number
  maxAnnotations?: number
  currentUnit?: OfficePreviewUnit
}

export function getPreviewAgentPromptSource(
  previewPath: string | undefined,
  preview: unknown,
  previewError?: string
): PreviewPromptValue | null {
  if (preview && typeof preview === 'object') return preview as PreviewPromptValue
  const cleanError = previewError?.trim()
  if (!cleanError) return null
  return {
    ok: false,
    path: previewPath,
    error: cleanError
  }
}

export function previewAnnotationLabel(note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim()
  return clean.length > 86 ? `${clean.slice(0, 85)}...` : clean
}

export function buildPreviewAgentPrompt(
  previewPath: string | undefined,
  preview: unknown,
  annotations: PreviewPromptAnnotation[],
  options: PreviewPromptOptions = {}
): string {
  const p = normalizePreview(preview)
  const maxContentChars = positiveInt(options.maxContentChars, 20_000)
  const maxAnnotations = positiveInt(options.maxAnnotations, 20)
  const currentUnit = options.currentUnit
  const rawContent = currentUnit?.content ?? (typeof p.content === 'string' ? p.content : '')
  const contentTruncated = rawContent.length > maxContentChars
  const content = rawContent ? truncate(rawContent, maxContentChars) : ''
  const visibleAnnotations = annotations.slice(0, maxAnnotations)
  const annotationsTruncated = annotations.length > visibleAnnotations.length
  const currentUnitLocatorLine = formatCurrentUnitLocator(currentUnit)
  const notes = annotations
    .slice(0, maxAnnotations)
    .map((item, index) => formatAnnotation(item, index))
    .join('\n')

  return [
    '请基于这个 EastGenesis 产物预览继续工作。',
    '',
    `文件: ${p.path ?? previewPath ?? '(unknown)'}`,
    `类型: ${p.type ?? '(unknown)'}`,
    `模式: ${p.mode ?? '(unknown)'}`,
    `MIME: ${p.mime ?? '(unknown)'}`,
    currentUnit ? '发送范围: 当前结构单元' : '发送范围: 整份文件',
    currentUnit ? `当前单元: ${currentUnit.title}` : '',
    currentUnit ? `当前序号: ${currentUnit.position}/${currentUnit.total}` : '',
    currentUnit ? `单元类型: ${currentUnit.kind}` : '',
    currentUnitLocatorLine,
    typeof p.bytes === 'number' ? `大小: ${p.bytes} bytes` : '',
    rawContent ? `内容字符: ${rawContent.length}` : '',
    rawContent ? `已发送字符: ${Math.min(rawContent.length, maxContentChars)}` : '',
    rawContent ? `内容截断: ${contentTruncated ? '是' : '否'}` : '',
    annotations.length > 0
      ? `批注数量: ${visibleAnnotations.length}/${annotations.length}${annotationsTruncated ? ' (已截断)' : ''}`
      : '',
    p.ok === false && p.error ? `预览错误: ${p.error}` : '',
    content ? `\n${currentUnit ? '当前结构单元内容' : '预览内容'}:\n\`\`\`` : '',
    content,
    content ? '```' : '',
    !content ? '\n预览内容: (此预览没有可发送的文本内容;请基于文件元数据、批注继续,或先提取文本/OCR/转换后再分析。)' : '',
    notes ? '\n结构化批注:\n' : '',
    notes,
    '',
    '请指出需要修改的文件、具体问题和下一步操作。'
  ]
    .filter(Boolean)
    .join('\n')
}

function normalizePreview(preview: unknown): PreviewPromptValue {
  if (!preview || typeof preview !== 'object') return {}
  return preview as PreviewPromptValue
}

function formatAnnotation(item: PreviewPromptAnnotation, index: number): string {
  const parts = [`${index + 1}.`]
  if (item.createdAt) parts.push(`[${item.createdAt}]`)
  if (item.path) parts.push(`path=${item.path}`)
  const locator = formatLocator(item.locator)
  if (locator) parts.push(`locator=${locator}`)
  parts.push(item.note)
  return parts.join(' ')
}

function formatLocator(locator: unknown): string {
  if (!locator || typeof locator !== 'object') return ''
  try {
    return JSON.stringify(locator)
  } catch {
    return ''
  }
}

function formatCurrentUnitLocator(currentUnit: OfficePreviewUnit | undefined): string {
  if (!currentUnit) return ''
  return `当前定位: locator=${formatLocator({
    page: currentUnit.position,
    quote: currentUnit.quote || undefined,
    selector: `office:${currentUnit.kind}:${currentUnit.position}:${currentUnit.title}`
  })}`
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback
}
