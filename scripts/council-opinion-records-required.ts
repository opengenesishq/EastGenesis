import assert from 'node:assert/strict'
import { readCouncilOpinionRecords } from '../src/renderer/src/components/experience/council-opinion-records'
import type { CouncilRecord } from '../src/shared/council-types'
import type { SessionMeta, TaskSnapshotRecord, TranscriptEntry } from '../src/shared/types'

const opinion = { sessionId: 'council-1', institutionId: 'neige', status: 'completed' as const }
const record = { sessionId: 'parent', councilId: 'council', projectId: 'project', goalId: 'goal', workItemId: 'work',
  opinions: [opinion] } as CouncilRecord
const meta = { id: opinion.sessionId, parentSessionId: 'parent', orchestrationId: 'council', childTaskId: 'neige',
  childRole: 'council:neige', workspaceId: 'project', goalId: 'goal', workItemId: 'council-1-review', status: 'idle' } as SessionMeta
const transcript = [{ seq: 1, event: { kind: 'assistant-message', text: 'Original advice' } }] as TranscriptEntry[]
const snapshot = { sessionId: opinion.sessionId, meta, transcript, updatedAt: 42 } as TaskSnapshotRecord
function fixture() {
  const calls: string[] = []
  const host = {
    councilGet: async () => ({ sessionId: record.sessionId, history: [record] }) as any,
    listSessions: async () => [meta],
    syncSession: async (id: string) => { calls.push(`sync:${id}`); return true },
    session: () => meta,
    getTranscript: async (id: string) => { calls.push(`transcript:${id}`); return transcript },
    listHistory: async () => [],
    listTaskSnapshots: async () => [snapshot]
  }
  return { host, calls }
}
async function main() {
  let passed = 0
  const check = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`) }
  await check('live-opinion-syncs-exact-child-and-reads-existing-transcript', async () => {
    const f = fixture(), result = await readCouncilOpinionRecords(record, opinion, f.host)
    assert.equal(result.source, 'live'); assert.equal(result.transcript, transcript)
    assert.deepEqual(f.calls, ['sync:council-1', 'transcript:council-1'])
  })
  await check('closed-child-reads-bound-snapshot-without-creating-session', async () => {
    const f = fixture(); f.host.listSessions = async () => []
    const result = await readCouncilOpinionRecords(record, opinion, f.host)
    assert.equal(result.source, 'snapshot'); assert.equal(result.capturedAt, 42)
    assert.equal(result.transcript, transcript); assert.deepEqual(f.calls, [])
  })
  await check('missing-transcript-remains-explicitly-unavailable', async () => {
    const f = fixture(); f.host.listSessions = async () => []; f.host.listTaskSnapshots = async () => []
    const result = await readCouncilOpinionRecords(record, opinion, f.host)
    assert.equal(result.source, 'unavailable'); assert.deepEqual(result.transcript, [])
  })
  await check('foreign-council-or-child-identity-is-rejected', async () => {
    for (const patch of [{ parentSessionId: 'other' }, { orchestrationId: 'other' }, { workspaceId: 'other' },
      { goalId: 'other' }, { workItemId: 'other' }, { childTaskId: 'other' }, { childRole: 'other' }]) {
      const f = fixture(); f.host.session = () => ({ ...meta, ...patch })
      await assert.rejects(readCouncilOpinionRecords(record, opinion, f.host), /归属/)
      assert(!f.calls.some(call => call.startsWith('transcript:')))
    }
    const f = fixture(); f.host.councilGet = async () => ({ sessionId: record.sessionId, history: [{ ...record, opinions: [] }] }) as any
    await assert.rejects(readCouncilOpinionRecords(record, opinion, f.host), /议事记录/)
    assert.deepEqual(f.calls, [])
  })
  await check('foreign-or-corrupt-snapshot-cannot-be-presented-as-original-opinion', async () => {
    for (const entry of [{ ...snapshot, meta: { ...meta, parentSessionId: 'other' } },
      { ...snapshot, conversationLedger: { valid: false, schemaVersion: 1, mode: 'sealed', entryCount: 1 } } as TaskSnapshotRecord]) {
      const f = fixture(); f.host.listSessions = async () => []; f.host.listTaskSnapshots = async () => [entry]
      await assert.rejects(readCouncilOpinionRecords(record, opinion, f.host))
    }
  })
  console.log(`Council opinion records: ${passed}/${passed}; no Provider calls or session creation.`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
