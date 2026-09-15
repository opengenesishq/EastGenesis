import assert from 'node:assert/strict'
import PptxGenJS from 'pptxgenjs'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import ExcelJS from 'exceljs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OfficeRevisionKind, OfficeRevisionOperation } from '../src/shared/office-revision-types'
import type { ScopedOfficeArtifact } from '../src/main/office-revision/scope'
import { generateOfficeRevision, officeArtifactSnapshot } from '../src/main/office-revision/inspection'
import { readOfficePackage, writeOfficePackage } from '../src/main/office-revision/package'
import { inspectPresentationPackage } from '../src/main/office-revision/presentation'
import { officeBytesDigest } from '../src/main/office-revision/digest'
import { normalizeOfficeDraft } from '../src/main/office-revision/input'
import { slideTextRevision } from '../src/renderer/src/components/workbench/office-revision/office-revision-model'
import OfficeRevisionEditor from '../src/renderer/src/components/workbench/office-revision/OfficeRevisionEditor'

function snapshot(kind: OfficeRevisionKind, bytes: Buffer) {
  return officeArtifactSnapshot({ record: { artifactId: 'fixture-artifact', kind, digest: officeBytesDigest(bytes), lineageId: 'fixture-lineage', version: 1 },
    bytes, latest: true, title: 'Isolated source fixture', scope: { projectId: 'fixture-project', workItemId: 'fixture-work' }, mediaType: '' } as ScopedOfficeArtifact)
}
let passed = 0
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); passed++; console.log(`PASS ${name}`) }

