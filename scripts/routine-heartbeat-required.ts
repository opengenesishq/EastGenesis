import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import { SessionInputService, type SessionInputRuntime } from '../src/main/task/session-input-service'
import { RoutineHeartbeatService, type RoutineHeartbeatRuntime } from '../src/main/routines/routine-heartbeat-service'
import { captureRoutineSessionTarget } from '../src/main/routines/routine-heartbeat-target'
import { createRoutine, listRoutines, updateRoutine, type Routine } from '../src/main/routineStore'
import { listRoutineRuns, runRoutineWithHistory } from '../src/main/routines/routine-runner'

const roots: string[] = []
let checks = 0
async function check(name: string, run: () => Promise<void>): Promise<void> { await run(); checks++; console.log(`PASS ${name}`) }
async function fixture(status: SessionMeta['status'] = 'idle') {
  const root = mkdtempSync(join(tmpdir(), 'caogen-heartbeat-')); roots.push(root)
  const meta = { id: 'task-a', createdAt: 10, status, cwd: root, workspaceId: 'project-a', goalId: 'goal-a', workItemId: 'work-a',
    providerId: 'original-provider', model: 'original-model', permissionMode: 'default', budgetUsd: 2 } as SessionMeta
  const runs: TaskRunRecord[] = []
  const results = new Map<string, { text: string; isError: boolean }>()
  const notifications: string[] = []
  const evidence: string[] = []
  let sends = 0
  let unknown = false
  let preflight: (() => Promise<void>) | undefined
  const inputRuntime: SessionInputRuntime = {
    meta: (id) => id === meta.id ? meta : undefined,
    preflight: async () => { await preflight?.() },
    send: async (id, payload) => {
      assert.equal(id, meta.id); sends++
      if (unknown) return false
      runs.push({ id: `run-${sends}`, sessionId: id, status: 'running', messageId: payload.messageId,
        steps: [{ messageId: payload.messageId, requestText: payload.text }] } as TaskRunRecord)
      meta.status = 'running'
      return true
    },
    accepted: async (record) => runs.some((run) => run.sessionId === record.sessionId && run.messageId === record.messageId &&
      run.steps[0]?.requestText === record.payload.text)
  }
  const inputService = new SessionInputService(root, inputRuntime)
  const runtime: RoutineHeartbeatRuntime = {
    meta: inputRuntime.meta, inputs: inputService, runs: async () => runs,
    result: (_sessionId, messageId) => results.get(messageId),
    persistResult: async (record, run, text) => {
      assert.equal(record.sessionId, meta.id); assert.equal(record.workItemId, 'work-a')
      assert.equal(text, results.get(run.messageId!)?.text); evidence.push(run.id)
      return { artifactId: `artifact-${run.id}`, evidenceId: `evidence-${run.id}` }
    },
    notify: (_routine, record) => { notifications.push(`${record.id}:${record.status}:${record.heartbeat?.phase}`) }
  }
  const service = new RoutineHeartbeatService(root, runtime)
  const makeRoutine = (id = 'plan-a') => createRoutine(root, { id, name: id, prompt: '检查当前任务的新进展',
    projectCwd: root, schedule: 'every 1h', executionTarget: captureRoutineSessionTarget(meta), nextRunAt: 100,
    notification: { enabled: true, onSuccess: true, onFailure: true } })
  const routine = await makeRoutine()
  const current = async () => (await listRoutines(root)).find((item) => item.id === routine.id)!
  const finish = (index = 0) => {
    const run = runs[index]; run.status = 'completed'; run.finishedAt = Date.now(); meta.status = 'idle'
    results.set(run.messageId!, { text: `已完成 ${run.id}`, isError: false })
  }
  return { root, meta, runs, results, service, runtime, inputService, routine, current, makeRoutine, finish, notifications, evidence,
    sends: () => sends, unknown: () => { unknown = true }, preflight: (fn: () => Promise<void>) => { preflight = fn },
    restart: () => new RoutineHeartbeatService(root, { ...runtime, inputs: new SessionInputService(root, inputRuntime) }) }
}

