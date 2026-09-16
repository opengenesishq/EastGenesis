import { posix } from 'node:path'
import type { OfficeRevisionOperation, OfficeRevisionCheck } from '../../shared/office-revision-types'
import { officeBytesDigest, officeValueDigest } from './digest'
import { officeError } from './errors'
import { inspectPresentationPackage, type PresentationInspection } from './presentation'
import { newPresentationSlide } from './presentation-new-slide'
import { OFFICE_RELATION, PACKAGE_RELATION, readPackageRelations, relationshipPart, removePresentationPages } from './presentation-relationships'
import { applyXmlPatches, readOfficePackage, unchangedOfficeScopeDigest, utf8, writeOfficePackage, type OfficePackage, type XmlPatch } from './package'
import { descendants, xmlSpans, type XmlSpan } from './xml-spans'

const MAIN = 'ppt/presentation.xml', RELS = 'ppt/_rels/presentation.xml.rels', TYPES = '[Content_Types].xml'
const SLIDE_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
type Operation = Extract<OfficeRevisionOperation, { kind: 'setSlideSequence' }>

export function inspectSlideSequence(parts: OfficePackage) {
  const xml = utf8(parts.get(MAIN)!), root = xmlSpans(xml)[0]
  const complex = ['custShowLst', 'sectionLst', 'extLst'].some(name => descendants(root, name).length)
  return { nodeDigest: officeValueDigest([officeBytesDigest(parts.get(MAIN)!), officeBytesDigest(parts.get(RELS)!)]),
    editable: !complex, ...(complex ? { reason: '文稿包含自定义放映、分节或扩展目录；请先在 PowerPoint 中调整这些关联，再修改页面顺序。' } : {}) }
}

