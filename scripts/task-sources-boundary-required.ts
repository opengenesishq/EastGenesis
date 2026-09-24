import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StudioResultArtifact, StudioResultEvidence, StudioResultRun } from '../src/shared/studio-result-types'
import { TaskSourceService, registeredSources, type TaskSourceContext } from '../src/main/source-panel/task-source-service'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-task-sources-')))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD3sAAAAASUVORK5CYII=', 'base64')
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const doc = 'Only this task attachment', docHash = hash(doc), imageHash = hash(png)
let passed = 0
type Fixture = { service: TaskSourceService; context: TaskSourceContext; folder: string; document: string; image: string; output: string }
function artifact(output: string, workItemId = 'work-1'): StudioResultArtifact {
  return { id: 'artifact-1', workItemId, title: 'Result.txt', kind: 'file', version: 2, digest: `sha256:${hash('Output v2')}`,
    mediaType: 'text/plain', deliveryCategory: 'report', deliveryStatus: 'ready', currentArtifactIds: ['artifact-1'], deliveryScope: 'current', createdAt: 1, updatedAt: 2,
    locations: [{ id: 'location-1', kind: 'local_file', availability: 'available', path: output, checksum: `sha256:${hash('Output v2')}`, sizeBytes: 9 }],
    inboundRelations: 0, outboundRelations: 0, evidenceIds: ['source-1'], acceptanceIds: [] } as StudioResultArtifact
}
function evidence(): StudioResultEvidence {
  return { id: 'source-1', origin: 'workflow', kind: 'research_source', source: 'runtime', title: 'Recorded search result', summary: 'A search snippet', sourceContentKind: 'search_snippet',
    sourceUri: 'https://example.com/research', runId: 'run-1', observedAt: 1, verifier: 'runtime', contentDigest: `sha256:${hash('A search snippet')}` }
}
async function check(name: string, run: (fixture: Fixture) => Promise<void>) {
  const folder = join(root, `case-${passed}`), vault = join(folder, 'attachments', 'task-1'), documents = join(vault, 'documents', 'S2')
  mkdirSync(documents, { recursive: true })
  const image = join(vault, `${imageHash}.png`), document = join(documents, `${docHash}.txt`), output = join(folder, 'Result.txt')
  writeFileSync(image, png); writeFileSync(document, doc); writeFileSync(output, 'Output v2')
  const context: TaskSourceContext = { meta: { id: 'task-1', createdAt: 1, cwd: folder, status: 'idle', workspaceId: 'project-1', workItemId: 'work-1', goalId: 'goal-1' },
    transcript: [{ seq: 1, event: { kind: 'user-message', text: 'https://example.org/plain-link', attachments: [{ id: imageHash, hash: imageHash, mime: 'image/png', bytes: png.length }] } }],
    artifacts: [artifact(output)], runs: [{ id: 'run-1', sessionId: 'task-1', workItemId: 'work-1' } as StudioResultRun], evidence: [evidence()] }
  const service = new TaskSourceService(folder, async () => structuredClone(context))
  await run({ service, context, folder, document, image, output })
  console.log(`PASS ${name}`); passed++
}
async function main() {
  await check('task collection distinguishes sent, imported, artifact version and recorded snippet', async ({ service }) => {
    const collection = await service.list(1, 'task-1')
    assert.equal(collection.items.length, 4)
    assert.equal(collection.items.filter(item => item.provenance === 'message_attachment').length, 1)
    assert.equal(collection.items.filter(item => item.provenance === 'imported_attachment').length, 1)
    assert.equal(collection.items.find(item => item.kind === 'artifact')?.version, 2)
    assert.equal(collection.items.find(item => item.kind === 'research')?.sourceContentKind, 'search_snippet')
    assert.deepEqual(collection.memory, { task: true, project: true })
  })
  await check('attachment and output preview use verified original bytes', async ({ service }) => {
    const collection = await service.list(1, 'task-1')
    for (const item of collection.items.filter(item => item.kind !== 'research')) {
      const detail = await service.read(1, 'task-1', collection.collectionId, item.id)
      if (item.mime === 'image/png') assert.equal(detail.preview?.dataUrl, `data:image/png;base64,${png.toString('base64')}`)
      else assert.equal(detail.preview?.content, item.kind === 'artifact' ? 'Output v2' : doc)
    }
  })
  await check('cross-window, cross-task, fabricated collection and source IDs are rejected', async ({ service }) => {
    const collection = await service.list(1, 'task-1'), id = collection.items[0].id
    await assert.rejects(service.read(2, 'task-1', collection.collectionId, id), /不属于/)
    await assert.rejects(service.read(1, 'task-2', collection.collectionId, id), /不属于/)
    await assert.rejects(service.read(1, 'task-1', 'invented', id), /不属于/)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, 'f'.repeat(64)), /不属于/)
  })
  await check('project aggregate excludes other tasks and unbound ordinary links', async ({ service, context, output }) => {
    context.meta.workItemId = undefined
    context.artifacts = [artifact(output, 'other-work')]
    context.runs = [{ id: 'run-1', sessionId: 'another-session', workItemId: 'other-work' } as StudioResultRun]
    const collection = await service.list(1, 'task-1')
    assert.equal(collection.items.length, 2)
    assert(!collection.items.some(item => item.kind === 'artifact' || item.kind === 'research'))
    assert.equal(registeredSources({ ...context, evidence: [{ ...evidence(), kind: 'test_result', runId: undefined }] }).length, 0)
  })
  await check('canonical WorkItem sources survive same-work-item resumed Session', async ({ service, context }) => {
    context.runs[0].sessionId = 'previous-session'
    const collection = await service.list(1, 'task-1')
    assert.equal(collection.items.filter(item => item.kind === 'research').length, 1)
    assert.equal(collection.items.filter(item => item.kind === 'artifact').length, 1)
  })
  await check('rebinding task invalidates all old reads and URL resolution', async ({ service, context }) => {
    const collection = await service.list(1, 'task-1')
    context.meta.goalId = 'different-goal'
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.items[0].id), /归属/)
    await assert.rejects(service.url(1, 'task-1', collection.collectionId, collection.items.find(item => item.kind === 'research')!.id), /归属/)
  })
  await check('changed artifact versions and evidence metadata invalidate stale selection', async ({ service, context }) => {
    const collection = await service.list(1, 'task-1')
    context.artifacts[0].version = 3
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.items.find(item => item.kind === 'artifact')!.id), /版本/)
    context.evidence[0].sourceUri = 'https://example.com/changed'
    await assert.rejects(service.url(1, 'task-1', collection.collectionId, collection.items.find(item => item.kind === 'research')!.id), /版本/)
  })
  await check('tampered attachment and output bytes fail digest verification', async ({ service, document, output }) => {
    const collection = await service.list(1, 'task-1')
    writeFileSync(document, 'X'.repeat(Buffer.byteLength(doc)))
    writeFileSync(output, 'Output v3')
    for (const item of collection.items.filter(item => item.provenance === 'imported_attachment' || item.kind === 'artifact')) {
      await assert.rejects(service.read(1, 'task-1', collection.collectionId, item.id), /版本不一致/)
    }
  })
  await check('missing recorded attachment remains visible and cannot yield preview', async ({ service, image }) => {
    rmSync(image)
    const collection = await service.list(1, 'task-1'), item = collection.items.find(item => item.provenance === 'message_attachment')!
    assert.match(item.unavailableReason ?? '', /不存在/)
    assert.equal((await service.read(1, 'task-1', collection.collectionId, item.id)).preview, undefined)
  })
  await check('artifact symbolic links cannot authorize original-file preview', async ({ service, output, folder }) => {
    const collection = await service.list(1, 'task-1'), item = collection.items.find(item => item.kind === 'artifact')!
    const target = join(folder, 'alternate.txt'); writeFileSync(target, 'Output v2'); rmSync(output); symlinkSync(target, output)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, item.id), /符号链接/)
  })
  await check('attachment vault cannot escape through a symlinked document directory', async ({ service, folder, document }) => {
    const outside = join(folder, 'outside'); mkdirSync(outside); writeFileSync(join(outside, `${docHash}.txt`), doc)
    const directory = join(folder, 'attachments', 'task-1', 'documents', 'S2')
    rmSync(document); rmSync(directory, { recursive: true }); symlinkSync(outside, directory)
    const collection = await service.list(1, 'task-1')
    assert(!collection.items.some(item => item.provenance === 'imported_attachment'))
    assert.equal(collection.warnings.length, 1)
  })
  await check('recorded source URL resolves only on explicit request and rejects credential URLs', async ({ service, context }) => {
    let collection = await service.list(1, 'task-1'), item = collection.items.find(item => item.kind === 'research')!
    assert.equal(await service.url(1, 'task-1', collection.collectionId, item.id), 'https://example.com/research')
    const detail = await service.read(1, 'task-1', collection.collectionId, item.id)
    assert.equal(detail.evidence?.sourceContentKind, 'search_snippet'); assert.equal(detail.preview, undefined)
    context.evidence[0].sourceUri = 'https://user:password@example.com/private'
    collection = await service.list(1, 'task-1'); item = collection.items.find(item => item.kind === 'research')!
    assert.equal((await service.read(1, 'task-1', collection.collectionId, item.id)).evidence?.sourceUri, undefined)
    await assert.rejects(service.url(1, 'task-1', collection.collectionId, item.id), /未登记/)
  })
  await check('owner release invalidates previously selected source', async ({ service }) => {
    const collection = await service.list(1, 'task-1')
    service.releaseOwner(1)
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.items[0].id), /不属于/)
    await assert.rejects(service.list(1, 'task-1'), /窗口已关闭/)
    assert((await service.list(2, 'task-1')).items.length > 0)
  })
  await check('page reload while list is pending cannot repopulate a released owner', async ({ context, folder }) => {
    let resume!: () => void
    const pending = new Promise<void>(resolve => { resume = resolve })
    const service = new TaskSourceService(folder, async () => { await pending; return structuredClone(context) })
    const listing = service.list(7, 'task-1')
    service.releaseOwner(7); resume()
    await assert.rejects(listing, /窗口已关闭/)
  })
  await check('task reassignment during an asynchronous read aborts returned preview', async ({ context, folder }) => {
    let calls = 0, rebindAt = Number.POSITIVE_INFINITY
    const service = new TaskSourceService(folder, async () => {
      calls++
      if (calls === rebindAt) context.meta.cwd = '/changed-after-read'
      return structuredClone(context)
    })
    const collection = await service.list(1, 'task-1')
    rebindAt = calls + 3
    await assert.rejects(service.read(1, 'task-1', collection.collectionId, collection.items[0].id), /归属/)
  })
  await check('closed tasks are rejected before inventory or preview', async ({ service, context }) => {
    context.meta.status = 'closed'
    await assert.rejects(service.list(1, 'task-1'), /关闭/)
  })
  console.log(`task sources boundaries: ${passed}/${passed} passed`)
}
main().finally(() => rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
