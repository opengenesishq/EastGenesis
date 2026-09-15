import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'
import { PREPARATION_WRITE_TOOLS } from '../src/shared/preparation-permission-types'
import type { ProjectPreparationSlice } from '../src/shared/preparation-portability-types'
import { buildOfficeArtifactEffectTarget, executeOfficeArtifactTool } from '../src/main/agent/tools/office-artifact'
import { PreparationPermissionStore } from '../src/main/permission/preparation-permission-store'
import { preparationPaths } from '../src/main/data-lifecycle/preparation-data-files'
import { collectProjectPreparation, importProjectPreparation, verifyProjectPreparation } from '../src/main/data-lifecycle/preparation-portability'
import { assertPreparationFileContent } from '../src/main/data-lifecycle/preparation-file-content'
import { projectAggregateDigest } from '../src/main/project-aggregate/codec'
import { OFFICE_PACKAGE_LIMITS, readOfficePackage, writeOfficePackage } from '../src/main/office-revision/package'

const roots: string[] = []
function root() { const value = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-prep-office-'))); roots.push(value); return value }
const projectId = 'prep-office', sessionId = randomUUID()
let passed = 0
async function check(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`PASS ${name}`) }
function metaAt(directory: string): SessionMeta {
  const cwd = join(directory, 'formal'); mkdirSync(cwd, { recursive: true })
  return { id: sessionId, createdAt: 1, workspaceId: projectId, goalId: 'goal-office', workItemId: 'work-office',
    cwd, status: 'idle', taskStrategy: 'plan' } as SessionMeta
}
const formats = ['docx', 'xlsx', 'pptx', 'pdf'] as const
async function generate(directory: string, extension: typeof formats[number], text: string): Promise<Buffer> {
  const tool = { docx: 'create_document', xlsx: 'create_spreadsheet', pptx: 'create_presentation', pdf: 'create_pdf' }[extension]
  const input = { path: `客户汇报.${extension}`, title: '客户汇报 Office draft',
    ...(extension === 'docx' ? { paragraphs: [text] } : extension === 'xlsx' ? { sheets: [{ name: 'Metrics', rows: [['结果'], [text]] }] } :
      extension === 'pptx' ? { slides: [{ title: '汇报', body: text }] } : { sections: [{ heading: '结果', paragraphs: [text] }] }) }
  const target = await buildOfficeArtifactEffectTarget(tool, input, directory)
  await executeOfficeArtifactTool(tool, input, directory, target)
  return readFileSync(join(directory, input.path))
}
function changeFile(slice: ProjectPreparationSlice, path: string, bytes: Buffer): ProjectPreparationSlice {
  const value = structuredClone(slice)
  value.sessions[0].files = [{ path, encoding: 'base64', data: bytes.toString('base64'), sizeBytes: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }]
  const { sliceDigest: _, ...body } = value; value.sliceDigest = projectAggregateDigest(body)
  return value
}
async function main() {
  const source = root(), meta = metaAt(source), permissions = new PreparationPermissionStore(source)
  const grant = permissions.grant(meta, { expectedRevision: 0, allowedWriteTools: PREPARATION_WRITE_TOOLS }, 'local-user:test')
  const fixtures = new Map<string, Buffer>()
  for (const extension of formats) fixtures.set(extension, await generate(grant.directory!, extension, '客户汇报数据已核对。Source confirmed, six pages.'))
  const context = { sessionIds: [sessionId], sessionHistory: [{ meta }], activeSessions: [], sessionCreationJournal: [] }
  let slice: ProjectPreparationSlice
  await check('four actual Office writers export and restore exact bytes with a revoked destination grant', () => {
    slice = collectProjectPreparation(source, projectId, context)
    assert.equal(slice.sessions[0].files.length, 4)
    const target = root(), targetMeta = metaAt(target)
    importProjectPreparation(target, projectId, slice, context)
    verifyProjectPreparation(target, projectId, slice, context)
    const restored = new PreparationPermissionStore(target).get(targetMeta)
    assert.equal(restored.status, 'revoked'); assert.equal(restored.available, false)
    assert.equal(restored.revision, grant.revision + 1)
    for (const extension of formats) assert.deepEqual(readFileSync(join(restored.directory!, `客户汇报.${extension}`)), fixtures.get(extension))
    const record = JSON.parse(readFileSync(preparationPaths(target, sessionId).permission, 'utf8'))
    assert.equal(record.importedNeedsReauthorization, true)
    assert.deepEqual(record.allowedWriteTools, PREPARATION_WRITE_TOOLS)
    assert.throws(() => new PreparationPermissionStore(target).assertWritable(targetMeta, restored.revision, restored.directory!, 'create_document'), /撤销/)
    importProjectPreparation(target, projectId, slice, context)
    assert.equal(new PreparationPermissionStore(target).get(targetMeta).revision, restored.revision)
    const targetPermissions = new PreparationPermissionStore(target)
    const textOnly = targetPermissions.grant(targetMeta, { expectedRevision: restored.revision }, 'local-user:explicit-text-grant')
    assert.deepEqual(textOnly.allowedWriteTools, ['write_file'])
    targetPermissions.assertWritable(targetMeta, textOnly.revision, textOnly.directory!)
    assert.throws(() => targetPermissions.assertWritable(targetMeta, textOnly.revision, textOnly.directory!, 'create_document'), /范围/)
  })
  const rejectsBeforeWriting = (value: ProjectPreparationSlice) => {
    const target = root()
    assert.throws(() => importProjectPreparation(target, projectId, value, context))
    assert(!existsSync(join(target, 'private')))
    assert(!existsSync(join(target, 'preparation-drafts')))
  }
  await check('mismatched, truncated and arbitrary binary files are rejected before any destination writes', () => {
    for (const extension of formats) {
      const bytes = fixtures.get(extension)!
      rejectsBeforeWriting(changeFile(slice!, `draft.${extension === 'pdf' ? 'docx' : 'pdf'}`, bytes))
      rejectsBeforeWriting(changeFile(slice!, `draft.${extension}`, bytes.subarray(0, bytes.length - 24)))
      rejectsBeforeWriting(changeFile(slice!, 'disguised.txt', bytes))
    }
    rejectsBeforeWriting(changeFile(slice!, 'opaque.bin', Buffer.from([0xff, 0, 0xfe, 0])))
    rejectsBeforeWriting(changeFile(slice!, 'fake.docx', Buffer.from('not an Office document')))
    rejectsBeforeWriting(changeFile(slice!, 'fake.pdf', Buffer.from('%PDF-1.3\n%%EOF')))
  })
  await check('compressed Office text and PDF font-mapped credentials cannot leave the preparation area', async () => {
    const sensitive = `Bearer ${'synthetic'.repeat(4)}`
    for (const extension of formats) {
      const bytes = await generate(root(), extension, sensitive)
      rejectsBeforeWriting(changeFile(slice!, `draft.${extension}`, bytes))
      assert.throws(() => assertPreparationFileContent(`draft.${extension}`, bytes), /credential/i)
    }
  })
  await check('OOXML credentials split across formatting and escaped characters are decoded before scanning', async () => {
    const parts = readOfficePackage(fixtures.get('docx')!)
    const xml = parts.get('word/document.xml')!.toString('utf8')
    parts.set('word/document.xml', Buffer.from(xml.replace('Source confirmed, six pages.', 'Bearer &#115;ynthetic<w:r><w:t>syntheticsyntheticsynthetic</w:t></w:r>')))
    const bytes = await writeOfficePackage(parts)
    rejectsBeforeWriting(changeFile(slice!, 'split.docx', bytes))
  })
  await check('wrong OOXML content types and unsupported embedded parts cannot be disguised as a draft', async () => {
    const parts = readOfficePackage(fixtures.get('docx')!)
    parts.set('[Content_Types].xml', Buffer.from(parts.get('[Content_Types].xml')!.toString('utf8').replace('wordprocessingml.document.main+xml', 'spreadsheetml.sheet.main+xml')))
    rejectsBeforeWriting(changeFile(slice!, 'wrong.docx', await writeOfficePackage(parts)))
    const opaque = readOfficePackage(fixtures.get('docx')!)
    opaque.set('word/embeddings/opaque.bin', Buffer.from([0xff, 0xfe, 0, 4]))
    rejectsBeforeWriting(changeFile(slice!, 'embedded.docx', await writeOfficePackage(opaque)))
  })
  await check('container expansion limits and the original total file limit remain enforced', () => {
    const oversized = Buffer.from(fixtures.get('docx')!)
    const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    assert(central >= 0); oversized.writeUInt32LE(OFFICE_PACKAGE_LIMITS.expandedBytes + 1, central + 24)
    rejectsBeforeWriting(changeFile(slice!, 'oversized.docx', oversized))
    const many = changeFile(slice!, 'empty.txt', Buffer.alloc(0))
    many.sessions[0].files = Array.from({ length: 2001 }, (_, index) => ({ ...many.sessions[0].files[0], path: `${index}.txt` }))
    const { sliceDigest: _, ...body } = many; many.sliceDigest = projectAggregateDigest(body)
    rejectsBeforeWriting(many)
  })
  await check('UTF-8 drafts retain credential checks and Unicode support', () => {
    assertPreparationFileContent('客户汇报.md', Buffer.from('客户汇报草稿。😀'))
    assert.throws(() => assertPreparationFileContent('notes.md', Buffer.from(`Bearer ${'synthetic'.repeat(4)}`)), /credential/i)
  })
  console.log(`Preparation Office portability: ${passed}/${passed} passed`)
}
main().finally(() => { for (const directory of roots) rmSync(directory, { recursive: true, force: true }) }).catch(error => { console.error(error); process.exitCode = 1 })
