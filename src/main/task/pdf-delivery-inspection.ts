import { inflateSync } from 'node:zlib'

const MAX_OBJECTS = 4_096
const MAX_EXPANDED_STREAM_BYTES = 32 * 1024 * 1024
const MAX_TEXT_CHARS = 200_000

type PdfObject = {
  id: number
  dictionary: string
  stream?: Buffer
}

type PdfTextMap = Map<number, string>

export interface PdfDeliveryEvidence {
  pageCount: number
  text: string
}

/**
 * Extract the evidence needed by delivery requirements from a PDF.
 *
 * This is deliberately a bounded parser for ordinary PDF files (including the
 * PDFKit writer used by EastGenesis). It follows the catalog's page tree and
 * decodes page content streams, including FlateDecode and ToUnicode maps. It
 * fails closed for unsupported object streams, encrypted files and malformed
 * page trees instead of treating a PDF header or cached metadata as evidence.
 */
export function inspectPdfDelivery(bytes: Buffer): PdfDeliveryEvidence {
  if (bytes.length === 0 || bytes.length > MAX_EXPANDED_STREAM_BYTES * 2) {
    throw new Error('PDF 为空或超过可检查大小限制')
  }
  const source = bytes.toString('latin1')
  if (!/^%PDF-1\.[0-7]\r?\n/.test(source)) throw new Error('PDF header 无效')
  const eof = source.lastIndexOf('%%EOF')
  if (eof < 0 || eof < Math.max(0, source.length - 16_384)) {
    throw new Error('PDF 缺少有效 EOF 标记')
  }
  if (/\/Encrypt\b|\/ObjStm\b|\/XRef\b/.test(source)) {
    throw new Error('加密或对象流 PDF 暂不支持安全解析')
  }

  const objects = parseObjects(source, bytes)
  if (objects.size === 0) throw new Error('PDF 没有可解析的对象')
  const catalog = [...objects.values()].find((object) => /\/Type\s*\/Catalog\b/.test(object.dictionary))
  if (!catalog) throw new Error('PDF Catalog 缺失')
  const pagesId = referenceAfter(catalog.dictionary, /\/Pages\s+(\d+)\s+(\d+)\s+R\b/)
  if (pagesId === undefined) throw new Error('PDF Catalog 未绑定页面树')

  const visited = new Set<number>()
  const pageIds: number[] = []
  const pageTreeCount = walkPageTree(objects, pagesId, undefined, visited, pageIds)
  if (pageTreeCount <= 0 || pageIds.length !== pageTreeCount) throw new Error('PDF 页面树为空或页数不一致')

  const textMaps = collectToUnicodeMaps(objects)
  const textParts: string[] = []
  for (const pageId of pageIds) {
    const page = objects.get(pageId)
    if (!page) throw new Error('PDF 页面对象缺失')
    const resources = referenceAfter(page.dictionary, /\/Resources\s+(\d+)\s+(\d+)\s+R\b/)
    const fontRefs = resources === undefined ? new Map<string, number>() : collectFontRefs(objects.get(resources)?.dictionary ?? '')
    const contents = contentReferences(page.dictionary)
    for (const contentId of contents) {
      const stream = objects.get(contentId)?.stream
      if (!stream) throw new Error('PDF 页面正文流缺失')
      const extracted = extractTextFromStream(stream, fontRefs, textMaps)
      if (extracted) textParts.push(extracted)
      if (textParts.join('\n').length >= MAX_TEXT_CHARS) break
    }
    if (textParts.join('\n').length >= MAX_TEXT_CHARS) break
  }

  return { pageCount: pageTreeCount, text: normalizeText(textParts.join('\n')).slice(0, MAX_TEXT_CHARS) }
}

