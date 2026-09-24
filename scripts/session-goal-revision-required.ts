import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from '../src/main/engine'
import type { SessionMeta } from '../src/shared/types'
import { createProjectGoalTask } from '../src/main/project-workspace/goal-task-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { SessionInputService } from '../src/main/task/session-input-service'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { assertScheduledInputCurrent } from '../src/main/routines/scheduled-input-gate'
import { validateSubmissionReceiptBindings } from '../src/main/data-lifecycle/submission-receipt-portability'
import { createAutomaticTaskPlan } from '../src/main/task/automatic-task-plan'
import { previewSessionGoalRevision } from '../src/shared/session-goal-revision'
import { createRoutine, listRoutines, updateRoutine } from '../src/main/routineStore'
import { captureRoutineSessionTarget } from '../src/main/routines/routine-heartbeat-target'
import { RoutineHeartbeatService } from '../src/main/routines/routine-heartbeat-service'
import { reserveRoutineHeartbeat, listRoutineRuns } from '../src/main/routines/routine-runner'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'caogen-goal-revision-'))
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Provider calls forbidden') }
  try {
    const workspace = await openProjectWorkspaceStore(root)
    await workspace.createWorkspace({ id: 'goals-project', name: 'Goals' })
    const original = await createProjectGoalTask({ projectId: 'goals-project', requestId: 'original', objective: '制作客户汇报，控制在六页，输出 PPTX。' }, root)
    const reads = createProjectWorkspaceReadService(root, 'canonical')
    const meta = { id: 'goal-session', workspaceId: original.goal.projectId, goalId: original.goal.id, workItemId: original.workItem.id,
      businessLineId: 'studio', taskStrategy: 'plan', status: 'idle', createdAt: 1, cwd: root, title: 'Goal', providerId: 'fixture', model: 'fixture',
      engine: 'openai', permissionMode: 'default', costUsd: 4, contextTokens: 0, usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } } as SessionMeta
    const engine = { meta, setTaskStrategy: async (value: SessionMeta['taskStrategy']) => { meta.taskStrategy = value } } as Engine
    const plans = new TaskPlanSessionCoordinator(id => id === meta.id ? engine : undefined, () => root)
    const initial = await plans.createGeneratedVersion(meta.id, await createAutomaticTaskPlan(original.goal.objective))
    await plans.approve(meta.id, initial.currentVersion!)
    let sends = 0
    const runtime = { meta: () => meta, send: async () => { sends++; return true }, accepted: async () => false,
      afterGoalRevision: async () => { await plans.setStrategy(meta.id, 'plan') } }
    const inputs = new SessionInputService(root, runtime)
    const goal = (await reads.getGoal(original.goal.id))!, item = (await reads.getWorkItem(original.workItem.id))!
    const text = '分析客户数据并交付 XLSX，注明来源。'
    const payload = { text, goalRevisionIntent: { schemaVersion: 1 as const, kind: 'revise_goal_objective' as const,
      expectedGoalRevision: goal.revision, expectedWorkItemRevision: item.revision } }
    await inputs.queue(meta.id, 'replace', payload)
    const result = await inputs.apply(meta.id, 'replace')
    assert.equal(result.phase, 'goal_revised'); assert.equal(sends, 0)
    const revised = (await reads.getGoal(goal.id))!, revisedItem = (await reads.getWorkItem(item.id))!
    assert.equal(revised.objective, text); assert.equal(revised.id, goal.id); assert.equal(revisedItem.id, item.id)
    assert.deepEqual(revised.contract, previewSessionGoalRevision(goal, text))
    assert.equal(revised.acceptanceResult, undefined); assert.equal(revisedItem.acceptance, undefined)
    assert(!revised.acceptance.some(criterion => criterion.criterion.includes('六页')))
    assert.equal(meta.costUsd, 4); assert.equal(meta.usage.input, 1)
    assert.deepEqual(await new SessionInputService(root, runtime).apply(meta.id, 'replace'), JSON.parse(JSON.stringify(result)))
    assert.equal((await reads.getGoal(goal.id))!.revision, revised.revision)
    await assert.rejects(inputs.queue(meta.id, 'replace', { ...payload, text: '另一个目标' }), /相同提交标识/)
    const events = (await workspace.getState()).events.filter(event => event.kind === 'goal.objective_revised')
    assert.equal(events.length, 1); assert.equal((events[0].payload.before as any).goalContract.objective, goal.objective)
    console.log('PASS replacement goal, fresh acceptance, canonical identity/cost preservation, durable audit and retry')
    await assert.rejects(plans.approve(meta.id, initial.currentVersion!), /交付要求已更新/)
    await assert.rejects(plans.setStrategy(meta.id, 'execute'), /交付要求已更新/)
    const refreshed = await plans.refreshRequirements(meta.id, revised.revision)
    assert.equal(refreshed.currentVersion?.objective, text)
    assert.equal(refreshed.currentVersion?.version, 2)
    assert.equal(refreshed.currentVersion?.steps.length, 1)
    assert.equal(refreshed.currentVersion?.steps[0].title, '按修订后的目标重新执行')
    await plans.approve(meta.id, refreshed.currentVersion!)
    await inputs.queue(meta.id, 'stale-goal', payload)
    await assert.rejects(inputs.apply(meta.id, 'stale-goal'), /revision|版本/)
    const latestGoal = (await reads.getGoal(goal.id))!
    await inputs.queue(meta.id, 'stale-item', { text: '再改目标', goalRevisionIntent: { ...payload.goalRevisionIntent, expectedGoalRevision: latestGoal.revision } })
    await assert.rejects(inputs.apply(meta.id, 'stale-item'), /revision|版本/)
    await assert.rejects(inputs.queue(meta.id, 'mixed', { ...payload, requirementRevisionIntent: { schemaVersion: 1, kind: 'revise_delivery_requirements', expectedGoalRevision: 1, expectedWorkItemRevision: 1 } }), /夹带/)
    console.log('PASS stale plans and both stale entity revisions refused; new plan requires approval')
    const routineRoot = join(root, 'routines')
    const routine = await createRoutine(routineRoot, { id: 'goal-continuation-goal-session', name: 'Goal continuation',
      projectId: meta.workspaceId, projectCwd: root, prompt: '继续目标', schedule: 'every 1m', enabled: true, executionTarget: captureRoutineSessionTarget(meta),
      goalContinuation: { maxTurns: 5 }, goalContinuationState: { turns: 3, repeatedResults: 0, status: 'active' } })
    const first = await reserveRoutineHeartbeat(routineRoot, routine, 'heartbeat-old', 1, null)
    await inputs.queue(meta.id, first.heartbeat!.inputRequestId, { text: first.heartbeat!.prompt })
    const heartbeat = new RoutineHeartbeatService(routineRoot, { meta: () => meta, inputs,
      runs: async () => [], result: () => undefined, goalCheck: async () => ({ action: 'continue', status: 'active' }), goalReserve: async () => {} })
    const cleared = await heartbeat.retireSessionGoalMode(meta.id)
    assert.equal(cleared.cancelledInputIds.length, 1)
    assert.equal((await inputs.list(meta.id)).find(input => input.id === first.heartbeat!.inputRequestId)?.phase, 'cancelled')
    const paused = (await listRoutines(routineRoot))[0]
    assert.equal(paused.goalContinuationState?.turns, 3); assert.equal(paused.goalContinuationState?.status, 'exited')
    assert.equal(paused.goalContinuationState?.generation, 1); assert.equal(paused.enabled, false)
    assert.equal((await reads.getGoal(goal.id))!.id, goal.id)
    // Simulate a crash after durable generation changed, before old queue cleanup.
    const staleOccurrence = await reserveRoutineHeartbeat(routineRoot, routine, 'heartbeat-stale-generation', 2, null)
    await inputs.queue(meta.id, staleOccurrence.heartbeat!.inputRequestId, { text: staleOccurrence.heartbeat!.prompt })
    await updateRoutine(routineRoot, routine.id, { enabled: true, goalContinuationState: { ...paused.goalContinuationState!, status: 'active' } })
    await heartbeat.sweep(meta.id)
    assert.equal(sends, 0)
    assert.equal((await listRoutineRuns(routineRoot)).find(run => run.id === staleOccurrence.id)?.status, 'failed')
    assert.equal((await listRoutines(routineRoot))[0].goalContinuationState?.turns, 3)
    console.log('PASS clear retires queued inputs; durable generation blocks old occurrences after restart; turn cap retained')
    await assert.rejects(assertScheduledInputCurrent(root, meta.id, staleOccurrence.heartbeat!.inputRequestId), /结束或退出/)
    const active = (await listRoutines(routineRoot))[0]
    const uncertain = await reserveRoutineHeartbeat(routineRoot, active, 'heartbeat-unknown', 3, null)
    await inputs.queue(meta.id, uncertain.heartbeat!.inputRequestId, { text: uncertain.heartbeat!.prompt })
    const unknownReceipt = await inputs.apply(meta.id, uncertain.heartbeat!.inputRequestId)
    assert.equal(unknownReceipt.phase, 'needs_reconciliation'); assert.equal(sends, 1)
    const exitUnknown = await heartbeat.retireSessionGoalMode(meta.id)
    assert(exitUnknown.pendingInputIds.includes(uncertain.heartbeat!.inputRequestId))
    assert.equal((await inputs.list(meta.id)).find(input => input.id === unknownReceipt.id)?.phase, 'needs_reconciliation')
    const exited = (await listRoutines(routineRoot))[0]
    await updateRoutine(routineRoot, exited.id, { enabled: true, goalContinuationState: { ...exited.goalContinuationState!, status: 'active' } })
    await heartbeat.sweep(meta.id)
    assert.equal(sends, 1, 'unknown outcome must never be automatically replayed after clear/resume')
    console.log('PASS generic dispatch gate refuses retired requests; unknown send retained without replay')
    const state = await workspace.getState()
    const aggregate = { projectId: goal.projectId, goals: state.goals, workItems: state.workItems,
      audit: state.events.map(event => ({ source: 'project_workspace', value: event })) } as any
    const slice = { projectId: goal.projectId, sessionInputs: [{ record: result }],
      projectGoals: [{ phase: 'ready', sessionId: meta.id, input: { projectId: goal.projectId, requestId: 'original', objective: original.goal.objective } }] } as any
    validateSubmissionReceiptBindings(slice, aggregate)
    assert.throws(() => validateSubmissionReceiptBindings(slice, { ...aggregate,
      audit: aggregate.audit.filter((entry: any) => entry.value.kind !== 'goal.objective_revised') }), /source binding|Goal request/)
    console.log('PASS portable revised-goal receipt binds audit and preserves immutable initial submission')
  } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
