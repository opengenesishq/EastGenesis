import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageCanvasService, validateImageCanvasAnnotation, type ImageCanvasContext } from '../src/main/image-canvas/image-canvas-service'
import { prepareImageAttachmentBytes, persistPreparedImageAttachment, sessionImageAttachmentsRoot } from '../src/main/attachmentOps'
import { imageCanvasDraftAddition, normalizedImageBox } from '../src/renderer/src/components/image-canvas/image-canvas-model'
import { projectUserMessageImageAttachments, imageAttachmentReferenceHash } from '../src/shared/attachment-types'
import type { StudioResultArtifact } from '../src/shared/studio-result-types'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-image-canvas-')))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD3sAAAAASUVORK5CYII='
const prepared = prepareImageAttachmentBytes(png, { mime: 'image/png' })
let passed = 0
async function check(name: string, run: (service: ImageCanvasService, context: ImageCanvasContext, folder: string, writes: { count: number }) => Promise<void>) {
  const folder = join(root, `case-${passed}`), writes = { count: 0 }
  const saved = await persistPreparedImageAttachment(prepared, sessionImageAttachmentsRoot(folder, 'task-1'))
  assert(saved.ok)
  const context: ImageCanvasContext = { meta: { id: 'task-1', createdAt: 1, cwd: folder, status: 'idle', sdkSessionId: 'sdk-1', workspaceId: 'project-1', goalId: 'goal-1', workItemId: 'work-1' }, transcript: [{ seq: 1, event: { kind: 'user-message', text: 'reference', attachments: projectUserMessageImageAttachments([saved]) } }], artifacts: [], runs: [] }
  const service = new ImageCanvasService(folder, {
    load: async () => structuredClone(context),
    stage: async (meta, value) => { writes.count++; const saved = await persistPreparedImageAttachment(value, sessionImageAttachmentsRoot(folder, meta.id)); assert(saved.ok); return saved },
    preview: value => ({ dataUrl: `data:${value.mime};base64,${value.data.toString('base64')}`, width: 1, height: 1 })
  })
  await run(service, context, folder, writes)
  console.log(`PASS ${name}`); passed++
}
function artifact(path: string, workItemId = 'work-1'): StudioResultArtifact {
  return { id: 'artifact-1', workItemId, title: 'Produced image', kind: 'file', version: 3, digest: `sha256:${prepared.hash}`, mediaType: 'image/png', deliveryCategory: 'media', deliveryStatus: 'ready', currentArtifactIds: ['artifact-1'], deliveryScope: 'current', createdAt: 1, updatedAt: 1, locations: [{ id: 'location-1', kind: 'local_file', availability: 'available', path, checksum: `sha256:${prepared.hash}`, sizeBytes: prepared.bytes }], inboundRelations: 0, outboundRelations: 0, evidenceIds: [], acceptanceIds: [] } as StudioResultArtifact
}
async function main() {
  await check('transcript image hydrates from trusted content object and stages a real attachment', async (service, _context, folder, writes) => {
    const collection = await service.list(1, 'task-1'), id = collection.images[0].id
    assert.equal(collection.images[0].attachmentId, prepared.hash)
    assert.deepEqual(projectUserMessageImageAttachments([{ id: prepared.hash, hash: prepared.hash, mime: prepared.mime, bytes: prepared.bytes }]), [{ id: prepared.hash, hash: prepared.hash, mime: prepared.mime, bytes: prepared.bytes }])
    const preview = await service.read(1, 'task-1', collection.collectionId, id)
    assert.equal(preview.dataUrl, `data:image/png;base64,${png}`)
    const draft = await service.draft(1, 'task-1', collection.collectionId, [id])
    assert.equal(draft.images[0].hash, prepared.hash)
    assert.equal(draft.images[0].path, join(sessionImageAttachmentsRoot(folder, 'task-1'), `${prepared.hash}.png`))
    assert.equal(writes.count, 0)
    const addition = imageCanvasDraftAddition(draft, 'Make it blue', {}, true)
    assert.equal(addition.payload.images?.[0].path, draft.images[0].path)
    assert.match(addition.payload.text, /Make it blue/)
  })
  await check('cross-window, cross-task and fabricated image IDs cannot read files', async service => {
    const collection = await service.list(1, 'task-1'), id = collection.images[0].id
    await assert.rejects(service.read(2, 'task-1', collection.collectionId, id), /不属于/)
    await assert.rejects(service.read(1, 'task-2', collection.collectionId, id), /不属于/)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, 'f'.repeat(64)), /来源/)
  })
  await check('canonical task rebinding invalidates reads and draft staging', async (service, context) => {
    const collection = await service.list(1, 'task-1'); context.meta.workItemId = 'different-work'
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.images[0].id), /归属/)
    await assert.rejects(service.draft(1, 'task-1', collection.collectionId, [collection.images[0].id]), /归属/)
  })
  await check('tampered and missing attachment bytes fail instead of creating fake attachments', async (service, _context, folder) => {
    const collection = await service.list(1, 'task-1'), id = collection.images[0].id
    const path = join(sessionImageAttachmentsRoot(folder, 'task-1'), `${prepared.hash}.png`), modified = Buffer.from(prepared.data)
    modified[modified.length - 1] ^= 1; writeFileSync(path, modified)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, id), /摘要/)
    rmSync(path); await assert.rejects(service.draft(1, 'task-1', collection.collectionId, [id]))
  })
  await check('same project does not expose another task artifact', async (service, context, folder) => {
    const path = join(folder, 'result.png'); writeFileSync(path, prepared.data)
    context.artifacts = [artifact(path, 'other-work')]
    assert.equal((await service.list(1, 'task-1')).images.length, 1)
  })
  await check('artifact version and original file reference survive real attachment staging', async (service, context, folder, writes) => {
    const path = join(folder, 'result.png'); writeFileSync(path, prepared.data); context.artifacts = [artifact(path)]
    const collection = await service.list(1, 'task-1'), item = collection.images.find(image => image.source === 'artifact')!
    const draft = await service.draft(1, 'task-1', collection.collectionId, [item.id])
    assert.equal(writes.count, 1); assert.equal(draft.references[0].version, 3); assert.equal(draft.references[0].sourcePath, path)
    assert.deepEqual(readFileSync(draft.images[0].path), prepared.data)
    context.artifacts[0].version = 4
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, item.id), /版本/)
  })
  await check('changed artifact bytes and symbolic links are rejected', async (service, context, folder) => {
    const path = join(folder, 'result.png'); writeFileSync(path, prepared.data); context.artifacts = [artifact(path)]
    const collection = await service.list(1, 'task-1'), item = collection.images.find(image => image.source === 'artifact')!
    const changed = Buffer.from(prepared.data); changed[changed.length - 1] ^= 1; writeFileSync(path, changed)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, item.id), /内容已变化/)
    const original = join(folder, 'original.png'); writeFileSync(original, prepared.data); rmSync(path); symlinkSync(original, path)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, item.id), /符号链接/)
  })
  await check('normalized regions persist with the exact image version and become draft instructions', async service => {
    const collection = await service.list(1, 'task-1'), id = collection.images[0].id
    const box = normalizedImageBox({ x: .8, y: .7 }, { x: .2, y: .1 })
    const note = await service.annotate(1, 'task-1', collection.collectionId, id, { note: 'Change heading', boundingBox: box })
    const notes = await service.annotations(1, 'task-1', collection.collectionId, id)
    assert.deepEqual(notes[0].boundingBox, box); assert.match(notes[0].locator?.selector ?? '', new RegExp(id))
    const draft = await service.draft(1, 'task-1', collection.collectionId, [id])
    assert.match(imageCanvasDraftAddition(draft, '', { [id]: [note] }, true).payload.text, /x=20.0%/)
  })
  await check('invalid regions and missing instructions cannot be stored', async service => {
    for (const boundingBox of [{ x: -.1, y: 0, width: .2, height: .2 }, { x: .9, y: 0, width: .2, height: .2 }, { x: 0, y: 0, width: NaN, height: .2 }, { x: 0, y: 0, width: 0, height: .2 }]) assert.throws(() => validateImageCanvasAnnotation({ note: 'note', boundingBox }))
    assert.throws(() => validateImageCanvasAnnotation({ note: '  ' }))
    const collection = await service.list(1, 'task-1')
    await assert.rejects(service.draft(1, 'task-1', collection.collectionId, []), /1 至 16/)
  })
  await check('legacy arbitrary IDs without hashes remain visible but cannot be silently rebound', async (service, context) => {
    if (context.transcript[0].event.kind === 'user-message') { delete context.transcript[0].event.attachments![0].hash; context.transcript[0].event.attachments![0].id = 'legacy-arbitrary-id' }
    const collection = await service.list(1, 'task-1')
    assert.match(collection.images[0].unavailableReason ?? '', /内容摘要/)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.images[0].id), /内容摘要/)
  })
  await check('production-era content-addressed IDs recover missing hashes and still verify bytes', async (service, context, folder) => {
    if (context.transcript[0].event.kind === 'user-message') delete context.transcript[0].event.attachments![0].hash
    const collection = await service.list(1, 'task-1'), item = collection.images[0]
    assert.equal(item.unavailableReason, undefined)
    assert.equal((await service.read(1, 'task-1', collection.collectionId, item.id)).dataUrl, `data:image/png;base64,${png}`)
    const draft = await service.draft(1, 'task-1', collection.collectionId, [item.id])
    assert.equal(draft.images[0].hash, prepared.hash)
    const modified = Buffer.from(prepared.data); modified[modified.length - 1] ^= 1
    writeFileSync(join(sessionImageAttachmentsRoot(folder, 'task-1'), `${prepared.hash}.png`), modified)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, item.id), /摘要/)
  })
  await check('explicit malformed or contradictory hashes never fall back to the ID', async (service, context) => {
    assert.equal(imageAttachmentReferenceHash({ id: prepared.hash, hash: 'bad', mime: prepared.mime, bytes: prepared.bytes }), undefined)
    assert.equal(imageAttachmentReferenceHash({ id: prepared.hash, hash: 'f'.repeat(64), mime: prepared.mime, bytes: prepared.bytes }), undefined)
    if (context.transcript[0].event.kind === 'user-message') context.transcript[0].event.attachments![0].hash = 'bad'
    const collection = await service.list(1, 'task-1')
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.images[0].id), /内容摘要/)
  })
  await check('legacy digest IDs do not bypass recorded MIME or byte-count checks', async (service, context) => {
    if (context.transcript[0].event.kind === 'user-message') { delete context.transcript[0].event.attachments![0].hash; context.transcript[0].event.attachments![0].bytes++ }
    const collection = await service.list(1, 'task-1')
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.images[0].id), /大小/)
  })
  console.log(`image-canvas-boundary-required: ${passed}/${passed} passed (offline; no provider calls)`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => rmSync(root, { recursive: true, force: true }))
