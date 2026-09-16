import { posix } from 'node:path'
import type { OfficeRevisionOperation, OfficeSlideSnapshot, OfficeSlideTextSnapshot } from '../../shared/office-revision-types'
import { officeBytesDigest } from './digest'
import { officeError } from './errors'
import { utf8, type OfficePackage, type XmlPatch } from './package'
import { decodeXmlText, encodeXmlText, xmlSpans, type XmlSpan } from './xml-spans'

const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const RELATION = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_RELATION = 'http://schemas.openxmlformats.org/package/2006/relationships'
interface TextLocation { part: string; xml: string; paragraphs: XmlSpan[][] }
export interface PresentationInspection {
  slides: OfficeSlideSnapshot[]
  texts: OfficeSlideTextSnapshot[]
  locations: Map<string, TextLocation>
  slideParts: Map<string, string>
}

export function slideTextKey(slideId: string, shapeId: string): string { return `${slideId}!${shapeId}` }

/** Page order comes from presentation relationships, never slide filename sorting. */
export function inspectPresentationPackage(parts: OfficePackage): PresentationInspection {
  const root = xmlSpans(requiredXml(parts, 'ppt/presentation.xml'))[0]
  if (root.name !== 'p:presentation' || root.attributes['xmlns:p'] !== PRESENTATION || root.attributes['xmlns:r'] !== RELATION) {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 主部件命名空间不受支持。')
  }
  assertNamespaces(root)
  const list = root.children.filter((node) => node.name === 'p:sldIdLst')
  if (list.length !== 1 || list[0].children.some((node) => node.name !== 'p:sldId')) {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面列表缺失或结构不受支持。')
  }
  const relations = xmlSpans(requiredXml(parts, 'ppt/_rels/presentation.xml.rels'))[0]
  if (relations.name !== 'Relationships' || relations.attributes.xmlns !== PACKAGE_RELATION) {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面关系命名空间不受支持。')
  }
  const relationshipIds = relations.children.map((node) => node.attributes.Id)
  if (relationshipIds.some((id) => !id) || new Set(relationshipIds).size !== relationshipIds.length) {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 关系身份重复或缺失。')
  }
  const result: PresentationInspection = { slides: [], texts: [], locations: new Map(), slideParts: new Map() }
  const seenParts = new Set<string>(), seenIds = new Set<string>()
  for (const [index, slide] of list[0].children.entries()) {
    const rawId = slide.attributes.id, relationId = slide.attributes['r:id']
    if (!validNumericId(rawId) || !relationId || seenIds.has(rawId)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面身份无效或重复。')
    seenIds.add(rawId)
    const relation = relations.children.find((node) => node.name === 'Relationship' && node.attributes.Id === relationId)
    if (!relation || relation.attributes.Type !== `${RELATION}/slide` || relation.attributes.TargetMode === 'External') {
      officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面关系缺失、类型不符或指向外部。')
    }
    const target = relation.attributes.Target
    if (!target || /[\\?#\u0000-\u001f]/.test(target)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面路径无效。')
    const part = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('ppt', target))
    if (!part.startsWith('ppt/slides/') || part.split('/').includes('..') || seenParts.has(part)) {
      officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面路径越界或重复。')
    }
    seenParts.add(part)
    result.slideParts.set(`slide:${rawId}`, part)
    inspectSlide(parts, part, `slide:${rawId}`, index, result)
  }
  return result
}

function inspectSlide(parts: OfficePackage, part: string, id: string, index: number, result: PresentationInspection): void {
  const xml = requiredXml(parts, part), root = xmlSpans(xml)[0]
  const types = xmlSpans(requiredXml(parts, '[Content_Types].xml'))[0].children.filter((node) => node.name === 'Override' && node.attributes.PartName === `/${part}`)
  if (types.length !== 1 || types[0].attributes.ContentType !== 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml') {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面部件类型缺失或不一致。')
  }
  if (root.name !== 'p:sld' || root.attributes['xmlns:p'] !== PRESENTATION || root.attributes['xmlns:a'] !== DRAWING) {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面命名空间不受支持。')
  }
  assertNamespaces(root)
  const common = root.children.filter((node) => node.name === 'p:cSld')
  const trees = common[0]?.children.filter((node) => node.name === 'p:spTree') ?? []
  if (common.length !== 1 || trees.length !== 1) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 页面形状树无效。')
  result.slides.push({ id, index, name: common[0].attributes.name || `第 ${index + 1} 页` })
  const shapeIds = new Set<string>()
  for (const shape of shapeNodes(trees[0])) {
    const identity = shape.children.find((node) => node.name === 'p:nvSpPr')?.children.filter((node) => node.name === 'p:cNvPr') ?? []
    if (identity.length !== 1 || !validNumericId(identity[0].attributes.id) || shapeIds.has(identity[0].attributes.id)) {
      officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 文本框身份缺失或重复。')
    }
    const shapeId = `shape:${identity[0].attributes.id}`
    shapeIds.add(identity[0].attributes.id)
    const bodies = shape.children.filter((node) => node.name === 'p:txBody')
    if (!bodies.length) continue
    const paragraphs = bodies.length === 1 ? ordinaryTextBody(bodies[0], xml) : undefined
    const text = bodies.map((body) => body.children.filter((node) => node.name === 'a:p').map((node) => paragraphText(node, xml)).join('\n')).join('\n')
    result.texts.push({ slideId: id, shapeId, name: identity[0].attributes.name || shapeId, text,
      nodeDigest: officeBytesDigest(xml.slice(shape.start, shape.end)), editable: Boolean(paragraphs),
      ...(!paragraphs ? { reason: '字段、链接、显式换行或复杂文本结构暂只读。' } : {}) })
    if (paragraphs) result.locations.set(slideTextKey(id, shapeId), { part, xml, paragraphs })
  }
}

function shapeNodes(tree: XmlSpan): XmlSpan[] {
  return tree.children.flatMap((node) => node.name === 'p:sp' ? [node] : node.name === 'p:grpSp' ? shapeNodes(node) : [])
}

function ordinaryTextBody(body: XmlSpan, xml: string): XmlSpan[][] | undefined {
  if (body.children.some((node) => !['a:bodyPr', 'a:lstStyle', 'a:p'].includes(node.name))) return undefined
  const paragraphs = body.children.filter((node) => node.name === 'a:p')
  if (!paragraphs.length) return undefined
  const result: XmlSpan[][] = []
  for (const paragraph of paragraphs) {
    if (paragraph.children.some((node) => !['a:pPr', 'a:r', 'a:endParaRPr'].includes(node.name))) return undefined
    const texts: XmlSpan[] = []
    for (const run of paragraph.children.filter((node) => node.name === 'a:r')) {
      if (run.children.some((node) => !['a:rPr', 'a:t'].includes(node.name)) || containsLink(run)) return undefined
      const nodes = run.children.filter((node) => node.name === 'a:t')
      if (nodes.length !== 1 || nodes[0].children.length || nodes[0].closeStart >= nodes[0].end || xml.slice(nodes[0].openEnd, nodes[0].closeStart).includes('<')) return undefined
      if (/_x[a-f0-9]{4}_/i.test(decodeXmlText(xml.slice(nodes[0].openEnd, nodes[0].closeStart)))) return undefined
      texts.push(nodes[0])
    }
    // Filling an empty paragraph would require creating new run/style structure.
    if (!texts.length) return undefined
    result.push(texts)
  }
  return result
}

function containsLink(node: XmlSpan): boolean {
  return node.children.some((child) => child.name === 'a:hlinkClick' || child.name === 'a:hlinkMouseOver' || containsLink(child))
}

function paragraphText(node: XmlSpan, xml: string): string {
  if (node.name === 'a:t') return decodeXmlText(xml.slice(node.openEnd, node.closeStart))
  if (node.name === 'a:br') return '\n'
  return node.children.map((child) => paragraphText(child, xml)).join('')
}

export function patchPresentationText(inspection: PresentationInspection, operation: Extract<OfficeRevisionOperation, { kind: 'replaceSlideText' }>): { part: string; patches: XmlPatch[] } {
  const selected = inspection.texts.find((item) => item.slideId === operation.slideId && item.shapeId === operation.shapeId)
  if (!selected || selected.nodeDigest !== operation.expectedNodeDigest) officeError('OFFICE_SELECTION_STALE', '页面或文本框已变化，请重新检查原稿。')
  const location = inspection.locations.get(slideTextKey(operation.slideId, operation.shapeId))
  if (!location) officeError('OFFICE_UNSUPPORTED_STRUCTURE', selected.reason ?? '该文本框暂只读。')
  const paragraphs = operation.text.split('\n')
  if (paragraphs.length !== location.paragraphs.length) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '局部文字替换需保留原文本框的段落数量。')
  return { part: location.part, patches: location.paragraphs.flatMap((nodes, index) => patchParagraphText(location.xml, nodes, paragraphs[index])) }
}

