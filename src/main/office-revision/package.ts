import { inflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import { officeError } from './errors'
import { officeValueDigest } from './digest'

export const OFFICE_PACKAGE_LIMITS = { compressedBytes: 20_000_000, expandedBytes: 64_000_000, entries: 2_048 } as const
export interface XmlPatch { start: number; end: number; replacement: string }
export type OfficePackage = Map<string, Buffer>

/** Bound expansion from central-directory lengths before allocating inflated output. */
export function readOfficePackage(bytes: Buffer): OfficePackage {
  if (bytes.length > OFFICE_PACKAGE_LIMITS.compressedBytes) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '文件超过Office局部编辑大小上限。')
  const eocd = findDirectory(bytes), count = bytes.readUInt16LE(eocd + 10)
  if (bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6) || count !== bytes.readUInt16LE(eocd + 8)
      || count > OFFICE_PACKAGE_LIMITS.entries) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '分卷、ZIP64或过多部件不支持局部修订。')
  const directoryStart = bytes.readUInt32LE(eocd + 16), directoryBytes = bytes.readUInt32LE(eocd + 12)
  if (directoryStart + directoryBytes !== eocd) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP目录边界无效。')
  const parts: OfficePackage = new Map()
  let offset = directoryStart, expanded = 0
  for (let index = 0; index < count; index++) {
    requireRange(bytes, offset, 46)
    if (bytes.readUInt32LE(offset) !== 0x02014b50) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP目录条目无效。')
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32)
    requireRange(bytes, offset, 46 + nameLength + extraLength + commentLength)
    const name = utf8(bytes.subarray(offset + 46, offset + 46 + nameLength))
    const size = bytes.readUInt32LE(offset + 24)
    expanded += size
    if (expanded > OFFICE_PACKAGE_LIMITS.expandedBytes || parts.has(name) || !validPartName(name)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP部件重复、路径无效或解压大小超限。')
    const content = readPart(bytes, offset, name, directoryStart)
    if (!name.endsWith('/')) parts.set(name, content)
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (offset !== eocd) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP目录长度不一致。')
  return parts
}

function readPart(bytes: Buffer, central: number, name: string, directoryStart: number): Buffer {
  const flags = bytes.readUInt16LE(central + 8), method = bytes.readUInt16LE(central + 10)
  const compressed = bytes.readUInt32LE(central + 20), size = bytes.readUInt32LE(central + 24), local = bytes.readUInt32LE(central + 42)
  if ((flags & 1) || ![0, 8].includes(method) || size === 0xffffffff || local === 0xffffffff) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '加密或不支持的ZIP编码不能修订。')
  requireRange(bytes, local, 30)
  if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP局部条目不一致。')
  const nameLength = bytes.readUInt16LE(local + 26), dataStart = local + 30 + nameLength + bytes.readUInt16LE(local + 28)
  requireRange(bytes, local + 30, nameLength)
  if (utf8(bytes.subarray(local + 30, local + 30 + nameLength)) !== name || dataStart + compressed > directoryStart) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP部件位置不一致。')
  const raw = bytes.subarray(dataStart, dataStart + compressed)
  const content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) })
  if (content.length !== size || crc32(content) !== bytes.readUInt32LE(central + 16)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP部件CRC或长度校验失败。')
  return content
}

function findDirectory(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset
  }
  return officeError('OFFICE_UNSUPPORTED_STRUCTURE', '无法识别完整Office ZIP文件。')
}
function requireRange(bytes: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > bytes.length) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'ZIP部件越界。')
}
function validPartName(name: string): boolean {
  return Boolean(name) && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') && !/[\0-\x1f]/.test(name)
}
const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
  let value = initial
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255]
  return (value ^ 0xffffffff) >>> 0
}
export function utf8(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
export async function writeOfficePackage(parts: OfficePackage): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, bytes] of parts) zip.file(name, bytes, { date: new Date('2000-01-01T00:00:00Z'), createFolders: false })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'DOS', streamFiles: false })
}
export function applyXmlPatches(xml: string, patches: XmlPatch[]): string {
  const ordered = [...patches].sort((left, right) => left.start - right.start)
  let cursor = 0, output = ''
  for (const patch of ordered) {
    if (patch.start < cursor || patch.end < patch.start || patch.end > xml.length) officeError('OFFICE_SELECTION_STALE', '选区重叠或超出原稿。')
    output += xml.slice(cursor, patch.start) + patch.replacement; cursor = patch.end
  }
  return output + xml.slice(cursor)
}
export function unchangedOfficeScopeDigest(parts: OfficePackage, changes: Map<string, XmlPatch[]>): string {
  return officeValueDigest([...parts].map(([name, bytes]) => {
    const patches = changes.get(name)
    return [name, patches ? applyXmlPatches(utf8(bytes), patches.map((patch) => ({ ...patch, replacement: '<CAOTAI-SELECTED-REGION/>' }))) : bytes.toString('base64')]
  }))
}
