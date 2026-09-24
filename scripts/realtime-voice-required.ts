import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'
import { SessionInputService } from '../src/main/task/session-input-service'
import { createVoiceInputService } from '../src/main/voice-input/service'
import { createRealtimeVoiceService } from '../src/main/voice-input/realtime-service'
import { createVoiceReplyPlayback } from '../src/renderer/src/components/voice-reply-playback'
import { controlRealtimeVoiceTask } from '../src/main/voice-input/realtime-task-control'
import type { SupervisorRunRecord } from '../src/shared/supervisor-types'

const roots: string[] = []
const originalFetch = globalThis.fetch
let providerCalls = 0, checks = 0
globalThis.fetch = async () => { providerCalls++; throw new Error('Network forbidden in offline voice fixture') }
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  await run(); checks++; console.log(`PASS ${name}`)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caogen-realtime-voice-')); roots.push(root)
  const meta = { id: 'session-a', workspaceId: 'workspace-a', goalId: 'goal-a', workItemId: 'work-a', status: 'idle' } as SessionMeta
  let transcription = '给当前任务补充来源', transcriptions = 0, interruptions = 0, accepted = true
  let transcribeBarrier: Promise<void> | undefined, preflightBarrier: Promise<void> | undefined
  const preflightEntered = deferred<void>()
  const sent = new Set<string>()
  const inputs = new SessionInputService(root, {
    meta: id => id === meta.id ? meta : undefined,
    preflight: async () => { preflightEntered.resolve(); await preflightBarrier },
    send: async (id, payload) => { assert.equal(id, meta.id); sent.add(payload.messageId!); return accepted },
    accepted: async record => accepted && sent.has(record.messageId)
  })
  const voice = createVoiceInputService({
    target: () => ({ providerId: 'offline-fixture', providerName: 'Offline fixture', model: 'fixture-asr', baseUrl: 'https://invalid.invalid', identity: 'fixture-connection' }),
    execute: async () => { transcriptions++; await transcribeBarrier; return transcription },
    reserve: () => ({ sent() {}, finish() {} }), saveUsage() {}
  })
  const service = createRealtimeVoiceService({ voice, inputs, session: id => id === meta.id ? meta : undefined,
    control: async (id, action) => { assert.equal(id, meta.id); assert.ok(['pause', 'cancel'].includes(action)); interruptions++; meta.status = 'idle' } })
  const prepared = service.prepare(1, meta.id)
  const segment = (sequence: number) => ({ callId: prepared.callId, segmentId: randomUUID(), sequence,
    audio: new Uint8Array(128).buffer, mimeType: 'audio/wav', durationMs: 1000 })
  return { service, prepared, segment, inputs, meta, sent,
    start: () => service.start(1, prepared.callId), transcriptions: () => transcriptions, interruptions: () => interruptions,
    transcript: (text: string) => { transcription = text }, accept: (value: boolean) => { accepted = value },
    waitForTranscription: (promise: Promise<void>) => { transcribeBarrier = promise },
    preflightEntered: preflightEntered.promise,
    waitForPreflight: (promise: Promise<void>) => { preflightBarrier = promise } }
}

