import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SendMessagePayload, SessionMeta } from '../src/shared/types'
import { SessionInputService, type SessionInputRuntime } from '../src/main/task/session-input-service'
import { sessionInputIntent } from '../src/renderer/src/components/composer/session-input-intent'
import { messagePayloadDigest } from '../src/main/message-payload-digest'

const roots: string[] = []
let passed = 0
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  await run()
  passed++
  console.log(`PASS ${name}`)
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caogen-session-input-'))
  roots.push(root)
  let meta = { id: 'session-a', workspaceId: 'project-a', goalId: 'goal-a', workItemId: 'work-a', status: 'running' } as SessionMeta
  let sends = 0
  let accepted = false
  let behavior: () => Promise<boolean> = async () => { accepted = true; return true }
  const runtime: SessionInputRuntime = {
    meta: (id) => id === meta.id ? meta : undefined,
    send: async (id, payload) => {
      assert.equal(id, 'session-a')
      assert.ok(payload.messageId?.startsWith('session-input:session-a:'))
      sends++
      return behavior()
    },
    accepted: async () => accepted
  }
  const service = new SessionInputService(root, runtime)
  const file = () => {
    const dir = join(root, 'private', 'session-inputs')
    const sessionDir = join(dir, readdirSync(dir)[0])
    return join(sessionDir, readdirSync(sessionDir).find((name) => name.endsWith('.json'))!)
  }
  return { service, root, runtime, file, sends: () => sends,
    updateMeta: (patch: Partial<SessionMeta>) => { meta = { ...meta, ...patch } },
    accept: () => { accepted = true },
    behave: (next: () => Promise<boolean>) => { behavior = next } }
}

async function main(): Promise<void> {
  await check('running additions persist unchanged in the original task without execution', async () => {
    const f = fixture()
    const record = await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    assert.equal(f.sends(), 0)
    assert.equal(record.workItemId, 'work-a')
    assert.equal(record.phase, 'queued')
    const restored = new SessionInputService(f.root, f.runtime)
    assert.deepEqual(await restored.list('session-a'), [record])
    assert.deepEqual(await restored.list('session-b'), [])
  })
  await check('retrying a saved request preserves identity and conflicting content is rejected', async () => {
    const f = fixture()
    const one = await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    assert.deepEqual(await f.service.queue('session-a', 'input-a', { text: '第二页补来源' }), one)
    await assert.rejects(f.service.queue('session-a', 'input-a', { text: '换掉目标' }), /不同补充要求/)
  })
  await check('apply cannot send while running, and retains the pending requirement', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    await assert.rejects(f.service.apply('session-a', 'input-a'), /仍在运行/)
    assert.equal(f.sends(), 0)
    assert.equal((await f.service.list('session-a'))[0].phase, 'queued')
  })
  await check('explicit continuation invokes the original send path exactly once across duplicate clicks and restart', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    f.updateMeta({ status: 'idle' })
    const [one, two] = await Promise.all([f.service.apply('session-a', 'input-a'), f.service.apply('session-a', 'input-a')])
    assert.equal(one.phase, 'applied')
    assert.deepEqual(one, two)
    const restored = new SessionInputService(f.root, f.runtime)
    await restored.apply('session-a', 'input-a')
    assert.equal(f.sends(), 1)
  })
  await check('ownership drift blocks continuation before send', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    f.updateMeta({ status: 'idle', workItemId: 'work-b' })
    await assert.rejects(f.service.apply('session-a', 'input-a'), /归属不一致/)
    assert.equal(f.sends(), 0)
  })
  await check('false acceptance stays unresolved and cannot be blindly replayed', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    f.updateMeta({ status: 'idle' })
    f.behave(async () => false)
    assert.equal((await f.service.apply('session-a', 'input-a')).phase, 'needs_reconciliation')
    const restored = new SessionInputService(f.root, f.runtime)
    await assert.rejects(restored.apply('session-a', 'input-a'), /未确认接收/)
    assert.equal(f.sends(), 1)
  })
  await check('boolean true without durable acceptance evidence cannot discard the saved requirement', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    f.updateMeta({ status: 'idle' })
    f.behave(async () => true)
    assert.equal((await f.service.apply('session-a', 'input-a')).phase, 'needs_reconciliation')
    assert.equal(f.sends(), 1)
  })
  await check('positive original-ledger evidence reconciles a false or lost response', async () => {
    for (const fail of ['false', 'throw']) {
      const f = fixture()
      await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
      f.updateMeta({ status: 'idle' })
      f.behave(async () => { f.accept(); if (fail === 'throw') throw new Error('response lost'); return false })
      assert.equal((await f.service.apply('session-a', 'input-a')).phase, 'applied')
      assert.equal(f.sends(), 1)
    }
  })
  await check('crashed dispatch barrier requires evidence, never elapsed time, to resolve', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    const path = f.file()
    const record = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...record, phase: 'dispatching' }))
    const restored = new SessionInputService(f.root, f.runtime)
    assert.equal((await restored.list('session-a'))[0].phase, 'needs_reconciliation')
    f.accept()
    assert.equal((await restored.list('session-a'))[0].phase, 'applied')
    assert.equal(f.sends(), 0)
  })
  await check('queued cancellation cannot execute and preserves its receipt', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    assert.equal((await f.service.cancel('session-a', 'input-a')).phase, 'cancelled')
    await assert.rejects(f.service.apply('session-a', 'input-a'))
    assert.equal(f.sends(), 0)
  })
  await check('corrupt receipt and path-like identity fail closed', async () => {
    const f = fixture()
    await f.service.queue('session-a', 'input-a', { text: '第二页补来源' })
    writeFileSync(f.file(), '{broken')
    await assert.rejects(f.service.list('session-a'))
    await assert.rejects(f.service.queue('../session-a', 'input-a', { text: '内容' }), /标识无效/)
    assert.equal(f.sends(), 0)
  })
  await check('local controls use exact unquoted requests; supplemental content stays ordinary input', () => {
    assert.equal(sessionInputIntent('暂停这个任务。'), 'pause')
    assert.equal(sessionInputIntent('去故宫看看'), 'palace')
    assert.equal(sessionInputIntent('换一个更快的模型'), 'model')
    assert.equal(sessionInputIntent('“暂停这个任务”这句话请加入演示稿'), 'message')
    assert.equal(sessionInputIntent('暂停这个任务', true), 'message')
    assert.equal(sessionInputIntent('第二页补来源'), 'message')
  })
  await check('acceptance digest binds document versions and Office intent, while transport message id is independent', () => {
    const payload = { text: '补来源', documents: [{ id: 'doc-a', hash: 'v1' }],
      officeRevisionIntent: { baseArtifactId: 'artifact-a', baseDigest: 'version-a' } } as unknown as SendMessagePayload
    const digest = messagePayloadDigest(payload)
    assert.equal(messagePayloadDigest({ ...payload, messageId: 'transport-id' }), digest)
    assert.notEqual(messagePayloadDigest({ ...payload, documents: [{ ...payload.documents![0], hash: 'v2' }] }), digest)
    assert.notEqual(messagePayloadDigest({ ...payload, officeRevisionIntent: undefined }), digest)
    assert.notEqual(messagePayloadDigest({ ...payload, text: '改目标' }), digest)
  })
  console.log(`session-input: ${passed}/${passed} passed (local fixtures; no Provider calls)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
