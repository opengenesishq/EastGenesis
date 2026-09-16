import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import { PreparationPermissionStore } from '../src/main/permission/preparation-permission-store'
import { resolvePreparationToolScope } from '../src/main/permission/preparation-tool-scope'
import { executeOfficeCreationTool } from '../src/main/agent/tools/office-creation-tools'
import { executeOfficeRevisionTool } from '../src/main/agent/tools/office-revision-tools'
import { inspectScopedOffice, prepareOfficeRevision } from '../src/main/office-revision/plans'
import { authorizeOfficeRevisionSend } from '../src/main/office-revision/intent'
import { regenerateFrozenOfficeRevision } from '../src/main/office-revision/effect'
import { finalizeOfficeRevisionToolResult } from '../src/main/office-revision/producer'
import { isOfficeRevisionTarget } from '../src/main/office-revision/target-validation'
import { readScopedOfficeArtifact } from '../src/main/office-revision/scope'
import { prepareEffectExecution, markEffectExecutionStarted, completeEffectExecution } from '../src/main/task/effect-runtime'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { getPersistedArtifactLifecycle } from '../src/main/task/artifact-lifecycle-api'
import { saveWorkflowAcceptance, listPersistedWorkflowLedger, listWorkflowEvidence } from '../src/main/task/workflow-ledger-api'
import { slideTextRevision } from '../src/renderer/src/components/workbench/office-revision/office-revision-model'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { TaskPlanCanonicalProjector } from '../src/main/task/task-plan-canonical-projection'
import { syncTaskPlanLedger, purgeTaskPlanLedgerForSession } from '../src/main/task/task-plan-ledger'
import { requirementContinuationDraft } from '../src/main/task/task-plan-requirements'
import { readTaskSnapshotDatabase } from '../src/main/task/task-snapshot'
import { verifyArtifactLifecycle } from '../src/main/task/artifact-lifecycle-verification'
import { readWorkflowEventChain } from '../src/main/task/workflow-ledger-query'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-office-revision-'))), cwd = join(root, 'formal')
mkdirSync(cwd)
const meta = { id: 'ppt-revision', createdAt: 1, cwd, status: 'idle', taskStrategy: 'plan', title: 'PPT local revision fixture',
  providerId: 'fixture', model: 'fixture', engine: 'openai', permissionMode: 'default', costUsd: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
  workspaceId: 'revision-project', projectId: 'revision-project', goalId: 'revision-goal', workItemId: 'revision-work', childTaskId: 'revision-task' } as SessionMeta
