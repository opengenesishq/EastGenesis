import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { inflateRawSync, inflateSync } from 'node:zlib'

const DEFAULT_MAX_TEXT_PREVIEW_BYTES = 1_000_000
const DEFAULT_MAX_ASSET_PREVIEW_BYTES = 20_000_000
const DEFAULT_MAX_PDF_TEXT_CHARS = 80_000

export type PreviewType =
  | 'html'
  | 'markdown'
  | 'text'
  | 'csv'
  | 'json'
  | 'image'
  | 'pdf'
  | 'office'
  | 'unknown'

export type PreviewMode = 'text' | 'asset' | 'unsupported'

export interface PreviewOpsFailure {
  ok: false
  error: string
}

export interface PreviewDetection {
  ok: true
  path: string
  type: PreviewType
  mode: PreviewMode
  mime: string
  bytes: number
  mtimeMs: number
}

export interface TextPreview extends PreviewDetection {
  mode: 'text'
  type: 'html' | 'markdown' | 'text' | 'csv' | 'json' | 'office'
  content: string
}

export interface AssetPreview extends PreviewDetection {
  mode: 'asset'
  type: 'image' | 'pdf'
  dataUrl: string
  content?: string
}

export interface UnknownPreview extends PreviewDetection {
  mode: 'unsupported'
  type: 'unknown'
}

export interface PreparePreviewOptions {
  maxTextBytes?: number
  maxAssetBytes?: number
}

export type DetectPreviewResult = PreviewDetection | PreviewOpsFailure
export type PreparePreviewResult = TextPreview | AssetPreview | UnknownPreview | PreviewOpsFailure

export interface PreviewFileTarget {
  fullPath: string
  relativePath: string
  bytes: number
  mtimeMs: number
}

interface PreviewKind {
  type: PreviewType
  mode: PreviewMode
  mime: string
}

