import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { TaskHandoffService, type TaskHandoffBackend } from '../src/main/task-handoff/service'
import { canonicalJson } from '../src/main/project-workspace/codec'
import type { TaskHandoffBundle } from '../src/main/task-handoff/task-bundle'
import type { SessionMeta } from '../src/shared/types'
import { getTaskSnapshot, saveTaskSnapshot, listTaskRuns } from '../src/main/task/task-snapshot'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-handoff-service-')))
const aRoot = join(root, 'a'), bRoot = join(root, 'b'), cwd = join(root, 'work'); mkdirSync(cwd); writeFileSync(join(cwd, 'note.md'), 'original bytes')
const identity = { sessionId: 'service-task', sessionCreatedAt: 1720000000000 }
const meta = (path: string): SessionMeta => ({ id: identity.sessionId, title: 'Synthetic original task', cwd: path, createdAt: identity.sessionCreatedAt, status: 'idle', providerId: '', model: '', permissionMode: 'default', costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0 } as SessionMeta)
const local = new Map<string, SessionMeta>([[aRoot, meta(cwd)]])
let a: TaskHandoffService, b: TaskHandoffService, commits = 0, dropCommitReply = false, imported = 0, revokeDuringImport = false, authorityCurrent = true
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const capture = (dir: string): TaskHandoffBundle => { const value = { schemaVersion: 1, identity, cwd: local.get(dir)!.cwd, title: 'Synthetic original task' }; return { ...value, digest: hash(value) } as TaskHandoffBundle }
const backend = (dir: string): TaskHandoffBackend => ({
  getSession: id => id === identity.sessionId ? local.get(dir) : undefined,
  stopAndReconcile: async () => local.get(dir)!, beforeImport: async () => undefined,
  capture: async () => capture(dir), validate: value => { const { digest, ...body } = value; assert.equal(digest, hash(body)); },
  assertSourceCurrent: async value => assert.equal(capture(dir).digest, value.digest),
  previewImport: async () => ({ canImport: true, conflicts: [], missingResources: ['Synthetic provider is intentionally absent'] }),
  importBundle: async (_bundle, path) => { imported++; local.set(dir, meta(path)); if (revokeDuringImport) authorityCurrent = false },
  request: async (_host, action, payload) => {
    const target = dir === aRoot ? b : a
    const result = await target.remote({ deviceId: dir === aRoot ? 'device-a' : 'device-b', projectId: 'paired-control-project', publicKey: 'fixture-paired-key' }, action, payload, async () => { if (!authorityCurrent) throw new Error('fixture authority revoked') })
    if (action === 'commit') { commits++; if (dropCommitReply) { dropCommitReply = false; throw new Error('simulated response loss') } }
    return result
  }
})
async function main() {
  a = new TaskHandoffService(aRoot, backend(aRoot)); b = new TaskHandoffService(bRoot, backend(bRoot))
  const aReceive = join(root, 'a-receive'), bReceive = join(root, 'b-receive'); mkdirSync(aReceive); mkdirSync(bReceive)
  const ag = a.destinations.add(aReceive), bg = b.destinations.add(bReceive)
  const prepared = await a.prepare({ sessionId: identity.sessionId, hostId: 'peer-b', destinationId: bg.id })
  assert.equal(prepared.state, 'ready'); assert.equal(prepared.canCancelBeforeRelease, true)
  assert.throws(() => a.gate.assert(identity), /NOT_OWNER/)
  assert.equal(b.gate.status(identity.sessionId), undefined)
  const preview = b.list()[0]; assert.equal(readFileSync(join(preview.targetPath!, 'note.md'), 'utf8'), 'original bytes')
  console.log('PASS prepare, inert complete bytes, original identity and explicit preview')
  dropCommitReply = true
  const unknown = await a.commit(prepared.id, prepared.previewDigest!)
  assert.equal(unknown.state, 'needs_reconciliation', JSON.stringify(unknown)); assert.equal(unknown.canCancelBeforeRelease, false)
  const pendingEffect = (await getTaskSnapshot(`operation:${prepared.id}`, aRoot))!
  assert.equal(pendingEffect.run!.effects![0].status, 'waiting_reconciliation')
  assert.equal(imported, 1); b.gate.assert(identity); assert.throws(() => a.gate.assert(identity), /NOT_OWNER/)
  const sourceRestart = new TaskHandoffService(aRoot, backend(aRoot)); a = sourceRestart
  const reconciled = await a.reconcile(prepared.id); assert.equal(reconciled.state, 'committed'); assert.equal(commits, 1); assert.equal(imported, 1)
  await assert.rejects(a.cancel(prepared.id), /释放/)
  console.log('PASS actual Effect, lost response, source restart and original receipt reconciliation without repeat')
  for (const action of ['reconcile', 'commit'] as const) {
    // Simulate the durable committed journal surviving before the original Effect's completion write.
    await saveTaskSnapshot(structuredClone(pendingEffect), aRoot)
    if (action === 'reconcile') await a.reconcile(prepared.id)
    else await a.commit(prepared.id, prepared.previewDigest!)
    assert.equal(await getTaskSnapshot(`operation:${prepared.id}`, aRoot), null)
    const settled = await listTaskRuns(`operation:${prepared.id}`, aRoot)
    assert.equal(settled.length, 1); assert.equal(settled[0].effects![0].status, 'confirmed')
    assert.equal(commits, 1); assert.equal(imported, 1)
  }
  console.log('PASS committed journal repairs pending original Effect via both recovery entry points')
  writeFileSync(join(local.get(bRoot)!.cwd, 'note.md'), 'continued on B')
  const back = await b.prepare({ sessionId: identity.sessionId, hostId: 'peer-a', destinationId: ag.id })
  const arrived = await b.commit(back.id, back.previewDigest!)
  assert.equal(arrived.state, 'committed', JSON.stringify(arrived)); assert.equal(imported, 2)
  assert.equal(readFileSync(join(local.get(aRoot)!.cwd, 'note.md'), 'utf8'), 'continued on B')
  a.gate.assert(identity); assert.throws(() => b.gate.assert(identity), /NOT_OWNER/)
  console.log('PASS A to B to A files and execution ownership across the real coordinator')
  const cancelled = await a.prepare({ sessionId: identity.sessionId, hostId: 'peer-b', destinationId: bg.id })
  writeFileSync(join(local.get(aRoot)!.cwd, 'note.md'), 'edited during preview')
  await assert.rejects(a.commit(cancelled.id, cancelled.previewDigest!), /已变化|不一致/)
  const abort = await a.cancel(cancelled.id); assert.equal(abort.state, 'cancelled'); a.gate.assert(identity)
  assert.equal(imported, 2)
  console.log('PASS source drift cancels before release and never writes a second active task')
  const revoked = await a.prepare({ sessionId: identity.sessionId, hostId: 'peer-b', destinationId: bg.id })
  revokeDuringImport = true
  assert.equal((await a.commit(revoked.id, revoked.previewDigest!)).state, 'needs_reconciliation')
  assert.throws(() => a.gate.assert(identity), /NOT_OWNER/)
  assert.throws(() => b.gate.assert(identity), /NOT_OWNER/)
  assert.equal(b.gate.status(identity.sessionId)?.state, 'preparing')
  assert.equal(b.gate.status(identity.sessionId)?.incoming, true)
  console.log('PASS authorization revoked during import prevents target activation')
  console.log(JSON.stringify({ passed: 6, root, commits, imported }))
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
