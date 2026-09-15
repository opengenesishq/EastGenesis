import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import { PREPARATION_WRITE_TOOLS } from '../src/shared/preparation-permission-types'
import { executeCodingTool } from '../src/main/openaiTools'
import { buildEffectDescriptor } from '../src/main/task/effect-reconciler'
import { executeOfficeArtifactTool } from '../src/main/agent/tools/office-artifact'
import { PreparationPermissionStore } from '../src/main/permission/preparation-permission-store'
import { resolvePreparationToolScope } from '../src/main/permission/preparation-tool-scope'
import { preparationPaths } from '../src/main/data-lifecycle/preparation-data-files'
import { withDataLifecycleMutation } from '../src/main/data-lifecycle/data-lifecycle-mutation-lock'
import { prepareEffectExecution, markEffectExecutionStarted, completeEffectExecution } from '../src/main/task/effect-runtime'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { getPersistedArtifactLifecycle } from '../src/main/task/artifact-lifecycle-api'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-prep-office-'))), cwd = join(root, 'formal')
mkdirSync(cwd)
const meta = { id: 'office-draft', createdAt: 1, cwd, status: 'idle', taskStrategy: 'plan',
  title: 'Office preparation fixture', providerId: 'fixture-provider', model: 'fixture-model', engine: 'openai',
  permissionMode: 'default', costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
  workspaceId: 'office-project', projectId: 'office-project', goalId: 'office-goal', workItemId: 'office-work', childTaskId: 'office-task' } as SessionMeta
