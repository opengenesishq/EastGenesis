import { XMLValidator } from 'fast-xml-parser'
import { officeError } from './errors'

export interface XmlSpan {
  name: string; localName: string; start: number; openEnd: number; closeStart: number; end: number
  attributes: Record<string, string>; children: XmlSpan[]
}
/** Locate exact spans after structural validation; untouched bytes are never reserialized. */
export function xmlSpans(xml: string): XmlSpan[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'XML结构不受支持。')
  const roots: XmlSpan[] = [], stack: XmlSpan[] = []
  let count = 0
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w:.-]*(?:"[^"]*"|'[^']*'|[^'">])*>/g
  for (const token of xml.matchAll(tokens)) {
    const text = token[0], start = token.index
    if (text.startsWith('<?') || text.startsWith('<!')) continue
    if (text.startsWith('</')) {
      const node = stack.pop()
      if (!node || text.slice(2, -1).trim() !== node.name) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'XML节点边界不一致。')
      node.closeStart = start; node.end = start + text.length
      continue
    }
    if (++count > 500_000 || stack.length > 128) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'XML节点数量或深度超限。')
    const name = /^<([^\s/>]+)/.exec(text)![1]
    const node: XmlSpan = { name, localName: name.split(':').at(-1)!, start, openEnd: start + text.length,
      closeStart: start + text.length, end: start + text.length, attributes: xmlAttributes(text), children: [] }
    const parent = stack.at(-1)
    if (parent) parent.children.push(node); else roots.push(node)
    if (!text.endsWith('/>')) stack.push(node)
  }
  if (stack.length || roots.length !== 1) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'XML根节点不完整。')
  return roots
}
export function xmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1]] = decodeXmlText(match[2] ?? match[3])
  return attributes
}
export function decodeXmlText(text: string): string {
  return text.replace(/&([^;]+);/g, (_token, name: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (named[name] !== undefined) return named[name]
    const number = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : name.startsWith('#') ? Number(name.slice(1)) : NaN
    if (!Number.isInteger(number) || number < 0 || number > 0x10ffff) officeError('OFFICE_UNSUPPORTED_STRUCTURE', 'XML实体不可识别。')
    return String.fromCodePoint(number)
  })
}
export function encodeXmlText(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }
export function descendants(node: XmlSpan, localName: string): XmlSpan[] {
  return node.children.flatMap((child) => [...(child.localName === localName ? [child] : []), ...descendants(child, localName)])
}
