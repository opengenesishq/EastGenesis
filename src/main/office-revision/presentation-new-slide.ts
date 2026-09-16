import { encodeXmlText } from './xml-spans'
import { officeError } from './errors'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** New pages use the original canvas size and theme. Existing pages and their
 * authored shapes are never regenerated. */
export function newPresentationSlide(title: string, body: string, width: number, height: number): Buffer {
  // Office interprets these sequences after parsing XML; treating one as plain
  // text would pass our XML readback while displaying different user content.
  if (/_x[a-f0-9]{4}_/i.test(title) || /_x[a-f0-9]{4}_/i.test(body)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '新增页面文字包含 Office 转义序列，不能作为普通文字写入。')
  const shape = (id: number, name: string, text: string, top: number, extent: number, size: number, bold: boolean): string => {
    const paragraph = (value: string) => `<a:p><a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''}/><a:t xml:space="preserve">${encodeXmlText(value)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>`
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(width * .06)}" y="${Math.round(height * top)}"/><a:ext cx="${Math.round(width * .88)}" cy="${Math.round(height * extent)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"/><a:lstStyle/>${text.split('\n').map(paragraph).join('')}</p:txBody></p:sp>`
  }
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" showMasterSp="0"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shape(2, 'Title', title, .06, .18, 3000, true)}${shape(3, 'Body', body, .27, .65, 1800, false)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
}
