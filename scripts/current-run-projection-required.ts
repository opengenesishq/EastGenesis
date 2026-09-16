import assert from 'node:assert/strict'
import { projectWorkInbox } from '../src/shared/work-inbox-projection'
import { projectRunDetail } from '../src/shared/run-detail-projection'
import type {
  WorkflowAcceptanceRecord, WorkflowArtifactRecord, WorkflowEvidenceLinkRecord,
  WorkflowEventRecord, WorkflowRunSummary, WorkflowWorkItemRecord
} from '../src/shared/workflow-types'

const work: WorkflowWorkItemRecord = {
  schemaVersion: 1, id: 'work', projectId: 'project', goalId: 'goal', type: 'custom', title: 'Current task',
  status: 'done', revision: 20, source: 'explicit', runIds: ['old', 'current'], currentRunId: 'current',
  createdAt: 1, updatedAt: 20
}
const run: WorkflowRunSummary = {
  schemaVersion: 1, id: 'current', projectId: 'project', goalId: 'goal', workItemId: 'work', sessionId: 'session',
  taskId: 'task', status: 'executing', revision: 1, attempt: 1, acceptanceId: 'acceptance', acceptanceRevision: 1,
  createdAt: 10, updatedAt: 10, taskRunDigest: 'current-digest'
}
const old: WorkflowRunSummary = { ...run, id: 'old', acceptanceId: 'old-acceptance', status: 'completed', revision: 90, createdAt: 1, updatedAt: 30 }
const contract: WorkflowAcceptanceRecord = {
  schemaVersion: 1, id: 'acceptance', projectId: 'project', goalId: 'goal', workItemId: 'work',
  criteria: ['Include sources'], status: 'pending', evidenceRefs: [], revision: 1, createdAt: 1, updatedAt: 1
}
const passed: WorkflowAcceptanceRecord = { ...contract, revision: 2, status: 'passed', evidenceRefs: ['evidence'], updatedAt: 20 }
const captured: WorkflowEventRecord = {
  schemaVersion: 1, seq: 1, eventId: 'workflow:acceptance:acceptance:revision:1', streamId: 'work-item:work',
  entityType: 'acceptance', entityId: 'acceptance', kind: 'acceptance.created', payload: { ...contract },
  projectId: 'project', goalId: 'goal', workItemId: 'work', occurredAt: 1, prevDigest: '', digest: 'fixture'
}
const link: WorkflowEvidenceLinkRecord = {
  schemaVersion: 1, id: 'link', evidenceId: 'evidence', projectId: 'project', runId: 'current',
  acceptanceId: 'acceptance', relation: 'verifies', createdAt: 20
}
const artifact: WorkflowArtifactRecord = {
  schemaVersion: 1, id: 'old-artifact', projectId: 'project', goalId: 'goal', workItemId: 'work', runId: 'old',
  kind: 'document', title: 'Old result', version: 1, digest: 'old-artifact-digest', provenance: 'explicit', createdAt: 1, updatedAt: 1
}
const staleAcceptance: WorkflowAcceptanceRecord = { ...passed, id: 'old-acceptance', revision: 99 }
const base = { workItems: [work], runs: [old, run], acceptances: [staleAcceptance, passed],
  artifacts: [artifact], events: [captured], evidenceLinks: [link] }
const inbox = (input = base) => projectWorkInbox(input).items.find(item => item.workItemId === work.id)!
const detail = (input = base) => projectRunDetail(input, 'run/current/acceptance')!

// A high revision and newer update on an old Run cannot displace the pointer.
assert.equal(inbox().runId, 'current')
assert.equal(inbox().lane, 'running')
assert.equal(inbox().status, 'executing')
assert.deepEqual(inbox().artifactIds, [])
assert.deepEqual(detail().artifacts, [])
assert.equal(inbox({ ...base, workItems: [{ ...work, currentRunId: undefined }] }).runId, 'current')

// Missing or foreign current Run is recoverable; never silently reopen old.
const absent = inbox({ ...base, runs: [old] })
assert.equal(absent.lane, 'blocked')
assert.equal(absent.runId, 'current')
assert.equal(absent.status, 'blocked')
assert.match(absent.detail!, /missing/)
assert.equal(absent.acceptanceStatus, undefined)
for (const foreign of [{ ...run, workItemId: 'other' }, { ...run, goalId: 'other' }, { ...run, projectId: 'other' }]) {
  assert.equal(inbox({ ...base, runs: [old, foreign] }).lane, 'blocked')
}