async function main(): Promise<void> {
  await check('explicit start, owner, session identity, ordered segments and completed duplicate idempotency', async () => {
    const f = fixture(), one = f.segment(0)
    assert.throws(() => f.service.segment(1, one), /停止/)
    assert.throws(() => f.service.start(2, f.prepared.callId), /停止/)
    f.start()
    assert.throws(() => f.service.segment(1, f.segment(1)), /顺序/)
    const first = f.service.segment(1, one)
    assert.equal(f.service.segment(1, one), first)
    const receipt = await first
    assert.equal(f.service.segment(1, one), first)
    assert.throws(() => f.service.segment(1, { ...one, audio: new Uint8Array(129).buffer }), /替换/)
    assert.equal(receipt.input?.sessionId, 'session-a'); assert.equal(receipt.input?.workItemId, 'work-a')
    assert.equal(receipt.input?.phase, 'queued'); assert.equal(f.transcriptions(), 1)
    await f.service.segment(1, f.segment(1))
    assert.equal((await f.inputs.list('session-a')).length, 2)
    await f.service.stop(1, f.prepared.callId)
  })
  await check('running input waits; idle resumes automatically through durable original-task receipts exactly once', async () => {
    const f = fixture(); f.start(); f.meta.status = 'running'
    await f.service.segment(1, f.segment(0))
    assert.equal((await f.service.drain(1, f.prepared.callId))[0].phase, 'queued'); assert.equal(f.sent.size, 0)
    f.meta.status = 'idle'
    const [one, two] = await Promise.all([f.service.drain(1, f.prepared.callId), f.service.drain(1, f.prepared.callId)])
    assert.equal(one[0].phase, 'applied'); assert.deepEqual(one, two)
    await f.service.drain(1, f.prepared.callId); assert.equal(f.sent.size, 1)
    await f.service.stop(1, f.prepared.callId)
  })
  await check('older non-voice inputs are never bypassed and uncertain dispatch is never replayed', async () => {
    const f = fixture(); f.start()
    await f.inputs.queue('session-a', 'earlier', { text: '先处理这个要求' })
    await f.service.segment(1, f.segment(0))
    await f.service.drain(1, f.prepared.callId); assert.equal(f.sent.size, 0)
    await f.inputs.cancel('session-a', 'earlier'); f.accept(false)
    assert.equal((await f.service.drain(1, f.prepared.callId))[0].phase, 'needs_reconciliation')
    await f.service.drain(1, f.prepared.callId); assert.equal(f.sent.size, 1)
    await f.service.stop(1, f.prepared.callId)
  })
  await check('stopping cancels ASR and late results cannot queue into a switched task', async () => {
    const f = fixture(); f.start(); const gate = deferred<void>(); f.waitForTranscription(gate.promise)
    const pending = f.service.segment(1, f.segment(0))
    const rejected = assert.rejects(pending, /取消|停止/)
    await Promise.resolve(); await Promise.resolve()
    await f.service.stop(1, f.prepared.callId); gate.resolve()
    await rejected
    assert.equal((await f.inputs.list('session-a')).length, 0); assert.equal(f.sent.size, 0)
  })
  await check('stop during preflight blocks dispatch and withdraws the preserved transcript', async () => {
    const f = fixture(); f.start(); const gate = deferred<void>(); f.waitForPreflight(gate.promise)
    await f.service.segment(1, f.segment(0))
    const draining = f.service.drain(1, f.prepared.callId)
    const rejected = assert.rejects(draining, /停止/)
    await f.preflightEntered
    await f.service.stop(1, f.prepared.callId); gate.resolve(); await rejected
    assert.equal(f.sent.size, 0)
    const saved = (await f.inputs.list('session-a'))[0]
    assert.equal(saved.phase, 'cancelled'); assert.equal(saved.payload.text, '给当前任务补充来源')
  })
  await check('pause/cancel utterances and controls invoke real task interrupt; quoted phrases stay ordinary input', async () => {
    for (const text of ['暂停这个任务。', '取消当前任务']) {
      const f = fixture(); f.start(); f.transcript(text)
      const receipt = await f.service.segment(1, f.segment(0))
      assert.notEqual(receipt.action, 'input'); assert.equal(f.interruptions(), 1); assert.equal(f.sent.size, 0)
      assert.equal((await f.inputs.list('session-a')).length, 0)
    }
    const f = fixture(); f.start(); f.transcript('请解释“暂停这个任务”')
    assert.equal((await f.service.segment(1, f.segment(0))).action, 'input')
    await f.service.control(1, { callId: f.prepared.callId, command: 'cancel' })
    assert.equal(f.interruptions(), 1); assert.equal((await f.inputs.list('session-a'))[0].phase, 'cancelled')
  })
  await check('closed tasks and oversized/out-of-order audio cannot reach transcription', async () => {
    const f = fixture(); f.start()
    assert.throws(() => f.service.segment(1, { ...f.segment(0), durationMs: 30_001 }), /时长/)
    assert.throws(() => f.service.segment(1, { ...f.segment(0), audio: new ArrayBuffer(21 * 1024 * 1024) }), /格式/)
    f.meta.status = 'closed'
    assert.throws(() => f.service.segment(1, f.segment(0)), /关闭/)
    assert.equal(f.transcriptions(), 0)
    await f.service.cancelOwner(1)
  })
  await check('TTS interruption invalidates old callbacks and clears queued speech before a new reply', () => {
    const spoken: string[] = [], callbacks: Array<(error?: string) => void> = []
    let cancellations = 0
    const playback = createVoiceReplyPlayback({ speak(text, done) { spoken.push(text); callbacks.push(done) }, cancel() { cancellations++ } }, () => undefined)
    playback.enqueue('第一句。'); playback.enqueue('不应继续播放。')
    assert.equal(playback.speaking, true); playback.interrupt(); callbacks[0]()
    assert.equal(spoken.length, 1); assert.equal(playback.speaking, false); assert.equal(cancellations, 1)
    playback.enqueue('新的任务回复。'); callbacks[1]()
    assert.equal(spoken[1], '新的任务回复。'); assert.equal(playback.speaking, false)
    playback.enqueue('失败。'); playback.enqueue('错误后不继续。'); callbacks[2]('local voice unavailable')
    assert.equal(spoken.length, 3); assert.equal(playback.speaking, false)
  })
  await check('canonical pause and cancel disable continuation before distinct Supervisor controls', async () => {
    const meta = { id: 'session-a', workspaceId: 'workspace-a', goalId: 'goal-a', workItemId: 'work-a', status: 'running' } as SessionMeta
    const run = { id: 'run-a', projectId: 'workspace-a', goalId: 'goal-a', workItemId: 'work-a', revision: 1, status: 'running' } as SupervisorRunRecord
    for (const action of ['pause', 'cancel'] as const) {
      const calls: string[] = []
      await controlRealtimeVoiceTask({ session: () => meta, runId: () => 'run-a', getRun: async () => run,
        pauseContinuations: async () => { calls.push('pause-continuation') },
        claimLease: async () => { calls.push('lease'); return { ...run, revision: 2, lease: { id: 'lease', ownerId: 'local-operator', fencingToken: 1, acquiredAt: 0, heartbeatAt: 0, expiresAt: 100 } } },
        control: async request => { calls.push(request.action); assert.equal(request.options.expectedRevision, action === 'pause' ? 2 : 1); return { sessionId: 'session-a' } },
        interrupt: async () => { throw new Error('Canonical controls must not silently fall back to interrupt') }
      }, 'session-a', action)
      assert.deepEqual(calls, action === 'pause' ? ['pause-continuation', 'lease', 'pause'] : ['pause-continuation', 'cancel'])
    }
  })
  assert.equal(providerCalls, 0)
  console.log(`RESULT ${checks}/${checks}; external Provider/network calls: ${providerCalls}; microphone and real TTS not exercised.`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  globalThis.fetch = originalFetch
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
