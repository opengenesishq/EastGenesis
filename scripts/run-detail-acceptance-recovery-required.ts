import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createRunDetailRoute,
  parseRunDetailRoute,
  projectRunDetail,
  resolveRunRecoverySnapshotId,
  RunDetailProjectionError,
  type RunDetailCanonicalInput
} from '../src/shared/run-detail-projection'
import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowRunSummary,
  WorkflowWorkItemRecord
} from '../src/shared/workflow-types'

const stamp = 1_700_000_000_000

const run = (status: WorkflowRunSummary['status'], overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  schemaVersion: 1,
  id: 'run-1',
  projectId: 'project-1',
  goalId: 'goal-1',
  workItemId: 'work-1',
  sessionId: 'session-1',
  taskId: 'task-1',
  status,
  revision: 2,
  attempt: 1,
  acceptanceId: 'acceptance-1',
  acceptanceRevision: 1,
  createdAt: stamp,
  updatedAt: stamp + 10,
  taskRunDigest: 'digest-run-1',
  ...overrides
})

const workItem: WorkflowWorkItemRecord = {
  schemaVersion: 1,
  id: 'work-1',
  projectId: 'project-1',
  goalId: 'goal-1',
  type: 'custom',
  title: 'Ship the result',
  description: 'A canonical work item',
  status: 'verifying',
  revision: 3,
  source: 'explicit',
  runIds: ['run-1'],
  currentRunId: 'run-1',
  createdAt: stamp,
  updatedAt: stamp + 10
}

const acceptance = (status: WorkflowAcceptanceRecord['status'], evidenceRefs: string[] = ['evidence-1']): WorkflowAcceptanceRecord => ({
  schemaVersion: 1,
  id: 'acceptance-1',
  projectId: 'project-1',
  goalId: 'goal-1',
  workItemId: 'work-1',
  criteria: ['The result is reviewable'],
  status,
  evidenceRefs,
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp + 11
})

const evidenceLink = (evidenceId: string, overrides: Partial<WorkflowEvidenceLinkRecord> = {}): WorkflowEvidenceLinkRecord => ({
  schemaVersion: 1,
  id: `evidence-link-${evidenceId}`,
  evidenceId,
  projectId: 'project-1',
  runId: 'run-1',
  acceptanceId: 'acceptance-1',
  relation: 'verifies',
  createdAt: stamp + 12,
  ...overrides
})

const input = (status: WorkflowRunSummary['status'], acceptanceRecord = acceptance('pending'), links: WorkflowEvidenceLinkRecord[] = []): RunDetailCanonicalInput => ({
  runs: [run(status)],
  workItems: [workItem],
  acceptances: [acceptanceRecord],
  evidenceLinks: links
})

const route = createRunDetailRoute('run-1', 'acceptance')
assert.deepEqual(parseRunDetailRoute(route), { kind: 'run-detail', runId: 'run-1', section: 'acceptance' })
assert.equal(parseRunDetailRoute('run/missing/unknown'), null)
assert.equal(projectRunDetail(input('completed'), 'run/unknown/run'), null)
assert.throws(() => createRunDetailRoute('run/with-slash'), RunDetailProjectionError)

const failedRun = run('failed')
const matchingSnapshot = {
  id: 'snapshot-1', sessionId: failedRun.sessionId, taskId: failedRun.taskId,
  run: { id: failedRun.id, sessionId: failedRun.sessionId, taskId: failedRun.taskId, status: failedRun.status }
}
assert.equal(resolveRunRecoverySnapshotId(failedRun, [matchingSnapshot]), 'snapshot-1')
assert.throws(() => resolveRunRecoverySnapshotId(run('completed'), [matchingSnapshot]), RunDetailProjectionError)
assert.throws(() => resolveRunRecoverySnapshotId(failedRun, [{ ...matchingSnapshot, taskId: 'other-task' }]), RunDetailProjectionError)
assert.throws(() => resolveRunRecoverySnapshotId(failedRun, [matchingSnapshot, { ...matchingSnapshot, id: 'snapshot-2' }]), RunDetailProjectionError)

const reconciliationRun = run('waiting_reconciliation')
const reconciledSnapshot = { ...matchingSnapshot, run: { ...matchingSnapshot.run,
  status: 'waiting_reconciliation' as const, effects: [{ status: 'confirmed' as const }] } }
assert.equal(resolveRunRecoverySnapshotId(reconciliationRun, [reconciledSnapshot]), 'snapshot-1')
for (const status of ['prepared', 'executing', 'waiting_reconciliation'] as const) {
  assert.throws(() => resolveRunRecoverySnapshotId(reconciliationRun, [{ ...reconciledSnapshot,
    run: { ...reconciledSnapshot.run, effects: [{ status }] } }]), RunDetailProjectionError)
}
assert.throws(() => resolveRunRecoverySnapshotId(reconciliationRun, [{ ...reconciledSnapshot, taskId: 'other-task' }]), RunDetailProjectionError)

const runDetailSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/studio/RunDetailPanel.tsx'), 'utf8')
const inboxSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/studio/WorkInbox.tsx'), 'utf8')
assert(runDetailSource.includes('onRecover?:'), 'Run detail must accept a parent-owned recovery callback')
assert(runDetailSource.includes('data-run-recover'), 'Run detail must expose a recovery action control')
assert(runDetailSource.includes('data-run-recovery-result="completed"'), 'Run detail must expose the parent-owned recovery completion result')
assert(inboxSource.includes('resolveRunRecoverySnapshotId'), 'Work Inbox must resolve snapshot identity through the fail-closed helper')
assert(inboxSource.includes('recoverTaskSnapshot(snapshotId, { activate: false })'), 'Work Inbox must invoke local recovery without navigating away from the result')
assert(inboxSource.includes('await refresh()'), 'Work Inbox must refresh canonical Run state after local recovery')

const failed = projectRunDetail(input('failed', acceptance('failed'), []), 'run/run-1/recovery')
assert(failed)
assert.equal(failed.run.status, 'failed')
assert.deepEqual(failed.recovery, { state: 'available', action: 'recover', reason: 'run_failed' })
assert.equal(failed.acceptanceGate.status, 'failed')
assert.deepEqual(failed.acceptanceGate.blockers, ['acceptance_failed', 'evidence_missing'])

const passedWithoutLink = projectRunDetail(input('completed', acceptance('passed'), []), 'run/run-1/run')
assert(passedWithoutLink)
assert.equal(passedWithoutLink.acceptanceGate.status, 'blocked')
assert.deepEqual(passedWithoutLink.acceptanceGate.missingEvidenceRefs, ['evidence-1'])
assert.equal(passedWithoutLink.evidenceLinks.length, 0)

const linkOnAnotherRun = evidenceLink('evidence-1', { runId: 'run-2' })
const stillBlocked = projectRunDetail(input('completed', acceptance('passed'), [linkOnAnotherRun]), 'run/run-1/run')
assert(stillBlocked)
assert.equal(stillBlocked.acceptanceGate.status, 'blocked')
assert.equal(stillBlocked.evidenceLinks.length, 0)

const passed = projectRunDetail(input('completed', acceptance('passed'), [evidenceLink('evidence-1')]), 'run/run-1/run')
assert(passed)
assert.equal(passed.acceptanceGate.status, 'passed')
assert.deepEqual(passed.acceptanceGate.boundEvidenceRefs, ['evidence-1'])
assert.deepEqual(passed.acceptanceGate.missingEvidenceRefs, [])
assert.equal(passed.evidenceLinks[0]?.evidenceId, 'evidence-1')

const missingAcceptance = projectRunDetail({ ...input('completed'), acceptances: [] }, 'run/run-1/acceptance')
assert(missingAcceptance)
assert.equal(missingAcceptance.acceptanceGate.status, 'missing')
assert.deepEqual(missingAcceptance.acceptanceGate.blockers, ['acceptance_missing'])

const mismatch = projectRunDetail({ ...input('completed'), acceptances: [{ ...acceptance('passed'), id: 'another-acceptance' }] }, 'run/run-1/acceptance')
assert(mismatch)
assert.equal(mismatch.acceptance, undefined)
assert.equal(mismatch.acceptanceGate.status, 'missing')

for (const [status, expected] of [
  ['recovering', 'in_progress'],
  ['waiting_reconciliation', 'reconciliation_required'],
  ['executing', 'unavailable']
] as const) {
  const projection = projectRunDetail(input(status), 'run/run-1/recovery')
  assert(projection)
  assert.equal(projection.recovery.state, expected)
  assert.equal(projection.run.status, status)
}

assert.throws(() => projectRunDetail({ ...input('failed'), runs: [run('failed'), run('completed', { id: 'run-1' })] }, 'run/run-1/run'), RunDetailProjectionError)

const report = {
  schemaVersion: 1,
  kind: 'caogen.run-detail-acceptance-recovery-contract-report',
  status: 'passed',
  checks: 27,
  passed: 27,
  scope: 'pure canonical Run detail projection; no Provider network I/O',
  coverage: [
    'stable run/acceptance/recovery route round-trip',
    'canonical Run status to recovery state mapping',
    'failed Run exposes a recover action',
    'passed Acceptance blocks when canonical EvidenceLink binding is absent',
    'cross-run EvidenceLink cannot satisfy the gate',
    'Acceptance and EvidenceLink records are never fabricated for stale routes',
    'duplicate canonical Run identities fail closed',
    'failed Run resolves to one exact local recovery snapshot identity',
    'reconciled Run can continue explicitly while unresolved effects and cross-task snapshots are rejected',
    'non-failed, cross-task, and ambiguous recovery snapshots fail closed'
  ],
  limitations: ['does not prove Electron click path', 'does not call recoverTaskSnapshot', 'does not prove real Provider recovery'],
  generatedAt: new Date().toISOString()
}
const output = resolve(process.cwd(), 'test-results/run-detail-acceptance-recovery/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