function parseObjects(source: string, bytes: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>()
  const pattern = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\s*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (objects.size >= MAX_OBJECTS) throw new Error('PDF 对象数量超过限制')
    const id = Number(match[1])
    if (!Number.isSafeInteger(id) || objects.has(id)) continue
    const body = match[3]
    const streamMatch = /([\r\n])stream\r?\n/.exec(body)
    if (!streamMatch) {
      objects.set(id, { id, dictionary: body.trim() })
      continue
    }
    const dictionary = body.slice(0, streamMatch.index).trim()
    const start = streamMatch.index + streamMatch[0].length
    const end = body.lastIndexOf('endstream')
    if (end < start) throw new Error('PDF stream 边界无效')
    const streamDataStart = match.index + match[0].indexOf(body) + start
    const streamDataEnd = match.index + match[0].indexOf(body) + end
    let stream = bytes.subarray(streamDataStart, streamDataEnd)
    while (stream.length > 0 && (stream[stream.length - 1] === 0x0a || stream[stream.length - 1] === 0x0d)) {
      stream = stream.subarray(0, stream.length - 1)
    }
    const filter = /\/Filter\s+\/([A-Za-z0-9]+)\b/.exec(dictionary)?.[1]
    if (filter && filter !== 'FlateDecode') throw new Error(`PDF 使用不支持的流过滤器：${filter}`)
    if (filter === 'FlateDecode') {
      try {
        stream = inflateSync(stream, { maxOutputLength: MAX_EXPANDED_STREAM_BYTES })
      } catch {
        throw new Error('PDF 压缩正文流无法解码')
      }
    }
    if (stream.length > MAX_EXPANDED_STREAM_BYTES) throw new Error('PDF 正文流超过大小限制')
    objects.set(id, { id, dictionary, stream })
  }
  return objects
}

function walkPageTree(
  objects: Map<number, PdfObject>, id: number, expectedParent: number | undefined,
  visited: Set<number>, pageIds: number[]
): number {
  if (visited.has(id)) throw new Error('PDF 页面树存在循环引用')
  const object = objects.get(id)
  if (!object) throw new Error('PDF 页面树引用了不存在的对象')
  visited.add(id)
  const parent = referenceAfter(object.dictionary, /\/Parent\s+(\d+)\s+(\d+)\s+R\b/)
  if (expectedParent !== undefined && parent !== expectedParent) throw new Error('PDF 页面父子关系不一致')
  if (/\/Type\s*\/Page\b/.test(object.dictionary) && !/\/Type\s*\/Pages\b/.test(object.dictionary)) {
    if (pageIds.includes(id)) throw new Error('PDF 页面树重复引用页面对象')
    pageIds.push(id)
    visited.delete(id)
    return 1
  }
  if (!/\/Type\s*\/Pages\b/.test(object.dictionary)) throw new Error('PDF 页面树包含非页面节点')
  const count = Number(/\/Count\s+(\d+)\b/.exec(object.dictionary)?.[1])
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PDF 页面树 Count 无效')
  const kidsText = /\/Kids\s*\[([\s\S]*?)\]/.exec(object.dictionary)?.[1]
  if (!kidsText) throw new Error('PDF 页面树缺少 Kids')
  const kids = [...kidsText.matchAll(/(\d+)\s+(\d+)\s+R\b/g)].map((match) => Number(match[1]))
  if (kids.length === 0) throw new Error('PDF 页面树 Kids 为空')
  let leaves = 0
  for (const kid of kids) leaves += walkPageTree(objects, kid, id, visited, pageIds)
  visited.delete(id)
  if (leaves !== count) throw new Error(`PDF 页面树 Count=${count} 与实际页面=${leaves} 不一致`)
  return leaves
}

function referenceAfter(dictionary: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(dictionary)
  if (!match) return undefined
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : undefined
}

function contentReferences(dictionary: string): number[] {
  const single = referenceAfter(dictionary, /\/Contents\s+(\d+)\s+(\d+)\s+R\b/)
  if (single !== undefined) return [single]
  const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(dictionary)?.[1]
  return array ? [...array.matchAll(/(\d+)\s+(\d+)\s+R\b/g)].map((match) => Number(match[1])) : []
}

function collectFontRefs(dictionary: string): Map<string, number> {
  const fonts = /\/Font\s*<<([\s\S]*?)>>/.exec(dictionary)?.[1]
  const result = new Map<string, number>()
  if (!fonts) return result
  for (const match of fonts.matchAll(/\/([A-Za-z][\w.-]*)\s+(\d+)\s+(\d+)\s+R\b/g)) result.set(match[1], Number(match[2]))
  return result
}

function collectToUnicodeMaps(objects: Map<number, PdfObject>): Map<number, PdfTextMap> {
  const maps = new Map<number, PdfTextMap>()
  for (const object of objects.values()) {
    const mapId = referenceAfter(object.dictionary, /\/ToUnicode\s+(\d+)\s+(\d+)\s+R\b/)
    if (mapId === undefined) continue
    const stream = objects.get(mapId)?.stream
    if (!stream) throw new Error('PDF 字体 ToUnicode 映射缺失')
    maps.set(object.id, parseCMap(stream.toString('latin1')))
  }
  return maps
}

