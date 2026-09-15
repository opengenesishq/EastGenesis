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
import { slideTextRevision } from '../src/renderer/src/components/workbench/office-revision/office-revision-model'

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
  const run: TaskRunRecord = { schemaVersion: 1, id: 'revision-run', sessionId: meta.id, taskId: meta.childTaskId!, status: 'executing',
    revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, steps: [], toolExecutions: [], effects: [] }
  const saved = await saveTaskSnapshot(buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
  taskRuntimeRegistry.set(meta.id, saved.run!)
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
    assert.deepEqual(readFileSync(draftArgs.path), sourceBytes)
    const finalSnapshot = await inspectScopedOffice(context, finalized.artifactId, finalized.digest)
    assert.equal(finalSnapshot.slideTexts!.find((text) => text.slideId === selected.slideId && text.shapeId === selected.shapeId)!.text, 'Revised customer title')
    assert.ok(finalSnapshot.slideTexts!.some((text) => text.text === 'Other page unchanged'))
  })
  await check('old-head plans and unrelated Project scope cannot reuse the original', async () => {
    await assert.rejects(prepareOfficeRevision(context, { baseArtifactId: artifactId, expectedDigest: original.digest, operations: [operation] }), /BASE_NOT_HEAD/)
    await assert.rejects(readScopedOfficeArtifact({ ...context, meta: { ...meta, workspaceId: 'other-project' } }, artifactId), /SCOPE_MISMATCH/)
  })
  console.log(`Office revision lifecycle: ${passed}/${passed} passed; isolated actual stores and Effects, no Provider calls.`)
}
main().finally(() => rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
