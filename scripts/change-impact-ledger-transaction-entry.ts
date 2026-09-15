import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowAcceptanceRecord, WorkflowAcceptanceStatus } from '../src/shared/workflow-types'
import { digest } from '../src/main/task/workflow-ledger-codec'
import { mutateTaskSnapshotDatabase } from '../src/main/task/task-snapshot'
import {
  invalidateWorkflowAcceptanceForChange, linkWorkflowEvidence, projectGoal, projectWorkItem,
  projectWorkflowAcceptance, registerWorkflowArtifact, setupWorkflowLedgerSchema
} from '../src/main/task/workflow-ledger-store'
import { recordWorkflowArtifactLocation, registerWorkflowArtifactEdge } from '../src/main/task/workflow-ledger-artifact-graph'
import { buildWorkflowChangeImpactPlan, type WorkflowChangeImpactPlan } from '../src/main/task/workflow-change-impact'
import {
  applyPersistedWorkflowChangeImpact, commitWorkflowChangeImpactPlan,
  listPersistedWorkflowLedger, listWorkflowArtifactEdges, recordWorkflowEvidence,
  saveWorkflowAcceptance, verifyPersistedWorkflowLedger
} from '../src/main/task/workflow-ledger-api'

const projectId = 'change-impact-transaction-project'
const goalId = 'change-impact-goal'
const now = 1_800_000_000_000
const statuses = ['pending', 'verifying', 'passed', 'failed', 'waived'] as const
const scope = { projectId, limit: 500 }
type Check = { id: string; status: 'passed' }

async function seed(rootDir: string): Promise<WorkflowAcceptanceRecord[]> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    projectGoal(db, { id: goalId, projectId, title: 'Change impact', objective: 'Recheck affected artifacts', createdAt: now })
    const acceptances: WorkflowAcceptanceRecord[] = []
    for (const label of ['source', ...statuses, 'untouched']) {
      const workItemId = `work-item:${label}`
      projectWorkItem(db, { id: workItemId, projectId, goalId, title: label, type: 'testing', status: 'ready', createdAt: now })
      const artifactId = `artifact:${label}`
      const artifactPath = join(rootDir, `${label}.txt`)
      const artifactBytes = Buffer.from(`Verified ${label} artifact\n`)
      const contentDigest = createHash('sha256').update(artifactBytes).digest('hex')
      writeFileSync(artifactPath, artifactBytes)
      registerWorkflowArtifact(db, { id: artifactId, projectId, goalId, workItemId, kind: 'document', title: label, digest: contentDigest, createdAt: now })
      recordWorkflowArtifactLocation(db, { id: `location:${label}`, artifactId, projectId, goalId, workItemId,
        kind: 'file', path: artifactPath, checksum: contentDigest, sizeBytes: artifactBytes.length, createdAt: now })
      if (label === 'source') continue
      if (label !== 'untouched') registerWorkflowArtifactEdge(db, {
        id: `edge:${label}`, projectId, goalId, fromArtifactId: 'artifact:source', toArtifactId: artifactId,
        relation: 'derived_from', createdAt: now
      })
      const targetStatus: WorkflowAcceptanceStatus = label === 'untouched' ? 'passed' : label as WorkflowAcceptanceStatus
      let acceptance = projectWorkflowAcceptance(db, {
        id: `accept:${label}`, projectId, goalId, workItemId,
        criteria: ['artifact remains valid'], status: 'pending', createdAt: now
      })
      const evidenceId = `evidence:${label}`
      const criterionId = `criterion:${label}`
      recordWorkflowEvidence(db, { evidenceId, projectId, goalId, workItemId, artifactId,
        kind: 'test_result', title: 'Prior verification', contentDigest
      }, { source: 'runtime', verifier: 'fixture-verifier', observedAt: now })
      linkWorkflowEvidence(db, { id: `link:${label}`, evidenceId, projectId, artifactId,
        acceptanceId: acceptance.id, criterionId, evidenceOrigin: 'workflow', relation: 'verifies', createdAt: now })
      const withEvidence = {
        ...acceptance, evidenceRefs: [evidenceId],
        criterionEvidence: [{ criterionId, criterionIndex: 0, evidenceRefs: [evidenceId] }],
        verifier: 'prior-verifier', verifiedAt: now, revision: acceptance.revision + 1, updatedAt: now + 1
      }
      if (targetStatus === 'pending' || targetStatus === 'waived') {
        acceptance = projectWorkflowAcceptance(db, {
          ...withEvidence, status: targetStatus,
          ...(targetStatus === 'waived' ? { waiverReason: 'prior manual review', waivedBy: 'fixture-user' } : {})
        }, { caller: 'user', actorId: 'fixture-user' })
      } else {
        acceptance = projectWorkflowAcceptance(db, { ...withEvidence, status: 'verifying' })
        if (targetStatus !== 'verifying') acceptance = projectWorkflowAcceptance(db, {
          ...acceptance, status: targetStatus, revision: acceptance.revision + 1, updatedAt: now + 2
        })
      }
      acceptances.push(acceptance)
    }
    // The protected sibling deliberately has no edge from the changed source.
    registerWorkflowArtifact(db, { id: 'artifact:manual-sibling', projectId, goalId, workItemId: 'work-item:passed',
      kind: 'document', title: 'Manual edits', digest: digest('manual edits'), createdAt: now })
    return acceptances
  })
}

