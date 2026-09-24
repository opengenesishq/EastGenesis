import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SendMessagePayload, SessionMeta } from '../src/shared/types'
import { SessionInputService } from '../src/main/task/session-input-service'
import { SessionFollowUpCoordinator } from '../src/main/task/session-follow-up-coordinator'
import { assertSessionFollowUpMessageCurrent, pauseSessionFollowUps } from '../src/main/task/session-follow-up-gate'
import { normalizeSessionFollowUpBehavior } from '../src/shared/session-follow-up'

const roots: string[] = []
let passed = 0
async function check(name: string, body: () => Promise<void>): Promise<void> { await body(); passed++; console.log(`PASS ${name}`) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caogen-follow-up-')); roots.push(root)
  let meta = { id: 'session-a', createdAt: 42, status: 'running' } as SessionMeta
  const accepted = new Set<string>()
  const sent: SendMessagePayload[] = []
  let pauses = 0
  let safe = true
  let acknowledge = true
  let beforeEngine = async (): Promise<void> => {}
  const service = new SessionInputService(root, {
    meta: id => id === meta.id ? meta : undefined,
    accepted: async record => accepted.has(record.messageId),
    send: async (id, payload) => {
      await beforeEngine()
      assertSessionFollowUpMessageCurrent(root, id, payload.messageId, meta)
      sent.push(payload)
      meta = { ...meta, status: 'running' }
      if (acknowledge) accepted.add(payload.messageId!)
      return acknowledge
    }
  })
  const coordinator = new SessionFollowUpCoordinator(root, service, {
    meta: () => meta,
    pause: async (_id, messageId) => { pauses++; pauseSessionFollowUps(root, meta.id, messageId); meta = { ...meta, status: 'idle' } },
    barrier: async () => {},
    assertSafe: () => { if (!safe) throw new Error('外部结果待核对') }
  })
  return { root, service, coordinator, sent, pauses: () => pauses,
    update: (patch: Partial<SessionMeta>) => { meta = { ...meta, ...patch } },
    stop: () => pauseSessionFollowUps(root, meta.id),
    unsafe: () => { safe = false }, unknown: () => { acknowledge = false },
    beforeEngine: (value: () => Promise<void>) => { beforeEngine = value },
    receiptPath: () => { const dir = join(root, 'private', 'session-inputs'); const sub = join(dir, readdirSync(dir)[0]); return join(sub, readdirSync(sub)[0]) }
  }
}