// Normal verification increments remain valid for the same captured contract.
const completed = { ...base, runs: [old, { ...run, status: 'completed' as const }] }
assert.equal(inbox(completed).lane, 'completed')
assert.equal(detail(completed).acceptanceGate.status, 'passed')
assert.equal(detail(completed).acceptance?.id, 'acceptance')

// Changing the same Acceptance's criteria cannot pass a previous Run.
const changed = { ...completed, acceptances: [{ ...passed, criteria: ['Omit sources'], revision: 3 }] }
assert.equal(inbox(changed).lane, 'ready_for_delivery')
assert.equal(inbox(changed).acceptanceStatus, 'pending')
assert.equal(detail(changed).acceptanceGate.status, 'pending')
assert.deepEqual(detail(changed).acceptance?.criteria, ['Include sources'])
assert.deepEqual(detail(changed).acceptanceGate.evidenceRefs, [])
assert.deepEqual(detail(changed).acceptanceGate.boundEvidenceRefs, [])
assert.equal(detail({ ...completed, events: [] }).acceptanceGate.status, 'pending')
assert.equal(detail({ ...completed, events: [{ ...captured, goalId: 'foreign' }] }).acceptanceGate.status, 'pending')
assert.equal(detail({ ...completed, acceptances: [staleAcceptance] }).acceptanceGate.status, 'missing')

// Cross-run and unbound evidence and supports links cannot certify this Run.
for (const evidenceLinks of [[], [{ ...link, runId: 'old' }], [{ ...link, runId: undefined }], [{ ...link, relation: 'supports' as const }]]) {
  const input = { ...completed, evidenceLinks }
  assert.equal(detail(input).acceptanceGate.status, 'pending')
  assert.equal(inbox(input).acceptanceStatus, 'pending')
}
assert.equal(detail({ ...completed, runs: [{ ...run, acceptanceId: undefined, acceptanceRevision: undefined }] }).acceptanceGate.status, 'missing')

// Criterion policy changes are requirements changes; list order is not.
const policy = { criterionId: 'criterion', criterionIndex: 0, evidenceKind: 'review_result' as const, allowedSources: ['human', 'runtime'] as const }
const policies = [{ ...policy, allowedSources: [...policy.allowedSources] }]
const policyInput = { ...completed, acceptances: [{ ...passed, criterionPolicies: policies }],
  events: [{ ...captured, payload: { ...contract, criterionPolicies: [{ ...policy, allowedSources: ['runtime', 'human'] }] } }] }
assert.equal(detail(policyInput).acceptanceGate.status, 'passed')
assert.equal(detail({ ...policyInput, acceptances: [{ ...passed, criterionPolicies: [{ ...policy, allowedSources: ['human'] }] }] }).acceptanceGate.status, 'pending')

// Empty criteria are allowed; their existing evidence/waiver semantics remain.
const empty = { ...completed, acceptances: [{ ...passed, criteria: [] }], events: [{ ...captured, payload: { ...contract, criteria: [] } }] }
assert.equal(detail(empty).acceptanceGate.status, 'passed')
assert.equal(detail({ ...empty, acceptances: [{ ...empty.acceptances[0], evidenceRefs: [] }] }).acceptanceGate.status, 'pending')
assert.equal(detail({ ...empty, acceptances: [{ ...empty.acceptances[0], status: 'waived', evidenceRefs: [], waiverReason: 'User review', waivedBy: 'user' }] }).acceptanceGate.status, 'pending')
assert.equal(detail({ ...empty, acceptances: [{ ...empty.acceptances[0], status: 'waived', waiverReason: 'User review', waivedBy: 'user' }] }).acceptanceGate.status, 'waived')
assert.equal(detail({ ...empty, acceptances: [{ ...empty.acceptances[0], status: 'waived', waiverReason: 'User review', waivedBy: 'user' }], evidenceLinks: [{ ...link, runId: 'old' }] }).acceptanceGate.status, 'pending')

console.log('Current Run projection: 7 focused scenarios passed; no Provider calls.')
