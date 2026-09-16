import assert from 'node:assert/strict'
import PptxGenJS from 'pptxgenjs'
import { writeFileSync } from 'node:fs'
import { generateOfficeRevision, officeArtifactSnapshot } from '../src/main/office-revision/inspection'
import { inspectPresentationPackage } from '../src/main/office-revision/presentation'
import { readOfficePackage, writeOfficePackage } from '../src/main/office-revision/package'
import { officeBytesDigest } from '../src/main/office-revision/digest'
import type { ScopedOfficeArtifact } from '../src/main/office-revision/scope'
import type { OfficeRevisionOperation } from '../src/shared/office-revision-types'

function snapshot(bytes: Buffer) {
  return officeArtifactSnapshot({ bytes, latest: true, title: 'Original client deck', scope: { projectId: 'project', workItemId: 'work' },
    record: { artifactId: 'artifact', digest: officeBytesDigest(bytes), kind: 'presentation', lineageId: 'lineage', version: 1 } } as ScopedOfficeArtifact)
}
async function main() {
  const deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE'
  for (let page = 1; page <= 6; page++) {
    const slide = deck.addSlide()
    slide.addText(`Manually authored page ${page}`, { x: 1, y: 1, w: 9, h: 1, color: '135E96', bold: true })
    slide.addNotes(`Private page ${page} speaker notes`)
    if (page === 2) slide.addTable([['Keep this table', '42']], { x: 1, y: 3, w: 6 })
  }
  const bytes = Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Buffer)
  const original = readOfficePackage(bytes), originalSnapshot = snapshot(bytes)
  const operation: OfficeRevisionOperation = { kind: 'setSlideSequence', expectedNodeDigest: originalSnapshot.slideSequence!.nodeDigest,
    slides: [...originalSnapshot.slides!.map(slide => ({ slideId: slide.id })),
      { title: '补充来源 & <说明>', body: '数据来源：年度报告\n保留先前结论' }, { title: '下一步', body: '客户行动与时间安排' }] }
  const expanded = await generateOfficeRevision('presentation', bytes, [operation])
  const expandedParts = readOfficePackage(expanded.bytes), expandedSnapshot = snapshot(expanded.bytes)
  assert.equal(expandedSnapshot.slides!.length, 8)
  for (const [part, content] of original) {
    if (['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', '[Content_Types].xml', 'docProps/app.xml'].includes(part)) continue
    assert.deepEqual(expandedParts.get(part), content, `original part preserved: ${part}`)
  }
  assert(expandedSnapshot.slideTexts!.some(text => text.text === '数据来源：年度报告\n保留先前结论'))
  assert(expandedSnapshot.slideTexts!.some(text => text.text === '补充来源 & <说明>'))
  assert.deepEqual((await generateOfficeRevision('presentation', bytes, [operation])).bytes, expanded.bytes)
  console.log('PASS six-to-eight pages preserves original page XML, notes, table, shared styles and deterministic new content')
  const ids = expandedSnapshot.slides!.map(slide => slide.id)
  const shrink: OfficeRevisionOperation = { kind: 'setSlideSequence', expectedNodeDigest: expandedSnapshot.slideSequence!.nodeDigest,
    slides: [ids[7], ids[1], ids[2], ids[3], ids[4], ids[6]].map(slideId => ({ slideId })) }
  const shrunk = await generateOfficeRevision('presentation', expanded.bytes, [shrink])
  const shrunkParts = readOfficePackage(shrunk.bytes), inspected = inspectPresentationPackage(shrunkParts)
  assert.deepEqual(inspected.slides.map(slide => slide.id), shrink.slides.map(slide => 'slideId' in slide ? slide.slideId : ''))
  assert.equal(shrunkParts.has('ppt/slides/slide1.xml'), false)
  assert.equal(shrunkParts.has('ppt/slides/slide6.xml'), false)
  assert.equal(shrunkParts.has('ppt/notesSlides/notesSlide1.xml'), false)
  assert.equal(shrunkParts.has('ppt/notesSlides/_rels/notesSlide6.xml.rels'), false)
  assert.deepEqual(shrunkParts.get('ppt/notesSlides/notesSlide2.xml'), original.get('ppt/notesSlides/notesSlide2.xml'))
  assert.deepEqual(shrunkParts.get('ppt/slides/slide2.xml'), original.get('ppt/slides/slide2.xml'))
  console.log('PASS eight-to-six pages changes exact order and removes only deleted-page parts and speaker notes')
  await assert.rejects(generateOfficeRevision('presentation', expanded.bytes, [{ ...shrink, expectedNodeDigest: operation.expectedNodeDigest }]), /SELECTION_STALE/)
  await assert.rejects(generateOfficeRevision('presentation', bytes, [{ ...operation, slides: [{ slideId: 'slide:99999' }] }]), /SELECTION_STALE/)
  await assert.rejects(generateOfficeRevision('presentation', bytes, [{ ...operation, slides: [] }]), /PLAN_MISMATCH/)
  await assert.rejects(generateOfficeRevision('presentation', bytes, [{ ...operation, slides: [{ slideId: originalSnapshot.slides![0].id }, { slideId: originalSnapshot.slides![0].id }] }]), /PLAN_MISMATCH/)
  const linked = new Map(original)
  const relationship = 'ppt/slides/_rels/slide2.xml.rels'
  linked.set(relationship, Buffer.from(linked.get(relationship)!.toString().replace('</Relationships>', '<Relationship Id="rIdOtherSlide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide1.xml"/></Relationships>')))
  const linkedBytes = await writeOfficePackage(linked)
  await assert.rejects(generateOfficeRevision('presentation', linkedBytes, [{ kind: 'setSlideSequence',
    expectedNodeDigest: snapshot(linkedBytes).slideSequence!.nodeDigest, slides: originalSnapshot.slides!.slice(1).map(slide => ({ slideId: slide.id })) }]), /仍引用/)
  console.log('PASS stale list, missing slide, empty/duplicate sequence and retained-page references reject before output')
  if (process.env.CAOGEN_PPT_SEQUENCE_SAMPLE) writeFileSync(process.env.CAOGEN_PPT_SEQUENCE_SAMPLE, shrunk.bytes)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
