import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'
import { buildEffectDescriptor } from '../src/main/task/effect-reconciler'
import { prepareEffect, markEffectExecuting, completeEffect } from '../src/main/task/effect-ledger'
import { createTaskRun } from '../src/main/task/task-run'
import { buildTaskSnapshot, getTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { recheckPersistedTaskEffect, resolvePersistedTaskEffect, reconcilePersistedTaskSnapshot } from '../src/main/task/effect-runtime'
import { buildTaskEffectRecoveryView } from '../src/main/task/effect-recovery-view'
import { effectRecordIntegrityMatches } from '../src/main/task/effect-record-integrity'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'

const root = mkdtempSync(join(tmpdir(), 'caogen-effect-recovery-'))
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Provider calls forbidden') }

async function createWaiting(id: string, opaque = false) {
  const now = Date.now(), file = join(root, `${id}.txt`)
  const toolName = opaque ? 'external_send' : 'write_file'
  const descriptor = await buildEffectDescriptor({ cwd: root, toolName, toolInput: { path: file, content: 'expected result' } })
  let run = createTaskRun({ id: `run-${id}`, sessionId: id, taskId: id, now, digitalWorkerBinding: { kind: 'unscoped' } })
  const prepared = prepareEffect(run, { sessionId: id, cwd: root, toolUseId: 'write-original', toolName,
    descriptor, ownerId: 'stopped-worker', now })
  run = markEffectExecuting(prepared.run, prepared.handle, now + 1)
  run = completeEffect(run, prepared.handle, 'waiting_reconciliation', 'unknown', 'original response lost', now + 2)
  const meta = { id, title: id, cwd: root, model: 'fixture', providerId: 'fixture', status: 'idle', engine: 'openai',
    taskStrategy: 'execute', permissionMode: 'default', createdAt: now, costUsd: 0, contextTokens: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, digitalWorkerBinding: { kind: 'unscoped' } } as SessionMeta
  const snapshot = await saveTaskSnapshot(buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'important-event', now: now + 2 }), root)
  return { snapshot, file, descriptor, effect: snapshot.run!.effects![0] }
}

