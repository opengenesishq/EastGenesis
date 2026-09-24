import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Goal, WorkItem } from '../src/shared/project-workspace-types'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import { normalizeRoutineGoalContinuation } from '../src/shared/routine-heartbeat-types'
import { createRoutine, listRoutines, updateRoutine } from '../src/main/routineStore'
import { captureRoutineSessionTarget } from '../src/main/routines/routine-heartbeat-target'
import { RoutineHeartbeatService, type RoutineHeartbeatRuntime } from '../src/main/routines/routine-heartbeat-service'
import { SessionInputService } from '../src/main/task/session-input-service'
import { goalContinuationDecision, type GoalContinuationContext } from '../src/main/routines/goal-continuation-policy'
import { reserveGoalContinuationTurn, settleGoalContinuationTurn } from '../src/main/routines/goal-continuation-progress'
import { pauseSessionContinuations } from '../src/main/routines/pause-session-continuations'
import { listRoutineRuns } from '../src/main/routines/routine-runner'

const roots: string[] = []
let checks = 0
const check = async (label: string, run: () => Promise<void>) => { await run(); checks++; console.log(`PASS ${label}`) }
async function fixture(maxTurns = 5) {
  const root = mkdtempSync(join(tmpdir(), 'caogen-goal-continuation-')); roots.push(root)
  const meta = { id: 'session-a', sdkSessionId: 'sdk-a', createdAt: 1, cwd: root, workspaceId: 'project-a', goalId: 'goal-a', workItemId: 'work-a', taskStrategy: 'execute', status: 'idle' } as SessionMeta
  const runs: TaskRunRecord[] = []
  const results = new Map<string, { text: string; isError: boolean }>()
  let sends = 0, unknown = false, preflight = async () => {}
  const context: GoalContinuationContext = { workspaceActive: true, meta,
    goal: { id: meta.goalId, projectId: meta.workspaceId, status: 'running' } as Goal,
    workItem: { id: meta.workItemId, goalId: meta.goalId, projectId: meta.workspaceId, status: 'running' } as WorkItem,
    budget: { schemaVersion: 1, sessionId: meta.id, source: 'request_budget_ledger', observedAt: Date.now(), state: 'ready', remainingState: 'unlimited' },
    taskRuns: runs, supervisorRuns: [] }
  const inputs = new SessionInputService(root, { meta: id => id === meta.id ? meta : undefined,
    preflight: () => preflight(),
    send: async (id, payload) => {
      assert.equal(id, meta.id); sends++
      if (unknown) return false
      runs.push({ id: `run-${sends}`, sessionId: id, messageId: payload.messageId, status: 'running',
        steps: [{ messageId: payload.messageId, requestText: payload.text }] } as TaskRunRecord)
      meta.status = 'running'; return true
    },
    accepted: async record => runs.some(run => run.messageId === record.messageId && run.steps[0]?.requestText === record.payload.text) })
  const runtime: RoutineHeartbeatRuntime = { meta: id => id === meta.id ? meta : undefined, inputs, runs: async () => runs,
    result: (_session, id) => results.get(id),
    goalCheck: async (routine, record) => goalContinuationDecision(routine, record.id, context),
    goalReserve: record => reserveGoalContinuationTurn(root, record), goalSettle: record => settleGoalContinuationTurn(root, record) }
  const service = new RoutineHeartbeatService(root, runtime)
  const routine = await createRoutine(root, { id: 'goal-continuation-session-a', name: 'Continue goal', prompt: 'Make the next verified step', projectCwd: root,
    executionTarget: captureRoutineSessionTarget(meta), goalContinuation: { maxTurns }, schedule: 'every 1m', nextRunAt: 100 })
  const current = async () => (await listRoutines(root))[0]
  let tick = 0
  return { root, meta, context, runs, inputs, service, current, sends: () => sends,
    trigger: async () => service.trigger(await current(), 1000 + tick, ++tick),
    finish: async (text: string) => { const run = runs.at(-1)!; run.status = 'completed'; run.finishedAt = Date.now(); meta.status = 'idle'; results.set(run.messageId!, { text, isError: false }); await service.sweep() },
    unknown: () => { unknown = true }, preflight: (fn: () => Promise<void>) => { preflight = fn },
    restart: () => new RoutineHeartbeatService(root, runtime) }
}

