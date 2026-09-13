import assert from 'node:assert/strict'
import { seed, code, assertUnbound } from './frozen-routing-fixture.mjs'

export async function evidenceChecks(api, stage, check) {
  const evidence = [
    ['started', { startedAt: 110 }], ['cursor', { lastAppliedEventSeq: 1 }],
    ['request event', { lastEventKind: 'user-message' }], ['retry', { attempt: 2 }],
    ['recovery', { recoveryCount: 1 }], ['permission', { pendingPermissionRequestId: 'approval-a' }],
    ['planning status', { status: 'planning' }], ['historical error', { error: 'prior unknown' }]
  ]
  for (const [name, changes] of evidence) await check(`queued label cannot conceal ${name} evidence`, async () => {
    const f = await seed(api, stage, `evidence-${name.replaceAll(' ', '-')}`, changes)
    await assert.rejects(api.binding.bindFrozenRunRoutingPolicy(f.input, f.root), code('RUN_ALREADY_STARTED'))
    await assertUnbound(api, f)
  })
  await check('persisted user message rejects first binding even without Run cursor', async () => {
    const f = await seed(api, stage, 'message')
    const snapshot = api.snap.buildTaskSnapshot({ meta: f.meta, transcript: [{ seq: 1, eventId: `event-${f.policy.messageId}`, streamId: f.meta.id, occurredAt: 110, event: { kind: 'user-message', messageId: f.policy.messageId, text: 'already submitted' } }],
      lastSeq: 1, eventCount: 1, reason: 'important-event', run: f.run, now: 120 })
    await api.snap.saveTaskSnapshot(snapshot, f.root)
    await assert.rejects(api.binding.bindFrozenRunRoutingPolicy(f.input, f.root), code('RUN_ALREADY_STARTED'))
  })
  for (const status of ['completed', 'failed', 'executing']) await check(`old ${status} conversation ${status === 'completed' ? 'permits' : 'blocks'} a pristine next Run`, async () => {
    const f = await seed(api, stage, `history-${status}`)
    if (status === 'executing') {
      const executing = { ...f.run, status, revision: 2, updatedAt: 150, startedAt: 110 }
      const snapshot = api.snap.buildTaskSnapshot({ meta: f.meta, transcript: [{ seq: 1, eventId: `event-history-${status}-1`, streamId: f.meta.id, occurredAt: 110, event: { kind: 'user-message', messageId: 'old-message', text: 'old request' } }], lastSeq: 1, eventCount: 1, reason: 'important-event', run: executing, now: 150 })
      await api.snap.saveTaskSnapshot(snapshot, f.root)
      const policy = api.policy.sealFrozenRoutingPolicy(f.draft)
      await assert.rejects(api.binding.bindFrozenRunRoutingPolicy({ ...f.input, expectedRunRevision: 2, policy }, f.root), code('RUN_ALREADY_STARTED'))
      return
    }
    const previous = { ...f.run, status, revision: 2, updatedAt: 150, startedAt: 110,
      ...(status === 'executing' ? {} : { finishedAt: 150 }), lastAppliedEventSeq: 2, lastAppliedEventId: 'history-2' }
    const transcript = [{ seq: 1, eventId: `event-history-${status}-1`, streamId: f.meta.id, occurredAt: 110, event: { kind: 'user-message', messageId: 'old-message', text: 'old request' } },
      { seq: 2, eventId: `event-history-${status}-2`, streamId: f.meta.id, occurredAt: 120, event: { kind: 'turn-result', isError: status !== 'completed', durationMs: 10, costUsd: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } } }]
    const old = api.snap.buildTaskSnapshot({ meta: f.meta, transcript, lastSeq: 2, eventCount: 2, reason: 'important-event', run: previous, now: 150 })
    await api.snap.saveTaskSnapshot(old, f.root)
    const next = { ...f.run, id: `${f.run.id}-next`, revision: 3, createdAt: 200, updatedAt: 200 }
    const fresh = api.snap.buildTaskSnapshot({ meta: f.meta, transcript, lastSeq: 2, eventCount: 2, reason: 'important-event', run: next, now: 200 })
    await api.snap.saveTaskSnapshot(fresh, f.root)
    const work = await f.workspace.getWorkItem(f.meta.workItemId)
    await f.commands.updateWorkItem(work.id, { runRefs: [...work.runRefs, next.id] }, { expectedRevision: work.revision })
    const policy = api.policy.sealFrozenRoutingPolicy({ ...f.draft, owner: { ...f.draft.owner, runId: next.id } })
    const bind = () => api.binding.bindFrozenRunRoutingPolicy({ ...f.input, runId: next.id, expectedRunRevision: next.revision, policy }, f.root)
    if (status === 'completed') assert.equal((await bind()).routingPolicy.policyDigest, policy.policyDigest)
    else await assert.rejects(bind(), code('RUN_ALREADY_STARTED'))
  })
}