/** Retain styled runs and unchanged prefix/suffix; replacement characters fill the original run spans. */
function patchParagraphText(xml: string, nodes: XmlSpan[], replacement: string): XmlPatch[] {
  const strings = nodes.map((node) => decodeXmlText(xml.slice(node.openEnd, node.closeStart)))
  const before = Array.from(strings.join('')), after = Array.from(replacement)
  let prefix = 0, suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  if (prefix === before.length && prefix === after.length) return []
  const inserted = after.slice(prefix, after.length - suffix), removedEnd = before.length - suffix
  let position = 0, insertedOffset = 0
  const spans = strings.map((text) => {
    const start = position
    position += Array.from(text).length
    return { start, end: position }
  })
  const first = spans.findIndex((span, index) => prefix < span.end || index === spans.length - 1)
  const last = removedEnd > prefix ? spans.findLastIndex((span) => span.start < removedEnd && span.end > prefix) : first
  return nodes.flatMap((node, index) => {
    const original = Array.from(strings[index]), { start, end } = spans[index]
    let text = original.slice(0, Math.max(0, Math.min(original.length, prefix - start))).join('')
    if (index >= first && index <= last) {
      const capacity = index === last ? inserted.length - insertedOffset : Math.max(0, Math.min(end, removedEnd) - Math.max(start, prefix))
      text += inserted.slice(insertedOffset, insertedOffset + capacity).join('')
      insertedOffset += capacity
    }
    text += original.slice(Math.max(0, Math.min(original.length, removedEnd - start))).join('')
    if (text === strings[index]) return []
    return [{ start: node.openEnd, end: node.closeStart, replacement: encodeXmlText(text) }]
  })
}

function assertNamespaces(node: XmlSpan): void {
  for (const [prefix, namespace] of [['p', PRESENTATION], ['a', DRAWING], ['r', RELATION]]) {
    if (node.attributes[`xmlns:${prefix}`] !== undefined && node.attributes[`xmlns:${prefix}`] !== namespace) {
      officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'PowerPoint 节点重定义了标准命名空间。')
    }
  }
  node.children.forEach(assertNamespaces)
}

function validNumericId(value: string): boolean { return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 0xffffffff }
function requiredXml(parts: OfficePackage, name: string): string {
  const bytes = parts.get(name)
  if (!bytes) officeError('OFFICE_UNSUPPORTED_STRUCTURE', `缺少 PowerPoint 部件: ${name}`)
  return utf8(bytes)
}
