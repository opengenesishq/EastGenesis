import type { OfficeParagraphSnapshot, OfficeRevisionOperation } from '../../shared/office-revision-types'
import { officeBytesDigest } from './digest'
import { officeError } from './errors'
import { utf8, type OfficePackage, type XmlPatch } from './package'
import { decodeXmlText, descendants, encodeXmlText, xmlSpans, type XmlSpan } from './xml-spans'

export const DOCUMENT_PART = 'word/document.xml'
export interface DocumentInspection { xml: string; paragraphs: OfficeParagraphSnapshot[]; textNodes: Map<string, XmlSpan> }
export function inspectDocumentPackage(parts: OfficePackage): DocumentInspection {
  const bytes = parts.get(DOCUMENT_PART)
  if (!bytes) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '缺少Word正文部件。')
  const xml = utf8(bytes), root = xmlSpans(xml)[0]
  if (root.name !== 'w:document' || root.attributes['xmlns:w'] !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') officeError('OFFICE_UNSUPPORTED_STRUCTURE', '该Word XML命名空间暂不支持局部修订。')
  const body = root.children.find((node) => node.name === 'w:body')
  if (!body) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '缺少Word正文。')
  const textNodes = new Map<string, XmlSpan>()
  const paragraphs = descendants(body, 'p').map((paragraph, index): OfficeParagraphSnapshot => {
    const id = `paragraph:${index + 1}`
    const candidate = body.children.includes(paragraph) ? ordinaryParagraphText(paragraph) : undefined
    const textNode = candidate && !xml.slice(candidate.openEnd, candidate.closeStart).includes('<') ? candidate : undefined
    if (textNode) textNodes.set(id, textNode)
    return { id, index, text: descendants(paragraph, 't').map((node) => decodeXmlText(xml.slice(node.openEnd, node.closeStart))).join(''),
      nodeDigest: officeBytesDigest(xml.slice(paragraph.start, paragraph.end)), editable: Boolean(textNode),
      ...(!textNode ? { reason: '表格、字段、链接、批注、多格式或空结构段落暂只读。' } : {}) }
  })
  return { xml, paragraphs, textNodes }
}
function ordinaryParagraphText(paragraph: XmlSpan): XmlSpan | undefined {
  if (paragraph.name !== 'w:p' || paragraph.children.some((child) => !['w:pPr', 'w:r'].includes(child.name))) return undefined
  const runs = paragraph.children.filter((child) => child.name === 'w:r')
  if (runs.length !== 1 || runs[0].children.some((child) => !['w:rPr', 'w:t'].includes(child.name))) return undefined
  const texts = runs[0].children.filter((child) => child.name === 'w:t')
  return texts.length === 1 && texts[0].children.length === 0 && texts[0].closeStart < texts[0].end ? texts[0] : undefined
}
export function patchDocumentParagraph(inspection: DocumentInspection, operation: Extract<OfficeRevisionOperation, { kind: 'replaceParagraphText' }>): XmlPatch {
  const paragraph = inspection.paragraphs.find((item) => item.id === operation.paragraphId)
  if (!paragraph || paragraph.nodeDigest !== operation.expectedNodeDigest) officeError('OFFICE_SELECTION_STALE', '段落选区已变化，请重新检查原稿。')
  const node = inspection.textNodes.get(operation.paragraphId)
  if (!node) officeError('OFFICE_UNSUPPORTED_STRUCTURE', paragraph.reason ?? '该段落暂只读。')
  let opening = inspection.xml.slice(node.start, node.openEnd)
  if (!/\bxml:space\s*=/.test(opening)) opening = `${opening.slice(0, -1)} xml:space="preserve">`
  else opening = opening.replace(/\bxml:space\s*=\s*(?:"[^"]*"|'[^']*')/, 'xml:space="preserve"')
  return { start: node.start, end: node.end, replacement: opening + encodeXmlText(operation.text) + inspection.xml.slice(node.closeStart, node.end) }
}
