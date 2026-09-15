import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createProjectGoalSubmissionClient, type ProjectGoalSubmissionHost } from '../src/renderer/src/lib/project-goal-task-submission'
import type { ProjectGoalTaskPrepareInput, ProjectGoalTaskPrepared, ProjectGoalTaskStarted } from '../src/shared/types'

const checks: { name: string; status: string }[] = []
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed' }); throw error }
}
function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  let prepareCalls = 0
  let failPreparation = false, loseResponse = false
  const receipts = new Map<string, ProjectGoalTaskPrepared>()
  const requests: ProjectGoalTaskPrepareInput[] = []
  const host: ProjectGoalSubmissionHost = {
    async prepare(input) {
      prepareCalls++
      requests.push(input)
      if (failPreparation) throw new Error('Preparation failed')
      if (!receipts.has(input.requestId)) {
        const sessionId = globalThis.crypto.randomUUID()
        receipts.set(input.requestId, {
          requestId: input.requestId, sessionId, recovered: false,
          goal: { id: `g-${input.requestId}`, projectId: input.projectId },
          workItem: { id: `w-${input.requestId}`, projectId: input.projectId, goalId: `g-${input.requestId}` },
          plan: { sessionId, currentVersion: {
            binding: { sessionId, workspaceId: input.projectId, goalId: `g-${input.requestId}`, workItemId: `w-${input.requestId}` }
          } }
        } as ProjectGoalTaskPrepared)
      }
      if (loseResponse) throw new Error('IPC response lost')
      return receipts.get(input.requestId)!
    }
  }
  return { storage, host, receipts, requests, values,
    client: () => createProjectGoalSubmissionClient(storage, host),
    fail: (value: boolean) => { failPreparation = value },
    lose: (value: boolean) => { loseResponse = value },
    calls: () => prepareCalls }
}
async function main(): Promise<void> {
const input = { projectId: 'project-a', objective: '把这些数据做成客户汇报，控制在六页。', template: 'auto' as const }
try {
  await check('duplicate clicks share one main-process submission', async () => {
    const f = fixture()
    const results = await Promise.all([f.client().submit(input), f.client().submit(input)])
    assert.deepEqual(results[0], results[1])
    assert.equal(f.calls(), 1)
  })
  await check('preparation failure and renderer reload retain request identity', async () => {
    const f = fixture(); f.fail(true)
    await assert.rejects(f.client().submit(input), /Preparation failed/)
    f.fail(false)
    const result = await f.client().submit(input)
    assert.equal(result.requestId, f.requests[0].requestId)
  })
  await check('lost IPC response retries the same durable preparation', async () => {
    const f = fixture(); f.lose(true)
    await assert.rejects(f.client().submit(input), /response lost/)
    f.lose(false)
    const result = await f.client().submit(input)
    assert.equal(f.receipts.size, 1)
    assert.equal(result.sessionId, f.receipts.get(result.requestId)!.sessionId)
  })
  await check('legacy claimed session is forwarded for authoritative recovery', async () => {
    const f = fixture()
    f.values.set('caogen.project-goal-submissions.v1', JSON.stringify([{ ...input, requestId: 'legacy', sessionCreationClaimed: true }]))
    await f.client().submit(input)
    assert.equal(f.requests[0].legacyCreationClaimed, true)
    assert.equal(f.requests[0].requestId, 'legacy')
  })
  await check('edited objectives and other projects retain separate pending identities', async () => {
    const f = fixture(); f.fail(true)
    for (const draft of [input, { ...input, objective: '修改后的目标' }, { ...input, projectId: 'project-b' }]) {
      await assert.rejects(f.client().submit(draft))
    }
    assert.equal(new Set(f.requests.map((request) => request.requestId)).size, 3)
    f.fail(false)
    assert.equal((await f.client().submit(input)).requestId, f.requests[0].requestId)
  })
  await check('storage failure prevents mutation and corrupt journal is preserved', async () => {
    const f = fixture()
    f.storage.setItem = () => { throw new Error('storage full') }
    await assert.rejects(f.client().submit(input), /storage full/)
    assert.equal(f.calls(), 0)
    f.values.set('caogen.project-goal-submissions.v1', '{bad')
    await assert.rejects(f.client().submit(input), /无法读取/)
    assert.equal(f.calls(), 0)
    assert.equal([...f.values.values()][0], '{bad')
  })
  await check('foreign Goal or plan receipts are rejected without acknowledging', async () => {
    const f = fixture()
    const result = await f.client().submit(input)
    const receipt = f.receipts.get(result.requestId)!
    receipt.goal.projectId = 'foreign'
    await assert.rejects(f.client().submit(input), /回执与原提交身份不一致/)
    receipt.goal.projectId = input.projectId
    receipt.plan.currentVersion!.binding.workItemId = 'foreign'
    await assert.rejects(f.client().submit(input), /身份不一致/)
    assert.equal(f.values.size, 1)
  })
  await check('confirmed session cannot silently change on retry', async () => {
    const f = fixture()
    const result = await f.client().submit(input)
    f.receipts.get(result.requestId)!.sessionId = globalThis.crypto.randomUUID()
    await assert.rejects(f.client().submit(input), /会话回执无效/)
  })
  await check('acknowledging permits an explicit new identical task', async () => {
    const f = fixture()
    const first = await f.client().submit(input)
    f.client().acknowledge(first.requestId)
    assert.notEqual((await f.client().submit(input)).requestId, first.requestId)
  })
  await check('new simple tasks accept direct receipts without a plan and retain identity after response loss', async () => {
    const f = fixture()
    let lost = true
    const receipts = new Map<string, Extract<ProjectGoalTaskStarted, { kind: 'direct' }>>()
    f.host.start = async (request) => {
      if (!receipts.has(request.requestId)) {
        const prepared = await f.host.prepare(request)
        receipts.set(request.requestId, {
          ...prepared, kind: 'direct',
          decision: { schemaVersion: 1, kind: 'direct', mode: 'auto', taskStrategy: 'view', reason: 'Simple request' },
          input: { schemaVersion: 1, id: 'goal-start-fixture', sessionId: prepared.sessionId,
            workspaceId: request.projectId, goalId: prepared.goal.id, workItemId: prepared.workItem.id,
            messageId: `session-input:${prepared.sessionId}:goal-start-fixture`, payload: { text: request.objective },
            phase: 'applied', createdAt: 1, updatedAt: 1 }
        })
        delete (receipts.get(request.requestId) as unknown as Record<string, unknown>).plan
      }
      if (lost) throw new Error('direct response lost')
      return receipts.get(request.requestId)!
    }
    await assert.rejects(f.client().submit(input), /direct response lost/)
    lost = false
    const result = await f.client().submit(input)
    assert.equal(result.kind, 'direct')
    assert.equal(result.inputPhase, 'applied')
    assert.equal(receipts.size, 1)
    assert.equal(f.calls(), 1)
    const receipt = receipts.get(result.requestId)!
    receipt.input.phase = 'needs_reconciliation'
    receipt.input.error = '原提交结果待核对'
    assert.equal((await f.client().submit(input)).message, receipt.input.error)
    receipt.input.workItemId = 'foreign'
    await assert.rejects(f.client().submit(input), /执行回执与原任务身份不一致/)
  })
  await check('legacy pending preparation never calls automatic start', async () => {
    const f = fixture()
    f.host.start = async () => { throw new Error('old task must not execute') }
    f.values.set('caogen.project-goal-submissions.v1', JSON.stringify([{ ...input, requestId: 'legacy-plan' }]))
    assert.equal((await f.client().submit(input)).kind, 'plan')
    assert.equal(f.calls(), 1)
  })
  await check('changing pending start mode cannot turn a plan request into execution', async () => {
    const f = fixture(); f.fail(true)
    await assert.rejects(f.client().submit({ ...input, mode: 'plan' }), /Preparation failed/)
    await assert.rejects(f.client().submit({ ...input, mode: 'auto' }), /已固定开始方式/)
    assert.equal(f.calls(), 1)
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  const report = { kind: 'caogen.project-goal-submission', generatedAt: new Date().toISOString(),
    status: process.exitCode ? 'failed' : 'passed', checks,
    evidence: 'behavioral client tests with controlled host and durable storage, no Provider calls or human evidence' }
  mkdirSync('test-results/project-goal-submission', { recursive: true })
  writeFileSync('test-results/project-goal-submission/latest.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}

}
void main()
