import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskHandoffService, type TaskHandoffBackend } from '../src/main/task-handoff/service'
import { captureTaskHandoffBundle, validateTaskHandoffBundle, assertTaskHandoffSourceCurrent, previewTaskHandoffImport, importTaskHandoffBundle } from '../src/main/task-handoff/task-bundle'
import { seedTaskHandoffFixture } from './lib/task-handoff-bundle-fixture'
import { historyEntriesFromDocument, historyStoreDocument } from '../src/main/history-store-format'
import { getTaskSnapshot, listTaskRuns, buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { ProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-service'
import { verifyPersistedArtifactLifecycle } from '../src/main/task/artifact-lifecycle-api'
import type { HistoryEntry, SessionMeta } from '../src/shared/types'
const root = process.argv[2], aRoot = join(root, 'source'), bRoot = join(root, 'target'), cwd = join(root, 'workspace')
let a: TaskHandoffService, b: TaskHandoffService, calls = 0, loseReply = false
const getMeta = (dir: string, id: string): SessionMeta | undefined => {
  try { return historyEntriesFromDocument<HistoryEntry>(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))).find(item => item.id === id) as unknown as SessionMeta } catch { return undefined }
}
const backend = (dir: string): TaskHandoffBackend => ({
  getSession: id => getMeta(dir, id), stopAndReconcile: async id => getMeta(dir, id)!, beforeImport: async () => undefined,
  capture: id => captureTaskHandoffBundle(dir, id), validate: validateTaskHandoffBundle, assertSourceCurrent: bundle => assertTaskHandoffSourceCurrent(dir, bundle),
  previewImport: (bundle, path) => previewTaskHandoffImport(dir, bundle, path), importBundle: (bundle, path) => importTaskHandoffBundle(dir, bundle, path),
  request: async (_hostId, action, payload) => {
    const result = await (dir === aRoot ? b : a).remote({ deviceId: dir === aRoot ? 'paired-source' : 'paired-target', projectId: 'paired-control', publicKey: 'fixture-device-key' }, action, payload)
    if (action === 'commit') { calls++; if (loseReply) { loseReply = false; throw new Error('lost commit reply') } }
    return result
  }
})
async function main() {
  const seed = await seedTaskHandoffFixture(aRoot, cwd, 'integrated')
  a = new TaskHandoffService(aRoot, backend(aRoot)); b = new TaskHandoffService(bRoot, backend(bRoot))
  const aDest = join(root, 'receive-a'), bDest = join(root, 'receive-b'); mkdirSync(aDest); mkdirSync(bDest)
  const ag = a.destinations.add(aDest), bg = b.destinations.add(bDest)
  const prepared = await a.prepare({ sessionId: seed.sessionId, hostId: 'target-peer', destinationId: bg.id })
  assert.equal(prepared.state, 'ready'); loseReply = true
  const sent = await a.commit(prepared.id, prepared.previewDigest!)
  assert.equal(sent.state, 'needs_reconciliation', JSON.stringify(sent)); assert.equal(sent.canCancelBeforeRelease, false)
  a = new TaskHandoffService(aRoot, backend(aRoot)); b = new TaskHandoffService(bRoot, backend(bRoot))
  assert.equal((await a.reconcile(sent.id)).state, 'committed'); assert.equal(calls, 1)
  const imported = getMeta(bRoot, seed.sessionId)!
  assert.equal(imported.id, seed.meta.id); assert.equal(imported.createdAt, seed.meta.createdAt)
  assert.equal(readFileSync(join(imported.cwd, 'deliverable.txt'), 'utf8'), 'Frozen deliverable bytes')
  assert.deepEqual(await listTaskRuns(seed.sessionId, bRoot), [seed.run]); assert.equal((await getTaskSnapshot(seed.sessionId, bRoot))?.run, undefined)
  assert.equal((await verifyPersistedArtifactLifecycle(bRoot)).valid, true)
  await new ProjectAggregateService({ workspaceRoot: bRoot, workflowRoot: bRoot, aggregateRoot: bRoot, digitalWorkerRoot: bRoot, routineRoot: join(bRoot, 'routines'), learningRoot: join(bRoot, 'learning') }).verifyLiveProject(seed.projectId)
  console.log('PASS actual task closure, files, original Run/identity, source-ref artifact and canonical project through signed coordinator')
  const continued = { ...imported, title: 'Continued at target', updatedAt: seed.now + 10 }
  writeFileSync(join(bRoot, 'sessions.json'), JSON.stringify(historyStoreDocument([continued])))
  const runB = { ...seed.run, id: 'integrated-run-b', effects: [], toolExecutions: [], steps: [], createdAt: seed.now + 10, updatedAt: seed.now + 10 }
  await saveTaskSnapshot(buildTaskSnapshot({ meta: continued, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', run: runB, now: seed.now + 10 }), bRoot)
  const returned = await b.prepare({ sessionId: seed.sessionId, hostId: 'source-peer', destinationId: ag.id })
  const landed = await b.commit(returned.id, returned.previewDigest!)
  assert.equal(landed.state, 'committed', JSON.stringify(landed)); assert.equal((await listTaskRuns(seed.sessionId, aRoot)).length, 2)
  a.gate.assert({ sessionId: seed.sessionId, sessionCreatedAt: seed.now }); assert.throws(() => b.gate.assert({ sessionId: seed.sessionId }), /NOT_OWNER/)
  assert.equal((await verifyPersistedArtifactLifecycle(aRoot)).valid, true)
  console.log('PASS actual task A to B to A, new target Run, restart and one executable owner')
  console.log(JSON.stringify({ passed: 2, calls }))
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
