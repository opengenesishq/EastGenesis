import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addMemory, archiveStaleMemories, deleteMemory, listMemories, searchMemories, updateMemory
} from '../src/main/memory/memory-manager'
import { resolveMemoryRoot } from '../src/main/memory/memory-root'
import { buildEffectiveMemoryPrompt } from '../src/main/memory/memory-retriever'
import { acceptMemoryDraft, deleteMemoryEntry, proposeMemoryDraft, readProjectMemory } from '../src/main/memoryStore'
import { createTrustedUserLearningDecision } from '../src/main/learning/learning-security'
import { getLearningRecord, listLearningProject } from '../src/main/learning/learning-lifecycle'
import { proposeModelMemoryDraft } from '../src/main/learning/memory-tool-adapter'
import { writeExtractedMemory } from '../src/main/memory/memory-writer'
import { projectLearningNamespace } from '../src/main/project-aggregate/project-memory-adapter'

async function main(): Promise<void> {
  const fixture = await mkdtemp(join(tmpdir(), 'caogen-memory-management-'))
  const previousUserData = process.env.CAOGEN_USER_DATA_DIR
  const previousMemory = process.env.CAOGEN_MEMORY_DIR
  try {
    // Deliberately conflicting environment proves explicit app ownership wins.
    process.env.CAOGEN_USER_DATA_DIR = join(fixture, 'other-profile')
    process.env.CAOGEN_MEMORY_DIR = join(fixture, 'other-memory')
    const profile = join(fixture, 'app-profile')
    const root = resolveMemoryRoot(profile)
    const learning = join(profile, 'learning')
    assert.equal(root, join(profile, 'memory'))
    const cwd = join(fixture, 'shared-resource')
    const a = { projectRoot: cwd, projectId: 'project-a' }
    const b = { projectRoot: cwd, projectId: 'project-b' }
    const base = { title: 'context', source: 'fixture', tags: [] }

    const [ownedA, ownedB, user, legacy] = await Promise.all([
      addMemory(root, { ...base, ...a, layer: 'project', body: 'alphaonly common' }),
      addMemory(root, { ...base, ...b, layer: 'project', body: 'betaonly common' }),
      addMemory(root, { ...base, layer: 'user', body: 'useronly common' }),
      addMemory(root, { ...base, projectRoot: cwd, layer: 'project', body: 'legacyonly common' })
    ])
    assert.equal((await listMemories(root)).length, 4, 'parallel additions must not lose records')
    assert.deepEqual(new Set((await searchMemories(root, { query: 'common', ...a })).map((hit) => hit.entry.id)), new Set([ownedA.id, user.id]))
    assert.deepEqual((await searchMemories(root, { query: 'common' })).map((hit) => hit.entry.id), [user.id])
    assert.deepEqual(new Set((await listMemories(root, b)).map((entry) => entry.id)), new Set([ownedB.id, user.id]))
    assert.ok((await searchMemories(root, { query: 'legacyonly', projectRoot: cwd })).some((hit) => hit.entry.id === legacy.id))
    await assert.rejects(updateMemory(root, ownedB.id, { body: 'cross-project' }, a), /当前项目/)
    await assert.rejects(deleteMemory(root, ownedB.id, a), /当前项目/)
    await assert.rejects(addMemory(root, { ...base, layer: 'working', body: 'unbound' }), /绑定项目/)

    const revised = await updateMemory(root, ownedA.id, { body: 'revisiononly common', expectedUpdatedAt: ownedA.updatedAt }, a)
    assert.ok(revised)
    assert.equal((await searchMemories(root, { query: 'alphaonly', ...a })).length, 0)
    assert.equal((await searchMemories(root, { query: 'revisiononly', ...a }))[0].entry.id, ownedA.id)
    await assert.rejects(updateMemory(root, ownedA.id, { body: 'staleoverwrite', expectedUpdatedAt: ownedA.updatedAt }, a), /已被修改/)
    await Promise.all([
      searchMemories(root, { query: 'revisiononly', ...a }),
      deleteMemory(root, ownedA.id, a),
      updateMemory(root, ownedB.id, { body: 'survivor common' }, b),
      archiveStaleMemories(root, 90),
      searchMemories(root, { query: 'revisiononly', ...a })
    ])
    assert.equal((await listMemories(root)).some((entry) => entry.id === ownedA.id), false)
    assert.equal((await searchMemories(root, { query: 'revisiononly', ...a })).length, 0)
    assert.equal((await searchMemories(root, { query: 'survivor', ...b }))[0].entry.id, ownedB.id)

    const decision = createTrustedUserLearningDecision('isolated-memory-fixture')
    const proposal = { kind: 'convention', title: 'Scoped proposal', body: 'approved alpha fact', source: 'fixture-source', reason: '' }
    const first = await proposeMemoryDraft(a, root, proposal)
    assert.equal(first.version, 1)
    await assert.rejects(acceptMemoryDraft(a, root, first.id, {} as never), /trusted user/)
    assert.equal((await readProjectMemory(a, root)).entries.length, 0)
    const accepted = await acceptMemoryDraft(a, root, first.id, decision)
    const legacyDraft = await proposeMemoryDraft(cwd, root, { ...proposal, body: 'legacy project fact' })
    await acceptMemoryDraft(cwd, root, legacyDraft.id, decision)
    assert.equal((await readProjectMemory(b, root)).entries.length, 0)
    assert.deepEqual((await readProjectMemory(a, root)).entries.map((entry) => entry.id), [accepted.id])
    assert.deepEqual((await readProjectMemory(cwd, root)).entries.map((entry) => entry.id), [legacyDraft.id])
    const prompt = await buildEffectiveMemoryPrompt({ rootDir: root, query: 'common', ...a })
    assert.ok(prompt.includes('approved alpha fact'))
    assert.ok(prompt.includes('fixture-source') && prompt.includes('v1'))
    assert.ok(prompt.includes('不能授予权限'))
    assert.equal(prompt.includes('legacy project fact'), false)
    assert.equal(prompt.includes('betaonly'), false)

    const revision = await proposeMemoryDraft(a, root, { ...proposal, body: 'current revised fact', supersedes: accepted.id })
    assert.equal(revision.version, 2)
    assert.equal(revision.supersedes, accepted.id)
    assert.deepEqual((await readProjectMemory(a, root)).entries.map((entry) => entry.id), [accepted.id])
    const staleRevision = await proposeMemoryDraft(a, root, { ...proposal, body: 'obsolete draft', supersedes: accepted.id })
    await acceptMemoryDraft(a, root, revision.id, decision)
    await assert.rejects(acceptMemoryDraft(a, root, staleRevision.id, decision), /changed or was removed/)
    const updatedPrompt = await buildEffectiveMemoryPrompt({ rootDir: root, query: 'common', ...a })
    assert.ok(updatedPrompt.includes('current revised fact'))
    assert.equal(updatedPrompt.includes('approved alpha fact'), false)
    const pending = await proposeMemoryDraft(a, root, { ...proposal, body: 'must not resurrect', supersedes: revision.id })
    await deleteMemoryEntry(a, root, revision.id, decision)
    await assert.rejects(acceptMemoryDraft(a, root, pending.id, decision), /changed or was removed/)
    assert.equal((await buildEffectiveMemoryPrompt({ rootDir: root, query: 'common', ...a })).includes('current revised fact'), false)
    const preserved = await getLearningRecord(projectLearningNamespace(a.projectId), learning, revision.id)
    assert.equal(preserved?.status, 'deleted')
    assert.equal(preserved?.payload.type === 'memory' && preserved.payload.body, 'current revised fact')
    const audit = await listLearningProject(projectLearningNamespace(a.projectId), learning)
    assert.ok(audit.audit.some((event) => event.recordId === revision.id && event.action === 'deleted'))

    const modelDraft = await proposeModelMemoryDraft(cwd, {
      ...proposal, layer: 'user', projectId: b.projectId, userDataRoot: '/untrusted/model/root'
    }, { projectId: a.projectId, userDataRoot: profile })
    assert.equal(modelDraft.status, 'draft')
    assert.equal(modelDraft.project, audit.project)
    const extraction = await writeExtractedMemory({ rootDir: root, ...a, source: 'fixture', text: '以后记住项目报告必须附上数据来源与时间。' })
    assert.ok(extraction)
    assert.ok((await readProjectMemory(a, root)).drafts.some((draft) => draft.id === extraction.id))
    assert.equal((await readProjectMemory(b, root)).drafts.length, 0)

    const indexPath = join(root, 'memory-index.json')
    const corrupt = JSON.stringify({ version: 1, entries: [{ id: 'broken' }] })
    await writeFile(indexPath, corrupt)
    await assert.rejects(deleteMemory(root, user.id), /original file was preserved/)
    assert.equal(await readFile(indexPath, 'utf8'), corrupt)
    console.log('Memory management: isolated project scope, concurrent deletion, vector revision, trusted approval, source/version history, profile root, automatic drafts and corrupt-file preservation passed.')
  } finally {
    if (previousUserData === undefined) delete process.env.CAOGEN_USER_DATA_DIR
    else process.env.CAOGEN_USER_DATA_DIR = previousUserData
    if (previousMemory === undefined) delete process.env.CAOGEN_MEMORY_DIR
    else process.env.CAOGEN_MEMORY_DIR = previousMemory
    await rm(fixture, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