async function main() {
  await check('same Session and canonical identity; exact message-to-run-to-result binding', async () => {
    const f = await fixture(); const original = { ...f.meta }
    const run = await f.service.trigger(f.routine, 200, 100)
    assert.equal(run.status, 'running'); assert.equal(run.sessionId, original.id)
    assert.equal(run.goalId, original.goalId); assert.equal(run.workItemId, original.workItemId)
    assert.equal(run.workflowRunId, f.runs[0].id)
    assert.equal(f.meta.providerId, original.providerId); assert.equal(f.meta.model, original.model)
    assert.equal(f.meta.permissionMode, original.permissionMode); assert.equal(f.meta.budgetUsd, original.budgetUsd)
    await f.service.trigger(await f.current(), 200, 100); assert.equal(f.sends(), 1)
    f.finish(); await f.service.sweep()
    const settled = (await listRoutineRuns(f.root))[0]
    assert.equal(settled.status, 'succeeded'); assert.equal(settled.resultText, '已完成 run-1')
    assert.equal(settled.artifactId, 'artifact-run-1'); assert.deepEqual(f.evidence, ['run-1'])
    assert.equal(f.meta.status, 'idle'); assert.equal(f.meta.workItemId, original.workItemId)
  })
  await check('busy tasks queue and coalesce; queued prompt remains immutable after edit', async () => {
    const f = await fixture('running'); const first = await f.service.trigger(f.routine, 200, 100)
    assert.equal(first.status, 'queued'); assert.equal(f.sends(), 0)
    await updateRoutine(f.root, f.routine.id, { prompt: '后续的新要求' })
    const second = await f.service.trigger(await f.current(), 300, 200)
    assert.equal(second.id, first.id); assert.equal(f.sends(), 0)
    f.meta.status = 'idle'; await f.service.sweep(); assert.equal(f.sends(), 1)
    assert.equal(f.runs[0].steps[0].requestText, f.routine.prompt)
  })
  await check('two plans on one Session cannot dispatch concurrently', async () => {
    const f = await fixture(); const other = await f.makeRoutine('plan-b')
    const [one, two] = await Promise.all([f.service.trigger(f.routine, 200, 100), f.service.trigger(other, 200, 100)])
    assert.equal(f.sends(), 1); assert.equal([one, two].filter((run) => run.status === 'queued').length, 1)
    f.finish(); await f.service.sweep(); assert.equal(f.sends(), 2)
  })
  await check('unknown acceptance pauses once and never replays after restart; positive evidence reconciles', async () => {
    const f = await fixture(); f.unknown()
    const run = await f.service.trigger(f.routine, 200, 100)
    assert.equal(run.heartbeat?.phase, 'needs_reconciliation'); assert.equal((await f.current()).enabled, false)
    await f.restart().sweep(); await f.restart().sweep(); assert.equal(f.sends(), 1); assert.equal(f.notifications.length, 1)
    f.runs.push({ id: 'recovered-run', sessionId: f.meta.id, status: 'completed', messageId: run.heartbeat!.messageId,
      steps: [{ messageId: run.heartbeat!.messageId, requestText: run.heartbeat!.prompt }] } as TaskRunRecord)
    f.results.set(run.heartbeat!.messageId, { text: '已核对原始结果', isError: false })
    await f.restart().sweep(); assert.equal((await listRoutineRuns(f.root))[0].status, 'succeeded')
    assert.equal(f.sends(), 1); assert.equal((await f.current()).enabled, false); assert.equal(f.meta.status, 'idle')
  })
  await check('closed or reassigned task pauses without sending or closing another task', async () => {
    for (const patch of [{ status: 'closed' }, { workItemId: 'other-work' }]) {
      const f = await fixture('running'); await f.service.trigger(f.routine, 200, 100)
      Object.assign(f.meta, { status: 'idle' }, patch); await f.service.sweep()
      assert.equal(f.sends(), 0); assert.equal((await f.current()).enabled, false)
      assert.equal((await listRoutineRuns(f.root))[0].status, 'failed'); assert.equal(f.meta.status, patch.status ?? 'idle')
    }
  })
  await check('stale trigger cannot run a newly rebound task', async () => {
    const f = await fixture()
    await updateRoutine(f.root, f.routine.id, { executionTarget: { ...captureRoutineSessionTarget(f.meta), sessionId: 'task-b' } })
    await assert.rejects(f.service.trigger(f.routine, 200, 100), /绑定已变化/)
    assert.equal(f.sends(), 0); assert.equal((await listRoutineRuns(f.root)).length, 0)
  })
  await check('pause while authorization waits keeps original durable input queued', async () => {
    const f = await fixture()
    f.preflight(async () => { await updateRoutine(f.root, f.routine.id, { enabled: false }) })
    const record = await f.service.trigger(f.routine, 200, 100)
    assert.equal(record.status, 'queued'); assert.equal(f.sends(), 0)
    assert.equal((await f.inputService.list(f.meta.id))[0].phase, 'queued')
    f.preflight(async () => {}); await updateRoutine(f.root, f.routine.id, { enabled: true }); await f.service.sweep()
    assert.equal(f.sends(), 1)
  })
  await check('rebind while authorization waits prevents send and preserves the new plan', async () => {
    const f = await fixture()
    f.preflight(async () => { await updateRoutine(f.root, f.routine.id, { executionTarget: { ...captureRoutineSessionTarget(f.meta), sessionId: 'task-b' } }) })
    const record = await f.service.trigger(f.routine, 200, 100)
    assert.equal(record.status, 'failed'); assert.equal(f.sends(), 0)
    assert.equal((await f.current()).enabled, true)
  })
  await check('unrelated results and missing exact transcript cannot falsely complete a heartbeat', async () => {
    const f = await fixture(); const record = await f.service.trigger(f.routine, 200, 100)
    f.results.set('unrelated-message', { text: '其他任务已完成', isError: false }); f.runs[0].status = 'completed'; f.meta.status = 'idle'
    await f.service.sweep(); const uncertain = (await listRoutineRuns(f.root))[0]
    assert.equal(uncertain.heartbeat?.phase, 'needs_reconciliation'); assert.equal(uncertain.status, 'running'); assert.equal(f.evidence.length, 0)
    f.results.set(record.heartbeat!.messageId, { text: '本次结果', isError: false }); await f.restart().sweep()
    assert.equal((await listRoutineRuns(f.root))[0].status, 'succeeded'); assert.equal(f.sends(), 1)
  })
  await check('run errors affect only this occurrence and preserve original task', async () => {
    const f = await fixture(); await f.service.trigger(f.routine, 200, 100)
    f.runs[0].status = 'failed'; f.runs[0].error = 'provider unavailable'; f.meta.status = 'idle'
    await f.service.sweep(); assert.equal((await listRoutineRuns(f.root))[0].status, 'failed')
    assert.equal(f.meta.status, 'idle'); assert.equal(f.meta.goalId, 'goal-a'); assert.equal(f.meta.workItemId, 'work-a')
  })
  await check('regular routine history cannot evict a pending continuation', async () => {
    const f = await fixture('running'); const record = await f.service.trigger(f.routine, 200, 100)
    writeFileSync(join(f.root, 'routine-runs.json'), JSON.stringify({ version: 1, runs: [record, ...Array.from({ length: 501 }, (_, i) => ({
      id: `historical-${i}`, routineId: 'old-plan', routineName: '历史', projectCwd: f.root, startedAt: Date.now() + i,
      status: 'succeeded', inboxStatus: 'accepted', dispatchState: 'prompt_accepted', nextRunAt: null }))] }))
    const legacy = await createRoutine(f.root, { id: 'legacy', name: '独立定时', prompt: '报告', projectCwd: f.root, schedule: 'every 1h' })
    const result = await runRoutineWithHistory(f.root, legacy, async () => ({ sessionId: 'new-session' }), 500)
    assert.equal(result.status, 'succeeded'); assert.equal(result.heartbeat, undefined)
    assert.ok((await listRoutineRuns(f.root)).some((run) => run.id === record.id))
  })
  console.log(`PASS ${checks} continuation scenarios; real durable Routine and SessionInput stores; no provider calls.`)
}
main().finally(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true }))).catch((error) => { console.error(error); process.exitCode = 1 })
