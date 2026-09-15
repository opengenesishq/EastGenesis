import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import type { StudioResultFileCheck } from '../src/shared/studio-result-file-change-types'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createProductionProjectAggregateService } from '../src/main/project-aggregate'
import { buildTaskSnapshot, readTaskSnapshotDatabase, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { registerCanonicalProducedArtifact } from '../src/main/task/artifact-production-boundary'
import { createWorkflowArtifactEdge, listPersistedWorkflowLedger, saveWorkflowAcceptance, verifyPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-api'
import { buildStudioResultSnapshot } from '../src/main/studio-result/studio-result-service'
import { checkStudioResultFiles } from '../src/main/studio-result/studio-result-file-changes'
import { commitProjectWorkspaceFileChangeImpact } from '../src/main/project-workspace/file-change-impact'
import { createProjectWorkspaceCanonicalWriteBoundary } from '../src/main/project-workspace/canonical-write'
import { projectWorkspaceFile } from '../src/main/project-workspace/persistence'
import { buildWorkflowChangeImpactPlan } from '../src/main/task/workflow-change-impact'
import { readAcceptances, readArtifacts, readEvidenceLinks } from '../src/main/task/workflow-ledger-query'
import { readArtifactEdges } from '../src/main/task/workflow-ledger-artifact-graph-query'

const recovering = process.argv[2] === '--recover-file-change'
const checkingAfterRestart = process.argv[2] === '--check-after-restart'
const root = recovering || checkingAfterRestart ? process.argv[3] : realpathSync(mkdtempSync(join(tmpdir(), 'caogen-file-changes-')))
const projectId = 'file-change-project', goalId = 'file-change-goal'
const meta = { id: 'file-change-session', createdAt: 1, cwd: root, status: 'idle', taskStrategy: 'execute',
  title: 'Source changes', providerId: 'fixture', model: 'fixture', engine: 'openai', permissionMode: 'default',
  costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
  workspaceId: projectId, projectId, goalId } as SessionMeta
let passed = 0
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); passed++; console.log(`PASS ${name}`) }
async function snapshot() {
  return buildStudioResultSnapshot(meta, await createProductionProjectAggregateService(root).verifyLiveProject(projectId))
}
async function ledger() { return listPersistedWorkflowLedger({ projectId, limit: 500 }, root) }
async function main() {
  const workspace = await openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: projectId, name: 'File changes', kind: 'office' })
  const commands = createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: goalId, projectId, title: 'Report', objective: 'Preserve manual edits', status: 'verifying' })
  for (const name of ['source', 'report', 'unrelated']) {
    const workItemId = `work:${name}`, runId = `run:${name}`, artifactId = `artifact:${name}`
    await commands.createWorkItem({ id: workItemId, projectId, goalId, title: name, type: 'planning', status: 'verifying' })
    const childMeta = { ...meta, id: `session:${name}`, workItemId, childTaskId: `task:${name}` }
    const run: TaskRunRecord = { schemaVersion: 1, id: runId, sessionId: childMeta.id, taskId: childMeta.childTaskId, status: 'executing',
      revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, steps: [], toolExecutions: [], effects: [] }
    await saveTaskSnapshot(buildTaskSnapshot({ meta: childMeta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
    const item = await workspace.getWorkItem(workItemId)
    await commands.updateWorkItem(workItemId, { runRefs: [runId] }, { expectedRevision: item!.revision })
    writeFileSync(join(root, `${name}.txt`), `Original ${name} content`)
    await registerCanonicalProducedArtifact({
      lifecycle: { id: artifactId, projectId, goalId, workItemId, runId, lineageId: `lineage:${name}`, kind: 'report', title: name,
        version: 1, provenance: 'explicit', mediaType: 'text/plain', retention: { mode: 'retain' }, metadata: { producer: 'file-check-fixture' },
        content: { storageKind: 'source_ref', sourceRef: join(root, `${name}.txt`) } },
      evidence: { id: `evidence:${name}`, kind: 'delivery_check', title: name, summary: 'Original bytes verified', verifier: 'fixture' },
      acceptance: { id: `acceptance:${name}`, criterionId: `criterion:${name}`, criterion: 'Original bytes match', status: 'passed', verifier: 'fixture' },
      attachToStage: false
    }, root)
  }
  await createWorkflowArtifactEdge({ id: 'source-report', projectId, goalId,
    fromArtifactId: 'artifact:source', toArtifactId: 'artifact:report', relation: 'derived_from' }, root)
  for (const name of ['source', 'report', 'unrelated']) {
    const stage = await saveWorkflowAcceptance({ id: `acceptance:stage:${name}`, projectId, goalId, workItemId: `work:${name}`,
      status: 'pending', criteria: ['Manual stage approval'] }, root)
    await saveWorkflowAcceptance({ ...stage, revision: stage.revision + 1, status: 'waived',
      waiverReason: 'Manual stage approval', waivedBy: 'fixture-user' }, root, { caller: 'user', actorId: 'fixture-user' })
  }
  for (const name of ['source', 'report', 'unrelated']) {
    let item = await workspace.getWorkItem(`work:${name}`)
    item = await commands.setWorkItemAcceptance(item!.id, { status: 'passed', evidenceRefs: [`evidence:${name}`],
      verifiedBy: 'fixture-user', verifiedAt: Date.now() }, { expectedRevision: item!.revision })
    await commands.transitionWorkItem(item.id, 'done', { expectedRevision: item.revision })
  }
  let goal = await workspace.getGoal(goalId)
  goal = await commands.setGoalAcceptance(goalId, { status: 'passed', evidenceRefs: ['evidence:source', 'evidence:report'],
    verifiedBy: 'fixture-user', verifiedAt: Date.now() }, { expectedRevision: goal!.revision })
  await commands.transitionGoal(goalId, 'completed', { expectedRevision: goal.revision })
  await check('unchanged canonical source files do not mutate verification', async () => {
    const before = await ledger()
    const result = await checkStudioResultFiles(meta, root)
    assert.equal(result.files.length, 3)
    assert(result.files.every(file => file.state === 'unchanged'))
    assert.deepEqual(await ledger(), before)
  })
  writeFileSync(join(root, 'source.txt'), 'Manual corrections with new source values')
  await check('manual edits reopen completed source and downstream only and preserve actual bytes', async () => {
    await assert.rejects(snapshot(), /artifact bytes are invalid/)
    const result = await runFileCheckProcess()
    assert.deepEqual(result.protectedArtifactIds, ['artifact:source'])
    assert.deepEqual(result.rerunWorkItemIds, ['work:report'])
    assert.deepEqual(result.reviewWorkItemIds, ['work:source'])
    assert.deepEqual(result.acceptanceIds.sort(), ['acceptance:report', 'acceptance:source', 'acceptance:stage:report', 'acceptance:stage:source'])
    const after = await ledger()
    assert.equal(after.acceptances.items.find(item => item.id === 'acceptance:unrelated')?.status, 'passed')
    assert.equal(after.acceptances.items.find(item => item.id === 'acceptance:source')?.status, 'pending')
    assert.equal(after.acceptances.items.find(item => item.id === 'acceptance:stage:source')?.status, 'pending')
    assert.equal(after.acceptances.items.find(item => item.id === 'acceptance:source')?.evidenceRefs.length, 0)
    assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'Manual corrections with new source values')
    assert.equal(readFileSync(join(root, 'report.txt'), 'utf8'), 'Original report content')
    const current = await snapshot()
    assert.equal(current.artifacts.find(artifact => artifact.id === 'artifact:source')?.deliveryStatus, 'verification_pending')
    assert.equal(current.workItems.find(item => item.id === 'work:source')?.status, 'verifying')
    assert.equal(current.workItems.find(item => item.id === 'work:report')?.status, 'verifying')
    assert.equal(current.workItems.find(item => item.id === 'work:unrelated')?.status, 'done')
    assert.equal(current.goal?.status, 'verifying')
    assert.equal(current.runs.length, 3, 'file check must not dispatch new Runs')
    assert.equal((await workspace.getWorkItem('work:source'))?.acceptance?.status, 'pending')
    assert.equal((await workspace.getWorkItem('work:unrelated'))?.acceptance?.status, 'passed')
    assert.equal((await workspace.getGoal(goalId))?.acceptanceResult?.status, 'pending')
  })
  await check('same byte observation replays without event or acceptance revision churn', async () => {
    const before = await ledger()
    await checkStudioResultFiles(meta, root)
    assert.deepEqual(await ledger(), before)
  })
  await check('missing work items and cross-project Sessions fail before ledger mutation', async () => {
    const before = await ledger()
    await assert.rejects(checkStudioResultFiles({ ...meta, workItemId: 'missing-work' }, root), /STUDIO_FILE_CHECK_SCOPE/)
    await assert.rejects(checkStudioResultFiles({ ...meta, workspaceId: 'other-project' }, root), /STUDIO_FILE_CHECK_SCOPE/)
    assert.deepEqual(await ledger(), before)
  })
  for (const faultAt of ['before_canonical_commit', 'after_canonical_commit'] as const) {
  await check(`new process restores file-change plan interrupted at ${faultAt}`, async () => {
    const manualText = `Manual changes after completed delivery: ${faultAt}`
    writeFileSync(join(root, 'unrelated.txt'), manualText)
    const plan = await readTaskSnapshotDatabase(root, db => buildWorkflowChangeImpactPlan({ projectId,
      changedArtifactIds: ['artifact:unrelated'], manuallyModifiedArtifactIds: ['artifact:unrelated'],
      artifacts: readArtifacts(db), acceptances: readAcceptances(db), evidenceLinks: readEvidenceLinks(db), edges: readArtifactEdges(db) }))
    const beforeJson = readFileSync(projectWorkspaceFile(root))
    await assert.rejects(commitProjectWorkspaceFileChangeImpact({ projectId, plan, rootDir: root }, { faultAt }))
    assert.deepEqual(readFileSync(projectWorkspaceFile(root)), beforeJson)
    await runRecoveryProcess()
    assert.equal((await snapshot()).workItems.find(item => item.id === 'work:unrelated')?.status, 'verifying')
    assert.equal((await workspace.getWorkItem('work:unrelated'))?.acceptance?.status, 'pending')
    assert.equal((await ledger()).acceptances.items.find(item => item.id === 'acceptance:unrelated')?.status, 'pending')
    const after = await ledger(), json = readFileSync(projectWorkspaceFile(root))
    await runRecoveryProcess()
    assert.deepEqual(await ledger(), after)
    assert.deepEqual(readFileSync(projectWorkspaceFile(root)), json)
    assert.equal(readFileSync(join(root, 'unrelated.txt'), 'utf8'), manualText)
  })
  }
  await check('missing and substituted files invalidate without following symlinks', async () => {
    rmSync(join(root, 'unrelated.txt'))
    let result = await checkStudioResultFiles(meta, root)
    assert.equal(result.files.find(file => file.artifactId === 'artifact:unrelated')?.reason, 'missing')
    assert.equal((await ledger()).acceptances.items.find(item => item.id === 'acceptance:unrelated')?.status, 'pending')
    symlinkSync(join(root, 'report.txt'), join(root, 'unrelated.txt'))
    result = await checkStudioResultFiles(meta, root)
    assert.equal(result.files.find(file => file.artifactId === 'artifact:unrelated')?.reason, 'unsafe_path')
    assert.equal(readFileSync(join(root, 'report.txt'), 'utf8'), 'Original report content')
    assert.equal((await verifyPersistedWorkflowLedger(root)).valid, true)
  })
  console.log(`Studio result file changes: ${passed}/${passed} passed; isolated canonical stores, no Provider calls.`)
}
async function runRecoveryProcess(): Promise<void> {
  const result = await runFixtureChild('--recover-file-change')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}
async function runFileCheckProcess(): Promise<StudioResultFileCheck> {
  const result = await runFixtureChild('--check-after-restart')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout)
}
async function runFixtureChild(mode: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(resolve('node_modules/.bin/tsx'), [resolve(process.argv[1]), mode, root],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', status => resolveChild({ status, stdout, stderr }))
  })
}
async function recoverOnly(): Promise<void> {
  const readiness = await createProjectWorkspaceCanonicalWriteBoundary(root).reconcile()
  assert.equal(readiness.ready, true)
  assert.equal((await verifyPersistedWorkflowLedger(root)).valid, true)
}
if (recovering) recoverOnly().catch(error => { console.error(error); process.exitCode = 1 })
else if (checkingAfterRestart) (async () => {
  // A normal first-open read remains strict; only the file-repair ingress can
  // prepare and commit this narrowly observed external change.
  await assert.rejects(snapshot())
  const result = await checkStudioResultFiles(meta, root)
  assert.equal((await snapshot()).goal?.status, 'verifying')
  console.log(JSON.stringify(result))
})().catch(error => { console.error(error); process.exitCode = 1 })
else main().finally(() => rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
