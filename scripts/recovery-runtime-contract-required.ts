import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { buildTaskSnapshot, saveTaskSnapshot, getTaskSnapshot } from '../src/main/task/task-snapshot'
import { prepareTaskSnapshotRecovery } from '../src/main/task/task-snapshot-recovery-lifecycle'
import { recoverTaskExecutionState } from '../src/main/task/task-execution'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'

const now = 1_800_000_000_000
const rootDir = mkdtempSync(join(tmpdir(), 'caogen-recovery-runtime-'))

function runBase(): TaskRunRecord {
  return {
    schemaVersion: 1,
    id: 'run-recovery-runtime',
    sessionId: 'session-recovery-runtime',
    taskId: 'task-recovery-runtime',
    digitalWorkerBinding: { kind: 'unscoped' },
    status: 'failed',
    revision: 4,
    attempt: 2,
    recoveryCount: 1,
    createdAt: now - 100,
    updatedAt: now - 10,
    steps: [
      { id: 'step-done', runId: 'run-recovery-runtime', sessionId: 'session-recovery-runtime', sequence: 1, status: 'completed', createdAt: now - 90, updatedAt: now - 80, finishedAt: now - 80 },
      { id: 'step-pending', runId: 'run-recovery-runtime', sessionId: 'session-recovery-runtime', sequence: 2, status: 'waiting_approval', createdAt: now - 70, updatedAt: now - 60, pendingPermissionRequestId: 'approval-1' }
    ],
    toolExecutions: [
      { id: 'tool-approval', runId: 'run-recovery-runtime', sessionId: 'session-recovery-runtime', stepId: 'step-pending', toolUseId: 'tool-approval', toolName: 'write_file', status: 'waiting_approval', requestId: 'approval-1', createdAt: now - 65, updatedAt: now - 60 },
      { id: 'tool-running', runId: 'run-recovery-runtime', sessionId: 'session-recovery-runtime', stepId: 'step-pending', toolUseId: 'tool-running', toolName: 'shell', status: 'running', createdAt: now - 55, updatedAt: now - 50 }
    ]
  }
}

function meta(): SessionMeta {
  return {
    id: 'session-recovery-runtime', title: 'Recovery runtime fixture', cwd: rootDir,
    childTaskId: 'task-recovery-runtime', model: 'fixture-model', providerId: 'fixture-provider',
    taskStrategy: 'execute', permissionMode: 'default', status: 'error', costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
    createdAt: now - 100, digitalWorkerBinding: { kind: 'unscoped' }
  }
}

async function main(): Promise<void> {
  const checks: string[] = []
  try {
    const base = runBase()
    const recovered = recoverTaskExecutionState(base, now)
    assert.equal(recovered.steps?.[0].status, 'completed')
    assert.equal(recovered.steps?.[1].status, 'recovering')
    assert.equal(recovered.steps?.[1].pendingPermissionRequestId, undefined)
    assert.equal(recovered.toolExecutions?.find((item) => item.id === 'tool-approval')?.status, 'cancelled')
    assert.equal(recovered.toolExecutions?.find((item) => item.id === 'tool-running')?.status, 'unknown_outcome')
    checks.push('pending approval is cancelled and in-flight tool is marked unknown_outcome')

    const repeated = recoverTaskExecutionState(recovered, now + 1)
    assert.deepEqual(repeated, recovered)
    checks.push('recovery state transition is idempotent')

    const snapshot = buildTaskSnapshot({ meta: meta(), transcript: [], lastSeq: 0, eventCount: 0, reason: 'important-event', run: base, now })
    await saveTaskSnapshot(snapshot, rootDir)
    const prepared = await prepareTaskSnapshotRecovery(snapshot, rootDir, () => false)
    assert.equal(prepared.recoveredRun.status, 'recovering')
    // A terminal failed snapshot starts a fresh successor Run; its first recovery is count 1.
    assert.equal(prepared.recoveredRun.recoveryCount, 1)
    assert.notEqual(prepared.recoveredRun.id, base.id)
    const persisted = await getTaskSnapshot(snapshot.id, rootDir)
    assert.equal(persisted?.run?.status, 'failed')
    checks.push('prepareTaskSnapshotRecovery validates a terminal failure into a fresh recoverable successor without prematurely mutating the persisted failure')

    const report = { schemaVersion: 1, kind: 'caogen.recovery-runtime-contract-report', status: 'passed', checks: checks.length, passed: checks.length, checks, limitations: ['does not prove Electron click path', 'does not call a real Provider or claim production recovery'] }
    const reportPath = join(process.cwd(), 'test-results', 'recovery-runtime-contract', 'latest.json')
    mkdirSync(join(process.cwd(), 'test-results', 'recovery-runtime-contract'), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
