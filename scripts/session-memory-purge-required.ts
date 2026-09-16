import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMemory, listMemories, updateMemory } from '../src/main/memory/memory-manager'
import { historyStoreDocument } from '../src/main/history-store-format'
import { activeSessionRegistryDocument } from '../src/main/active-session-registry-format'
import { sessionCreationJournalDocument } from '../src/main/session-creation-journal-format'
import { deleteStandaloneSession, resumeSessionDeletions } from '../src/main/data-lifecycle/session-deletion-coordinator'
import { SessionDeletionJournal } from '../src/main/data-lifecycle/session-deletion-journal'
import { withDataLifecycleMutation } from '../src/main/data-lifecycle/data-lifecycle-mutation-lock'
import { taskMemoryScope } from '../src/main/memory/task-memory-scope'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProductionProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-factory'
import { importProjectAggregate } from '../src/main/data-lifecycle/project-import-coordinator'

const roots: string[] = []
const base = { title: '任务事实', body: '报告只使用已确认数据。', source: 'user' }
function root() { const value = mkdtempSync(join(tmpdir(), 'caogen-session-memory-')); roots.push(value); return value }
function meta(directory: string, id = randomUUID(), taskMemorySessionId?: string) {
  return { id, sdkSessionId: `sdk-${id}`, cwd: directory, workspaceId: 'project-a', createdAt: 1, updatedAt: 1,
    status: 'closed', ...(taskMemorySessionId ? { taskMemorySessionId } : {}) }
}
function history(directory: string, values: ReturnType<typeof meta>[]) {
  writeFileSync(join(directory, 'sessions.json'), JSON.stringify(historyStoreDocument(values)))
}
let passed = 0
async function check(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${name}`) }
async function main() {
  await check('original deletion retains resumed Session memory; final resume deletion clears only Session-owned working records', async () => {
    const directory = root(), memory = join(directory, 'memory'), original = meta(directory), resumed = meta(directory, randomUUID(), original.id)
    history(directory, [original, resumed])
    const shared = await addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id })
    const keep = await Promise.all([
      addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id, workItemId: 'canonical-work-item' }),
      addMemory(memory, { ...base, layer: 'working', projectId: 'project-a' }),
      addMemory(memory, { ...base, layer: 'project', projectId: 'project-a' }),
      addMemory(memory, { ...base, layer: 'working', projectId: 'project-b', sessionId: original.id }),
      addMemory(memory, { ...base, layer: 'user' })
    ])
    const first = await deleteStandaloneSession(original.id, original.sdkSessionId, directory)
    assert.equal(first.removedRecords.layeredMemory, 0); assert.equal(first.residuals.layeredMemory, 0)
    assert((await listMemories(memory)).some(entry => entry.id === shared.id))
    await assert.rejects(addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id }), /已永久删除/)
    await assert.rejects(updateMemory(memory, shared.id, { body: 'late edit' }, { projectId: 'project-a', sessionId: original.id }), /已永久删除/)
    const scope = await taskMemoryScope(resumed, directory)
    assert.equal(scope.writerSessionId, resumed.id); assert.equal(scope.sessionId, original.id)
    const continuing = await addMemory(memory, { ...base, ...scope, layer: 'working' })
    const last = await deleteStandaloneSession(resumed.id, resumed.sdkSessionId, directory)
    assert.equal(last.removedRecords.layeredMemory, 2); assert.equal(last.residuals.layeredMemory, 0)
    const remaining = await listMemories(memory)
    assert.deepEqual(remaining.map(entry => entry.id).sort(), keep.map(entry => entry.id).sort())
    assert(!remaining.some(entry => entry.id === continuing.id))
  })
  await check('frozen memory ownership survives interruption after history removal and blocks queued writers', async () => {
    const directory = root(), memory = join(directory, 'memory'), original = meta(directory)
    history(directory, [original])
    await addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id })
    await assert.rejects(deleteStandaloneSession(original.id, original.sdkSessionId, directory, {
      afterPhase: phase => { if (phase === 'stores_purged') throw new Error('injected interruption after stores') }
    }), /injected interruption/)
    const pending = new SessionDeletionJournal(directory).getPendingSession(original.id)!
    assert.equal(pending.memoryScope?.ownership, 'resolved')
    assert.equal((JSON.parse(readFileSync(join(directory, 'sessions.json'), 'utf8')).entries ?? []).length, 0)
    await assert.rejects(addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id }), /正在永久删除/)
    const resumed = await resumeSessionDeletions(directory)
    assert.equal(resumed[0].removedRecords.layeredMemory, 1)
    assert.equal((await listMemories(memory)).length, 0)
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve }).then(() =>
      withDataLifecycleMutation(directory, () => addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id })))
    release(); await assert.rejects(delayed, /已永久删除/)
    assert.equal((await listMemories(memory)).length, 0)
  })
  await check('active registry and pending creation preserve resumed memory even without history', async () => {
    for (const owner of ['active', 'creation'] as const) {
      const directory = root(), memory = join(directory, 'memory'), original = meta(directory), resumed = meta(directory, randomUUID(), original.id)
      history(directory, [original])
      if (owner === 'active') writeFileSync(join(directory, 'active-sessions.json'), JSON.stringify(activeSessionRegistryDocument([{ ...resumed, status: 'idle' }])))
      else writeFileSync(join(directory, 'session-creation-journal.json'), JSON.stringify(sessionCreationJournalDocument([
        { requestId: 'pending-resume', sessionId: resumed.id, phase: 'prepared', draft: { baseMeta: resumed } }
      ])))
      const entry = await addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id })
      const result = await deleteStandaloneSession(original.id, original.sdkSessionId, directory)
      assert.equal(result.removedRecords.layeredMemory, 0)
      assert((await listMemories(memory)).some(value => value.id === entry.id))
    }
  })
  await check('path-owned Session memory is deleted precisely while legacy shared working remains', async () => {
    const directory = root(), memory = join(directory, 'memory'), original = meta(directory)
    const { workspaceId: _, ...standalone } = original
    writeFileSync(join(directory, 'sessions.json'), JSON.stringify(historyStoreDocument([{ ...standalone, projectId: 'legacy-directory-project' }])))
    const owned = await addMemory(memory, { ...base, layer: 'working', projectRoot: directory, sessionId: original.id })
    const shared = await addMemory(memory, { ...base, layer: 'working', projectRoot: directory })
    const result = await deleteStandaloneSession(original.id, original.sdkSessionId, directory)
    assert.equal(result.removedRecords.layeredMemory, 1)
    assert.deepEqual((await listMemories(memory)).map(value => value.id), [shared.id])
    assert.notEqual(owned.id, shared.id)
  })
  await check('missing or conflicting ownership is never guessed from a matching Session anchor', async () => {
    const directory = root(), memory = join(directory, 'memory'), original = meta(directory)
    const entry = await addMemory(memory, { ...base, layer: 'working', projectId: 'project-a', sessionId: original.id })
    const unknown = await deleteStandaloneSession(original.id, original.sdkSessionId, directory)
    assert.equal(unknown.removedRecords.layeredMemory, 0)
    assert.equal(unknown.memoryOwnership, 'unresolved')
    assert((await listMemories(memory)).some(value => value.id === entry.id))
    const conflicting = meta(directory)
    history(directory, [conflicting])
    writeFileSync(join(directory, 'active-sessions.json'), JSON.stringify(activeSessionRegistryDocument([{ ...conflicting, workspaceId: 'project-b' }])))
    await assert.rejects(deleteStandaloneSession(conflicting.id, conflicting.sdkSessionId, directory), /ownership changed/)
    assert(existsSync(join(directory, 'sessions.json')))
  })
  await check('verified Project import restores only the original deleted Session identity for future memory writes', async () => {
    const source = root(), sourceMeta = { ...meta(source), projectId: 'legacy-directory-identity' }
    history(source, [sourceMeta])
    await (await openProjectWorkspaceStore(source)).createWorkspace({ id: 'project-a', name: 'Memory restore fixture', kind: 'software' })
    await addMemory(join(source, 'memory'), { ...base, layer: 'working', projectId: 'project-a', sessionId: sourceMeta.id })
    const service = createProductionProjectAggregateService(source)
    await service.sealProject('project-a', { expectedAggregateRevision: 0 })
    const bundle = (await service.exportProject('project-a')).bundle
    const target = root()
    await deleteStandaloneSession(sourceMeta.id, sourceMeta.sdkSessionId, target)
    await assert.rejects(addMemory(join(target, 'memory'), { ...base, layer: 'working', projectId: 'project-a', sessionId: sourceMeta.id }), /已永久删除/)
    await importProjectAggregate(bundle, target)
    const scope = await taskMemoryScope(sourceMeta, target)
    await addMemory(join(target, 'memory'), { ...base, ...scope, layer: 'working' })
    await assert.rejects(addMemory(join(target, 'memory'), { ...base, ...scope, layer: 'working', sessionId: 'changed-anchor' }), /已永久删除/)
    assert.equal((await listMemories(join(target, 'memory'))).length, 2)
  })
  console.log(`session-memory-purge: ${passed}/${passed} passed (temporary local data only)`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true })
})