const PREVIEW_BY_EXTENSION: Record<string, PreviewKind> = {
  '.csv': { type: 'csv', mode: 'text', mime: 'text/csv' },
  '.doc': { type: 'unknown', mode: 'unsupported', mime: 'application/msword' },
  '.docx': {
    type: 'office',
    mode: 'text',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  },
  '.gif': { type: 'image', mode: 'asset', mime: 'image/gif' },
  '.htm': { type: 'html', mode: 'text', mime: 'text/html' },
  '.html': { type: 'html', mode: 'text', mime: 'text/html' },
  '.odp': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.oasis.opendocument.presentation' },
  '.ods': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  '.jpeg': { type: 'image', mode: 'asset', mime: 'image/jpeg' },
  '.jpg': { type: 'image', mode: 'asset', mime: 'image/jpeg' },
  '.json': { type: 'json', mode: 'text', mime: 'application/json' },
  '.log': { type: 'text', mode: 'text', mime: 'text/plain' },
  '.markdown': { type: 'markdown', mode: 'text', mime: 'text/markdown' },
  '.md': { type: 'markdown', mode: 'text', mime: 'text/markdown' },
  '.pdf': { type: 'pdf', mode: 'asset', mime: 'application/pdf' },
  '.png': { type: 'image', mode: 'asset', mime: 'image/png' },
  '.ppt': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.ms-powerpoint' },
  '.pptx': {
    type: 'office',
    mode: 'text',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  },
  '.svg': { type: 'image', mode: 'asset', mime: 'image/svg+xml' },
  '.text': { type: 'text', mode: 'text', mime: 'text/plain' },
  '.tsv': { type: 'csv', mode: 'text', mime: 'text/tab-separated-values' },
  '.txt': { type: 'text', mode: 'text', mime: 'text/plain' },
  '.webp': { type: 'image', mode: 'asset', mime: 'image/webp' },
  '.xls': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.ms-excel' },
  '.xlsx': {
    type: 'office',
    mode: 'text',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
}

const UNKNOWN_PREVIEW: PreviewKind = {
  type: 'unknown',
  mode: 'unsupported',
  mime: 'application/octet-stream'
}

/**
 * 检测项目内文件可用的预览类型。只返回元数据,不读取文件内容。
 */
export async function detectPreview(projectRoot: string, relativePath: string): Promise<DetectPreviewResult> {
  try {
    const target = await resolvePreviewFileTarget(projectRoot, relativePath)
    return {
      ok: true,
      path: target.relativePath,
      ...detectPreviewKind(target.relativePath),
      bytes: target.bytes,
      mtimeMs: target.mtimeMs
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

/**
 * 准备项目内文件预览。文本类返回 UTF-8 content; 图片/PDF/unknown 只返回稳定元数据。
 */
export async function preparePreview(
  projectRoot: string,
  relativePath: string,
  options: PreparePreviewOptions = {}
): Promise<PreparePreviewResult> {
  try {
    const target = await resolvePreviewFileTarget(projectRoot, relativePath)
    const kind = detectPreviewKind(target.relativePath)
    const base = {
      ok: true as const,
      path: target.relativePath,
      ...kind,
      bytes: target.bytes,
      mtimeMs: target.mtimeMs
    }

    if (kind.mode !== 'text') {
      if (kind.type === 'unknown') return base as UnknownPreview
      const maxAssetBytes = positiveLimit(options.maxAssetBytes, DEFAULT_MAX_ASSET_PREVIEW_BYTES)
      if (target.bytes > maxAssetBytes) {
        return failure(`预览资产过大: ${target.bytes} bytes, 上限 ${maxAssetBytes} bytes`)
      }
      const buffer = await readFile(target.fullPath)
      const preview = {
        ...base,
        bytes: buffer.byteLength,
        dataUrl: `data:${kind.mime};base64,${buffer.toString('base64')}`
      } as AssetPreview
      if (kind.type === 'pdf') {
        const content = preparePdfText(buffer)
        if (content) preview.content = content
      }
      return preview
    }

    if (kind.type === 'office') {
      const maxOfficeBytes = positiveLimit(options.maxAssetBytes, DEFAULT_MAX_ASSET_PREVIEW_BYTES)
      if (target.bytes > maxOfficeBytes) {
        return failure(`Office 文档过大: ${target.bytes} bytes, 上限 ${maxOfficeBytes} bytes`)
      }
      const buffer = await readFile(target.fullPath)
      try {
        return {
          ...base,
          bytes: buffer.byteLength,
          content: prepareOfficeText(buffer, target.relativePath)
        } as TextPreview
      } catch (err) {
        return failure(`Office 文档无法解析:${errorMessage(err)}`)
      }
    }

    const maxTextBytes = positiveLimit(options.maxTextBytes, DEFAULT_MAX_TEXT_PREVIEW_BYTES)
    if (target.bytes > maxTextBytes) {
      return failure(`预览文本过大: ${target.bytes} bytes, 上限 ${maxTextBytes} bytes`)
    }

    const buffer = await readFile(target.fullPath)
    if (buffer.includes(0)) return failure('文件看起来是二进制内容')

    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return failure('文件不是有效的 UTF-8 文本')
    }

    return {
      ...base,
      bytes: buffer.byteLength,
      content
    } as TextPreview
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export async function resolvePreviewFileTarget(
  projectRoot: string,
  relativePath: string
): Promise<PreviewFileTarget> {
  const root = await normalizeProjectRoot(projectRoot)
  const target = resolveProjectPath(root, relativePath)
  const realTarget = await realpath(target.fullPath)
  ensureInsideRoot(root, realTarget)

  const info = await stat(realTarget)
  if (!info.isFile()) throw new Error('只能预览文件')

  return {
    fullPath: realTarget,
    relativePath: toProjectRelative(root, realTarget),
    bytes: info.size,
    mtimeMs: info.mtimeMs
  }
}

async function normalizeProjectRoot(projectRoot: string): Promise<string> {
  if (!projectRoot.trim()) throw new Error('项目目录不能为空')
  const root = await realpath(projectRoot)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('项目目录不存在或不是目录')
  return root
}

function resolveProjectPath(root: string, relativePath: string): { fullPath: string; relativePath: string } {
  if (!relativePath.trim()) throw new Error('文件路径不能为空')
  if (relativePath.includes('\0')) throw new Error('文件路径包含非法字符')
  if (path.isAbsolute(relativePath)) throw new Error('只允许项目内相对路径')

  const fullPath = path.resolve(root, relativePath)
  ensureInsideRoot(root, fullPath)
  return { fullPath, relativePath: toProjectRelative(root, fullPath) }
}

export function detectPreviewKind(relativePath: string): PreviewKind {
  const extension = path.extname(relativePath).toLowerCase()
  return PREVIEW_BY_EXTENSION[extension] ?? UNKNOWN_PREVIEW
}

export function prepareOfficeText(buffer: Buffer, relativePath: string): string {
  const zip = readZip(buffer)
  const extension = path.extname(relativePath).toLowerCase()
  if (extension === '.docx') return extractDocxText(zip)
  if (extension === '.xlsx') return extractXlsxText(zip)
  if (extension === '.pptx') return extractPptxText(zip)
  throw new Error('暂不支持该 Office 格式')
}

export function preparePdfText(buffer: Buffer): string | undefined {
  const text = extractPdfText(buffer, DEFAULT_MAX_PDF_TEXT_CHARS)
  if (!text) return undefined
  return ['# PDF Document', '', text].join('\n')
}

function extractPdfText(buffer: Buffer, maxChars: number): string {
  const parts: string[] = []
  for (const stream of extractPdfContentStreams(buffer)) {
    const extracted = extractPdfTextFromStream(stream, Math.max(0, maxChars - parts.join('\n').length))
    if (extracted) parts.push(extracted)
    if (parts.join('\n').length >= maxChars) break
  }
  return normalizeExtractedText(parts.join('\n')).slice(0, maxChars).trim()
}

function extractPdfContentStreams(buffer: Buffer): string[] {
  const source = buffer.toString('latin1')
  const streams: string[] = []
  let searchFrom = 0
  while (searchFrom < source.length) {
    const streamToken = source.indexOf('stream', searchFrom)
    if (streamToken < 0) break
    const endToken = source.indexOf('endstream', streamToken + 6)
    if (endToken < 0) break
    const dictStart = source.lastIndexOf('<<', streamToken)
    const dictEnd = source.lastIndexOf('>>', streamToken)
    const dict = dictStart >= 0 && dictEnd > dictStart ? source.slice(dictStart, dictEnd + 2) : ''
    let dataStart = streamToken + 6
    if (source[dataStart] === '\r' && source[dataStart + 1] === '\n') dataStart += 2
    else if (source[dataStart] === '\n' || source[dataStart] === '\r') dataStart += 1
    const raw = trimPdfStreamBuffer(buffer.subarray(dataStart, endToken))
    const decoded = decodePdfStream(raw, dict)
    if (decoded) streams.push(decoded.toString('latin1'))
    searchFrom = endToken + 9
  }
  return streams
}

function trimPdfStreamBuffer(buffer: Buffer): Buffer {
  let start = 0
  let end = buffer.length
  while (start < end && (buffer[start] === 0x0a || buffer[start] === 0x0d)) start += 1
  while (end > start && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1
  return buffer.subarray(start, end)
}

function decodePdfStream(buffer: Buffer, dict: string): Buffer | null {
  const hasFlate = /\/Filter\s*(?:\/FlateDecode|\[[^\]]*\/FlateDecode[^\]]*\])/i.test(dict)
  const hasUnsupportedFilter = /\/Filter\b/i.test(dict) && !hasFlate
  if (hasUnsupportedFilter) return null
  if (!hasFlate) return buffer
  try {
    return inflateSync(buffer)
  } catch {
    return null
  }
}

function extractPdfTextFromStream(stream: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const lines: string[] = []
  const textObjectPattern = /\bBT\b([\s\S]*?)\bET\b/g
  let match: RegExpExecArray | null
  while ((match = textObjectPattern.exec(stream))) {
    const strings = extractPdfStrings(match[1])
      .map((item) => item.trim())
      .filter(Boolean)
    if (strings.length > 0) lines.push(strings.join('\n'))
    if (lines.join('\n').length >= maxChars) break
  }
  return lines.join('\n').slice(0, maxChars)
}

function extractPdfStrings(textObject: string): string[] {
  const strings: string[] = []
  for (let index = 0; index < textObject.length; index += 1) {
    const char = textObject[index]
    if (char === '(') {
      const literal = readPdfLiteralString(textObject, index)
      strings.push(literal.value)
      index = literal.end
    } else if (char === '<' && textObject[index + 1] !== '<') {
      const hex = readPdfHexString(textObject, index)
      if (hex.value) strings.push(hex.value)
      index = hex.end
    }
  }
  return strings
}

function readPdfLiteralString(source: string, start: number): { value: string; end: number } {
  let depth = 1
  let out = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      const escaped = readPdfEscape(source, index)
      out += escaped.value
      index = escaped.end
    } else if (char === '(') {
      depth += 1
      out += char
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) return { value: out, end: index }
      out += char
    } else {
      out += char
    }
  }
  return { value: out, end: source.length - 1 }
}

function readPdfEscape(source: string, slashIndex: number): { value: string; end: number } {
  const next = source[slashIndex + 1]
  if (!next) return { value: '', end: slashIndex }
  if (next === 'n') return { value: '\n', end: slashIndex + 1 }
  if (next === 'r') return { value: '\r', end: slashIndex + 1 }
  if (next === 't') return { value: '\t', end: slashIndex + 1 }
  if (next === 'b') return { value: '\b', end: slashIndex + 1 }
  if (next === 'f') return { value: '\f', end: slashIndex + 1 }
  if (next === '(' || next === ')' || next === '\\') return { value: next, end: slashIndex + 1 }
  if (next === '\r' && source[slashIndex + 2] === '\n') return { value: '', end: slashIndex + 2 }
  if (next === '\r' || next === '\n') return { value: '', end: slashIndex + 1 }
  if (/[0-7]/.test(next)) {
    const octal = source.slice(slashIndex + 1, slashIndex + 4).match(/^[0-7]{1,3}/)?.[0] ?? next
    return { value: String.fromCharCode(parseInt(octal, 8)), end: slashIndex + octal.length }
  }
  return { value: next, end: slashIndex + 1 }
}

function readPdfHexString(source: string, start: number): { value: string; end: number } {
  const end = source.indexOf('>', start + 1)
  if (end < 0) return { value: '', end: source.length - 1 }
  let hex = source.slice(start + 1, end).replace(/\s+/g, '')
  if (hex.length % 2 === 1) hex += '0'
  const bytes: number[] = []
  for (let index = 0; index < hex.length; index += 2) {
    const value = Number.parseInt(hex.slice(index, index + 2), 16)
    if (Number.isFinite(value)) bytes.push(value)
  }
  return { value: decodePdfBytes(Buffer.from(bytes)), end }
}

function decodePdfBytes(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    let out = ''
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      out += String.fromCharCode(buffer.readUInt16BE(index))
    }
    return out
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return buffer.toString('latin1')
  }
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