let passed = 0
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); passed++; console.log(`PASS ${name}`) }
async function main() {
  const workspace = await openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: meta.workspaceId!, name: 'Revision fixture', kind: 'office' })
  const commands = createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: meta.goalId!, projectId: meta.workspaceId!, title: 'Prepare report', objective: 'Revise a selected slide', status: 'verifying' })
  await commands.createWorkItem({ id: meta.workItemId!, projectId: meta.workspaceId!, goalId: meta.goalId, title: 'Draft presentation', type: 'planning', status: 'verifying' })
  const originalAcceptance = await saveWorkflowAcceptance({ id: 'office-original-requirements', projectId: meta.workspaceId,
    goalId: meta.goalId, workItemId: meta.workItemId, criteria: ['输出 PPTX，控制在一页，注明来源'], status: 'pending', evidenceRefs: [],
    revision: 1, createdAt: 1, updatedAt: 1 }, root)
  const run: TaskRunRecord = { schemaVersion: 1, id: 'revision-run', sessionId: meta.id, taskId: meta.childTaskId!, status: 'executing',
    revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, steps: [], toolExecutions: [], effects: [] }
  const saved = await saveTaskSnapshot(buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
  taskRuntimeRegistry.set(meta.id, saved.run!)
  await saveWorkflowAcceptance({ ...originalAcceptance, status: 'verifying', revision: 2, updatedAt: 2 }, root)
  const item = await workspace.getWorkItem(meta.workItemId!)
  await commands.updateWorkItem(item!.id, { runRefs: [run.id] }, { expectedRevision: item!.revision })

  const grants = new PreparationPermissionStore(root)
  const grant = grants.grant(meta, { expectedRevision: 0, allowedWriteTools: ['create_presentation'] }, 'local-user:fixture')
  const draftArgs = { path: join(grant.directory!, 'original.pptx'), title: 'Customer presentation', slides: [
    { title: 'Original title', body: 'Report facts and sources' }, { title: 'Keep this page', body: 'Other page unchanged' }
  ] }
  const scope = resolvePreparationToolScope(meta, 'create_presentation', draftArgs, root)
  const creationInput = { rootDir: root, sessionId: meta.id, toolUseId: 'create-ppt-fixture', toolName: 'create_presentation', toolInput: draftArgs, cwd: scope.cwd, officeSourceCwd: cwd }
  const creation = await prepareEffectExecution(creationInput)
  assert(creation)
  await markEffectExecutionStarted(creation, creationInput)
  const creationResult = await executeOfficeCreationTool('create_presentation', draftArgs, scope.cwd, {
    sessionMeta: meta, userDataRoot: root, preparationPermission: scope.preparation, effectTarget: creation.target
  })
  const created = await completeEffectExecution(creation, creationResult)
  assert.equal(created?.status, 'confirmed')
  const artifactId = `artifact:office:${created!.id}`
  const original = await getPersistedArtifactLifecycle(artifactId, root)
  assert(original)
  await check('Office checks bind actual page count to the original Run Acceptance revision and leave user acceptance open', async () => {
    const evidence = (await listWorkflowEvidence({ artifactId }, root)).find(item => item.verifier === 'office-request-requirements')
    assert(evidence)
    const report = evidence.metadata?.report as { binding: { acceptanceRevision: number }; checks: Array<{ requirement: { kind: string }; status: string; actualPageCount?: number }> }
    assert.equal(report.binding.acceptanceRevision, 1)
    assert.equal(evidence.runId, run.id)
    assert.equal(evidence.artifactId, artifactId)
    assert.equal(evidence.contentDigest, original.digest.slice(7))
    assert.equal(report.checks.find(item => item.requirement.kind === 'page_count')?.actualPageCount, 2)
    assert.equal(report.checks.find(item => item.requirement.kind === 'page_count')?.status, 'failed')
    const ledger = await listPersistedWorkflowLedger({}, root)
    assert.equal(ledger.acceptances.items.find(item => item.id === originalAcceptance.id)?.status, 'verifying')
    assert.ok(ledger.acceptances.items.some(item => item.id.startsWith(`acceptance:office-requirements:${artifactId}:`) && item.status === 'verifying'))
    assert.ok(ledger.acceptances.items.some(item => item.id.startsWith(`acceptance:office-requirements:${artifactId}:`) && item.status === 'failed'))
  })
  const sourceBytes = readFileSync(draftArgs.path)
  grants.revoke(meta, { expectedRevision: grant.revision }, 'local-user:fixture')
  meta.taskStrategy = 'execute'
  const context = { meta, rootDir: root }
  const snapshot = await inspectScopedOffice(context, artifactId, original.digest)
  const selected = snapshot.slideTexts!.find((text) => text.text === 'Original title')!
  assert(selected?.editable)
  const operation = slideTextRevision(snapshot, selected.slideId, selected.shapeId, 'Revised customer title')
  const plan = await prepareOfficeRevision(context, { baseArtifactId: artifactId, expectedDigest: original.digest, operations: [operation] })
  const intent = { planId: plan.planId, planDigest: plan.planDigest, baseArtifactId: artifactId, baseDigest: original.digest }
  await check('canonical preparation source remains readable after write grant revocation and has a real frozen preview', () => {
    assert.equal(grants.get(meta).status, 'revoked')
    assert.equal(plan.changes[0].before, 'Original title')
    assert.equal(plan.changes[0].after, 'Revised customer title')
    assert.equal(plan.nextVersion, 2)
    assert.ok(plan.checks.some((value) => value.id === 'unselected-content' && value.state === 'passed'))
  })
  await authorizeOfficeRevisionSend({ meta, payload: { text: 'Revise the selected title', officeRevisionIntent: intent }, run: taskRuntimeRegistry.get(meta.id)!, rootDir: root })
  const input = { rootDir: root, sessionId: meta.id, toolUseId: 'revise-ppt-fixture', toolName: 'revise_office_artifact', toolInput: intent, cwd }
  const handle = await prepareEffectExecution(input)
  assert(handle && handle.target.kind === 'office_artifact_revision')
  const target = handle.target
  await check('frozen Effect contains exact page, shape, base Artifact and formal pptx output', () => {
    assert.equal(isOfficeRevisionTarget(target), true)
    assert.equal(target.artifactKind, 'presentation')
    assert.equal(target.baseArtifactId, artifactId)
    assert.deepEqual(target.operations, [operation])
    assert(target.workspacePath.startsWith(`${cwd}/artifacts/`))
    assert(target.workspacePath.endsWith('.pptx'))
    assert.equal(isOfficeRevisionTarget({ ...target, artifactKind: 'document' }), false)
  })
  await check('manual original changes and forged frozen replacements fail before output is written', async () => {
    writeFileSync(draftArgs.path, Buffer.concat([sourceBytes, Buffer.from('manual edit')]))
    await assert.rejects(regenerateFrozenOfficeRevision(context, target), /BASE_CHANGED/)
    writeFileSync(draftArgs.path, sourceBytes)
    await assert.rejects(regenerateFrozenOfficeRevision(context, { ...target, operations: [{ ...operation, text: 'forged' }] as typeof target.operations }), /OUTPUT_CONFLICT/)
    assert.equal(existsSync(target.workspacePath), false)
  })
  await markEffectExecutionStarted(handle, input)
  const result = await executeOfficeRevisionTool('revise_office_artifact', intent, { sessionMeta: meta, userDataRoot: root, effectTarget: target })
  assert.equal(JSON.parse(result.output).status, 'awaiting_canonical_registration')
  const effect = await completeEffectExecution(handle, result)
  assert.equal(effect?.status, 'confirmed')
  const finalized = JSON.parse((await finalizeOfficeRevisionToolResult(result, effect, root)).output)
  await check('formal revision registers same-lineage v2 with preserved original and canonical delivery evidence', async () => {
    assert.equal(finalized.status, 'registered')
    assert.equal(finalized.version, 2)
    assert.equal(finalized.lineageId, original.lineageId)
    assert.equal(finalized.supersedesId, artifactId)
    const record = await getPersistedArtifactLifecycle(finalized.artifactId, root)
    assert.equal(record?.kind, 'presentation')
    assert.equal(record?.digest, target.expectedSha256)
    const revisedEvidence = (await listWorkflowEvidence({ artifactId: finalized.artifactId }, root)).find(item => item.verifier === 'office-request-requirements')
    assert.equal(revisedEvidence?.contentDigest, target.expectedSha256.slice(7))
    assert.equal(revisedEvidence?.metadata?.artifactVersion, 2)
    assert.deepEqual(readFileSync(draftArgs.path), sourceBytes)
    const finalSnapshot = await inspectScopedOffice(context, finalized.artifactId, finalized.digest)
    assert.equal(finalSnapshot.slideTexts!.find((text) => text.slideId === selected.slideId && text.shapeId === selected.shapeId)!.text, 'Revised customer title')
    assert.ok(finalSnapshot.slideTexts!.some((text) => text.text === 'Other page unchanged'))
  })
  await check('old-head plans and unrelated Project scope cannot reuse the original', async () => {
    await assert.rejects(prepareOfficeRevision(context, { baseArtifactId: artifactId, expectedDigest: original.digest, operations: [operation] }), /BASE_NOT_HEAD/)
    await assert.rejects(readScopedOfficeArtifact({ ...context, meta: { ...meta, workspaceId: 'other-project' } }, artifactId), /SCOPE_MISMATCH/)
  })
  await check('approved amendment child edits the exact prior file and keeps the lineage across WorkItems', async () => {
    const goal = (await workspace.getGoal(meta.goalId!))!, item = (await workspace.getWorkItem(meta.workItemId!))!
    await commands.reviseGoalRequirements(goal.id, { sessionId: meta.id, projectId: goal.projectId, workItemId: item.id,
      requestId: 'revise-existing', messageId: `session-input:${meta.id}:revise-existing`, payloadDigest: 'b'.repeat(64),
      text: '第二页补来源', intent: { schemaVersion: 1, kind: 'revise_delivery_requirements',
        expectedGoalRevision: goal.revision, expectedWorkItemRevision: item.revision } })
    const revisedGoal = (await workspace.getGoal(meta.goalId!))!
    const draft = await requirementContinuationDraft(meta, revisedGoal.revision, root)
    assert.deepEqual(draft.requirementSource!.artifacts!.map(file => file.artifactId), [finalized.artifactId])
    const plans = new TaskPlanContractStore(() => root)
    const pending = plans.createVersion({ sessionId: meta.id, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId }, draft, 'local-user')
    await syncTaskPlanLedger(root, pending)
    const projection = await new TaskPlanCanonicalProjector(() => root).project(pending.currentVersion!)
    const child = { ...meta, id: 'amendment-child', parentSessionId: meta.id, workItemId: projection.steps[0].workItemId, childTaskId: 'amendment-step' }
    const childRun = { ...run, id: 'amendment-run', sessionId: child.id, taskId: child.childTaskId, createdAt: Date.now(), updatedAt: Date.now() }
    await assert.rejects(inspectScopedOffice({ meta: child, rootDir: root }, finalized.artifactId), /SCOPE_MISMATCH/)
    const approved = plans.approve(meta.id, pending.currentVersion!, projection)
    await syncTaskPlanLedger(root, approved)
    await saveTaskSnapshot(buildTaskSnapshot({ meta: child, run: childRun, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created' }), root)
    taskRuntimeRegistry.set(child.id, childRun)
    const childContext = { meta: child, rootDir: root }
    await assert.rejects(inspectScopedOffice(childContext, original.artifactId), /SCOPE_MISMATCH/)
    const base = await inspectScopedOffice(childContext, finalized.artifactId)
    const text = base.slideTexts!.find(shape => shape.text === 'Other page unchanged')!
    const nextPlan = await prepareOfficeRevision(childContext, { baseArtifactId: finalized.artifactId, expectedDigest: finalized.digest,
      operations: [slideTextRevision(base, text.slideId, text.shapeId, 'Other page unchanged; source: annual report')] })
    const nextIntent = { planId: nextPlan.planId, planDigest: nextPlan.planDigest, baseArtifactId: finalized.artifactId, baseDigest: finalized.digest }
    const nextInput = { rootDir: root, sessionId: child.id, toolUseId: 'amendment-revision', toolName: 'revise_office_artifact', toolInput: nextIntent, cwd }
    const nextHandle = await prepareEffectExecution(nextInput)
    assert(nextHandle && nextHandle.target.kind === 'office_artifact_revision')
    assert.equal(nextHandle.target.revisionRunId, childRun.id)
    assert(isOfficeRevisionTarget(nextHandle.target))
    await syncTaskPlanLedger(root, plans.revoke(meta.id, pending.currentVersion!))
    await assert.rejects(executeOfficeRevisionTool('revise_office_artifact', nextIntent, { sessionMeta: child, userDataRoot: root, effectTarget: nextHandle.target }), /SCOPE_MISMATCH/)
    await completeEffectExecution(nextHandle, { ok: false, output: 'Approval revoked before any file write' })
    await syncTaskPlanLedger(root, plans.approve(meta.id, pending.currentVersion!, projection))
    // A new approval cannot refresh an old Run's input authority silently.
    await assert.rejects(inspectScopedOffice(childContext, finalized.artifactId), /SCOPE_MISMATCH/)
    const cancelledRun = taskRuntimeRegistry.get(child.id)!
    await saveTaskSnapshot(buildTaskSnapshot({ meta: child, run: { ...cancelledRun, status: 'cancelled',
      revision: cancelledRun.revision + 1, updatedAt: Date.now() }, transcript: [], lastSeq: 0, eventCount: 0, reason: 'important-event' }), root)
    const restartedRun = { ...childRun, id: 'amendment-run-reapproved', steps: [], toolExecutions: [], effects: [], createdAt: Date.now(), updatedAt: Date.now() }
    const restarted = await saveTaskSnapshot(buildTaskSnapshot({ meta: child, run: restartedRun, transcript: [], lastSeq: 1, eventCount: 1, reason: 'created' }), root)
    assert.equal(restarted.run?.id, restartedRun.id)
    const frozenInputs = await readTaskSnapshotDatabase(root, db => readWorkflowEventChain(db).find(event => event.eventId === `workflow:run:${restartedRun.id}:requirements`))
    assert(frozenInputs?.payload.revisionAccess, 'new Run freezes current approved originals')
    const childItem = (await workspace.getWorkItem(child.workItemId!))!
    await commands.updateWorkItem(childItem.id, { runRefs: [childRun.id, restartedRun.id] }, { expectedRevision: childItem.revision })
    taskRuntimeRegistry.set(child.id, restartedRun)
    const replan = await prepareOfficeRevision(childContext, { baseArtifactId: finalized.artifactId, expectedDigest: finalized.digest,
      operations: [slideTextRevision(base, text.slideId, text.shapeId, 'Other page unchanged; source: annual report')] })
    const reintent = { ...nextIntent, planId: replan.planId, planDigest: replan.planDigest }
    const reinput = { ...nextInput, toolUseId: 'amendment-reapproved', toolInput: reintent }
    const rehandle = await prepareEffectExecution(reinput)
    assert(rehandle)
    await markEffectExecutionStarted(rehandle, reinput)
    const output = await executeOfficeRevisionTool('revise_office_artifact', reintent, { sessionMeta: child, userDataRoot: root, effectTarget: rehandle.target })
    const completed = await completeEffectExecution(rehandle, output)
    assert.equal(completed?.status, 'confirmed')
    const revision = JSON.parse((await finalizeOfficeRevisionToolResult(output, completed, root)).output)
    const record = await getPersistedArtifactLifecycle(revision.artifactId, root)
    assert.equal(record?.workItemId, child.workItemId)
    assert.equal(record?.version, 3); assert.equal(record?.supersedesId, finalized.artifactId)
    const inspected = await inspectScopedOffice(childContext, revision.artifactId)
    assert(inspected.slideTexts!.some(shape => shape.text === 'Revised customer title'))
    assert(inspected.slideTexts!.some(shape => shape.text.includes('source: annual report')))
    assert.equal((await inspectScopedOffice(context, finalized.artifactId)).artifact.latest, false)
    await syncTaskPlanLedger(root, plans.revoke(meta.id, pending.currentVersion!))
    await finalizeOfficeRevisionToolResult(output, completed, root)
    await purgeTaskPlanLedgerForSession(root, meta.id)
    plans.deleteSession(meta.id)
    await finalizeOfficeRevisionToolResult(output, completed, root)
    await readTaskSnapshotDatabase(root, db => verifyArtifactLifecycle(db, root))
  })
  console.log(`Office revision lifecycle: ${passed}/${passed} passed; isolated actual stores and Effects, no Provider calls.`)
}
main().finally(() => rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