async function writeStage(rootDir: string): Promise<Check[]> {
  const checks: Check[] = []
  const passed = (id: string) => checks.push({ id, status: 'passed' })
  const prior = await seed(rootDir)
  assert.equal((await verifyPersistedWorkflowLedger(rootDir)).valid, true)
  passed('canonical-artifacts-edges-evidence-and-all-acceptance-states-seeded')
  const priorById = new Map(prior.map((item) => [item.id, item]))
  const before = await listPersistedWorkflowLedger(scope, rootDir)
  for (const status of ['verifying', 'passed', 'waived'] as const) {
    const item = priorById.get(`accept:${status}`)!
    await assert.rejects(saveWorkflowAcceptance({ ...item, status: 'pending', revision: item.revision + 1 }, rootDir), /transition/)
  }
  assert.equal(digest(await listPersistedWorkflowLedger(scope, rootDir)), digest(before))
  passed('ordinary-state-machine-still-rejects-regressions')

  const input = { projectId, rootDir, changedArtifactIds: ['artifact:source'], manuallyModifiedArtifactIds: ['artifact:manual-sibling'] }
  const applied = await applyPersistedWorkflowChangeImpact({ ...input, now: now + 10 })
  assert.equal(applied.plan.acceptanceRechecks.length, 5)
  for (const status of statuses) {
    const item = applied.acceptances.find((candidate) => candidate.id === `accept:${status}`)!
    const old = priorById.get(item.id)!
    assert.equal(item.status, status === 'failed' ? 'failed' : 'pending')
    assert.equal(item.revision, old.revision + 1)
    assert.deepEqual(item.evidenceRefs, [])
    for (const field of ['criterionEvidence', 'verifier', 'verifiedAt', 'waiverReason', 'waivedBy'] as const) assert.equal(item[field], undefined)
    assert(item.notes?.includes(applied.plan.planDigest))
    passed(`persisted-${status}-recheck-clears-old-proof-and-fences-revision`)
  }
  assert.deepEqual(applied.acceptances.find((item) => item.id === 'accept:untouched'), before.acceptances.items.find((item) => item.id === 'accept:untouched'))
  passed('unaffected-acceptance-remains-byte-equivalent')
  assert(!applied.plan.rerunWorkItemIds.includes('work-item:passed'))
  assert(applied.plan.reviewWorkItemIds.includes('work-item:passed'))
  assert.equal(applied.plan.artifacts.find((item) => item.artifactId === 'artifact:passed')?.reason, 'protected_work_item')
  assert(!applied.plan.artifacts.some((item) => item.artifactId === 'artifact:manual-sibling'))
  passed('protected-sibling-outside-change-subgraph-blocks-whole-work-item-rerun')

  const after = await listPersistedWorkflowLedger(scope, rootDir)
  const planEvents = after.events.items.filter((event) => event.kind === 'workflow.change-impact.plan.created')
  const invalidations = after.events.items.filter((event) => event.kind === 'acceptance.invalidated_by_change')
  assert.equal(planEvents.length, 1)
  assert.equal(invalidations.length, 5)
  assert.deepEqual(after.evidenceLinks, before.evidenceLinks, 'historical evidence links must remain auditable')
  passed('one-plan-and-five-invalidations-retain-historical-evidence-links')
  const replay = await commitWorkflowChangeImpactPlan(applied.plan, rootDir, now + 11)
  assert.equal(replay.acceptances.length, 5)
  assert.equal(digest(await listPersistedWorkflowLedger(scope, rootDir)), digest(after))
  passed('same-plan-replay-does-not-append-events-or-revisions')

  // Verification prepared from pending/verifying/failed cannot reuse the old
  // revision, even if it still carries previously valid evidence links.
  for (const status of ['pending', 'verifying', 'failed'] as const) {
    const item = priorById.get(`accept:${status}`)!
    await assert.rejects(mutateTaskSnapshotDatabase(rootDir, (db) => {
      let next = item
      if (status !== 'verifying') next = projectWorkflowAcceptance(db, {
        ...item, status: 'verifying', revision: item.revision + 1, updatedAt: now + 12
      })
      projectWorkflowAcceptance(db, { ...next, status: 'passed', revision: next.revision + 1, updatedAt: now + 13 })
    }), /revision/)
    assert.equal(digest(await listPersistedWorkflowLedger(scope, rootDir)), digest(after))
    passed(`stale-${status}-verification-cannot-pass-after-change`)
  }

  const edges = (await listWorkflowArtifactEdges({ projectId, limit: 500 }, rootDir)).items
  const freshPlan = buildWorkflowChangeImpactPlan({ ...input, artifacts: after.artifacts.items,
    edges, acceptances: after.acceptances.items, evidenceLinks: after.evidenceLinks.items })
  const { planDigest: _digest, ...unsigned } = freshPlan
  const conflicting = { ...unsigned, acceptanceRechecks: unsigned.acceptanceRechecks.map((item, index) =>
    index === 1 ? { ...item, previousRevision: item.previousRevision + 99, nextRevision: item.nextRevision + 99 } : item) }
  await assert.rejects(commitWorkflowChangeImpactPlan({ ...conflicting, planDigest: digest(conflicting) }, rootDir, now + 14), /changed after impact plan/)
  assert.equal(digest(await listPersistedWorkflowLedger(scope, rootDir)), digest(after))
  passed('late-acceptance-conflict-rolls-back-plan-and-earlier-invalidation')

  const current = applied.acceptances.find((item) => item.id === 'accept:verifying')!
  const reset = { ...current, revision: current.revision + 1, updatedAt: now + 15 }
  await assert.rejects(mutateTaskSnapshotDatabase(rootDir, (db) =>
    invalidateWorkflowAcceptanceForChange(db, reset, { caller: 'user', actorId: 'fixture-user' })), /system authority/)
  await assert.rejects(mutateTaskSnapshotDatabase(rootDir, (db) =>
    invalidateWorkflowAcceptanceForChange(db, { ...reset, verifier: 'stale-verifier' })), /clear prior verification/)
  assert.equal(digest(await listPersistedWorkflowLedger(scope, rootDir)), digest(after))
  passed('dedicated-invalidation-rejects-non-system-and-stale-metadata')
  assert.equal((await verifyPersistedWorkflowLedger(rootDir)).valid, true)
  passed('ledger-and-evidence-chain-verify-after-rechecks-and-rejected-writes')
  writeFileSync(join(rootDir, 'expected.json'), JSON.stringify({ plan: applied.plan, ledgerDigest: digest(after) }))
  return checks
}