async function main() {
  const checks: string[] = []
  try {
    const first = await createWaiting('not-applied')
    const unchangedFile = readFileSync(join(root, 'task-snapshots.db'))
    const projected = buildTaskEffectRecoveryView([first.snapshot], first.snapshot.sessionId, first.snapshot.run!.id, first.snapshot.taskId)
    assert.equal(projected.snapshots[0].effects[0].id, first.effect.id)
    assert.deepEqual(readFileSync(join(root, 'task-snapshots.db')), unchangedFile)
    assert.equal(buildTaskEffectRecoveryView([first.snapshot], 'another-session').snapshots.length, 0)
    assert.equal(buildTaskEffectRecoveryView([first.snapshot], first.snapshot.sessionId, 'other-run').snapshots.length, 0)
    assert.throws(() => buildTaskEffectRecoveryView([{ ...first.snapshot, taskId: 'other-task' }], first.snapshot.sessionId), /身份|摘要/)
    assert.throws(() => buildTaskEffectRecoveryView([first.snapshot, first.snapshot], first.snapshot.sessionId), /多个恢复快照/)
    checks.push('read-only exact session/run/task projection rejects corrupt or ambiguous ownership')

    const queried = await recheckPersistedTaskEffect(first.snapshot.id, first.effect.id, first.effect.revision, { rootDir: root })
    const unknown = queried.run!.effects![0]
    assert.equal(unknown.status, 'waiting_reconciliation')
    assert.equal(unknown.evidence.some(item => item.kind === 'retry_authorized'), false)
    await assert.rejects(recheckPersistedTaskEffect(first.snapshot.id, first.effect.id, first.effect.revision, { rootDir: root }), /stale_revision/)
    await assert.rejects(recheckPersistedTaskEffect(first.snapshot.id, first.effect.id, unknown.revision,
      { rootDir: root, assertStopped: () => { throw new Error('active execution') } }), /active execution/)
    checks.push('negative read-only query stays unknown without retry authorization; stale/active actions fail')

    const refreshed = await reconcilePersistedTaskSnapshot(queried, root)
    assert.equal(refreshed.run!.effects![0].status, 'waiting_reconciliation')
    assert.equal(refreshed.run!.effects![0].evidence.some(item => item.kind === 'retry_authorized'), false)
    const currentUnknown = refreshed.run!.effects![0]
    checks.push('later general snapshot reconciliation preserves the explicit manual-review barrier')

    const abandoned = await resolvePersistedTaskEffect(first.snapshot.id, currentUnknown.id, currentUnknown.revision, 'abandoned_by_user',
      { rootDir: root, note: '用户核对后决定放弃本次操作' })
    const abandonedEffect = abandoned.run!.effects![0]
    assert.equal(abandonedEffect.status, 'abandoned')
    assert.equal(abandonedEffect.evidence.some(item => item.kind === 'retry_authorized'), false)
    const receipt = abandonedEffect.evidence.at(-1)!.resolutionReceipt!
    assert.equal(receipt.expectedRevision, currentUnknown.revision)
    assert.equal(receipt.targetDigest, unknown.targetDigest)
    assert.equal(receipt.inputDigest, unknown.inputDigest)
    assert.equal(receipt.note, '用户核对后决定放弃本次操作')
    assert(effectRecordIntegrityMatches(abandonedEffect))
    assert.deepEqual((await getTaskSnapshot(first.snapshot.id, root))!.run!.effects![0], abandonedEffect)
    assert.throws(() => prepareEffect(abandoned.run!, { sessionId: first.snapshot.sessionId, cwd: root, toolUseId: 'retry',
      toolName: 'write_file', descriptor: first.descriptor, ownerId: 'new-worker' }), /重试授权/)
    const corrupt = structuredClone(abandonedEffect)
    corrupt.evidence.at(-1)!.resolutionReceipt!.note = 'forged approval'
    assert.equal(effectRecordIntegrityMatches(corrupt), false)
    checks.push('abandonment persists exact-version human receipt, blocks new lease, and detects receipt tampering')

    const applied = await createWaiting('applied')
    writeFileSync(applied.file, 'expected result')
    const confirmed = await recheckPersistedTaskEffect(applied.snapshot.id, applied.effect.id, applied.effect.revision, { rootDir: root })
    assert.equal(confirmed.run!.effects![0].status, 'confirmed')
    assert.equal(readFileSync(applied.file, 'utf8'), 'expected result')
    assert.equal(confirmed.run!.effects![0].evidence.some(item => item.kind === 'retry_authorized'), false)
    checks.push('positive local file readback confirms original result without writing or repeating it')

    const explicit = await createWaiting('explicit-retry')
    const authorized = await resolvePersistedTaskEffect(explicit.snapshot.id, explicit.effect.id, explicit.effect.revision,
      'confirmed_not_applied', { rootDir: root, note: '核对原目标不存在，允许以后重试' })
    assert(authorized.run!.effects![0].evidence.some(item => item.kind === 'retry_authorized'))
    assert.equal(authorized.meta.permissionMode, explicit.snapshot.meta.permissionMode)
    assert.equal(authorized.run!.effects![0].inputDigest, explicit.effect.inputDigest)
    checks.push('explicit non-execution remains distinct from abandonment without changing permissions or inputs')

    const opaque = await createWaiting('opaque', true)
    assert.equal(opaque.effect.reconcilability, 'opaque')
    const manualOnly = await recheckPersistedTaskEffect(opaque.snapshot.id, opaque.effect.id, opaque.effect.revision, { rootDir: root })
    const manualEffect = manualOnly.run!.effects![0]
    assert.equal(manualEffect.status, 'waiting_reconciliation')
    assert.match(manualEffect.error!, /没有结果查询服务/)
    assert.equal(manualEffect.evidence.some(item => item.kind === 'retry_authorized'), false)
    const humanConfirmed = await resolvePersistedTaskEffect(opaque.snapshot.id, manualEffect.id, manualEffect.revision, 'confirmed_applied',
      { rootDir: root, note: '用户已在原系统核对原始记录' })
    assert.equal(humanConfirmed.run!.effects![0].status, 'confirmed')
    assert.equal(humanConfirmed.run!.effects![0].evidence.at(-1)!.resolutionReceipt!.expectedRevision, manualEffect.revision)
    checks.push('opaque external effects remain manual-only and accept a bound human confirmation receipt')
    console.log(`Task Effect recovery: ${checks.length}/${checks.length} passed\n${checks.join('\n')}\nProvider calls: 0`)
  } finally {
    globalThis.fetch = originalFetch
    taskRuntimeRegistry.clear()
    rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
