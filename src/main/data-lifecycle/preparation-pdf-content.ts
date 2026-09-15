import { inflateSync } from 'node:zlib'
import { assertNoCredentialMaterial } from '../project-aggregate/codec'

const MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const MAX_OBJECTS = 2048
interface PdfObject { id: number; syntax: string; strings: Buffer[]; stream?: Buffer }

/** Deliberately supports the current PDFKit writer, not arbitrary imported PDF dialects. */
export function assertPreparationPdfContent(bytes: Buffer): void {
  const source = bytes.toString('latin1')
  if (bytes.length > MAX_EXPANDED_BYTES || !/^%PDF-1\.[0-7]\r?\n/.test(source)) fail('unsupported PDF header or size')
  const footer = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(source)
  if (!footer) fail('incomplete PDF trailer')
  const xrefOffset = Number(footer[1]), xref = source.slice(xrefOffset, footer.index)
  const table = /^xref\s+0 (\d+)\s*\n([\s\S]*?)trailer\s*([\s\S]*)$/.exec(xref)
  if (!table) fail('unsupported PDF cross-reference structure')
  const count = Number(table[1]), entries = [...table[2].matchAll(/^(\d{10}) (\d{5}) ([fn])\s*$/gm)]
  if (count < 2 || count > MAX_OBJECTS || entries.length !== count ||
      table[2].replace(/^(\d{10}) (\d{5}) ([fn])\s*$/gm, '').trim() || entries[0][3] !== 'f') fail('invalid PDF cross-reference entries')
  const trailer = pdfStrings(table[3])
  if (!/^<<[\s\S]*>>\s*$/.test(table[3]) || /\/(?:Encrypt|Prev|XRefStm)\b/.test(trailer.syntax) ||
      Number(/\/Size\s+(\d+)\b/.exec(trailer.syntax)?.[1]) !== count) fail('unsupported PDF trailer')
  const rootId = Number(/\/Root\s+(\d+) 0 R\b/.exec(trailer.syntax)?.[1])
  const offsets = entries.slice(1).map((entry, index) => ({ id: index + 1, offset: Number(entry[1]), generation: entry[2], state: entry[3] }))
    .sort((a, b) => a.offset - b.offset)
  const header = /^%PDF-1\.[0-7]\r?\n%[^\r\n]*\r?\n/.exec(source)
  if (!header || offsets[0].offset !== header[0].length) fail('unsupported PDF object prefix')
  const objects: PdfObject[] = []
  let expanded = 0
  for (let index = 0; index < offsets.length; index++) {
    const entry = offsets[index], end = offsets[index + 1]?.offset ?? xrefOffset
    if (entry.state !== 'n' || entry.generation !== '00000' || entry.offset < header[0].length || end <= entry.offset || end > xrefOffset) fail('invalid PDF object offset')
    const body = source.slice(entry.offset, end), prefix = `${entry.id} 0 obj\n`
    if (!body.startsWith(prefix) || !/\nendobj\s*$/.test(body)) fail('invalid PDF object boundary')
    const content = body.slice(prefix.length, body.lastIndexOf('\nendobj'))
    const streamStart = /\nstream\r?\n/.exec(content)
    const metadata = streamStart ? content.slice(0, streamStart.index) : content
    const parsed = pdfStrings(metadata)
    if (/\/[^\s/<>()\[\]]*#|\/(?:Encrypt|ObjStm|XRef|EmbeddedFile|Filespec|JavaScript|Launch)\b/.test(parsed.syntax)) fail('unsupported PDF object encoding')
    if (!(metadata.startsWith('<<') && metadata.endsWith('>>')) && !(parsed.strings.length === 1 && !parsed.syntax.trim())) fail('unsupported PDF object value')
    const object: PdfObject = { id: entry.id, ...parsed }
    scanStrings(parsed.strings)
    assertNoCredentialMaterial(metadata)
    if (streamStart) {
      const length = /\/Length\s+(\d+)\s*(?=\/|>>)/.exec(parsed.syntax)
      if (!length || [...parsed.syntax.matchAll(/\/Length\b/g)].length !== 1) fail('unsupported PDF stream length')
      const start = streamStart.index + streamStart[0].length, size = Number(length[1])
      if (!Number.isSafeInteger(size) || !/^\r?\nendstream$/.test(content.slice(start + size))) fail('invalid PDF stream boundary')
      const raw = Buffer.from(content.slice(start, start + size), 'latin1')
      const filters = [...parsed.syntax.matchAll(/\/Filter\b/g)]
      if (filters.length > 1 || (filters.length && !/\/Filter\s+\/FlateDecode\s*(?=\/|>>)/.test(parsed.syntax)) || /\/DecodeParms\b/.test(parsed.syntax)) fail('unsupported PDF stream filter')
      try { object.stream = filters.length ? inflateSync(raw, { maxOutputLength: Math.max(1, MAX_EXPANDED_BYTES - expanded) }) : raw }
      catch { return fail('invalid or oversized PDF compressed stream') }
      expanded += object.stream.length
      if (expanded > MAX_EXPANDED_BYTES) fail('PDF expanded content exceeds portable limits')
    }
    objects.push(object)
  }
  const byId = new Map(objects.map(object => [object.id, object]))
  const root = byId.get(rootId)
  if (!root || !/\/Type\s+\/Catalog\b/.test(root.syntax)) fail('PDF catalog is missing')
  const pages = byId.get(Number(/\/Pages\s+(\d+) 0 R\b/.exec(root.syntax)?.[1]))
  if (!pages || !/\/Type\s+\/Pages\b/.test(pages.syntax) || !/\/Count\s+[1-9]\d*\b/.test(pages.syntax) ||
      !objects.some(object => /\/Type\s+\/Page\b/.test(object.syntax))) fail('PDF pages are missing')
  // Embedded fonts are the only opaque streams produced by the current writer.
  const fontIds = new Set(objects.flatMap(object => [...object.syntax.matchAll(/\/FontFile[23]\s+(\d+) 0 R\b/g)].map(match => Number(match[1]))))
  const maps: Map<number, string>[] = []
  const textStreams: string[] = []
  for (const object of objects) {
    if (!object.stream) continue
    assertNoCredentialMaterial(object.stream.toString('utf8'))
    if (fontIds.has(object.id)) {
      const signature = object.stream.subarray(0, 4)
      if (object.stream.length < 12 || !(signature.equals(Buffer.from([0, 1, 0, 0])) || signature.toString('ascii') === 'true')) fail('unsupported PDF embedded font')
      const tableCount = object.stream.readUInt16BE(4)
      if (!tableCount || tableCount > 128 || 12 + tableCount * 16 > object.stream.length) fail('invalid PDF embedded font directory')
      for (let table = 0; table < tableCount; table++) {
        const offset = object.stream.readUInt32BE(12 + table * 16 + 8), size = object.stream.readUInt32BE(12 + table * 16 + 12)
        if (offset < 12 + tableCount * 16 || offset + size > object.stream.length) fail('invalid PDF embedded font table')
      }
      continue
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(object.stream) } catch { return fail('unsupported opaque PDF stream') }
    if (/\bbegincmap\b/.test(text)) maps.push(readPdfKitCmap(text))
    else textStreams.push(text)
  }
  const unicodeIds = objects.flatMap(object => [...object.syntax.matchAll(/\/ToUnicode\s+(\d+) 0 R\b/g)].map(match => Number(match[1])))
  if (!maps.length || maps.length !== unicodeIds.length || unicodeIds.some(id => !byId.get(id)?.stream)) fail('PDF font text mapping is missing')
  for (const text of textStreams) {
    const parsed = pdfStrings(text)
    scanStrings(parsed.strings)
    // Try each embedded-font map: preparation's writer currently uses a single font; scanning
    // all maps also prevents a font switch from making a string invisible to this check.
    for (const map of maps) {
      const decoded = parsed.strings.map(value => decodeGlyphs(value, map))
      for (const value of decoded) assertNoCredentialMaterial(value)
      assertNoCredentialMaterial(decoded.join(''))
      assertNoCredentialMaterial(decoded.join('\n'))
    }
  }
  scanStrings(trailer.strings)
}

function readPdfKitCmap(text: string): Map<number, string> {
  const map = new Map<number, string>()
  const block = /(\d+) beginbfrange\s*([\s\S]*?)\s*endbfrange/.exec(text)
  if (!block || /beginbfchar/.test(text)) fail('unsupported PDF font mapping')
  const ranges = [...block[2].matchAll(/<([a-f\d]{4})>\s*<([a-f\d]{4})>\s*\[([^\]]*)\]/gi)]
  if (ranges.length !== Number(block[1]) || block[2].replace(/<([a-f\d]{4})>\s*<([a-f\d]{4})>\s*\[([^\]]*)\]/gi, '').trim()) fail('invalid PDF font mapping ranges')
  for (const range of ranges) {
    const from = parseInt(range[1], 16), to = parseInt(range[2], 16)
    const values = [...range[3].matchAll(/<([a-f\d\s]*)>/gi)]
    if (values.length !== to - from + 1 || range[3].replace(/<([a-f\d\s]*)>/gi, '').trim()) fail('invalid PDF font mapping values')
    for (let index = 0; index < values.length; index++) {
      const hex = values[index][1].replace(/\s/g, '')
      if (hex.length % 4 || map.has(from + index)) fail('invalid PDF Unicode mapping')
      map.set(from + index, utf16be(Buffer.from(hex, 'hex')))
    }
  }
  return map
}