async function readStage(rootDir: string): Promise<Check[]> {
  const expected = JSON.parse(readFileSync(join(rootDir, 'expected.json'), 'utf8')) as { plan: WorkflowChangeImpactPlan; ledgerDigest: string }
  const ledger = await listPersistedWorkflowLedger(scope, rootDir)
  assert.equal(digest(ledger), expected.ledgerDigest)
  assert.equal((await verifyPersistedWorkflowLedger(rootDir)).valid, true)
  const replay = await commitWorkflowChangeImpactPlan(expected.plan, rootDir, now + 20)
  assert.equal(replay.acceptances.length, 5)
  assert.equal(digest(await listPersistedWorkflowLedger(scope, rootDir)), expected.ledgerDigest)
  return ['independent-electron-restart-preserves-exact-ledger', 'restart-ledger-and-evidence-chain-verify',
    'restart-plan-replay-remains-idempotent'].map((id) => ({ id, status: 'passed' }))
}

export async function run(stage: string, rootDir: string, runId: string): Promise<unknown> {
  const startedAt = new Date().toISOString()
  assert(process.versions.electron, 'fixture requires the real Electron runtime')
  assert.equal(process.type, 'browser', 'fixture requires the Electron main process')
  assert(stage === 'write' || stage === 'read', 'unsupported transaction fixture stage')
  const checks = stage === 'write' ? await writeStage(rootDir) : await readStage(rootDir)
  return { kind: 'caogen.change-impact-ledger-stage', runId, stage, status: 'passed', checks,
    runtime: { electron: process.versions.electron, processType: process.type, pid: process.pid },
    providerCalls: false, humanEvidence: false, startedAt, finishedAt: new Date().toISOString() }
}