export async function reviseSlideSequence(parts: OfficePackage, inspection: PresentationInspection, operation: Operation) {
  const sequence = inspectSlideSequence(parts)
  if (sequence.nodeDigest !== operation.expectedNodeDigest) officeError('OFFICE_SELECTION_STALE', '页面顺序已变化，请重新检查原稿。')
  if (!sequence.editable) officeError('OFFICE_UNSUPPORTED_STRUCTURE', sequence.reason!)
  const originalIds = inspection.slides.map(slide => slide.id)
  const retainedIds = operation.slides.flatMap(slide => 'slideId' in slide ? [slide.slideId] : [])
  if (retainedIds.some(id => !inspection.slideParts.has(id))) officeError('OFFICE_SELECTION_STALE', '选中的原页面已不存在。')
  if (retainedIds.length === operation.slides.length && JSON.stringify(retainedIds) === JSON.stringify(originalIds)) officeError('OFFICE_PLAN_MISMATCH', '页面顺序和内容没有变化。')
  const output = new Map(parts), changes = new Map<string, XmlPatch[]>(), afterChanges = new Map<string, XmlPatch[]>()
  const apply = (part: string, patches: XmlPatch[]) => {
    if (!patches.length) return
    const xml = utf8(parts.get(part)!)
    changes.set(part, patches)
    output.set(part, Buffer.from(applyXmlPatches(xml, patches)))
    let offset = 0
    afterChanges.set(part, [...patches].sort((a, b) => a.start - b.start).map(patch => {
      const start = patch.start + offset
      offset += patch.replacement.length - (patch.end - patch.start)
      return { start, end: start + patch.replacement.length, replacement: '' }
    }))
  }
  const mainXml = utf8(parts.get(MAIN)!), mainRoot = xmlSpans(mainXml)[0]
  const list = mainRoot.children.find(node => node.name === 'p:sldIdLst')!
  const removedIds = originalIds.filter(id => !retainedIds.includes(id))
  const removedParts = removedIds.map(id => inspection.slideParts.get(id)!)
  const relations = readPackageRelations(parts, MAIN)
  const relXml = utf8(parts.get(RELS)!), relRoot = xmlSpans(relXml)[0]
  const relPatches: XmlPatch[] = relations.filter(relation => relation.target && removedParts.includes(relation.target))
    .map(relation => ({ start: relation.node.start, end: relation.node.end, replacement: '' }))
  const addedParts = new Set<string>(), overrides: string[] = [], entries: string[] = [], insertedRelations: string[] = []
  const relationIds = new Set(relations.map(relation => relation.id))
  let slideId = Math.max(255, ...originalIds.map(id => Number(id.slice(6))))
  let partNumber = 1, relationNumber = 1
  const size = mainRoot.children.find(node => node.name === 'p:sldSz')
  const width = Number(size?.attributes.cx), height = Number(size?.attributes.cy)
  const newSlides = operation.slides.filter(slide => !('slideId' in slide))
  let layout: string | undefined
  if (newSlides.length) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 51206400)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '原页面尺寸不受支持。')
    const firstPart = inspection.slideParts.values().next().value
    const layouts = firstPart ? readPackageRelations(parts, firstPart).filter(relation => relation.type === `${OFFICE_RELATION}/slideLayout`) : []
    if (layouts.length !== 1 || !layouts[0].target) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '原稿没有可沿用的页面布局。')
    layout = layouts[0].target
    assertPresentationLayout(parts, layout)
  }
  const expectedIds: string[] = []
  for (const slide of operation.slides) {
    if ('slideId' in slide) {
      const node = list.children.find(node => `slide:${node.attributes.id}` === slide.slideId)!
      entries.push(mainXml.slice(node.start, node.end)); expectedIds.push(slide.slideId)
      continue
    }
    while (parts.has(`ppt/slides/slide${partNumber}.xml`) || output.has(`ppt/slides/slide${partNumber}.xml`) || output.has(`ppt/slides/_rels/slide${partNumber}.xml.rels`)) partNumber++
    const part = `ppt/slides/slide${partNumber}.xml`, relPart = relationshipPart(part)
    if (++slideId > 0x7fffffff) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '原稿页面身份已达到上限。')
    while (relationIds.has(`rIdCaogen${relationNumber}`)) relationNumber++
    const relationId = `rIdCaogen${relationNumber++}`; relationIds.add(relationId)
    expectedIds.push(`slide:${slideId}`)
    entries.push(`<p:sldId id="${slideId}" r:id="${relationId}"/>`)
    insertedRelations.push(`<Relationship Id="${relationId}" Type="${OFFICE_RELATION}/slide" Target="slides/slide${partNumber}.xml"/>`)
    output.set(part, newPresentationSlide(slide.title, slide.body, width, height))
    const target = posix.relative('ppt/slides', layout!).split('/').map(segment => encodeURIComponent(segment)).join('/')
    output.set(relPart, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELATION}"><Relationship Id="rId1" Type="${OFFICE_RELATION}/slideLayout" Target="${target}"/></Relationships>`))
    addedParts.add(part); addedParts.add(relPart)
    overrides.push(`<Override PartName="/${part}" ContentType="${SLIDE_TYPE}"/>`)
  }
  apply(MAIN, [{ start: list.openEnd, end: list.closeStart, replacement: entries.join('') }])
  if (insertedRelations.length) relPatches.push({ start: relRoot.closeStart, end: relRoot.closeStart, replacement: insertedRelations.join('') })
  apply(RELS, relPatches)
  // A package thumbnail can still show a deleted or reordered first page.
  // Drop its cache binding; keep the image itself if a retained page uses it.
  const thumbnails = readPackageRelations(parts, '').filter(relation => relation.type === `${PACKAGE_RELATION}/metadata/thumbnail`)
  apply(relationshipPart(''), thumbnails.map(relation => ({ start: relation.node.start, end: relation.node.end, replacement: '' })))
  const removed = new Set(removePresentationPages(parts, output, removedParts, thumbnails.flatMap(relation => relation.target ? [relation.target] : [])))
  const typesRoot = xmlSpans(utf8(parts.get(TYPES)!))[0]
  const typePatches = typesRoot.children.filter(node => node.name === 'Override' && removed.has(contentTypePart(node)))
    .map(node => ({ start: node.start, end: node.end, replacement: '' }))
  if (overrides.length) typePatches.push({ start: typesRoot.closeStart, end: typesRoot.closeStart, replacement: overrides.join('') })
  apply(TYPES, typePatches)
  updatePresentationProperties(parts, output, operation.slides.length, apply)
  const unchanged = new Map([...parts].filter(([name]) => !removed.has(name)))
  const unchangedScopeDigest = unchangedOfficeScopeDigest(unchanged, changes)
  const bytes = await writeOfficePackage(output), readback = readOfficePackage(bytes)
  const retained = new Map([...readback].filter(([name]) => !addedParts.has(name)))
  if (unchangedOfficeScopeDigest(retained, afterChanges) !== unchangedScopeDigest) officeError('OFFICE_OUTPUT_CONFLICT', '页面调整改变了批准范围之外的原稿内容。')
  const verified = inspectPresentationPackage(readback)
  if (JSON.stringify(verified.slides.map(slide => slide.id)) !== JSON.stringify(expectedIds)) officeError('OFFICE_OUTPUT_CONFLICT', '新稿页面顺序回读不一致。')
  for (const [index, slide] of operation.slides.entries()) {
    if ('slideId' in slide) continue
    const texts = verified.texts.filter(text => text.slideId === expectedIds[index])
    if (texts.find(text => text.shapeId === 'shape:2')?.text !== slide.title || texts.find(text => text.shapeId === 'shape:3')?.text !== slide.body) officeError('OFFICE_OUTPUT_CONFLICT', '新增页面内容回读不一致。')
  }
  // Validate every surviving relationship, including notes, charts and media.
  for (const owner of ['', ...[...readback.keys()].filter(name => !name.endsWith('.rels'))]) readPackageRelations(readback, owner)
  const checks: OfficeRevisionCheck[] = [
    { id: 'package', state: 'passed', message: '页面清单、关系、部件类型和新增文字已回读核验。' },
    { id: 'coverage', state: 'passed', message: `页面从 ${originalIds.length} 页调整为 ${operation.slides.length} 页。` },
    { id: 'unselected-content', state: 'passed', message: '保留页面及共享图表、图片、样式、备注字节不变；仅移除选定页面及其独占部件，并更新页面目录。' },
    { id: 'semantic', state: 'not_checked', message: '新增页面的事实、来源和排版仍需复核；新增页沿用原尺寸与主题，使用标题和正文布局。' }
  ]
  const describe = (id: string) => { const slide = inspection.slides.find(slide => slide.id === id)!; return `原第 ${slide.index + 1} 页：${slide.name}` }
  return { bytes, unchangedScopeDigest, checks, changes: [{ targetId: 'presentation:slide-sequence', label: '页面数量与顺序',
    before: originalIds.map((id, i) => `${i + 1}. ${describe(id)}`).join('\n'),
    after: operation.slides.map((slide, i) => `${i + 1}. ${'slideId' in slide ? describe(slide.slideId) : `新增：${slide.title}\n${slide.body}`}`).join('\n') }] }
}

