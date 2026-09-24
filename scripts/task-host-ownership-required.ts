import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTaskHostExecutionGate, TaskHostExecutionGate } from '../src/main/task-handoff/execution-gate'
import { TaskHostOwnershipStore, verifyTaskHandoffReleaseProof } from '../src/main/task-handoff/ownership-store'
import { executePersistedModelAttempt } from '../src/main/task/model-attempt-runtime'
import type { ModelAttemptRecord } from '../src/shared/model-attempt-types'
import { executeInteractiveOperationEffect } from '../src/main/task/operation-effect-gateway'
import { getTaskSnapshot } from '../src/main/task/task-snapshot'
import { reconcileInteractiveOperationSnapshot } from '../src/main/ipc/operation-snapshot'

const root = mkdtempSync(join(tmpdir(), 'caogen-host-ownership-'))
const identity = { sessionId: 'task-original', sessionCreatedAt: 1234 }
const digest = 'a'.repeat(64)
const results: string[] = []
async function group(name: string, run: () => void | Promise<void>) { await run(); results.push(name); console.log(`PASS ${name}`) }
async function main() {
  try {
    const a = new TaskHostExecutionGate(join(root, 'a')), b = new TaskHostExecutionGate(join(root, 'b'))
    const ah = a.store.hostIdentity(), bh = b.store.hostIdentity()
    await group('legacy local task and stable installation identity', async () => {
      assert.equal(await a.withPermit(identity, () => 42), 42)
      assert.deepEqual(new TaskHostOwnershipStore(join(root, 'a')).hostIdentity(), ah)
      assert.notEqual(ah.hostId, bh.hostId)
    })
    await group('freeze blocks new work and drains actual awaited action', async () => {
      let complete!: () => void, started!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      const action = a.withPermit(identity, async () => { started(); await new Promise<void>(resolve => { complete = resolve }) })
      await entered
      let frozen = false
      const freeze = a.freeze(identity, 'handoff-1').then(() => { frozen = true })
      await assert.rejects(a.withPermit(identity, () => assert.fail('must not execute')), /NOT_OWNER/)
      assert.equal(frozen, false)
      assert.throws(() => a.release(identity, { targetHostId: bh.hostId, handoffId: 'handoff-1', bundleDigest: digest }), /BARRIER/)
      complete(); await action; await freeze
      assert.equal(frozen, true)
    })
    let proof: ReturnType<TaskHostExecutionGate['release']>
    await group('release proof, inert import and exact idempotency', () => {
      proof = a.release(identity, { targetHostId: bh.hostId, handoffId: 'handoff-1', bundleDigest: digest })
      assert.deepEqual(a.release(identity, { targetHostId: bh.hostId, handoffId: 'handoff-1', bundleDigest: digest }), proof)
      assert.throws(() => a.release(identity, { targetHostId: bh.hostId, handoffId: 'handoff-1', bundleDigest: 'b'.repeat(64) }))
      assert.throws(() => a.assert(identity), /NOT_OWNER/)
      assert.throws(() => b.activateImported(proof, ah.publicKey), /NOT_STAGED/)
      b.stageImported(identity, ah.hostId, 'handoff-1', 0)
      assert.throws(() => b.assert(identity), /NOT_OWNER/)
      assert.throws(() => verifyTaskHandoffReleaseProof({ ...proof, bundleDigest: 'b'.repeat(64) }, ah.publicKey), /signature/)
      assert.throws(() => b.activateImported(proof, bh.publicKey), /binding/)
      b.activateImported(proof, ah.publicKey)
      b.activateImported(proof, ah.publicKey)
      b.assert(identity)
    })
    await group('restart stays closed on source and requires a fresh drain before release', async () => {
      const sourceRestart = new TaskHostExecutionGate(join(root, 'a'))
      assert.throws(() => sourceRestart.assert(identity), /NOT_OWNER/)
      const targetRestart = new TaskHostExecutionGate(join(root, 'b'))
      targetRestart.assert(identity)
      await b.freeze(identity, 'handoff-back')
      const preparingRestart = new TaskHostExecutionGate(join(root, 'b'))
      assert.throws(() => preparingRestart.assert(identity), /NOT_OWNER/)
      assert.throws(() => preparingRestart.release(identity, { targetHostId: ah.hostId, handoffId: 'handoff-back', bundleDigest: digest }), /BARRIER/)
    })
    await group('bidirectional transfer preserves identity and increments generation', () => {
      const back = b.release(identity, { targetHostId: ah.hostId, handoffId: 'handoff-back', bundleDigest: digest })
      a.stageImported(identity, bh.hostId, 'handoff-back', 1)
      a.activateImported(back, bh.publicKey)
      assert.equal(a.status(identity.sessionId)?.generation, 2)
      assert.deepEqual(a.status(identity.sessionId)?.identity, identity)
      a.assert(identity); assert.throws(() => b.assert(identity), /NOT_OWNER/)
      assert.throws(() => a.activateImported(proof!, ah.publicKey))
    })
    await group('cancel invalidates old queued generation and rejects changed identity', async () => {
      const old = a.claim(identity)
      await a.freeze(identity, 'cancel-1')
      a.cancelBeforeRelease(identity, 'cancel-1')
      assert.throws(() => a.acquire(identity, old), /GENERATION_CHANGED/)
      assert.equal(await a.withPermit(identity, () => 'new'), 'new')
      assert.throws(() => a.assert({ ...identity, sessionCreatedAt: 999 }), /IDENTITY_CONFLICT/)
      assert.throws(() => a.store.prepare(identity, 'cancel-1'), /ID_REUSED/)
    })
    await group('handoff control is restricted and failed stop remains closed', async () => {
      await assert.rejects(a.freeze(identity, 'stop-failed', async () => { throw new Error('unknown effect') }), /unknown effect/)
      assert.throws(() => a.assert(identity), /NOT_OWNER/)
      assert.throws(() => a.release(identity, { targetHostId: bh.hostId, handoffId: 'stop-failed', bundleDigest: digest }), /BARRIER/)
      await a.freeze(identity, 'stop-failed')
      await a.withHandoffControl(identity, 'stop-failed', async () => {
        a.assertHandoffControl(identity.sessionId, 'stop-failed')
        assert.throws(() => a.assert(identity), /CONTROL_CANNOT/)
        assert.throws(() => a.assert({ sessionId: 'unrelated-new-session' }), /CONTROL_CANNOT/)
        await assert.rejects(a.withPermit(identity, () => assert.fail('no model or tools')), /CONTROL_CANNOT/)
      })
      assert.throws(() => a.assertHandoffControl(identity.sessionId, 'stop-failed'), /CONTROL_INVALID/)
      a.cancelBeforeRelease(identity, 'stop-failed')
    })
    await group('actual model boundary holds permit through operation and settlement', async () => {
      const modelRoot = join(root, 'model'), gate = getTaskHostExecutionGate(modelRoot)
      let entered!: () => void, finish!: () => void, starts = 0, settlements = 0
      const began = new Promise<void>(resolve => { entered = resolve })
      let stored: ModelAttemptRecord
      const dependencies = {
        getRetryAuthorization: async () => undefined,
        start: async (input: { id: string; runId: string; requestId: string; startedAt?: number }) => {
          starts += 1
          stored = { ...input, schemaVersion: 1, revision: 1, startedAt: input.startedAt ?? 1, status: 'started' } as ModelAttemptRecord
          return stored
        },
        complete: async () => { settlements += 1; return { ...stored, revision: 2, status: 'succeeded' as const } }
      }
      const input = { sessionId: identity.sessionId, rootDir: modelRoot, runId: 'model-run', requestId: 'model-request', providerId: 'fixture', model: 'fixture', protocol: 'fixture', adapterVersion: 'fixture', context: {}, routeReason: 'fixture' }
      const request = executePersistedModelAttempt(input, async () => { entered(); await new Promise<void>(resolve => { finish = resolve }); return 123 }, { dependencies })
      await began
      let drained = false
      const freeze = gate.freeze(identity, 'model-freeze').then(() => { drained = true })
      await assert.rejects(executePersistedModelAttempt(input, async () => assert.fail('Provider operation forbidden'), { dependencies }), /NOT_OWNER/)
      assert.equal(starts, 1); assert.equal(drained, false)
      finish(); assert.equal(await request, 123); await freeze
      assert.equal(settlements, 1); assert.equal(drained, true)
    })
    await group('actual interactive Effect holds source task ownership across its callback', async () => {
      const effectRoot = join(root, 'effect'), gate = getTaskHostExecutionGate(effectRoot), output = join(root, 'effect-output.txt')
      let entered!: () => void, finish!: () => void
      const began = new Promise<void>(resolve => { entered = resolve })
      const operation = executeInteractiveOperationEffect({ rootDir: effectRoot, operationId: 'owned-write', kind: 'file_write', title: 'fixture', sourceSessionId: identity.sessionId,
        cwd: root, toolName: 'write_file', toolInput: { path: output, content: 'fixture' },
        execute: async () => { entered(); await new Promise<void>(resolve => { finish = resolve }); writeFileSync(output, 'fixture'); return { ok: true } }, isSuccess: value => value.ok })
      await began
      let drained = false
      const freeze = gate.freeze(identity, 'effect-freeze').then(() => { drained = true })
      assert.equal(drained, false)
      finish(); assert.equal((await operation).status, 'completed'); await freeze
      assert.equal(readFileSync(output, 'utf8'), 'fixture')
      await assert.rejects(executeInteractiveOperationEffect({ rootDir: effectRoot, operationId: 'blocked-write', kind: 'file_write', title: 'fixture', sourceSessionId: identity.sessionId,
        cwd: root, toolName: 'write_file', toolInput: { path: output, content: 'blocked' }, execute: () => assert.fail('write forbidden'), isSuccess: () => true }), /NOT_OWNER/)
    })
    await group('interactive reconciliation reads and settles the explicit host root', async () => {
      const recoveryRoot = join(root, 'explicit-recovery'), output = join(root, 'recovered-output.txt')
      const outcome = await executeInteractiveOperationEffect({ rootDir: recoveryRoot, operationId: 'lost-reply', kind: 'file_write', title: 'fixture', sourceSessionId: 'reconcile-source',
        cwd: root, toolName: 'write_file', toolInput: { path: output, content: 'applied' },
        execute: () => { writeFileSync(output, 'partial'); throw new Error('reply lost') }, isSuccess: () => false })
      assert.equal(outcome.status, 'waiting_reconciliation')
      const snapshot = await getTaskSnapshot('operation:lost-reply', recoveryRoot)
      assert(snapshot)
      writeFileSync(output, 'applied') // The original external operation becomes observable before a read-only recheck.
      assert.equal(await reconcileInteractiveOperationSnapshot(snapshot, { rootDir: recoveryRoot, requireStored: true }), null)
      assert.equal(await getTaskSnapshot('operation:lost-reply', recoveryRoot), null)
      assert.equal(readFileSync(output, 'utf8'), 'applied')
    })
    await group('corrupt or missing authority never becomes an unmigrated task', () => {
      const file = a.store.filePath, original = readFileSync(file, 'utf8')
      writeFileSync(file, '{broken')
      assert.throws(() => a.assert(identity), /UNREADABLE/)
      writeFileSync(file, original)
      unlinkSync(file)
      assert.throws(() => a.assert(identity), /UNREADABLE/)
      writeFileSync(file, original)
      const bad = JSON.parse(original)
      bad.records[0].state = 'released'; delete bad.records[0].releaseProof
      writeFileSync(file, JSON.stringify(bad))
      assert.throws(() => a.assert(identity), /UNREADABLE/)
    })
    console.log(`${results.length}/${results.length} host ownership groups passed`)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