interface ZipFile {
  entries: Map<string, Buffer>
}

function readZip(buffer: Buffer): ZipFile {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('不是有效的 Office Open XML ZIP 文件')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('ZIP64 Office 文件暂不支持')
  }
  ensureRange(buffer, centralOffset, centralSize)

  const entries = new Map<string, Buffer>()
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + fileNameLength
    ensureRange(buffer, nameStart, fileNameLength)
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8')
    entries.set(name, inflateZipEntry(buffer, localOffset, compressedSize, method))
    offset = nameEnd + extraLength + commentLength
  }
  return { entries }
}

function inflateZipEntry(buffer: Buffer, localOffset: number, compressedSize: number, method: number): Buffer {
  ensureRange(buffer, localOffset, 30)
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏')
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  const dataOffset = localOffset + 30 + nameLength + extraLength
  ensureRange(buffer, dataOffset, compressedSize)
  const data = buffer.subarray(dataOffset, dataOffset + compressedSize)
  if (method === 0) return Buffer.from(data)
  if (method === 8) return inflateRawSync(data)
  throw new Error(`ZIP 压缩方式暂不支持:${method}`)
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function ensureRange(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) throw new Error('ZIP 文件范围越界')
}

function extractDocxText(zip: ZipFile): string {
  const xml = zipText(zip, 'word/document.xml')
  if (!xml) throw new Error('缺少 word/document.xml')
  const pageParts = xml.split(
    /<(?:[A-Za-z_][\w.-]*:)?br\b(?=[^>]*\b(?:[A-Za-z_][\w.-]*:)?type\s*=\s*(?:"page"|'page'))[^>]*\/?>/gi
  )
  const pages = pageParts.map(extractDocxPartText)
  if (pages.length > 1) {
    const sections: string[] = ['# Word Document']
    pages.forEach((body, index) => {
      sections.push('', `## Page ${index + 1}`, body || '未提取到可读文本')
    })
    return sections.join('\n')
  }
  return ['# Word Document', '', pages[0] || '未提取到可读文本'].join('\n')
}

