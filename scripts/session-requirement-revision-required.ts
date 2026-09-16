import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from '../src/main/engine'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import { createProjectGoalTask } from '../src/main/project-workspace/goal-task-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { SessionInputService } from '../src/main/task/session-input-service'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { createAutomaticTaskPlan } from '../src/main/task/automatic-task-plan'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import { previewSessionRequirementRevision } from '../src/shared/session-requirement-revision'
import { sessionInputIntent } from '../src/renderer/src/components/composer/session-input-intent'
import { buildTaskSnapshot } from '../src/main/task/task-snapshot-builder'
import { readTaskSnapshotDatabase, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { findWorkflowRun } from '../src/main/task/workflow-ledger-store'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'
import { buildSessionRequirementContext } from '../src/main/task/session-requirement-context'
import { readOfficeRunRequirements } from '../src/main/task/office-delivery-requirement-ledger'

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'caogen-requirement-revision-'))
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Provider calls forbidden in this local check') }
  try {
    const workspace = await openProjectWorkspaceStore(root)
    await workspace.createWorkspace({ id: 'requirements-project', name: 'Requirements' })
    const objective = '把这些数据做成客户汇报，控制在六页，输出 PPTX。'
    const original = await createProjectGoalTask({ projectId: 'requirements-project', requestId: 'original', objective }, root)
    const reads = createProjectWorkspaceReadService(root, 'canonical')
    const meta = { id: 'requirements-session', workspaceId: original.goal.projectId, goalId: original.goal.id,
      workItemId: original.workItem.id, businessLineId: 'studio', taskStrategy: 'plan', status: 'idle',
      createdAt: 1, cwd: root, title: 'Requirements', providerId: 'fixture', model: 'fixture', engine: 'openai',
      permissionMode: 'default', costUsd: 0, contextTokens: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } } as SessionMeta
    const engine = { meta, setTaskStrategy: async (value: SessionMeta['taskStrategy']) => { meta.taskStrategy = value } } as Engine
    const plans = new TaskPlanSessionCoordinator(id => id === meta.id ? engine : undefined, () => root)
    const initial = await plans.createGeneratedVersion(meta.id, await createAutomaticTaskPlan(objective))
    await plans.approve(meta.id, initial.currentVersion!)
    const run: TaskRunRecord = { schemaVersion: 1, id: 'old-run', sessionId: meta.id, taskId: meta.id,
      status: 'planning', revision: 1, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, steps: [], toolExecutions: [], effects: [] }
    await saveTaskSnapshot(buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
    const frozen = await readTaskSnapshotDatabase(root, db => findWorkflowRun(db, run.id))
    assert(frozen)
    const before = await readOfficeRunRequirements(frozen, root)
    await saveTaskSnapshot(buildTaskSnapshot({ meta, run: { ...run, status: 'completed', revision: 2, updatedAt: 3 },
      transcript: [], lastSeq: 0, eventCount: 0, reason: 'important-event', now: 3 }), root)
    let sends = 0
    const runtime = { meta: () => meta, send: async () => { sends++; return true }, accepted: async () => false,
      preflight: async () => { await plans.assertInteractiveExecution(meta.id, '继续任务') } }
    const inputs = new SessionInputService(root, runtime)
    const goal = (await reads.getGoal(original.goal.id))!, item = (await reads.getWorkItem(original.workItem.id))!
    const text = '第二页补来源；改成八页。'
    const preview = previewSessionRequirementRevision(goal, item, text)
    assert(preview.changed)
    assert(preview.goalContract.acceptance.some(entry => entry.criterion === '第二页补来源'))
    assert(!preview.goalContract.acceptance.some(entry => entry.criterion.includes('六页')))
    await inputs.queue(meta.id, 'amendment', { text, requirementRevisionIntent: { schemaVersion: 1,
      kind: 'revise_delivery_requirements', expectedGoalRevision: goal.revision, expectedWorkItemRevision: item.revision } })
    const result = await inputs.apply(meta.id, 'amendment')
    assert.equal(result.phase, 'requirements_applied'); assert.equal(sends, 0)
    const revised = (await reads.getGoal(goal.id))!
    assert.deepEqual(revised.contract, preview.goalContract)
    assert.equal(revised.objective, objective, 'initial submission identity is preserved')
    assert.deepEqual(await readOfficeRunRequirements(frozen, root), before, 'old Run keeps six-page contract')
    assert.deepEqual(await new SessionInputService(root, runtime).apply(meta.id, 'amendment'), JSON.parse(JSON.stringify(result)))
    assert.equal((await reads.getGoal(goal.id))!.revision, revised.revision)
    console.log('PASS canonical amendment, child inheritance, original identity, frozen Run and durable retry')
    await assert.rejects(plans.approve(meta.id, initial.currentVersion!), /交付要求已更新/)
    meta.taskStrategy = 'execute'
    await inputs.queue(meta.id, 'continue', { text: '继续修改' })
    await assert.rejects(inputs.apply(meta.id, 'continue'), /交付要求已更新/)
    assert.equal((await inputs.list(meta.id)).find(record => record.id === 'continue')?.phase, 'queued')
    assert.equal(sends, 0)
    await plans.setStrategy(meta.id, 'plan')
    const updated = await plans.refreshRequirements(meta.id, revised.revision)
    assert.equal(updated.currentVersion?.version, 2)
    assert.deepEqual(await plans.refreshRequirements(meta.id, revised.revision), updated)
    const approved = await plans.approve(meta.id, updated.currentVersion!)
    const dag = approvedTaskPlanToDag(meta.id, updated.currentVersion!, approved.projection)
    assert.equal(dag.tasks.length, 1)
    assert(dag.tasks[0].prompt.includes('第二页补来源'))
    assert(dag.tasks[0].prompt.includes('八页'))
    assert.notEqual(dag.tasks[0].id, initial.currentVersion!.steps[0].id)
    console.log('PASS stale approval blocked before dispatch and same-task amendment plan uses current requirements')
    const nextRun = { ...run, id: 'new-run', status: 'executing' as const, createdAt: 3, updatedAt: 3 }
    const next = await saveTaskSnapshot(buildTaskSnapshot({ meta, run: nextRun, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 3 }), root)
    taskRuntimeRegistry.set(meta.id, next.run!)
    const context = await buildSessionRequirementContext(meta, root)
    assert(context.includes('第二页补来源')); assert(context.includes('八页')); assert(!context.includes('六页'))
    assert.equal(sessionInputIntent(text), 'requirements')
    assert.equal(sessionInputIntent('第二页需要补来源吗？'), 'message')
    await inputs.queue(meta.id, 'stale', { text: '控制在九页', requirementRevisionIntent: { schemaVersion: 1,
      kind: 'revise_delivery_requirements', expectedGoalRevision: goal.revision, expectedWorkItemRevision: item.revision } })
    await assert.rejects(inputs.apply(meta.id, 'stale'), /revision|版本/)
    console.log('PASS native Run context, explicit revision intent and stale contract refusal; no Provider calls')
  } finally { taskRuntimeRegistry.clear(); globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
