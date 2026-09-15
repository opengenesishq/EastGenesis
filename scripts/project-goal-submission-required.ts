import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createProjectGoalSubmissionClient, type ProjectGoalSubmissionHost } from '../src/renderer/src/lib/project-goal-task-submission'
import type { ProjectGoalTaskResult, SessionMeta, TaskPlanStateView } from '../src/shared/types'

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
  let goalCalls = 0, sessionCalls = 0, planCalls = 0
  let failPlan = false, loseSessionResponse = false
  const goals = new Map<string, ProjectGoalTaskResult>()
  const sessions: SessionMeta[] = []
  const plans = new Map<string, TaskPlanStateView>()
  const host: ProjectGoalSubmissionHost = {
    async createGoal(input) {
      goalCalls++
      if (!goals.has(input.requestId)) goals.set(input.requestId, {
        requestId: input.requestId, recovered: false,
        goal: { id: `g-${input.requestId}`, projectId: input.projectId, revision: 1 },
        workItem: { id: `w-${input.requestId}`, projectId: input.projectId, goalId: `g-${input.requestId}` }
      } as ProjectGoalTaskResult)
      return goals.get(input.requestId)!
    },
    async listSessions() { return sessions },
    async createSession(result) {
      sessionCalls++
      const id = `s-${result.requestId}`
      sessions.push({ id, workspaceId: result.goal.projectId, goalId: result.goal.id, workItemId: result.workItem.id } as SessionMeta)
      if (loseSessionResponse) throw new Error('IPC response lost')
      return id
    },
    async getPlan(id) { return plans.get(id) },
    async generatePlan(id, result) {
      planCalls++
      if (failPlan) throw new Error('No model connection')
      const plan = { sessionId: id, currentVersion: {
        id: `plan-${id}`, binding: { sessionId: id, workspaceId: result.goal.projectId, goalId: result.goal.id, workItemId: result.workItem.id }
      } } as TaskPlanStateView
      plans.set(id, plan)
      return plan
    }
  }
  return { storage, host, goals, sessions, plans, values,
    client: () => createProjectGoalSubmissionClient(storage, host),
    failPlan: (value: boolean) => { failPlan = value },
    loseSessionResponse: (value: boolean) => { loseSessionResponse = value },
    counts: () => ({ goalCalls, sessionCalls, planCalls }) }
}
async function main(): Promise<void> {
const input = { projectId: 'project-a', objective: '把这些数据做成客户汇报，控制在六页。', template: 'auto' as const }
try {
  await check('duplicate clicks share one canonical submission', async () => {
    const f = fixture()
    const results = await Promise.all([f.client().submit(input), f.client().submit(input)])
    assert.deepEqual(results[0], results[1])
    assert.deepEqual(f.counts(), { goalCalls: 1, sessionCalls: 1, planCalls: 1 })
  })
  await check('model failure and renderer reload reuse Goal WorkItem and Session', async () => {
    const f = fixture(); f.failPlan(true)
    await assert.rejects(f.client().submit(input), /No model/)
    const ids = [...f.goals.keys()]
    f.failPlan(false)
    await f.client().submit(input)
    assert.deepEqual([...f.goals.keys()], ids)
    assert.equal(f.counts().sessionCalls, 1)
  })
  await check('lost session response recovers by canonical ownership', async () => {
    const f = fixture(); f.loseSessionResponse(true)
    await assert.rejects(f.client().submit(input), /response lost/)
    f.loseSessionResponse(false)
    const result = await f.client().submit(input)
    assert.equal(result.sessionId, f.sessions[0].id)
    assert.equal(f.counts().sessionCalls, 1)
  })
  await check('unverifiable session creation blocks a second create', async () => {
    const f = fixture(); f.loseSessionResponse(true)
    await assert.rejects(f.client().submit(input))
    f.sessions.splice(0)
    await assert.rejects(f.client().submit(input), /尚未核实/)
    assert.equal(f.counts().sessionCalls, 1)
  })
  await check('existing plan is not regenerated on reopen', async () => {
    const f = fixture()
    const first = await f.client().submit(input)
    assert.deepEqual(await f.client().submit(input), first)
    assert.equal(f.counts().planCalls, 1)
  })
  await check('different projects and edited pending requests retain separate identities', async () => {
    const f = fixture(); f.failPlan(true)
    await assert.rejects(f.client().submit(input))
    const originalId = [...f.goals.keys()][0]
    await assert.rejects(f.client().submit({ ...input, objective: '修改后的目标' }))
    await assert.rejects(f.client().submit({ ...input, projectId: 'project-b' }))
    f.failPlan(false)
    assert.equal((await f.client().submit(input)).requestId, originalId)
    assert.equal(f.goals.size, 3)
  })
  await check('storage unavailable prevents all task mutations', async () => {
    const f = fixture()
    f.storage.setItem = () => { throw new Error('storage full') }
    await assert.rejects(f.client().submit(input), /storage full/)
    assert.equal(f.counts().goalCalls, 0)
  })
  await check('corrupt journal is preserved and fails closed', async () => {
    const f = fixture(); f.values.set('caogen.project-goal-submissions.v1', '{bad')
    await assert.rejects(f.client().submit(input), /无法读取/)
    assert.equal(f.counts().goalCalls, 0)
    assert.equal([...f.values.values()][0], '{bad')
  })
  await check('foreign plan identity is rejected', async () => {
    const f = fixture()
    const result = await f.client().submit(input)
    f.plans.get(result.sessionId)!.currentVersion!.binding.workItemId = 'foreign'
    await assert.rejects(f.client().submit(input), /身份不一致/)
  })
  await check('foreign Goal receipt cannot create a Session', async () => {
    const f = fixture()
    const create = f.host.createGoal
    f.host.createGoal = async (draft) => {
      const result = await create(draft)
      result.goal.projectId = 'foreign-project'
      return result
    }
    await assert.rejects(f.client().submit(input), /回执与原提交身份不一致/)
    assert.equal(f.counts().sessionCalls, 0)
  })
  await check('acknowledged submission permits an explicit new identical task', async () => {
    const f = fixture()
    const first = await f.client().submit(input)
    f.client().acknowledge(first.requestId)
    assert.notEqual((await f.client().submit(input)).requestId, first.requestId)
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
