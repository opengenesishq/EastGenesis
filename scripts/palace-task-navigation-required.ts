import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { preparePalaceTaskNavigation } from '../src/renderer/src/components/office/palaceTaskNavigation'
import type { SessionMeta, WorkflowLedgerRendererSelection } from '../src/shared/types'
import type { WorkInboxItem } from '../src/shared/work-inbox-projection'

const checks: { id: string; status: 'passed' }[] = []
const item = { id: 'row', sourceKind: 'work_item', sourceId: 'work', projectId: 'project', goalId: 'goal',
  workItemId: 'work', runId: 'old-run', lane: 'needs_confirmation', status: 'waiting_approval',
  title: 'Task', artifactIds: [], updatedAt: 1 } as WorkInboxItem
const meta = (id = 'current-session'): SessionMeta => ({ id, workspaceId: 'project', goalId: 'goal',
  workItemId: 'work', title: 'Task', status: 'idle' }) as SessionMeta

function fixture() {
  let current = true
  let currentRun = 'current-run'
  let omitRun = false
  let hydrated = meta()
  const calls: string[] = []
  const sessions = [meta('old-session'), meta()]
  const host = {
    readLedger: async () => {
      calls.push('ledger')
      return { workItems: { items: [{ id: 'work', projectId: 'project', goalId: 'goal',
        currentRunId: currentRun, runIds: ['old-run', 'current-run', 'reassigned-run'] }] },
      runs: { items: omitRun ? [] : [{ id: currentRun, projectId: 'project', goalId: 'goal', workItemId: 'work',
        sessionId: currentRun === 'reassigned-run' ? 'replacement-session' : 'current-session' }] } } as WorkflowLedgerRendererSelection
    },
    listSessions: async () => sessions,
    syncSession: async (id: string) => { calls.push(`sync:${id}`); return true },
    session: () => hydrated,
    current: () => current
  }
  return { host, calls, sessions, cancel: () => { current = false }, setRun: (id: string) => { currentRun = id },
    omitRun: () => { omitRun = true }, hydrate: (next: SessionMeta) => { hydrated = next } }
}

async function check(id: string, run: () => Promise<void>) { await run(); checks.push({ id, status: 'passed' }) }

async function main() {
await check('palace-stale-row-opens-current-canonical-session-after-hydration', async () => {
  const f = fixture()
  const result = await preparePalaceTaskNavigation(item, f.host)
  assert.equal(result?.sessionId, 'current-session')
  assert.equal(result?.runId, 'current-run')
  assert.deepEqual(result?.binding, { workspaceId: 'project', goalId: 'goal', workItemId: 'work' })
  assert.deepEqual(f.calls, ['ledger', 'ledger', 'sync:current-session', 'ledger', 'ledger'])
})
await check('missing-current-run-never-falls-back-to-an-old-session', async () => {
  const f = fixture(); f.omitRun()
  const result = await preparePalaceTaskNavigation(item, f.host)
  assert.equal(result?.reason, 'missing_run'); assert(!result?.sessionId)
  assert(!f.calls.some(call => call.startsWith('sync:')))
})
await check('task-reassigned-during-hydration-requires-a-new-click', async () => {
  const f = fixture()
  f.sessions.push(meta('replacement-session'))
  f.host.syncSession = async () => { f.setRun('reassigned-run'); return true }
  const result = await preparePalaceTaskNavigation(item, f.host)
  assert.equal(result?.reason, 'identity_conflict'); assert(!result?.sessionId)
  assert.equal(result?.runId, 'reassigned-run')
})
await check('closed-or-misbound-hydrated-session-cannot-open-approvals', async () => {
  for (const patch of [{ status: 'closed' as const }, { goalId: 'another-goal' }, { workspaceId: 'another-project' }, { workItemId: 'another-work' }]) {
    const f = fixture(); f.hydrate({ ...meta(), ...patch })
    const result = await preparePalaceTaskNavigation(item, f.host)
    assert(!result?.sessionId); assert(result?.reason)
  }
})
await check('leaving-palace-while-hydrating-does-not-steal-focus', async () => {
  const f = fixture()
  f.host.syncSession = async () => { f.cancel(); return true }
  assert.equal(await preparePalaceTaskNavigation(item, f.host), null)
  assert.equal(f.calls.length, 2)
})
await check('failed-session-refresh-never-opens-a-cached-session', async () => {
  const f = fixture(); f.host.syncSession = async () => false
  const result = await preparePalaceTaskNavigation(item, f.host)
  assert.equal(result?.reason, 'missing_session'); assert(!result?.sessionId)
})
await check('a-second-lookup-failure-does-not-return-the-earlier-success', async () => {
  const f = fixture(); f.host.syncSession = async () => { f.omitRun(); return true }
  const result = await preparePalaceTaskNavigation(item, f.host)
  assert.equal(result?.reason, 'missing_run'); assert(!result?.sessionId)
})
await check('lookup-errors-remain-visible-instead-of-falling-back', async () => {
  const f = fixture(); f.host.readLedger = async () => { throw new Error('Ledger offline') }
  await assert.rejects(preparePalaceTaskNavigation(item, f.host), /Ledger offline/)
  assert.equal(f.calls.length, 0)
})

const output = resolve('test-results/palace-task-navigation/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify({ kind: 'caogen.palace-task-navigation', status: 'passed', checks,
  providerCalls: false, humanEvidence: false, evidenceStrength: 'production-navigation-with-controlled-read-adapter',
  limitations: ['No packaged Electron click, WebGL or live Provider evidence'], generatedAt: new Date().toISOString() }, null, 2)}\n`)
console.log(`Palace task navigation: PASS (${checks.length}/${checks.length})\nreport: ${output}`)
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
