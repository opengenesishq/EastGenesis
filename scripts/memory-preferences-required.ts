import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings } from '../src/main/settings'
import { normalizeMemoryPreferences, resolveMemoryPreferences, validateMemoryOverrides } from '../src/shared/memory-preferences-types'
import { currentTaskMemoryPreferences, withTaskMemoryPreferences } from '../src/main/memory/memory-preferences'
import { addMemory, deleteMemory, listMemories, searchMemories, updateMemory } from '../src/main/memory/memory-manager'
import { buildEffectiveMemoryPrompt } from '../src/main/memory/memory-retriever'
import { writeExtractedMemory } from '../src/main/memory/memory-writer'
import { acceptMemoryDraft, proposeMemoryDraft, readProjectMemory } from '../src/main/memoryStore'
import { approveLearningDraft, createLearningDraft, getLearningRecord, rollbackLearningRecord } from '../src/main/learning/learning-lifecycle'
import { createTrustedUserLearningDecision } from '../src/main/learning/learning-security'
import { proposeModelMemoryDraft } from '../src/main/learning/memory-tool-adapter'
import { projectLearningNamespace } from '../src/main/project-aggregate/project-memory-adapter'
import { withDataLifecycleMutation } from '../src/main/data-lifecycle/data-lifecycle-mutation-lock'