function parseCMap(source: string): PdfTextMap {
  const result: PdfTextMap = new Map()
  const charBlock = /\d+\s+beginbfchar\s*([\s\S]*?)\s*endbfchar/g
  for (const block of source.matchAll(charBlock)) {
    for (const entry of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      result.set(parseHexCode(entry[1]), decodeUnicode(entry[2]))
    }
  }
  const rangeBlock = /\d+\s+beginbfrange\s*([\s\S]*?)\s*endbfrange/g
  for (const block of source.matchAll(rangeBlock)) {
    for (const entry of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(?:\[([^\]]+)\]|<([0-9a-f]+)>)/gi)) {
      const from = parseHexCode(entry[1]), to = parseHexCode(entry[2])
      if (to < from || to - from > 4096) throw new Error('PDF 字体映射范围无效')
      if (entry[3] !== undefined) {
        const values = [...entry[3].matchAll(/<([0-9a-f]+)>/gi)]
        if (values.length !== to - from + 1) throw new Error('PDF 字体映射数量不一致')
        values.forEach((value, index) => result.set(from + index, decodeUnicode(value[1])))
      } else {
        const start = parseHexCode(entry[4])
        for (let index = 0; index <= to - from; index += 1) result.set(from + index, decodeUnicodeNumber(start + index))
      }
    }
  }
  return result
}

function extractTextFromStream(stream: Buffer, fontRefs: Map<string, number>, textMaps: Map<number, PdfTextMap>): string {
  const source = stream.toString('latin1')
  const parts: string[] = []
  const textObjects = /\bBT\b([\s\S]*?)\bET\b/g
  for (const block of source.matchAll(textObjects)) {
    const blockParts: string[] = []
    let currentMap: PdfTextMap | undefined
    const tokens = /\/([A-Za-z][\w.-]*)\s+[-+]?\d+(?:\.\d+)?\s+Tf|<([0-9a-f\s]+)>|\(((?:\\.|[^\\)])*)\)/gi
    for (const token of block[1].matchAll(tokens)) {
      if (token[1] !== undefined) {
        const fontId = fontRefs.get(token[1])
        currentMap = fontId === undefined ? undefined : textMaps.get(fontId)
      } else if (token[2] !== undefined) {
        const bytes = Buffer.from(token[2].replace(/\s/g, '').padEnd(token[2].replace(/\s/g, '').length + (token[2].replace(/\s/g, '').length % 2), '0'), 'hex')
        blockParts.push(decodePdfString(bytes, currentMap))
      } else if (token[3] !== undefined) {
        blockParts.push(decodePdfLiteral(token[3], currentMap))
      }
    }
    if (blockParts.length > 0) parts.push(blockParts.join(''))
  }
  return parts.join('\n')
}

function decodePdfString(bytes: Buffer, map: PdfTextMap | undefined): string {
  if (map && bytes.length % 2 === 0) {
    let mapped = ''
    for (let index = 0; index < bytes.length; index += 2) mapped += map.get(bytes.readUInt16BE(index)) ?? ''
    if (mapped) return mapped
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16Be(bytes.subarray(2))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return bytes.toString('latin1') }
}

function decodePdfLiteral(value: string, map: PdfTextMap | undefined): string {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') { bytes.push(value.charCodeAt(index) & 0xff); continue }
    const next = value[++index]
    if (next === undefined) break
    const octal = /^[0-7]{1,3}/.exec(value.slice(index))?.[0]
    if (octal) { bytes.push(parseInt(octal, 8) & 0xff); index += octal.length - 1; continue }
    bytes.push(({ n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c } as Record<string, number>)[next] ?? next.charCodeAt(0))
  }
  return decodePdfString(Buffer.from(bytes), map)
}

function parseHexCode(value: string): number {
  const parsed = Number.parseInt(value, 16)
  if (!Number.isSafeInteger(parsed)) throw new Error('PDF 字体映射编码无效')
  return parsed
}

function decodeUnicode(value: string): string {
  const width = Math.max(4, Math.ceil(value.length / 4) * 4)
  const hex = value.padStart(width, '0')
  return decodeUtf16Be(Buffer.from(hex, 'hex'))
}

function decodeUnicodeNumber(value: number): string {
  return String.fromCodePoint(value <= 0xffff ? value : 0xfffd)
}

function decodeUtf16Be(bytes: Buffer): string {
  let output = ''
  for (let index = 0; index + 1 < bytes.length; index += 2) output += String.fromCharCode(bytes.readUInt16BE(index))
  return output
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
