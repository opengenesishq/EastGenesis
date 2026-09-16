import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMemory, deleteMemory, listMemories, memoryProjectIdHash } from '../src/main/memory/memory-manager'
import { createProductionProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-factory'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectGoalTask, goalTaskIds } from '../src/main/project-workspace/goal-task-service'
import { historyStoreDocument } from '../src/main/history-store-format'
import { importProjectAggregate } from '../src/main/data-lifecycle/project-import-coordinator'
import { purgeProjectPermanently } from '../src/main/data-lifecycle/project-deletion-coordinator'
import { ProjectDeletionBackupStore } from '../src/main/data-lifecycle/project-deletion-backup-store'
import { assertProjectLayeredMemoryImportable, collectProjectLayeredMemory, validateProjectLayeredMemory } from '../src/main/data-lifecycle/layered-memory-portability'
import { projectAggregateDigest } from '../src/main/project-aggregate/codec'
import type { ProjectLayeredMemorySlice } from '../src/shared/layered-memory-portability-types'
import { importProjectPortableRuntime, validateProjectPortableRuntime } from '../src/main/data-lifecycle/project-portable-runtime'
import { withDataLifecycleMutation } from '../src/main/data-lifecycle/data-lifecycle-mutation-lock'

const roots: string[] = []
function root() { const value = mkdtempSync(join(tmpdir(), 'caogen-layered-portable-')); roots.push(value); return value }
const projectId = 'memory-project', sessionId = 'memory-session', { goalId, workItemId } = goalTaskIds(projectId, 'memory-task')
const base = { title: '客户汇报', body: '六页报告，第二页补来源。', source: 'user' }
let passed = 0
async function check(name: string, run: () => Promise<void> | void) { await run(); passed++; console.log(`PASS ${name}`) }
function reseal(slice: ProjectLayeredMemorySlice) { const { sliceDigest: _, ...body } = slice; slice.sliceDigest = projectAggregateDigest(body) }
async function main() {
  const source = root(), memory = join(source, 'memory'), workspace = await openProjectWorkspaceStore(source)
  await workspace.createWorkspace({ id: projectId, name: 'Memory Project', kind: 'software' })
  await createProjectGoalTask({ projectId, requestId: 'memory-task', objective: base.body }, source)
  writeFileSync(join(source, 'sessions.json'), JSON.stringify(historyStoreDocument([
    { id: sessionId, workspaceId: projectId, goalId, workItemId, createdAt: 1, updatedAt: 1, status: 'idle', cwd: source },
    { id: 'session-only-resumed', taskMemorySessionId: 'session-only-original', workspaceId: projectId, createdAt: 2, updatedAt: 2, status: 'idle', cwd: source }
  ])))
  const owned = await Promise.all([
    addMemory(memory, { ...base, layer: 'project', projectId }),
    addMemory(memory, { ...base, layer: 'working', projectId }),
    addMemory(memory, { ...base, layer: 'working', projectId, sessionId, workItemId }),
    addMemory(memory, { ...base, layer: 'working', projectId, sessionId: 'session-only-original' })
  ])
  const preserved = await Promise.all([
    addMemory(memory, { ...base, layer: 'user' }),
    addMemory(memory, { ...base, layer: 'project', projectId: 'unrelated-project' }),
    addMemory(memory, { ...base, layer: 'working', projectRoot: source })
  ])
  const service = createProductionProjectAggregateService(source)
  await service.sealProject(projectId, { expectedAggregateRevision: 0 })
  const exported = await service.exportProject(projectId), runtime = exported.bundle.runtime!, slice = runtime.layeredMemory!
  await check('ordinary Project export includes only owned shared and task memory with exact identities', () => {
    assert.deepEqual(slice.entries.map(x => x.id).sort(), owned.map(x => x.id).sort())
    assert.equal(slice.legacyPathOwnership, 'unresolved_not_included')
    assert.equal(slice.unknownOwnership, 'unresolved_not_included')
    assert(slice.entries.every(x => !('vector' in x)))
    assert.equal(slice.entries.find(x => x.id === owned[3].id)?.sessionId, 'session-only-original')
    assert.equal(slice.entries.find(x => x.id === owned[2].id)?.workItemId, workItemId)
  })
  await check('ordinary import and journal retry restore memory while keeping sibling task access isolated', async () => {
    const target = root()
    await importProjectAggregate(exported.bundle, target)
    await withDataLifecycleMutation(target, () => importProjectPortableRuntime(exported.bundle, target))
    const entries = await listMemories(join(target, 'memory'))
    assert.equal(entries.length, owned.length)
    const sibling = await listMemories(join(target, 'memory'), { projectId, workItemId: 'sibling', sessionId: 'sibling-session' })
    assert.deepEqual(sibling.map(x => x.id).sort(), owned.slice(0, 2).map(x => x.id).sort())
    const resumed = await listMemories(join(target, 'memory'), { projectId, sessionId: 'session-only-original' })
    assert(resumed.some(x => x.id === owned[3].id)); assert(!resumed.some(x => x.id === owned[2].id))
  })
  await check('unknown task ownership and modified namespace are rejected rather than promoted to shared memory', async () => {
    for (const mutate of [
      (value: ProjectLayeredMemorySlice) => { value.entries[0].projectHash = memoryProjectIdHash('other-project') },
      (value: ProjectLayeredMemorySlice) => { value.entries[0].layer = 'user' },
      (value: ProjectLayeredMemorySlice) => { value.entries[0].layer = 'working'; value.entries[0].workItemId = 'unknown-work-item' },
      (value: ProjectLayeredMemorySlice) => { value.entries[0].layer = 'working'; delete value.entries[0].workItemId; value.entries[0].sessionId = 'unknown-session' }
    ]) {
      const value = structuredClone(slice); mutate(value); reseal(value)
      assert.throws(() => validateProjectLayeredMemory(value, exported.bundle.aggregate, runtime), /ownership|cross|Session/)
    }
    const unknown = await addMemory(memory, { ...base, projectId, layer: 'working', sessionId: 'missing-owner' })
    await assert.rejects(collectProjectLayeredMemory(source, exported.bundle.aggregate, runtime), /ownership/)
    await deleteMemory(memory, unknown.id, { projectId, sessionId: 'missing-owner' })
  })
  await check('export redacts secret text and rebuilds search vectors without the removed tokens', async () => {
    const privateText = `Bearer ${'fixture'.repeat(8)}`
    const secret = await addMemory(memory, { ...base, projectId, layer: 'project', body: privateText })
    const redacted = await collectProjectLayeredMemory(source, exported.bundle.aggregate, runtime)
    assert(!JSON.stringify(redacted).includes('fixture'.repeat(8)))
    assert(redacted.entries.find(entry => entry.id === secret.id)!.body.includes('[REDACTED]'))
    assert((await listMemories(memory)).find(entry => entry.id === secret.id)!.body.includes(privateText))
    await deleteMemory(memory, secret.id, { projectId })
  })
  await check('conflicting destination IDs never overwrite global or another Project memory', async () => {
    const target = root(), memoryRoot = join(target, 'memory')
    await addMemory(memoryRoot, { ...base, layer: 'user' })
    const index = join(memoryRoot, 'memory-index.json'), document = JSON.parse(readFileSync(index, 'utf8'))
    document.entries[0].id = slice.entries[0].id; writeFileSync(index, JSON.stringify(document))
    const before = readFileSync(index, 'utf8')
    await assert.rejects(assertProjectLayeredMemoryImportable(target, slice), /identity conflict/)
    assert.equal(readFileSync(index, 'utf8'), before)
  })
  await check('permanent Project deletion backs up and purges owned memory while preserving user, other Project, and legacy records', async () => {
    await workspace.deleteWorkspace(projectId)
    const deleted = await purgeProjectPermanently(projectId, source)
    assert.equal(deleted.residuals.layeredMemory, 0)
    assert.deepEqual((await listMemories(memory)).map(x => x.id).sort(), preserved.map(x => x.id).sort())
    const backup = new ProjectDeletionBackupStore(source).read(deleted.backupPath, deleted.operationId, projectId)
    assert.equal(backup.aggregateExport.runtime!.layeredMemory!.entries.length, owned.length)
    await assert.rejects(addMemory(memory, { ...base, layer: 'working', projectId, workItemId }), /已永久删除/)
    const target = root()
    await importProjectAggregate(backup.aggregateExport, target)
    assert.equal((await listMemories(join(target, 'memory'))).length, owned.length)
    await importProjectAggregate(exported.bundle, source)
    const fresh = await addMemory(memory, { ...base, layer: 'working', projectId, workItemId })
    assert((await listMemories(memory, { projectId, workItemId })).some(entry => entry.id === fresh.id))
  })
  await check('old bundles without layered memory still validate and do not invent memory ownership', () => {
    const old = structuredClone(exported.bundle); delete old.runtime!.layeredMemory
    const { runtimeDigest: _, ...body } = old.runtime!; old.runtime!.runtimeDigest = projectAggregateDigest(body)
    assert.equal(validateProjectPortableRuntime(old)!.layeredMemory, undefined)
  })
  console.log(`layered-memory-portability: ${passed}/${passed} passed (temporary local data only)`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true })
})
