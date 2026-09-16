import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import PptxGenJS from 'pptxgenjs'
import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import { checkOfficeDeliveryRequirements } from '../src/main/task/office-delivery-requirements'
import { readOfficePackage, writeOfficePackage } from '../src/main/office-revision/package'

const binding = { acceptanceId: 'original-acceptance', acceptanceRevision: 1, criteriaDigest: 'fixture' }
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
async function deck(count: number, text = 'Verified product details'): Promise<Buffer> {
  const file = new PptxGenJS()
  for (let i = 0; i < count; i++) file.addSlide().addText(text, { x: 1, y: 1, w: 8, h: 1 })
  return Buffer.from(await file.write({ outputType: 'nodebuffer' }) as Buffer)
}
const inspect = (bytes: Buffer, kind: 'presentation' | 'document' | 'spreadsheet' | 'pdf', criteria: string[]) =>
  checkOfficeDeliveryRequirements({ workspacePath: '/unused', bytes, kind, expectedDigest: digest(bytes), sourceRefs: [], criteria, binding })
let count = 0
function pass(name: string) { console.log(`PASS ${name}`); count++ }

async function main() {
  const six = await deck(6), seven = await deck(7)
  let report = await inspect(seven, 'presentation', ['输出 PPTX，控制在六页', '控制在六页'])
  assert.equal(report.checks.filter(check => check.requirement.kind === 'page_count').length, 1)
  assert.equal(report.checks.find(check => check.requirement.kind === 'page_count')?.status, 'failed')
  assert.equal(report.checks.find(check => check.requirement.kind === 'page_count')?.actualPageCount, 7)
  assert.equal(report.checks.find(check => check.requirement.kind === 'format')?.status, 'passed')
  assert.equal(report.finalUserAcceptance, false)
  pass('actual seven-slide PPTX fails the explicit six-page requirement while its format passes')

  report = await inspect(six, 'presentation', ['输出 PPTX，控制在六页'])
  assert.ok(report.checks.every(check => check.status === 'passed'))
  pass('six real slide relationships satisfy the original lte bound')

  const parts = readOfficePackage(seven)
  parts.set('ppt/presentation.xml', Buffer.from(parts.get('ppt/presentation.xml')!.toString().replace(/<p:sldId id="[^"]+" r:id="[^"]+"\/>/, '')))
  report = await inspect(await writeOfficePackage(parts), 'presentation', ['输出 PPTX，控制在六页'])
  assert.equal(report.checks.find(check => check.requirement.kind === 'page_count')?.actualPageCount, 6)
  pass('orphan ZIP slide files do not count as pages outside the presentation relationship tree')

  report = await checkOfficeDeliveryRequirements({ workspacePath: '/unused', bytes: seven, kind: 'presentation',
    expectedDigest: digest(six), sourceRefs: [], criteria: ['控制在六页'], binding })
  assert.equal(report.checks[0].status, 'unverified')
  pass('changed bytes cannot produce a passing check for the original Artifact digest')

  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Data').addRow(['Revenue', 42])
  report = await inspect(Buffer.from(await workbook.xlsx.writeBuffer()), 'spreadsheet', ['输出 PPTX，控制在六页'])
  assert.equal(report.checks.find(check => check.requirement.kind === 'page_count')?.status, 'not_applicable')
  assert.equal(report.checks.find(check => check.requirement.kind === 'format')?.status, 'unverified')
  pass('auxiliary spreadsheet avoids unrelated page rules while the missing presentation format stays open')

  const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Report')] }] }))
  report = await inspect(word, 'document', ['输出 DOCX，控制在六页'])
  assert.equal(report.checks.find(check => check.requirement.kind === 'format')?.status, 'passed')
  assert.equal(report.checks.find(check => check.requirement.kind === 'page_count')?.status, 'unverified')
  pass('DOCX structure is checked but cached page metadata cannot certify rendered page count')

  report = await inspect(Buffer.from('%PDF-1.7\n%%EOF'), 'pdf', ['输出 PDF，控制在六页'])
  assert.ok(report.checks.every(check => check.status === 'unverified'))
  pass('PDF headers cannot substitute for a parsed page tree')

  report = await inspect(six, 'presentation', ['输出 PPTX，注明来源'])
  assert.equal(report.checks.find(check => check.requirement.kind === 'sources')?.status, 'unverified')
  report = await inspect(await deck(1, '来源：https://example.org/report'), 'presentation', ['输出 PPTX，注明来源'])
  assert.equal(report.checks.find(check => check.requirement.kind === 'sources')?.status, 'unverified')
  assert.ok((report.checks.find(check => check.requirement.kind === 'sources')?.referenceCount ?? 0) > 0)
  pass('unverified or visible references cannot certify factual support without checking their evidence')

  report = await inspect(six, 'presentation', ['输出 PPTX 和输出 PDF，控制在六页'])
  assert.equal(report.checks.find(check => check.requirement.kind === 'page_count')?.status, 'unverified')
  pass('ambiguous page constraints across multiple output formats remain unverified')

  console.log(`Office delivery requirement checks: ${count}/${count} passed; no Provider calls.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
