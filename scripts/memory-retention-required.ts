import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMemory, listMemories, listMemoryEntriesForLifecycle, mutateMemoryEntries, searchMemories, updateMemory } from '../src/main/memory/memory-manager'
import { previewMemoryRetention, readMemoryRetention, saveMemoryRetention, sweepMemoryRetention,
  prepareProjectMemoryRetentionExport, assertProjectMemoryRetentionExportFresh } from '../src/main/memory/memory-retention'
import { MEMORY_RETENTION_DAY_MS as DAY } from '../src/main/memory/memory-retention-policy'
import { createLearningDraft, approveLearningDraft, listLearningProject, rollbackLearningRecord } from '../src/main/learning/learning-lifecycle'
import { mutateLearningState, readLearningState } from '../src/main/learning/learning-store'
import { createTrustedUserLearningDecision } from '../src/main/learning/learning-security'
import { projectLearningNamespace } from '../src/main/project-aggregate/project-memory-adapter'
import { readProjectMemory } from '../src/main/memoryStore'
import type { MemoryRetentionLayer } from '../src/shared/memory-retention-types'
import { collectProjectLayeredMemory, importProjectLayeredMemory } from '../src/main/data-lifecycle/layered-memory-portability'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProductionProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-factory'
import { importProjectAggregate } from '../src/main/data-lifecycle/project-import-coordinator'
import type { ProjectAggregateLearningAudit } from '../src/shared/project-aggregate-types'

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'caogen-memory-retention-'))
  const memory = join(root, 'memory'), learning = join(root, 'learning')
  const scope = { projectId: 'project-a', projectRoot: root, sessionId: 'session-a', workItemId: 'work-a' }
  const base = { title: 'Memory', body: 'retentionkeyword confirmed fact', source: 'fixture' }
  const now = Date.now(), old = new Date(now - 100 * DAY).toISOString()
  const checks: string[] = []
  const configure = async (layer: MemoryRetentionLayer, days: number | null, at = Date.now()) => {
    const view = await readMemoryRetention(memory, scope)
    const preview = await previewMemoryRetention(memory, scope, { layer, days, expectedRevision: view.revision }, at)
    await saveMemoryRetention(memory, scope, preview, at)
    return preview
  }
  try {
    await writeFile(join(root, 'original-task.json'), 'original transcript and audit must survive')
    const entries = await Promise.all([
      addMemory(memory, { ...base, ...scope, layer: 'working' }),
      addMemory(memory, { ...base, ...scope, workItemId: 'work-b', layer: 'working' }),
      addMemory(memory, { ...base, projectId: scope.projectId, layer: 'working' }),
      addMemory(memory, { ...base, projectId: 'project-b', sessionId: scope.sessionId, workItemId: scope.workItemId, layer: 'working' }),
      addMemory(memory, { ...base, projectId: scope.projectId, layer: 'project' }),
      addMemory(memory, { ...base, layer: 'user' }),
      addMemory(memory, { ...base, ...scope, layer: 'working', body: 'recent edit survives' })
    ])
    await mutateMemoryEntries(memory, (values) => ({ entries: values.map((entry) => ({ ...entry,
      updatedAt: entry.id === entries[6].id ? new Date(now).toISOString() : old, createdAt: old,
      lastUsedAt: new Date(now).toISOString() })), result: undefined }))
    assert.deepEqual((await readMemoryRetention(memory, scope)).settings.map((setting) => setting.days), [null, null, null])
    assert.deepEqual(await sweepMemoryRetention(memory, now), { layeredCount: 0, projectCount: 0 })
    assert.equal((await listMemories(memory)).length, 7)
    checks.push('default preserves all data regardless of age')

    const taskPreview = await configure('working', 30, now)
    assert.equal(taskPreview.layeredCount, 1)
    const kept = await listMemories(memory)
    assert.deepEqual(kept.map((entry) => entry.id).sort(), entries.slice(1).map((entry) => entry.id).sort())
    assert.equal((await searchMemories(memory, { ...scope, query: 'retentionkeyword', layers: ['working'] })).some((hit) => hit.entry.id === entries[0].id), false)
    assert.equal((await readFile(join(memory, 'memory-index.json'), 'utf8')).includes(entries[0].id), false)
    checks.push('task scope and project isolation; recent edit survives; lastUsedAt does not extend age; vector removed')

    const current = await readMemoryRetention(memory, scope)
    const preview = await previewMemoryRetention(memory, scope, { layer: 'project', days: 30, expectedRevision: current.revision })
    await updateMemory(memory, entries[4].id, { body: 'changed after preview' }, scope)
    await assert.rejects(saveMemoryRetention(memory, scope, preview), /重新预览/)
    await assert.rejects(saveMemoryRetention(memory, { ...scope, projectId: 'project-b' }, preview), /重新预览/)
    await assert.rejects(previewMemoryRetention(memory, scope, { layer: 'working', days: 0, expectedRevision: current.revision }), /保留天数/)
    await assert.rejects(previewMemoryRetention(memory, scope, { layer: 'working', days: 1, expectedRevision: 0 }), /设置已变化/)
    await assert.rejects(saveMemoryRetention(memory, scope, { ...preview, evaluatedAt: now - 400_000 }), /预览已过期/)
    checks.push('stale content, foreign scope, invalid age, old revision and old preview fail closed')

    const namespace = projectLearningNamespace(scope.projectId)
    const authority = createTrustedUserLearningDecision('memory-retention-fixture')
    const proposal = { kind: 'memory' as const, source: 'fixture', payload: { type: 'memory' as const,
      memoryKind: 'note', title: 'Approved fact', body: 'old project fact', reason: 'fixture' } }
    const active = await createLearningDraft(namespace, learning, proposal)
    await approveLearningDraft(namespace, learning, active.id, authority)
    const draft = await createLearningDraft(namespace, learning, { ...proposal, payload: { ...proposal.payload, body: 'old pending fact' } })
    const worker = await createLearningDraft(namespace, learning, { ...proposal, scope: 'worker', workerId: 'worker-a', memoryNamespace: 'worker-private', payload: { ...proposal.payload, body: 'worker preserved' } })
    const foreign = await createLearningDraft(projectLearningNamespace('project-b'), learning, proposal)
    await mutateLearningState(learning, namespace, (state) => { for (const record of state.records) record.updatedAt = old })
    const projectPreview = await configure('project', 30)
    assert.equal(projectPreview.projectCount, 2)
    const snapshot = await listLearningProject(namespace, learning)
    assert.equal(snapshot.records.find((record) => record.id === active.id)?.status, 'expired')
    assert.equal(snapshot.records.find((record) => record.id === draft.id)?.status, 'expired')
    assert.equal(snapshot.records.find((record) => record.id === worker.id)?.status, 'draft')
    assert.equal((await readLearningState(learning, projectLearningNamespace('project-b'))).records.find((record) => record.id === foreign.id)?.status, 'draft')
    assert(snapshot.audit.some((event) => event.recordId === active.id && event.action === 'expired'))
    assert.equal(snapshot.records.find((record) => record.id === active.id)?.payload.type, 'memory')
    await assert.rejects(approveLearningDraft(namespace, learning, draft.id, authority), /expired/)
    await assert.rejects(rollbackLearningRecord(namespace, learning, active.id, authority), /Expired memory/)
    assert.equal((await readProjectMemory(scope, memory)).entries.length, 0)
    checks.push('project active memories and drafts expire; audit and worker/foreign memories survive; approval cannot resurrect')

    const laterDraft = await createLearningDraft(namespace, learning, { ...proposal, payload: { ...proposal.payload, body: 'expires on read' } })
    await mutateLearningState(learning, namespace, (state) => { state.records.find((record) => record.id === laterDraft.id)!.updatedAt = old })
    assert.equal((await readProjectMemory(scope, memory)).drafts.some((record) => record.id === laterDraft.id), false)
    const tooLate = await addMemory(memory, { ...base, ...scope, layer: 'working' })
    await mutateMemoryEntries(memory, (values) => ({ entries: values.map((entry) => entry.id === tooLate.id ? { ...entry, updatedAt: old } : entry), result: undefined }))
    assert((await listMemoryEntriesForLifecycle(memory)).some((entry) => entry.id === tooLate.id), 'restore verification must inspect persisted entries without invoking age cleanup')
    assert.equal(await updateMemory(memory, tooLate.id, { body: 'late revival' }, scope), null)
    await configure('project', null)
    await configure('working', null)
    assert.equal((await listMemories(memory)).some((entry) => entry.id === tooLate.id), false)
    assert.equal((await readProjectMemory(scope, memory)).entries.length, 0)
    assert.equal((await readLearningState(learning, namespace)).records.find((record) => record.id === laterDraft.id)?.status, 'expired')
    checks.push('retrieval and edits enforce expiry between sweeps; disabling expiry cannot resurrect')

    assert.equal((await configure('user', 30)).layeredCount, 1)
    assert.equal((await listMemories(memory)).some((entry) => entry.id === entries[5].id), false)
    assert.equal(await readFile(join(root, 'original-task.json'), 'utf8'), 'original transcript and audit must survive')
    checks.push('user memory requires separate explicit configuration; original task source untouched')

    const exportRoot = await mkdtemp(join(tmpdir(), 'caogen-retention-export-'))
    try {
      const exportScope = { projectId: 'export-project' }
      const exportMemory = join(exportRoot, 'memory')
      const expired = await addMemory(exportMemory, { ...base, ...exportScope, layer: 'project' })
      const stillLive = await addMemory(exportMemory, { ...base, ...exportScope, layer: 'project', body: 'recent export fact' })
      const exportPreview = await previewMemoryRetention(exportMemory, exportScope, { layer: 'project', days: 30, expectedRevision: 0 })
      await saveMemoryRetention(exportMemory, exportScope, exportPreview)
      await mutateMemoryEntries(exportMemory, values => ({ entries: values.map(entry => entry.id === expired.id ? { ...entry, updatedAt: old } : entry), result: undefined }))
      const slice = await collectProjectLayeredMemory(exportRoot,
        { projectId: exportScope.projectId, workItems: [], workflow: { runs: [] } } as never,
        { sessionHistory: [], activeSessions: [], sessionCreationJournal: [], taskSnapshots: [] })
      assert.deepEqual(slice.entries.map(entry => entry.id), [stillLive.id])
      assert.equal((await listMemoryEntriesForLifecycle(exportMemory)).some(entry => entry.id === expired.id), false)
      const destination = join(exportRoot, 'no-policy-profile')
      await importProjectLayeredMemory(destination, slice)
      assert.deepEqual((await listMemories(join(destination, 'memory'))).map(entry => entry.id), [stillLive.id])
      assert.equal((await readMemoryRetention(join(destination, 'memory'), exportScope)).settings.find(setting => setting.layer === 'project')?.days, null)
      checks.push('export expires persisted entries before snapshot; import into an unconfigured profile cannot revive them')

      const workspace = await openProjectWorkspaceStore(exportRoot)
      await workspace.createWorkspace({ id: exportScope.projectId, name: 'Retention export', kind: 'software' })
      const exportNamespace = projectLearningNamespace(exportScope.projectId), exportLearning = join(exportRoot, 'learning')
      const expiringFact = await createLearningDraft(exportNamespace, exportLearning, proposal)
      await approveLearningDraft(exportNamespace, exportLearning, expiringFact.id, authority)
      const expiringDraft = await createLearningDraft(exportNamespace, exportLearning,
        { ...proposal, payload: { ...proposal.payload, body: 'Expired draft stays expired after import' } })
      await mutateLearningState(exportLearning, exportNamespace, state => {
        for (const record of state.records) record.updatedAt = old
      })
      const service = createProductionProjectAggregateService(exportRoot)
      const initialSeal = await service.sealProject(exportScope.projectId, { expectedAggregateRevision: 0 })
      const captured = await service.queryProject(exportScope.projectId)
      await assert.rejects(service.exportProject(exportScope.projectId), /项目记忆已到期/)
      await prepareProjectMemoryRetentionExport(exportRoot, exportScope.projectId)
      await assert.rejects(assertProjectMemoryRetentionExportFresh(exportRoot, exportScope.projectId, captured.memory), /项目记忆已到期/)
      await assertProjectMemoryRetentionExportFresh(exportRoot, exportScope.projectId,
        captured.memory.map(record => ({ ...record, namespace: 'legacy_path' })))
      await service.sealProject(exportScope.projectId, { expectedAggregateRevision: initialSeal.aggregateRevision })
      const bundle = (await service.exportProject(exportScope.projectId)).bundle
      assert(bundle.aggregate.memory.every(({ record }) => record.status === 'expired'))
      assert(bundle.aggregate.audit.some(entry => entry.source === 'learning' && (entry.value as ProjectAggregateLearningAudit).event.action === 'expired'))
      const importedRoot = join(exportRoot, 'new-profile')
      await importProjectAggregate(bundle, importedRoot)
      const imported = await readLearningState(join(importedRoot, 'learning'), exportNamespace)
      assert.equal(imported.records.find(record => record.id === expiringFact.id)?.status, 'expired')
      assert.equal(imported.records.find(record => record.id === expiringDraft.id)?.status, 'expired')
      assert.deepEqual((await listMemories(join(importedRoot, 'memory'))).map(entry => entry.id), [stillLive.id])
      assert.equal((await readProjectMemory({ ...exportScope, projectRoot: importedRoot }, join(importedRoot, 'memory'))).entries.length, 0)
      await assert.rejects(rollbackLearningRecord(exportNamespace, join(importedRoot, 'learning'), expiringFact.id, authority), /Expired memory/)
      checks.push('sealed Project export rejects expired active memories; prepared export/import preserves expiry and audit without copying retention policy')
    } finally { await rm(exportRoot, { recursive: true, force: true }) }

    const corrupt = '{"version":1,"revision":9,"policies":[{"days":0}]}'
    await writeFile(join(memory, 'memory-retention.json'), corrupt)
    const before = await readFile(join(memory, 'memory-index.json'), 'utf8')
    await assert.rejects(sweepMemoryRetention(memory), /设置损坏/)
    await assert.rejects(searchMemories(memory, { ...scope, query: 'retentionkeyword' }), /设置损坏/)
    assert.equal(await readFile(join(memory, 'memory-index.json'), 'utf8'), before)
    assert.equal(await readFile(join(memory, 'memory-retention.json'), 'utf8'), corrupt)
    checks.push('corrupt policy stops cleanup and retrieval without overwriting either file')
    console.log(JSON.stringify({ passed: checks.length, checks }, null, 2))
  } finally { await rm(root, { recursive: true, force: true }) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
