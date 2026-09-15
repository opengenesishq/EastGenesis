import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectWorkInbox, WorkInboxProjectionError, type WorkInboxLane } from '../src/shared/work-inbox-projection'
import type { WorkflowAcceptanceRecord, WorkflowArtifactRecord, WorkflowWorkItemRecord } from '../src/shared/workflow-types'

const stamp = 1_700_000_000_000
const item = (id: string, status: WorkflowWorkItemRecord['status'], updatedAt = stamp): WorkflowWorkItemRecord => ({
  schemaVersion: 1, id, projectId: 'p1', goalId: 'g1', type: 'custom', title: id,
  status, revision: 1, source: 'explicit', runIds: [], createdAt: stamp, updatedAt
} as WorkflowWorkItemRecord)
const acceptance = (workItemId: string, status: WorkflowAcceptanceRecord['status']): WorkflowAcceptanceRecord => ({
  schemaVersion: 1, id: `a-${workItemId}`, projectId: 'p1', workItemId, criteria: ['criterion'], status,
  evidenceRefs: [], revision: 1, createdAt: stamp, updatedAt: stamp
})
const artifact = (workItemId: string): WorkflowArtifactRecord => ({
  schemaVersion: 1, id: `artifact-${workItemId}`, projectId: 'p1', workItemId, kind: 'document', title: 'artifact',
  version: 1, digest: `digest-${workItemId}`, provenance: 'explicit', createdAt: stamp, updatedAt: stamp
})

const lanes: Record<WorkInboxLane, string> = {
  needs_confirmation: 'waiting', running: 'running', blocked: 'blocked', ready_for_delivery: 'delivery', completed: 'done'
}
const result = projectWorkInbox({
  projectId: 'p1',
  workItems: [
    item(lanes.needs_confirmation, 'waiting_approval'),
    item(lanes.running, 'running'),
    item(lanes.blocked, 'blocked'),
    item(lanes.ready_for_delivery, 'verifying'),
    item(lanes.completed, 'done')
  ],
  acceptances: [acceptance(lanes.ready_for_delivery, 'passed'), acceptance(lanes.completed, 'passed')],
  artifacts: [artifact(lanes.ready_for_delivery), artifact(lanes.completed)]
})
assert.equal(result.schemaVersion, 1)
assert.equal(result.total, 5)
assert.deepEqual(Object.fromEntries(Object.entries(result.lanes).map(([lane, value]) => [lane, value.count])), {
  needs_confirmation: 1, running: 1, blocked: 1, ready_for_delivery: 1, completed: 1
})
assert.equal(result.lanes.ready_for_delivery.items[0]?.id, `work-item:${lanes.ready_for_delivery}`)
assert.equal(result.lanes.completed.items[0]?.id, `work-item:${lanes.completed}`)

const scoped = projectWorkInbox({ projectId: 'p1', workItems: [item('in', 'running'), { ...item('out', 'running'), projectId: 'p2' }] })
assert.equal(scoped.total, 1)
assert.equal(scoped.items[0]?.id, 'work-item:in')

assert.throws(() => projectWorkInbox({ workItems: [item('duplicate', 'running'), item('duplicate', 'done')] }), WorkInboxProjectionError)
assert.throws(() => projectWorkInbox({ workItems: [{ ...item('bad-time', 'running'), updatedAt: Number.NaN }] }), WorkInboxProjectionError)

const stable = projectWorkInbox({ projectId: 'p1', workItems: [item('b', 'running', stamp), item('a', 'running', stamp)] })
assert.deepEqual(stable.items.map((entry) => entry.id), ['work-item:a', 'work-item:b'])

const report = { schemaVersion: 1, contract: 'V2-013 Work Inbox projection', status: 'passed', checks: 8, passed: 8, lanes: Object.fromEntries(Object.entries(result.lanes).map(([lane, value]) => [lane, value.count])), coverage: { verified: ['five stable lanes', 'canonical WorkItem/Run/Goal projection', 'Artifact and Acceptance association', 'project filtering and deterministic ordering', 'duplicate and invalid timestamp fail-closed'], explicitlyNotVerified: ['packaged Electron click path', 'Provider calls', 'human task evidence'] }, generatedAt: new Date().toISOString() }
const output = resolve(process.cwd(), 'test-results/work-inbox-projection/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
