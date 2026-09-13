import { posix } from 'node:path'
import type { OfficeCellSnapshot, OfficeLiteral, OfficeRevisionOperation, OfficeSheetSnapshot } from '../../shared/office-revision-types'
import { officeBytesDigest } from './digest'
import { officeError } from './errors'
import { utf8, type OfficePackage, type XmlPatch } from './package'
import { decodeXmlText, descendants, encodeXmlText, xmlSpans, type XmlSpan } from './xml-spans'

const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
interface CellLocation { node: XmlSpan; xml: string; part: string }
export interface SpreadsheetInspection { sheets: OfficeSheetSnapshot[]; cells: OfficeCellSnapshot[]; locations: Map<string, CellLocation>; formulaCount: number }
export function inspectSpreadsheetPackage(parts: OfficePackage): SpreadsheetInspection {
  const workbook = requiredXml(parts, 'xl/workbook.xml'), root = xmlSpans(workbook)[0]
  if (root.name !== 'workbook' || root.attributes.xmlns !== SPREADSHEET_NAMESPACE) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '该Excel XML命名空间暂不支持局部修订。')
  const relations = xmlSpans(requiredXml(parts, 'xl/_rels/workbook.xml.rels'))[0].children
  const shared = sharedStrings(parts)
  const result: SpreadsheetInspection = { sheets: [], cells: [], locations: new Map(), formulaCount: 0 }
  for (const sheet of descendants(root, 'sheet')) {
    const relation = relations.find((item) => item.attributes.Id === sheet.attributes['r:id'])
    if (!relation || relation.attributes.TargetMode === 'External') officeError('OFFICE_UNSUPPORTED_STRUCTURE', '工作表关系无效或指向外部。')
    const target = relation.attributes.Target
    const part = target?.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target ?? ''))
    if (!part.startsWith('xl/') || part.includes('..')) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '工作表关系越界。')
    inspectSheet(parts, part, sheet, shared, result)
  }
  return result
}
function inspectSheet(parts: OfficePackage, part: string, sheet: XmlSpan, shared: Array<string | undefined>, result: SpreadsheetInspection): void {
  const xml = requiredXml(parts, part), root = xmlSpans(xml)[0], id = `sheet:${sheet.attributes.sheetId}`
  if (root.name !== 'worksheet' || root.attributes.xmlns !== SPREADSHEET_NAMESPACE || result.sheets.some((item) => item.id === id)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '工作表结构或身份无效。')
  if (!/^[1-9][0-9]*$/.test(sheet.attributes.sheetId) || !sheet.attributes.name) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '工作表身份缺失。')
  const merges = descendants(root, 'mergeCell').map((node) => node.attributes.ref)
  const protectedSheet = descendants(root, 'sheetProtection').length > 0
  result.sheets.push({ id, name: sheet.attributes.name, usedRange: descendants(root, 'dimension')[0]?.attributes.ref })
  for (const row of descendants(root, 'row')) {
    for (const node of row.children.filter((child) => child.name === 'c')) {
      const address = node.attributes.r, key = `${id}!${address}`
      if (!validCellAddress(address) || result.locations.has(key)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '单元格地址重复或无效。')
      const value = inspectCell(xml, node, shared)
      const reason = protectedSheet ? '受保护工作表暂只读。' : merges.some((range) => rangeContains(range, address)) ? '合并单元格暂只读。' : value.reason
      if (value.type === 'formula') result.formulaCount++
      result.cells.push({ sheetId: id, address, ...value, nodeDigest: officeBytesDigest(xml.slice(node.start, node.end)), editable: !reason,
        ...(reason ? { reason } : {}) })
      result.locations.set(key, { node, xml, part })
    }
  }
}
function inspectCell(xml: string, node: XmlSpan, shared: Array<string | undefined>): Pick<OfficeCellSnapshot, 'type' | 'value' | 'formula' | 'cachedValue' | 'reason'> {
  const formula = node.children.find((child) => child.name === 'f'), raw = nodeText(xml, node.children.find((child) => child.name === 'v'))
  if (formula) return { type: 'formula', formula: nodeText(xml, formula), cachedValue: raw, reason: '第一版不修改公式，缓存结果不代表已重算。' }
  if (!ordinaryCellShape(node)) return { type: 'unsupported', reason: '复杂单元格内容暂只读。' }
  const type = node.attributes.t
  if (type === 's') return sharedStringCell(raw, shared)
  if (type === 'inlineStr') {
    const value = plainString(xml, node.children.find((child) => child.name === 'is'))
    return value === undefined ? { type: 'unsupported', reason: '富文本或Office转义文本单元格暂只读。' } : { type: 'string', value }
  }
  if (type === 'b' && (raw === '0' || raw === '1')) return { type: 'boolean', value: raw === '1' }
  if (type && type !== 'n') return { type: 'unsupported', reason: '该单元格类型暂只读。' }
  if (raw === '') return { type: 'blank', value: null }
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? { type: 'number', value: Number(raw) } : { type: 'unsupported', reason: '无效数字单元格暂只读。' }
}
function sharedStrings(parts: OfficePackage): Array<string | undefined> {
  const bytes = parts.get('xl/sharedStrings.xml')
  if (!bytes) return []
  const xml = utf8(bytes)
  return xmlSpans(xml)[0].children.filter((node) => node.name === 'si').map((node) => plainString(xml, node))
}
function plainString(xml: string, node?: XmlSpan): string | undefined {
  if (node && xml.slice(node.start, node.end).includes('<![CDATA[')) return undefined
  return node?.children.length === 1 && node.children[0].name === 't' && !node.children[0].children.length ? plainOfficeString(nodeText(xml, node.children[0])) : undefined
}
function nodeText(xml: string, node?: XmlSpan): string { return node ? decodeXmlText(xml.slice(node.openEnd, node.closeStart)) : '' }
function requiredXml(parts: OfficePackage, name: string): string {
  const part = parts.get(name)
  if (!part) officeError('OFFICE_UNSUPPORTED_STRUCTURE', `缺少Office部件:${name}`)
  return utf8(part)
}
export function validCellAddress(value: string): boolean {
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(value)) return false
  const coordinate = cellCoordinate(value)
  return coordinate.column <= 16_384 && coordinate.row <= 1_048_576
}
function cellCoordinate(address: string): { column: number; row: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(address)
  if (!match) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '单元格范围无效。')
  return { column: [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0), row: Number(match[2]) }
}
function rangeContains(range: string, address: string): boolean {
  const [first, last = first] = range.split(':')
  if (!validCellAddress(first) || !validCellAddress(last)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '合并范围无效。')
  const begin = cellCoordinate(first), end = cellCoordinate(last), value = cellCoordinate(address)
  return value.column >= begin.column && value.column <= end.column && value.row >= begin.row && value.row <= end.row
}
export function patchSpreadsheetCell(inspection: SpreadsheetInspection, operation: Extract<OfficeRevisionOperation, { kind: 'setCellValue' }>): { part: string; patch: XmlPatch } {
  const cell = inspection.cells.find((item) => item.sheetId === operation.sheetId && item.address === operation.address)
  if (!cell || cell.nodeDigest !== operation.expectedNodeDigest) officeError('OFFICE_SELECTION_STALE', '单元格选区已变化，请重新检查原稿。')
  if (!cell.editable) officeError('OFFICE_UNSUPPORTED_STRUCTURE', cell.reason ?? '该单元格暂只读。')
  const location = inspection.locations.get(`${operation.sheetId}!${operation.address}`)!
  let opening = location.xml.slice(location.node.start, location.node.openEnd).replace(/\s+t\s*=\s*(?:"[^"]*"|'[^']*')/, '').replace(/\s*\/?\s*>$/, '')
  const content = literalCellXml(operation.value)
  if (content.type) opening += ` t="${content.type}"`
  return { part: location.part, patch: { start: location.node.start, end: location.node.end, replacement: `${opening}>${content.body}</c>` } }
}
function literalCellXml(value: OfficeLiteral): { type?: string; body: string } {
  if (value === null) return { body: '' }
  if (typeof value === 'string') return { type: 'inlineStr', body: `<is><t xml:space="preserve">${encodeXmlText(requirePlainOfficeString(value))}</t></is>` }
  if (typeof value === 'boolean') return { type: 'b', body: `<v>${value ? 1 : 0}</v>` }
  return { body: `<v>${value}</v>` }
}
function sharedStringCell(raw: string, shared: Array<string | undefined>): Pick<OfficeCellSnapshot, 'type' | 'value' | 'reason'> {
  const index = Number(raw), value = /^[0-9]+$/.test(raw) && Number.isSafeInteger(index) ? shared[index] : undefined
  return value === undefined ? { type: 'unsupported', reason: '富文本、Office转义文本或无效共享字符串暂只读。' } : { type: 'string', value }
}
function ordinaryCellShape(node: XmlSpan): boolean {
  return Object.keys(node.attributes).every((key) => ['r', 's', 't'].includes(key)) && node.children.length <= 1 &&
    node.children.every((child) => ['v', 'is'].includes(child.name) && Object.keys(child.attributes).length === 0)
}

function plainOfficeString(value: string): string | undefined { return /_x[a-f0-9]{4}_/i.test(value) ? undefined : value }
function requirePlainOfficeString(value: string): string {
  if (plainOfficeString(value) === undefined) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'Office转义序列文本暂只读，不能在第一版局部编辑中解释或改写。')
  return value
}