async function main() {
  await check('goal continuation always requires a bounded turn limit', async () => {
    for (const value of [{}, { maxTurns: 0 }, { maxTurns: Infinity }, { maxTurns: 101 }]) assert.throws(() => normalizeRoutineGoalContinuation(value), /1–100/)
    assert.deepEqual(normalizeRoutineGoalContinuation({ maxTurns: 5 }), { maxTurns: 5 })
  })
  await check('same task continues across turns and persists the cap before dispatch', async () => {
    const f = await fixture(2), identity = { ...f.meta }
    await f.trigger(); assert.equal(f.sends(), 1); assert.equal((await f.current()).goalContinuationState?.turns, 1)
    await f.finish('First deliverable'); await f.trigger(); assert.equal(f.sends(), 2)
    await f.finish('Second deliverable')
    const plan = await f.current(); assert.equal(plan.enabled, false); assert.equal(plan.goalContinuationState?.status, 'limited')
    await f.restart().sweep(); assert.equal(f.sends(), 2)
    assert.equal(f.meta.id, identity.id); assert.equal(f.meta.sdkSessionId, identity.sdkSessionId); assert.equal(f.meta.goalId, identity.goalId); assert.equal(f.meta.workItemId, identity.workItemId)
  })
  await check('canonical goal completion stops without a provider call or inventing acceptance', async () => {
    const f = await fixture(); f.context.goal!.status = 'completed'
    const record = await f.trigger(); assert.equal(record.status, 'succeeded'); assert.equal(f.sends(), 0)
    assert.equal((await f.current()).goalContinuationState?.status, 'completed')
    assert.equal((await f.current()).enabled, false); assert.equal(f.context.goal!.acceptanceResult, undefined)
  })
  await check('approval waits in the original task and explicit pause prevents queued dispatch', async () => {
    const f = await fixture(); f.context.goal!.status = 'waiting_approval'
    await f.trigger(); assert.equal(f.sends(), 0); assert.equal((await f.current()).enabled, true)
    await pauseSessionContinuations(f.root, f.meta.id); f.context.goal!.status = 'running'
    await f.restart().sweep(); assert.equal(f.sends(), 0)
    await updateRoutine(f.root, (await f.current()).id, { enabled: true }); await f.service.sweep()
    assert.equal(f.sends(), 1)
  })
  await check('budget exhaustion during authorization is checked again before sending', async () => {
    const f = await fixture(); f.preflight(async () => { f.context.budget.remainingState = 'exhausted' })
    await f.trigger(); assert.equal(f.sends(), 0); assert.equal((await f.current()).enabled, false)
    assert.equal((await f.current()).goalContinuationState?.turns, 0)
  })
  await check('unknown dispatch keeps the reserved turn and never replays after restart', async () => {
    const f = await fixture(); f.unknown(); await f.trigger()
    assert.equal((await f.current()).enabled, false); assert.equal((await f.current()).goalContinuationState?.turns, 1)
    await f.restart().sweep(); await f.restart().sweep(); assert.equal(f.sends(), 1)
    assert.equal((await listRoutineRuns(f.root))[0].heartbeat?.phase, 'needs_reconciliation')
  })
  await check('repeated identical results stop automatic looping', async () => {
    const f = await fixture(5); await f.trigger(); await f.finish('No additional progress')
    await f.trigger(); await f.finish('No additional progress')
    assert.equal((await f.current()).enabled, false); assert.equal((await f.current()).goalContinuationState?.status, 'stalled')
    await f.restart().sweep(); assert.equal(f.sends(), 2)
  })
  console.log(`goal-continuation-required: ${checks}/${checks}; real Routine and SessionInput stores; local execution boundary only; no Provider calls`)
}
main().finally(() => roots.forEach(root => rmSync(root, { recursive: true, force: true }))).catch(error => { console.error(error); process.exitCode = 1 })