async function main(): Promise<void> {
  await check('default queues and preserves the original task/message once across concurrent drains', async () => {
    assert.equal(normalizeSessionFollowUpBehavior(undefined), 'queue')
    const f = fixture()
    const record = await f.service.queue('session-a', 'one', { text: '第二页补来源' }, { followUpBehavior: 'queue' })
    await f.coordinator.drain('session-a'); assert.equal(f.sent.length, 0)
    f.update({ status: 'idle' })
    await Promise.all([f.coordinator.drain('session-a'), f.coordinator.drain('session-a')])
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].messageId, record.messageId)
    assert.equal((await f.service.list('session-a'))[0].phase, 'applied')
    await f.coordinator.drain('session-a'); assert.equal(f.sent.length, 1)
  })
  await check('safe pause applies in the original session after the executor has stopped', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'one', { text: '改用最新数据' }, { followUpBehavior: 'pause_and_apply' })
    await f.coordinator.drain('session-a')
    assert.equal(f.pauses(), 1); assert.equal(f.sent.length, 1)
    assert.equal((await f.service.list('session-a'))[0].phase, 'applied')
  })
  await check('withdrawal and explicit stop suppress automatic sends; manual continuation remains possible', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'one', { text: '撤回我' }, { followUpBehavior: 'queue' })
    await f.service.cancel('session-a', 'one')
    await f.service.queue('session-a', 'two', { text: '保留我' }, { followUpBehavior: 'queue' })
    f.stop(); f.update({ status: 'idle' }); await f.coordinator.drain('session-a')
    assert.equal(f.sent.length, 0)
    assert.equal((await f.service.list('session-a')).find(item => item.id === 'two')?.followUp?.state, 'paused')
    await f.service.apply('session-a', 'two'); assert.equal(f.sent.length, 1)
  })
  await check('stop during send authorization is checked again before the execution engine', async () => {
    const f = fixture(); const entered = deferred(); const release = deferred()
    f.update({ status: 'idle' })
    f.beforeEngine(async () => { entered.resolve(); await release.promise })
    await f.service.queue('session-a', 'one', { text: '不能晚发' }, { followUpBehavior: 'queue' })
    const draining = f.coordinator.drain('session-a')
    await entered.promise; f.stop(); release.resolve(); await draining
    assert.equal(f.sent.length, 0)
    assert.equal((await f.service.list('session-a'))[0].phase, 'needs_reconciliation')
    await f.coordinator.drain('session-a'); assert.equal(f.sent.length, 0)
  })
  await check('unknown acceptance blocks automatic retries and later queued inputs', async () => {
    const f = fixture(); f.update({ status: 'idle' }); f.unknown()
    await f.service.queue('session-a', 'one', { text: '结果未知' }, { followUpBehavior: 'queue' })
    await f.service.queue('session-a', 'two', { text: '不能越过' }, { followUpBehavior: 'queue' })
    await f.coordinator.drain('session-a'); f.update({ status: 'idle' })
    await f.coordinator.drain('session-a')
    assert.equal(f.sent.length, 1)
    assert.equal((await f.service.list('session-a'))[0].phase, 'needs_reconciliation')
  })
  await check('unresolved effects stop pause-and-apply before a new turn', async () => {
    const f = fixture(); f.unsafe()
    await f.service.queue('session-a', 'one', { text: '不要重复外部操作' }, { followUpBehavior: 'pause_and_apply' })
    await f.coordinator.drain('session-a')
    const record = (await f.service.list('session-a'))[0]
    assert.equal(f.sent.length, 0); assert.equal(record.phase, 'queued'); assert.equal(record.followUp?.state, 'paused')
    assert.match(record.error!, /待核对/)
  })
  await check('old process permits cannot silently resume and original session creation remains bound', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'one', { text: '原任务' }, { followUpBehavior: 'queue' })
    const path = f.receiptPath(); const record = JSON.parse(readFileSync(path, 'utf8'))
    record.followUp.token = 'a-previous-process-token'; writeFileSync(path, JSON.stringify(record))
    f.update({ status: 'idle' }); await f.coordinator.drain('session-a'); assert.equal(f.sent.length, 0)
    assert.equal((await f.service.list('session-a'))[0].followUp?.state, 'paused')
    f.update({ createdAt: 43 }); await assert.rejects(f.service.apply('session-a', 'one'), /归属不一致/)
  })
  await check('manual inputs block later automatic inputs without changing their content', async () => {
    const f = fixture(); f.update({ status: 'idle' })
    await f.service.queue('session-a', 'one', { text: '先检查我' }, { followUpBehavior: 'manual' })
    await f.service.queue('session-a', 'two', { text: '下一轮' }, { followUpBehavior: 'queue' })
    await f.coordinator.drain('session-a'); assert.equal(f.sent.length, 0)
    await f.service.apply('session-a', 'one'); f.update({ status: 'idle' })
    await f.coordinator.drain('session-a'); assert.equal(f.sent.length, 2)
    assert.deepEqual(f.sent.map(item => item.text), ['先检查我', '下一轮'])
  })
  console.log(`session-follow-up: ${passed}/${passed} passed (local fixtures; no Provider calls)`)
}
main().finally(() => roots.forEach(root => rmSync(root, { recursive: true, force: true }))).catch(error => { console.error(error); process.exitCode = 1 })