function extractDocxPartText(xml: string): string {
  const paragraphs = xml
    .split(/<\/w:p>/i)
    .map((part) => extractXmlTextRuns(part))
    .map((text) => text.replace(/\s+\n/g, '\n').trim())
    .filter(Boolean)
  return paragraphs.join('\n\n')
}

function extractXlsxText(zip: ZipFile): string {
  const sharedStrings = parseSharedStrings(zipText(zip, 'xl/sharedStrings.xml'))
  const sheets = listWorkbookSheets(zip)
  if (sheets.length === 0) throw new Error('缺少工作表')

  const sections: string[] = ['# Excel Workbook']
  for (const sheet of sheets.slice(0, 20)) {
    const xml = zipText(zip, sheet.path)
    if (!xml) continue
    const rows = parseSheetRows(xml, sharedStrings)
    sections.push('', `## ${sheet.name}`, rows.length > 0 ? rows.map((row) => row.join('\t')).join('\n') : '空工作表')
  }
  return sections.join('\n')
}

function extractPptxText(zip: ZipFile): string {
  const slideNames = [...zip.entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(compareOoxmlPartNames)
  if (slideNames.length === 0) throw new Error('缺少幻灯片')

  const sections: string[] = ['# PowerPoint Presentation']
  slideNames.slice(0, 80).forEach((name, index) => {
    const text = extractXmlTextLines(zipText(zip, name)).trim()
    sections.push('', `## Slide ${index + 1}`, text || '未提取到可读文本')
  })
  return sections.join('\n')
}

function zipText(zip: ZipFile, name: string): string {
  const entry = zip.entries.get(name)
  if (!entry) return ''
  return new TextDecoder('utf-8', { fatal: false }).decode(entry)
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return []
  return matchTags(xml, 'si').map((item) => extractXmlTextRuns(item).trim())
}

function listWorkbookSheets(zip: ZipFile): Array<{ name: string; path: string }> {
  const workbook = zipText(zip, 'xl/workbook.xml')
  const rels = parseRelationships(zipText(zip, 'xl/_rels/workbook.xml.rels'))
  const sheets = workbook
    ? matchOpeningTags(workbook, 'sheet')
        .map((tag, index) => {
          const id = attrValue(tag, 'r:id') || attrValue(tag, 'id')
          const target = id ? rels.get(id) : ''
          return {
            name: attrValue(tag, 'name') || `Sheet ${index + 1}`,
            path: target ? normalizeZipPath('xl', target) : `xl/worksheets/sheet${index + 1}.xml`
          }
        })
        .filter((sheet) => zip.entries.has(sheet.path))
    : []
  if (sheets.length > 0) return sheets
  return [...zip.entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(compareOoxmlPartNames)
    .map((name, index) => ({ name: `Sheet ${index + 1}`, path: name }))
}

function parseRelationships(xml: string): Map<string, string> {
  const rels = new Map<string, string>()
  for (const tag of matchOpeningTags(xml, 'Relationship')) {
    const id = attrValue(tag, 'Id')
    const target = attrValue(tag, 'Target')
    if (id && target) rels.set(id, target)
  }
  return rels
}

function parseSheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = []
  for (const rowXml of matchTags(xml, 'row').slice(0, 500)) {
    const row: string[] = []
    for (const cell of matchFullTags(rowXml, 'c').slice(0, 120)) {
      const cellTag = cell.open
      const ref = attrValue(cellTag, 'r')
      const column = ref ? columnIndex(ref) : row.length
      while (row.length < column) row.push('')
      row[column] = cellValue(cell.inner, cellTag, sharedStrings)
    }
    rows.push(trimTrailingEmptyCells(row))
  }
  return rows
}

function cellValue(cellXml: string, cellTag: string, sharedStrings: string[]): string {
  const type = attrValue(cellTag, 't')
  if (type === 'inlineStr') return extractXmlTextRuns(cellXml).trim()
  const rawValue = firstTagText(cellXml, 'v')
  if (type === 's') return sharedStrings[Number(rawValue)] ?? ''
  if (type === 'b') return rawValue === '1' ? 'TRUE' : rawValue === '0' ? 'FALSE' : rawValue
  return decodeXml(rawValue)
}

function extractXmlTextRuns(xml: string): string {
  const prepared = xml
    .replace(/<[^>]*:tab\b[^>]*\/>/gi, '\t')
    .replace(/<[^>]*:br\b[^>]*\/>/gi, '\n')
  return matchTags(prepared, 't').map(decodeXml).join('')
}

function extractXmlTextLines(xml: string): string {
  return matchTags(xml, 't')
    .map(decodeXml)
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n')
}

function matchTags(xml: string, tagName: string): string[] {
  const escaped = escapeRegExp(tagName)
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi')
  const matches: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) matches.push(match[1])
  if (tagName.includes(':')) return matches
  const namespaced = new RegExp(`<[^\\s/>:]+:${escaped}\\b[^>]*>([\\s\\S]*?)<\\/[^\\s/>:]+:${escaped}>`, 'gi')
  while ((match = namespaced.exec(xml))) matches.push(match[1])
  return matches
}

