import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptMemoryDraft, deleteMemoryEntry, projectHash, proposeMemoryDraft, readProjectMemory } from '../src/main/memoryStore'
import { createTrustedUserLearningDecision } from '../src/main/learning/learning-security'
import { createLearningDraft, deleteLearningRecord, listLearningProject } from '../src/main/learning/learning-lifecycle'
import { learningStatePath } from '../src/main/learning/learning-store'
import { projectLearningNamespace } from '../src/main/project-aggregate/project-memory-adapter'
import { addMemory, listMemories, updateMemory } from '../src/main/memory/memory-manager'
import { importLegacyProjectMemory, previewLegacyProjectMemory } from '../src/main/memory/legacy-memory-import'
import { buildEffectiveMemoryPrompt } from '../src/main/memory/memory-retriever'

async function main() {
  const fixture = await mkdtemp(join(tmpdir(), 'caogen-legacy-memory-import-'))
  const root = join(fixture, 'profile', 'memory')
  const learning = join(fixture, 'profile', 'learning')
  const cwd = join(fixture, 'shared-directory')
  const a = { projectId: 'project-a', projectRoot: cwd }
  const b = { projectId: 'project-b', projectRoot: cwd }
  const authority = createTrustedUserLearningDecision('legacy-import-fixture')
  const input = { kind: 'note', title: 'Legacy fact', body: 'legacy fact body', source: 'old-user', reason: 'old reason' }
  const checks: string[] = []
  try {
    const original = await proposeMemoryDraft(cwd, root, input)
    await acceptMemoryDraft(cwd, root, original.id, authority)
    const oldDraft = await proposeMemoryDraft(cwd, root, { ...input, body: 'unapproved source draft' })
    const removed = await proposeMemoryDraft(cwd, root, { ...input, body: 'deleted source fact' })
    await deleteMemoryEntry(cwd, root, removed.id, authority)
    await createLearningDraft(cwd, learning, { kind: 'memory', source: 'expired-fixture', expiresAt: '2000-01-01T00:00:00.000Z',
      payload: { type: 'memory', memoryKind: 'note', title: 'expired', body: 'expired', reason: 'expired' } })
    const bucket = join(root, 'projects', projectHash(cwd), 'confirmed')
    await mkdir(bucket, { recursive: true })
    const raw = { ...input, id: 'legacy-json', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }
    const rawFile = join(bucket, 'legacy-json.json')
    await writeFile(rawFile, JSON.stringify(raw))
    // A leftover old copy must not restore a Learning-deleted entry into preview.
    await writeFile(join(bucket, `${removed.id}.json`), JSON.stringify({ ...raw, id: removed.id, body: 'deleted shadow' }))
    const vector = await addMemory(root, { layer: 'working', projectRoot: cwd, title: 'Layered', body: 'layered legacy', source: 'old-index' })
    await addMemory(root, { layer: 'user', title: 'Global', body: 'user global', source: 'user' })
    await addMemory(root, { layer: 'project', projectRoot: join(fixture, 'other-directory'), title: 'Other', body: 'other project', source: 'other' })
    const files = [rawFile, learningStatePath(learning, cwd), join(root, 'memory-index.json')]
    const before = await Promise.all(files.map(async (file) => ({ bytes: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs })))
    const preview = await previewLegacyProjectMemory(a, root)
    assert.equal(preview.projectId, a.projectId)
    assert.equal(preview.entries.length, 4)
    assert.ok(preview.entries.some((entry) => entry.sourceId === oldDraft.id && entry.sourceState === 'draft'))
    assert.equal(preview.entries.some((entry) => entry.sourceId === removed.id || entry.body.includes('expired')), false)
    assert.deepEqual(await Promise.all(files.map(async (file) => ({ bytes: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs }))), before)
    checks.push('preview reads all legacy stores without writes, expiry, foreign/global entries or tombstone resurrection')

    const selected = preview.entries.find((entry) => entry.sourceId === original.id)!
    const request = { expectedProjectId: a.projectId, entryKey: selected.entryKey, sourceDigest: selected.sourceDigest }
    await assert.rejects(importLegacyProjectMemory(b, root, request), /项目已变化/)
    await assert.rejects(importLegacyProjectMemory({ ...a, projectRoot: join(fixture, 'other-directory') }, root, request), /重新预览/)
    await assert.rejects(importLegacyProjectMemory(a, root, request, () => { throw new Error('scope changed') }), /scope changed/)
    const imports = await Promise.all([importLegacyProjectMemory(a, root, request), importLegacyProjectMemory(a, root, request)])
    assert.equal(imports[0].record.id, imports[1].record.id)
    assert.equal(imports[0].record.status, 'draft')
    assert.ok(imports[0].record.payload.type === 'memory' && imports[0].record.payload.reason.includes(selected.sourceDigest))
    const current = await listLearningProject(projectLearningNamespace(a.projectId), learning)
    assert.equal(current.records.length, 1)
    assert.equal(current.audit.filter((event) => event.action === 'proposed').length, 1)
    assert.deepEqual(await Promise.all(files.map(async (file) => ({ bytes: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs }))), before)
    assert.equal((await readProjectMemory(a, root)).entries.length, 0)
    assert.equal((await readProjectMemory(b, root)).drafts.length, 0)
    assert.equal((await readProjectMemory(cwd, root)).entries.some((entry) => entry.id === original.id), true)
    checks.push('target/directory identity is re-derived; concurrent import creates one unapproved audited draft and preserves source')

    await acceptMemoryDraft(a, root, imports[0].record.id, authority)
    assert.equal((await importLegacyProjectMemory(a, root, request)).replayed, true)
    assert.ok((await buildEffectiveMemoryPrompt({ rootDir: root, query: 'legacy', ...a })).includes(input.body))
    await deleteLearningRecord(projectLearningNamespace(a.projectId), learning, imports[0].record.id, authority)
    const deletedReplay = await importLegacyProjectMemory(a, root, request)
    assert.equal(deletedReplay.record.status, 'deleted')
    assert.equal(deletedReplay.replayed, true)
    const afterDelete = await previewLegacyProjectMemory(a, root)
    assert.equal(afterDelete.entries.find((entry) => entry.entryKey === selected.entryKey)?.imported?.status, 'deleted')
    assert.equal((await buildEffectiveMemoryPrompt({ rootDir: root, query: 'legacy', ...a })).includes(input.body), false)
    checks.push('approved/deleted replay keeps original lifecycle result and never restores retired content')

    const vectorPreview = preview.entries.find((entry) => entry.sourceId === vector.id)!
    const vectorRequest = { expectedProjectId: a.projectId, entryKey: vectorPreview.entryKey, sourceDigest: vectorPreview.sourceDigest }
    await updateMemory(root, vector.id, { body: 'changed after preview', expectedUpdatedAt: vector.updatedAt }, { projectRoot: cwd })
    await assert.rejects(importLegacyProjectMemory(a, root, vectorRequest), /重新预览/)
    const fresh = (await previewLegacyProjectMemory(a, root)).entries.find((entry) => entry.sourceId === vector.id)!
    assert.notEqual(fresh.sourceDigest, vectorPreview.sourceDigest)
    const importedFresh = await importLegacyProjectMemory(a, root, { ...vectorRequest, sourceDigest: fresh.sourceDigest })
    assert.equal(importedFresh.record.payload.type === 'memory' && importedFresh.record.payload.body, 'changed after preview')
    assert.ok((await listMemories(root, { projectRoot: cwd })).some((entry) => entry.id === vector.id))
    checks.push('changed source requires a new preview digest and original layered entry remains intact')
    console.log(JSON.stringify({ status: 'passed', checks, scope: 'temporary fixture only; no Provider calls or real memory migration' }, null, 2))
  } finally { await rm(fixture, { recursive: true, force: true }) }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