async function main(): Promise<void> {
  assert.equal(process.versions.electron, undefined, 'Run this isolated fixture with Node, never inside the desktop process')
  const root = await mkdtemp(join(tmpdir(), 'caogen-memory-preferences-'))
  const settings = getSettings()
  const prior = settings.memoryPreferences
  const temporary = process.env.CAOGEN_TEMPORARY_PROFILE_ID
  let groups = 0
  try {
    delete process.env.CAOGEN_TEMPORARY_PROFILE_ID
    settings.memoryPreferences = normalizeMemoryPreferences(undefined)
    assert.deepEqual(resolveMemoryPreferences({ useSharedMemory: false, contributeSharedMemory: true }, { contributeSharedMemory: false }).effective,
      { useSharedMemory: false, contributeSharedMemory: false })
    assert.deepEqual(resolveMemoryPreferences(undefined, { useSharedMemory: true, contributeSharedMemory: true }, true).effective,
      { useSharedMemory: false, contributeSharedMemory: false })
    assert.throws(() => validateMemoryOverrides({ useSharedMemory: 'false' }))
    assert.throws(() => validateMemoryOverrides({ taskId: 'other' }))
    groups++

    const memory = join(root, 'memory'), learning = join(root, 'learning')
    const target = { projectRoot: join(root, 'project'), projectId: 'fixture-project' }
    const scope = { ...target, sessionId: 'task-a' }
    const base = { title: 'common', body: 'common', source: 'isolated-fixture' }
    const task = { memoryOverrides: { useSharedMemory: false, contributeSharedMemory: false } }
    const taskOnly = await addMemory(memory, { ...base, ...scope, layer: 'working', body: 'common taskonly' })
    await addMemory(memory, { ...base, ...target, sessionId: 'task-b', layer: 'working', body: 'common othertask' })
    const shared = await addMemory(memory, { ...base, ...target, layer: 'project', body: 'common projectshared' })
    await addMemory(memory, { ...base, ...target, layer: 'working', body: 'common legacyshared' })
    await addMemory(memory, { ...base, layer: 'user', body: 'common usershared' })
    const proposal = { kind: 'note', title: 'common', body: 'common approvedshared', source: 'fixture', reason: 'fixture' }
    const authority = createTrustedUserLearningDecision('memory-preferences-fixture')
    const approved = await proposeMemoryDraft(target, memory, proposal)
    await acceptMemoryDraft(target, memory, approved.id, authority)
    const pending = await proposeMemoryDraft(target, memory, { ...proposal, body: 'pendingshared' })
    const allowed = () => currentTaskMemoryPreferences(task).effective.useSharedMemory
    const hits = await searchMemories(memory, { ...scope, query: 'common', sharedMemoryAllowed: allowed })
    assert.deepEqual(hits.map(hit => hit.entry.id), [taskOnly.id])
    const prompt = await buildEffectiveMemoryPrompt({ rootDir: memory, ...scope, query: 'common', sharedMemoryAllowed: allowed })
    assert(prompt.includes('taskonly'))
    for (const text of ['othertask', 'projectshared', 'legacyshared', 'usershared', 'approvedshared']) assert(!prompt.includes(text), text)
    assert.equal((await listMemories(memory)).length, 5, 'disabled retrieval never deletes stored entries')
    assert.equal((await readProjectMemory(target, memory)).entries[0].id, approved.id)
    const inheritedPrompt = await withTaskMemoryPreferences(task, () => buildEffectiveMemoryPrompt({ rootDir: memory, ...scope, query: 'common' }))
    assert(inheritedPrompt.includes('taskonly') && !inheritedPrompt.includes('approvedshared') && !inheritedPrompt.includes('projectshared'))
    groups++

    settings.memoryPreferences = { useSharedMemory: true, contributeSharedMemory: false }
    await withTaskMemoryPreferences(task, async () => {
      await updateMemory(memory, taskOnly.id, { body: 'common taskonly updated' }, scope)
      await addMemory(memory, { ...base, ...scope, layer: 'working' })
      await assert.rejects(addMemory(memory, { ...base, ...target, layer: 'project' }), /贡献已关闭/)
      await assert.rejects(updateMemory(memory, shared.id, { body: 'blocked' }, scope), /贡献已关闭/)
      await assert.rejects(proposeMemoryDraft(target, memory, proposal), /贡献已关闭/)
      await assert.rejects(acceptMemoryDraft(target, memory, pending.id, authority), /贡献已关闭/)
      await assert.rejects(approveLearningDraft(projectLearningNamespace(target.projectId), learning, pending.id, authority), /贡献已关闭/)
      await assert.rejects(rollbackLearningRecord(projectLearningNamespace(target.projectId), learning, approved.id, authority), /贡献已关闭/)
      await assert.rejects(proposeModelMemoryDraft(target.projectRoot, { ...proposal, layer: 'user' }, { projectId: target.projectId, userDataRoot: root }), /贡献已关闭/)
      assert.equal(await writeExtractedMemory({ rootDir: memory, ...target, source: 'fixture', text: '以后记住报告必须提供数据来源和时间。' }), null)
    })
    assert.equal((await getLearningRecord(projectLearningNamespace(target.projectId), learning, pending.id))?.status, 'draft')
    assert.equal((await readProjectMemory(target, memory)).entries[0].id, approved.id)
    groups++

    const results = await Promise.allSettled([
      withTaskMemoryPreferences({ memoryOverrides: { contributeSharedMemory: true } }, () => proposeMemoryDraft(target, memory, { ...proposal, body: 'explicitly allowed' })),
      withTaskMemoryPreferences(task, () => proposeMemoryDraft(target, memory, { ...proposal, body: 'must stay blocked' }))
    ])
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected')
    const inheritedExtraction = await withTaskMemoryPreferences({ memoryOverrides: { contributeSharedMemory: true } }, () =>
      writeExtractedMemory({ rootDir: memory, ...target, source: 'fixture', text: '以后记住所有客户报告必须包含可核验的数据来源。' }))
    assert(inheritedExtraction)
    await withTaskMemoryPreferences({ memoryOverrides: { useSharedMemory: false, contributeSharedMemory: true } }, () =>
      createLearningDraft(projectLearningNamespace(target.projectId), learning, {
        kind: 'memory', source: 'worker-fixture', confidence: 1, workerId: 'worker-a', memoryNamespace: 'worker-memory-a',
        payload: { type: 'memory', memoryKind: 'note', title: 'worker', body: 'worker shared memory', reason: 'fixture' }
      }))
    await assert.rejects(createLearningDraft(projectLearningNamespace(target.projectId), learning, {
      kind: 'memory', source: 'worker-fixture', confidence: 1, workerId: 'worker-a', memoryNamespace: 'worker-memory-a',
      payload: { type: 'memory', memoryKind: 'note', title: 'worker', body: 'must stay blocked', reason: 'fixture' }
    }), /贡献已关闭/)
    groups++

    let entered!: () => void, release!: () => void
    const enteredLock = new Promise<void>(resolve => { entered = resolve })
    const releaseLock = new Promise<void>(resolve => { release = resolve })
    const blocker = withDataLifecycleMutation(root, async () => { entered(); await releaseLock })
    await enteredLock
    const liveTask = { memoryOverrides: { contributeSharedMemory: true, useSharedMemory: true } }
    const queued = withTaskMemoryPreferences(() => liveTask, () => proposeMemoryDraft(target, memory, { ...proposal, body: 'late blocked draft' }))
    const rejected = assert.rejects(queued, /贡献已关闭/)
    const queuedPrompt = buildEffectiveMemoryPrompt({ rootDir: memory, ...scope, query: 'common', sharedMemoryAllowed: () => currentTaskMemoryPreferences(liveTask).effective.useSharedMemory })
    liveTask.memoryOverrides = { contributeSharedMemory: false, useSharedMemory: false }
    release()
    await blocker
    await rejected
    const latePrompt = await queuedPrompt
    assert(latePrompt.includes('taskonly'))
    assert(!latePrompt.includes('approvedshared') && !latePrompt.includes('projectshared'))
    assert(!(await readProjectMemory(target, memory)).drafts.some(draft => draft.body === 'late blocked draft'))
    groups++

    await withTaskMemoryPreferences(task, () => deleteMemory(memory, shared.id, scope))
    assert(!(await listMemories(memory)).some(entry => entry.id === shared.id))
    process.env.CAOGEN_TEMPORARY_PROFILE_ID = 'isolated-fixture'
    assert.deepEqual(currentTaskMemoryPreferences({ memoryOverrides: { useSharedMemory: true, contributeSharedMemory: true } }).effective,
      { useSharedMemory: false, contributeSharedMemory: false })
    groups++
    console.log(`PASS ${groups} memory preference boundary groups; isolated local stores; no Provider or desktop process`)
  } finally {
    settings.memoryPreferences = prior
    if (temporary === undefined) delete process.env.CAOGEN_TEMPORARY_PROFILE_ID
    else process.env.CAOGEN_TEMPORARY_PROFILE_ID = temporary
    await rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