function assertPresentationLayout(parts: OfficePackage, part: string): void {
  const root = xmlSpans(utf8(parts.get(part)!))[0]
  const types = xmlSpans(utf8(parts.get(TYPES)!))[0].children.filter(node =>
    node.name === 'Override' && contentTypePart(node) === part)
  if (root.name !== 'p:sldLayout' || root.attributes['xmlns:p'] !== 'http://schemas.openxmlformats.org/presentationml/2006/main' ||
    types.length !== 1 || types[0].attributes.ContentType !== 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml') {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', '原页面关联的布局部件类型或命名空间不一致。')
  }
}

function contentTypePart(node: XmlSpan): string {
  let part: string
  try { part = decodeURIComponent(node.attributes.PartName ?? '') } catch { return officeError('OFFICE_UNSUPPORTED_STRUCTURE', '部件类型路径编码无效。') }
  if (!part.startsWith('/') || /[\\?#:\u0000-\u001f]/.test(part) || part.slice(1).split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    officeError('OFFICE_UNSUPPORTED_STRUCTURE', '部件类型路径无效。')
  }
  return part.slice(1)
}

function updatePresentationProperties(parts: OfficePackage, output: OfficePackage, count: number, apply: (part: string, patches: XmlPatch[]) => void): void {
  const part = 'docProps/app.xml', bytes = parts.get(part)
  if (!bytes) return
  const root = xmlSpans(utf8(bytes))[0]
  const patches = root.children.flatMap((node): XmlPatch[] => {
    if (node.localName === 'Slides' || node.localName === 'Notes') {
      const value = node.localName === 'Slides' ? count : [...output.keys()].filter(name => /^ppt\/notesSlides\/[^/]+\.xml$/.test(name)).length
      return [{ start: node.start, end: node.end, replacement: `<${node.name}>${value}</${node.name}>` }]
    }
    // Office rebuilds these display caches. Keeping old titles after deletion
    // leaks removed content and presents a stale page index.
    return ['HeadingPairs', 'TitlesOfParts'].includes(node.localName) ? [{ start: node.start, end: node.end, replacement: '' }] : []
  })
  apply(part, patches)
}
