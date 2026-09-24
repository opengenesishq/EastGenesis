import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskActivityService, type ActivityEvent, type ActivitySource } from '../src/main/activity/activity-service'

const root = mkdtempSync(join(tmpdir(), 'caogen-activity-boundary-'))
const event = (seq: number, kind: ActivityEvent['kind'] = 'turn-result'): ActivityEvent => ({ kind, eventId: `event-${seq}`, streamId: 'stream-1', seq, occurredAt: seq * 1000 })
const source = (id = 'task-1'): ActivitySource => ({ meta: { id, title: id, createdAt: 100, status: 'idle', sdkSessionId: `sdk-${id}`, projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-1' }, active: true, archived: false, pendingCount: 0, updatedAt: 2000, runId: 'run-1', runStatus: 'completed', events: [event(1)] })
let passed = 0
async function check(name: string, run: (service: TaskActivityService, sources: ActivitySource[], folder: string) => Promise<void>) {
  const folder = join(root, `case-${passed}`), sources = [source()]
  const service = new TaskActivityService(folder, async () => sources)
  await run(service, sources, folder)
  console.log(`PASS ${name}`); passed++
}
async function main() {
  await check('canonical event projections distinguish running, pending approval, empty and archived', async (service, sources) => {
    sources[0].meta.status = 'running'; sources[0].runStatus = 'running'
    sources.push({ ...source('waiting'), pendingCount: 1 }, { ...source('empty'), runStatus: undefined, events: [] }, { ...source('archived'), archived: true })
    const snapshot = await service.list(1)
    assert.equal(snapshot.items.find(item => item.sessionId === 'task-1')?.status, 'running')
    assert.equal(snapshot.items.find(item => item.sessionId === 'waiting')?.status, 'waiting')
    assert.equal(snapshot.items.find(item => item.sessionId === 'empty')?.unread, false)
    assert.equal(snapshot.unreadCount, 2)
  })
  await check('read acknowledgement persists across process service restart', async (service, sources, folder) => {
    const snapshot = await service.list(1); service.mark(1, { snapshotId: snapshot.snapshotId, read: true })
    assert.equal((await new TaskActivityService(folder, async () => sources).list(2)).items[0].unread, false)
  })
  await check('old mark-all cannot consume later events or newly arrived tasks', async (service, sources) => {
    const old = await service.list(1)
    sources[0].events.push(event(2)); sources.push(source('new-task'))
    service.mark(1, { snapshotId: old.snapshotId, read: true })
    const current = await service.list(1)
    assert.equal(current.unreadCount, 2)
    assert.notEqual(old.items[0].sourceVersion, current.items.find(item => item.sessionId === 'task-1')?.sourceVersion)
  })
  await check('stale second window cannot undo newer explicit unread decision', async (service) => {
    const a = await service.list(1), b = await service.list(2)
    service.mark(1, { snapshotId: a.snapshotId, read: true })
    const updated = await service.list(1)
    service.mark(1, { snapshotId: updated.snapshotId, read: false })
    service.mark(2, { snapshotId: b.snapshotId, read: true })
    assert.equal((await service.list(2)).items[0].unread, true)
  })
  await check('resumed same conversation preserves read state but stale navigation cannot redirect', async (service, sources) => {
    const old = await service.list(1); service.mark(1, { snapshotId: old.snapshotId, read: true })
    sources[0].meta.id = 'resumed-task'; sources[0].meta.createdAt = 5000
    sources[0].sessionAliases = ['task-1', 'resumed-task']
    const resumed = await service.list(1)
    assert.equal(resumed.items[0].unread, false)
    assert.equal(resumed.items[0].sourceVersion, old.items[0].sourceVersion)
    await assert.rejects(service.resolve(1, old.snapshotId, old.items[0].id), /身份/)
  })
  await check('different canonical ownership cannot inherit read acknowledgement', async (service, sources) => {
    const old = await service.list(1); service.mark(1, { snapshotId: old.snapshotId, read: true })
    sources[0].meta.workItemId = 'different-work'
    assert.equal((await service.list(1)).items[0].unread, true)
    await assert.rejects(service.resolve(1, old.snapshotId, old.items[0].id), /身份/)
  })
  await check('snapshot ownership, window scope and item membership reject cross-task actions', async (service, sources) => {
    sources.push(source('other-task'))
    const scoped = await service.list(1, 'task-1')
    assert.equal(scoped.items.length, 1)
    assert.throws(() => service.mark(2, { snapshotId: scoped.snapshotId, read: true }, 'task-1'), /窗口/)
    assert.throws(() => service.mark(1, { snapshotId: scoped.snapshotId, read: true }, 'other-task'), /窗口/)
    assert.throws(() => service.mark(1, { snapshotId: scoped.snapshotId, itemIds: ['foreign'], read: true }, 'task-1'), /不属于/)
    await assert.rejects(service.resolve(1, scoped.snapshotId, scoped.items[0].id), /窗口/)
  })
  await check('run replacement invalidates navigation and archived records retain their original destination', async (service, sources) => {
    const old = await service.list(1); sources[0].runId = 'run-2'
    await assert.rejects(service.resolve(1, old.snapshotId, old.items[0].id), /运行已变化/)
    sources[0].active = false; sources[0].historyId = 'history-1'; sources[0].archived = true
    const current = await service.list(1)
    assert.deepEqual(await service.resolve(1, current.snapshotId, current.items[0].id), { kind: 'history', sessionId: 'task-1', historyId: 'history-1', recoverySnapshotId: undefined })
  })
  await check('navigation revalidates canonical source rather than cached list', async (_service, sources, folder) => {
    const flags: Array<boolean | undefined> = []
    const service = new TaskActivityService(folder, async fresh => { flags.push(fresh); return sources })
    const snapshot = await service.list(1); await service.resolve(1, snapshot.snapshotId, snapshot.items[0].id)
    assert.deepEqual(flags, [undefined, true])
  })
  await check('hundreds of unchanged refreshes reuse snapshot and changing activity remains usable', async (service, sources) => {
    const first = await service.list(1)
    for (let index = 0; index < 600; index++) { sources[0].updatedAt++; assert.equal((await service.list(1)).snapshotId, first.snapshotId) }
    let last = first
    for (let index = 2; index < 350; index++) { sources[0].events = [event(index)]; last = await service.list(1) }
    service.mark(1, { snapshotId: last.snapshotId, read: true })
    assert.equal((await service.list(1)).items[0].unread, false)
    assert.throws(() => service.mark(1, { snapshotId: first.snapshotId, read: true }), /过期/)
  })
  await check('distinct concurrent sessions retain distinct navigation IDs', async (service, sources) => {
    sources.push({ ...source('parallel'), meta: { ...sources[0].meta, id: 'parallel' } })
    const snapshot = await service.list(1)
    assert.equal(new Set(snapshot.items.map(item => item.id)).size, 2)
  })
  await check('corrupt read state fails visibly and remains untouched', async (service, _sources, folder) => {
    const initial = await service.list(1); service.mark(1, { snapshotId: initial.snapshotId, read: true })
    const file = join(folder, 'activity-read-receipts.json')
    writeFileSync(file, '{broken')
    await assert.rejects(service.list(1))
    assert.equal(readFileSync(file, 'utf8'), '{broken')
  })
  console.log(`activity-boundary-required: ${passed}/${passed} passed (offline; no provider calls)`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => rmSync(root, { recursive: true, force: true }))