function matchOpeningTags(xml: string, tagName: string): string[] {
  if (!xml) return []
  const escaped = escapeRegExp(tagName)
  const pattern = new RegExp(`<${escaped}\\b[^>]*\\/?>`, 'gi')
  const matches: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) matches.push(match[0])
  return matches
}

function matchFullTags(xml: string, tagName: string): Array<{ open: string; inner: string }> {
  const escaped = escapeRegExp(tagName)
  const pattern = new RegExp(`(<${escaped}\\b[^>]*>)([\\s\\S]*?)<\\/${escaped}>`, 'gi')
  const matches: Array<{ open: string; inner: string }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) matches.push({ open: match[1], inner: match[2] })
  const namespaced = new RegExp(`(<[^\\s/>:]+:${escaped}\\b[^>]*>)([\\s\\S]*?)<\\/[^\\s/>:]+:${escaped}>`, 'gi')
  while ((match = namespaced.exec(xml))) matches.push({ open: match[1], inner: match[2] })
  return matches
}

function firstTagText(xml: string, tagName: string): string {
  return matchTags(xml, tagName)[0] ?? ''
}

function attrValue(tag: string, name: string): string {
  const pattern = new RegExp(`\\s${escapeRegExp(name)}=(?:"([^"]*)"|'([^']*)')`, 'i')
  const match = tag.match(pattern)
  return decodeXml(match?.[1] ?? match?.[2] ?? '')
}

function normalizeZipPath(baseDir: string, target: string): string {
  const cleanTarget = target.replace(/\\/g, '/').replace(/^\/+/, '')
  return path.posix.normalize(path.posix.join(baseDir, cleanTarget))
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? ''
  let value = 0
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64)
  return Math.max(0, value - 1)
}

function trimTrailingEmptyCells(row: string[]): string[] {
  let end = row.length
  while (end > 0 && row[end - 1] === '') end -= 1
  return row.slice(0, end)
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function compareOoxmlPartNames(a: string, b: string): number {
  const an = Number(a.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0)
  const bn = Number(b.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0)
  return an === bn ? a.localeCompare(b) : an - bn
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ensureInsideRoot(root: string, fullPath: string): void {
  const rel = path.relative(root, fullPath)
  if (rel === '') return
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return
  throw new Error('路径越过了项目目录边界')
}

function toProjectRelative(root: string, fullPath: string): string {
  return path.relative(root, fullPath).split(path.sep).join('/')
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function failure(error: string): PreviewOpsFailure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