function decodeGlyphs(bytes: Buffer, map: Map<number, string>): string {
  if (bytes.length % 2) fail('unsupported PDF glyph encoding')
  let text = ''
  for (let index = 0; index < bytes.length; index += 2) {
    const value = map.get(bytes.readUInt16BE(index))
    if (value === undefined) fail('PDF glyph has no Unicode mapping')
    text += value
  }
  return text
}
function scanStrings(values: Buffer[]): void {
  const text = values.map(value => value[0] === 0xfe && value[1] === 0xff ? utf16be(value.subarray(2)) : value.toString('utf8'))
  for (const value of text) assertNoCredentialMaterial(value)
  assertNoCredentialMaterial(text.join(''))
}
function utf16be(bytes: Buffer): string {
  if (bytes.length % 2) fail('invalid PDF Unicode string')
  let text = ''
  for (let index = 0; index < bytes.length; index += 2) text += String.fromCharCode(bytes.readUInt16BE(index))
  return text
}

/** Decode PDF literal/hex strings, including octal escapes; leave syntax for structural checks. */
function pdfStrings(source: string): { syntax: string; strings: Buffer[] } {
  const strings: Buffer[] = []
  let syntax = ''
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '%') { const end = source.indexOf('\n', index); index = end < 0 ? source.length : end; syntax += '\n'; continue }
    if (source.slice(index, index + 2) === '<<') { syntax += '<<'; index++; continue }
    if (source[index] === '<') {
      const end = source.indexOf('>', index + 1), hex = source.slice(index + 1, end).replace(/\s/g, '')
      if (end < 0 || !/^[a-f\d]*$/i.test(hex)) fail('invalid PDF hex string')
      strings.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')); index = end; syntax += ' '; continue
    }
    if (source[index] !== '(') { syntax += source[index]; continue }
    let depth = 1, value = ''
    for (index++; index < source.length; index++) {
      const char = source[index]
      if (char === '\\') {
        const next = source[++index]
        if (next === undefined) fail('incomplete PDF escape')
        if (next === '\r' || next === '\n') { if (next === '\r' && source[index + 1] === '\n') index++; continue }
        const octal = /^[0-7]{1,3}/.exec(source.slice(index))?.[0]
        if (octal) { value += String.fromCharCode(parseInt(octal, 8) & 255); index += octal.length - 1; continue }
        value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next
      } else if (char === '(') { if (++depth > 128) fail('PDF literal nesting exceeds limit'); value += char }
      else if (char === ')') { if (--depth === 0) break; value += char }
      else value += char
    }
    if (depth) fail('incomplete PDF literal string')
    strings.push(Buffer.from(value, 'latin1')); syntax += ' '
  }
  return { syntax, strings }
}
function fail(message: string): never { throw new Error(`Project preparation portability: ${message}`) }