async function main() {
  const deck = new PptxGenJS()
  const first = deck.addSlide()
  first.addText('Unselected original page', { x: 1, y: 1, w: 7, h: 1, color: '003366' })
  const second = deck.addSlide()
  second.addText([{ text: 'Revenue ', options: { bold: true } }, { text: '2026 🧪 & source', options: { color: 'DD2200', italic: true } }], { x: 1, y: 1, w: 7, h: 1, fontSize: 20 })
  second.addText('Line one\nLine two', { x: 1, y: 3, w: 7, h: 2, fontSize: 15 })
  second.addTable([['Protected table content', '42']], { x: 1, y: 5, w: 6, h: 1 })
  let bytes = Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Buffer)
  const originalParts = readOfficePackage(bytes)
  // Display order intentionally differs from the filenames.
  const presentation = originalParts.get('ppt/presentation.xml')!.toString()
  const slideIds = presentation.match(/<p:sldId\b[^>]*\/>/g)!
  originalParts.set('ppt/presentation.xml', Buffer.from(presentation.replace(slideIds[0], '__FIRST_SLIDE__').replace(slideIds[1], slideIds[0]).replace('__FIRST_SLIDE__', slideIds[1])))
  bytes = await writeOfficePackage(originalParts)
  const source = snapshot('presentation', bytes)
  const target = source.slideTexts!.find((text) => text.text.includes('Revenue'))!
  assert(target, 'real PptxGenJS text box must be listed')
  assert(target.editable, target.reason)
  const operation = slideTextRevision(source, target.slideId, target.shapeId, 'Revenue actual 2026 🧪 & <verified source>')
  const generated = await generateOfficeRevision('presentation', bytes, [operation])

  await check('PowerPoint uses presentation page order and explicit text box identity', () => {
    assert.equal(source.slides!.find((slide) => slide.id === target.slideId)!.index, 0)
    assert.equal(source.coverage.complete, true)
    assert.equal(source.coverage.slideCount, 2)
    assert.equal(generated.changes[0].before, target.text)
    assert.equal(generated.changes[0].after, 'Revenue actual 2026 🧪 & <verified source>')
    assert.notDeepEqual(generated.bytes, bytes)
    assert.equal(snapshot('presentation', generated.bytes).slideTexts!.find((text) => text.shapeId === target.shapeId && text.slideId === target.slideId)!.text, generated.changes[0].after)
  })
  await check('renderer exposes the actual page/text box selection and frozen text replacement', () => {
    const html = renderToStaticMarkup(createElement(OfficeRevisionEditor, { snapshot: source, busy: false, onChange() {}, async onPreview() {} }))
    assert.ok(html.includes('data-office-slide-text-select'))
    assert.ok(html.includes('第 1 页'))
    assert.ok(html.includes('Revenue'))
    assert.ok(html.includes('预览修改'))
  })
  await check('only selected text bytes change; all other slides, table, styles and relationships remain identical', () => {
    const after = readOfficePackage(generated.bytes)
    assert.deepEqual([...after.keys()], [...originalParts.keys()])
    const changed = [...after.keys()].filter((part) => !after.get(part)!.equals(originalParts.get(part)!))
    assert.deepEqual(changed, ['ppt/slides/slide2.xml'])
    const originalXml = originalParts.get(changed[0])!.toString(), outputXml = after.get(changed[0])!.toString()
    const withoutText = (xml: string) => xml.replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)/g, '$1$2')
    assert.equal(withoutText(outputXml), withoutText(originalXml))
    assert.ok(outputXml.includes('Protected table content'))
    assert.ok(generated.checks.some((item) => item.id === 'unselected-content' && item.state === 'passed'))
    assert.ok(generated.checks.some((item) => item.id === 'semantic' && item.state === 'not_checked'))
  })
  await check('frozen regeneration is deterministic and rejects stale digest, wrong shape/page, wrong kind and broad operations', async () => {
    assert.deepEqual((await generateOfficeRevision('presentation', bytes, [operation])).bytes, generated.bytes)
    const malformed = [
      { ...operation, expectedNodeDigest: `sha256:${'0'.repeat(64)}` },
      { ...operation, shapeId: 'shape:9999' }, { ...operation, slideId: 'slide:9999' }
    ]
    for (const op of malformed) await assert.rejects(generateOfficeRevision('presentation', bytes, [op as OfficeRevisionOperation]), /SELECTION_STALE/)
    await assert.rejects(generateOfficeRevision('presentation', bytes, [{ kind: 'replaceParagraphText', paragraphId: 'paragraph:1', expectedNodeDigest: target.nodeDigest, text: 'wrong' }]), /PLAN_MISMATCH/)
    await assert.rejects(generateOfficeRevision('document', bytes, [operation]), /UNSUPPORTED_STRUCTURE/)
    assert.throws(() => normalizeOfficeDraft({ baseArtifactId: 'fixture', expectedDigest: source.artifact.digest, operations: [{...operation, path: '/arbitrary.xml'}] }), /PLAN_MISMATCH/)
    await assert.rejects(generateOfficeRevision('presentation', bytes, [operation, { ...operation, shapeId: 'shape:9999' } as OfficeRevisionOperation]), /一个文本框/)
  })
  await check('paragraph boundaries, mixed runs, emoji and literal XML characters survive', async () => {
    const multiline = source.slideTexts!.find((text) => text.text.includes('Line one'))!
    assert(multiline.editable, multiline.reason)
    const update = slideTextRevision(source, multiline.slideId, multiline.shapeId, 'Line one verified\nLine two 🧪 <quoted> & sourced')
    const result = snapshot('presentation', (await generateOfficeRevision('presentation', bytes, [update])).bytes)
    assert.equal(result.slideTexts!.find((text) => text.slideId === multiline.slideId && text.shapeId === multiline.shapeId)!.text, 'Line one verified\nLine two 🧪 <quoted> & sourced')
    assert.throws(() => slideTextRevision(source, multiline.slideId, multiline.shapeId, 'flattened'), /段落数量/)
    await assert.rejects(generateOfficeRevision('presentation', bytes, [{...update, text: 'flattened'} as OfficeRevisionOperation]), /段落数量/)
  })
  await check('ambiguous slide relationships, duplicate shape identities and outside targets fail closed', async () => {
    const corrupt = async (name: string, transform: (text: string) => string) => {
      const parts = new Map(originalParts)
      parts.set(name, Buffer.from(transform(parts.get(name)!.toString())))
      assert.throws(() => inspectPresentationPackage(parts), /UNSUPPORTED_STRUCTURE/)
    }
    await corrupt('ppt/_rels/presentation.xml.rels', (xml) => xml.replace('Target="slides/slide2.xml"', 'Target="../../outside.xml"'))
    await corrupt('ppt/slides/slide2.xml', (xml) => xml.replace(/(<p:cNvPr id=")[0-9]+(" name="Text 0")/, (_match, begin, end) => `${begin}999${end}`).replace(/(<p:cNvPr id=")[0-9]+(" name="Text 1")/, (_match, begin, end) => `${begin}999${end}`))
  })

  const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun({ text: 'Original paragraph', bold: true })] }), new Paragraph('Untouched paragraph')] }] }))
  await check('existing Word parser is connected to actual bytes with untouched paragraph and styles preserved', async () => {
    const doc = snapshot('document', word), p = doc.paragraphs.find((item) => item.text === 'Original paragraph')!
    assert.equal(doc.coverage.complete, true); assert.equal(p.editable, true)
    const output = await generateOfficeRevision('document', word, [{ kind: 'replaceParagraphText', paragraphId: p.id, expectedNodeDigest: p.nodeDigest, text: 'Revised paragraph' }])
    assert.equal(snapshot('document', output.bytes).paragraphs[0].text, 'Revised paragraph')
    assert.equal(snapshot('document', output.bytes).paragraphs[1].text, 'Untouched paragraph')
    assert.notDeepEqual(output.bytes, word)
  })
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Revenue')
  sheet.getCell('A1').value = 'Revenue'; sheet.getCell('B1').value = 100; sheet.getCell('B1').font = { bold: true }
  sheet.getCell('C1').value = { formula: 'B1*2', result: 200 }
  const workbook = Buffer.from(await book.xlsx.writeBuffer())
  await check('existing Excel parser updates literal cells while preserving formula cache and style', async () => {
    const source = snapshot('spreadsheet', workbook), cell = source.cells.find((item) => item.address === 'B1')!
    const formula = source.cells.find((item) => item.address === 'C1')!
    assert.equal(source.coverage.complete, true); assert.equal(formula.editable, false)
    const output = await generateOfficeRevision('spreadsheet', workbook, [{ kind: 'setCellValue', sheetId: cell.sheetId, address: cell.address, expectedNodeDigest: cell.nodeDigest, value: 150 }])
    const updated = snapshot('spreadsheet', output.bytes)
    assert.equal(updated.cells.find((item) => item.address === 'B1')!.value, 150)
    assert.deepEqual(updated.cells.find((item) => item.address === 'C1'), formula)
    await assert.rejects(generateOfficeRevision('spreadsheet', workbook, [{ kind: 'setCellValue', sheetId: formula.sheetId, address: formula.address, expectedNodeDigest: formula.nodeDigest, value: 1 }]), /UNSUPPORTED_STRUCTURE/)
  })
  console.log(`Office local revision passed (${passed} focused checks, no Provider calls).`)
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