const store = new PreparationPermissionStore(root)
let view = store.grant(meta, { expectedRevision: 0 }, 'local-user:fixture')
const directory = view.directory!, source = join(cwd, 'source.csv')
writeFileSync(source, 'Quarter,Revenue\nQ1,120\nQ2,180\n')
let passed = 0
async function check(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`PASS ${name}`) }
const draft = (name: string) => ({ path: join(directory, `${name}.docx`), title: '客户报告', paragraphs: ['收入来自 source.csv'], source_refs: ['source.csv'] })
async function runTool(name: string, args: Record<string, unknown>) {
  const scope = resolvePreparationToolScope(meta, name, args, root)
  const input = { rootDir: root, sessionId: meta.id, toolUseId: String(args.path), toolName: name,
    toolInput: args, cwd: scope.cwd, officeSourceCwd: meta.cwd }
  const handle = await prepareEffectExecution(input)
  assert(handle)
  await markEffectExecutionStarted(handle, input)
  const result = await executeCodingTool(name, args, scope.cwd, { preparationPermission: scope.preparation,
    sessionMeta: meta, userDataRoot: root, effectTarget: handle.target })
  const effect = await completeEffectExecution(handle, result)
  assert.equal(effect?.status, 'confirmed')
  const artifact = await getPersistedArtifactLifecycle(`artifact:office:${effect!.id}`, root)
  assert(artifact); assert.equal(artifact.sourceRef, args.path)
  return result
}
async function main() {
  const workspace = await openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: meta.workspaceId!, name: 'Office draft fixture', kind: 'office' })
  const commands = createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: meta.goalId!, projectId: meta.workspaceId!, title: 'Prepare report', objective: 'Produce draft files', status: 'verifying' })
  await commands.createWorkItem({ id: meta.workItemId!, projectId: meta.workspaceId!, goalId: meta.goalId, title: 'Draft report', type: 'planning', status: 'verifying' })
  const run: TaskRunRecord = { schemaVersion: 1, id: 'office-run', sessionId: meta.id, taskId: 'office-task', status: 'executing',
    revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, steps: [], toolExecutions: [], effects: [] }
  const snapshot = await saveTaskSnapshot(buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
  taskRuntimeRegistry.set(meta.id, snapshot.run!)
  const item = await workspace.getWorkItem(meta.workItemId!)
  if (!item!.runRefs.includes(run.id)) await commands.updateWorkItem(item!.id, { runRefs: [...item!.runRefs, run.id] }, { expectedRevision: item!.revision })
  await check('legacy record without tool scope stays text-only until explicit grant expansion', () => {
    const file = preparationPaths(root, meta.id).permission
    const { digest: _, ...old } = JSON.parse(readFileSync(file, 'utf8'))
    delete old.allowedWriteTools
    old.events.forEach((event: Record<string, unknown>) => delete event.allowedWriteTools)
    writeFileSync(file, JSON.stringify({ ...old, digest: createHash('sha256').update(JSON.stringify(old)).digest('hex') }))
    assert.deepEqual(new PreparationPermissionStore(root).get(meta).allowedWriteTools, ['write_file'])
    assert.throws(() => resolvePreparationToolScope(meta, 'create_document', draft('legacy'), root), /授权范围/)
    assert.equal(store.grant(meta, { expectedRevision: view.revision }, 'local-user:fixture').revision, view.revision)
    const oldRevision = view.revision
    view = store.grant(meta, { expectedRevision: view.revision, allowedWriteTools: PREPARATION_WRITE_TOOLS }, 'local-user:fixture')
    assert.equal(view.revision, oldRevision + 1)
    assert.throws(() => store.assertWritable(meta, oldRevision, directory), /撤销或变更/)
  })
  for (const [name, suffix, spec] of [
    ['create_document', 'docx', { paragraphs: ['资料来自 source.csv'] }],
    ['create_spreadsheet', 'xlsx', { sheets: [{ name: '收入', rows: [['季度', '收入'], ['Q1', 120]] }] }],
    ['create_presentation', 'pptx', { slides: [{ title: '客户汇报', body: '来源 source.csv' }] }],
    ['create_pdf', 'pdf', { sections: [{ heading: '客户汇报', paragraphs: ['来源 source.csv'] }] }]
  ] as const) {
    await check(`explicit preparation grant produces actual ${suffix} bytes through frozen Effect`, async () => {
      const args = { path: join(directory, `report.${suffix}`), title: '客户汇报', source_refs: ['source.csv'], ...spec }
      const result = await runTool(name, args)
      assert.equal(result.ok, true, result.output)
      const output = JSON.parse(result.output), bytes = readFileSync(args.path)
      assert(bytes.length > 100); assert.equal(output.bytes, bytes.length)
      assert.equal(output.sha256.replace(/^sha256:/, ''), createHash('sha256').update(bytes).digest('hex'))
      assert.deepEqual(output.sourceRefs, [source])
      assert(!existsSync(join(cwd, `report.${suffix}`)))
    })
  }
  await check('new draft version may cite original task data and an existing isolated draft', async () => {
    const args = { ...draft('v2'), source_refs: ['source.csv', join(directory, 'report.docx')] }
    const result = await runTool('create_document', args)
    assert.equal(result.ok, true, result.output)
    assert.deepEqual(JSON.parse(result.output).sourceRefs, [source, join(directory, 'report.docx')])
    await assert.rejects(() => runTool('create_document', args), /已存在/)
  })
  await check('changed source, forged source root and formal output cannot reuse approved draft Effect', async () => {
    const args = draft('changed')
    const effect = await buildEffectDescriptor({ toolName: 'create_document', toolInput: args, cwd: directory, officeSourceCwd: cwd })
    writeFileSync(source, 'changed after approval')
    const result = await executeCodingTool('create_document', args, directory, { preparationPermission: { revision: view.revision, directory },
      sessionMeta: meta, userDataRoot: root, effectTarget: effect.target })
    assert.equal(result.ok, false); assert(!existsSync(args.path))
    const forged = { ...draft('outside'), source_refs: [join(root, 'outside.txt')], sourceCwd: root }
    writeFileSync(join(root, 'outside.txt'), 'outside task')
    await assert.rejects(() => runTool('create_document', forged), /边界/)
    const formal = await executeCodingTool('create_document', { ...draft('formal'), path: join(cwd, 'escape.docx') }, directory,
      { preparationPermission: { revision: view.revision, directory }, sessionMeta: meta, userDataRoot: root, effectTarget: effect.target })
    assert.equal(formal.ok, false); assert(!existsSync(join(cwd, 'escape.docx')))
  })
  await check('revocation at final file-open boundary prevents writing and removes empty output', async () => {
    const args = draft('revoked')
    const effect = await buildEffectDescriptor({ toolName: 'create_document', toolInput: args, cwd: directory, officeSourceCwd: cwd })
    const revision = view.revision
    let checkpoints = 0
    await assert.rejects(() => executeOfficeArtifactTool('create_document', args, directory, effect.target, undefined, {
      sourceCwd: cwd, assertWriteAuthorized: () => {
        if (++checkpoints === 3) view = store.revoke(meta, { expectedRevision: revision }, 'local-user:fixture')
        store.assertWritable(meta, revision, directory, 'create_document')
      }
    }), /撤销或变更/)
    assert.equal(checkpoints, 3); assert(!existsSync(args.path))
    assert(existsSync(join(directory, 'report.docx')))
  })
  await check('ordinary lifecycle revocation can run while Office generation is pending', async () => {
    view = store.grant(meta, { expectedRevision: view.revision, allowedWriteTools: PREPARATION_WRITE_TOOLS }, 'local-user:fixture')
    const args = draft('interrupt-generation')
    const effect = await buildEffectDescriptor({ toolName: 'create_document', toolInput: args, cwd: directory, officeSourceCwd: cwd })
    const pending = executeCodingTool('create_document', args, directory, { preparationPermission: { revision: view.revision, directory },
      sessionMeta: meta, userDataRoot: root, effectTarget: effect.target })
    await withDataLifecycleMutation(root, () => { view = store.revoke(meta, { expectedRevision: view.revision }, 'local-user:fixture') })
    const result = await pending
    assert.equal(result.ok, false, result.output); assert(!existsSync(args.path))
  })
  console.log(`Preparation Office: ${passed}/${passed} passed; local generation only, no Provider calls.`)
}
main().finally(() => rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
