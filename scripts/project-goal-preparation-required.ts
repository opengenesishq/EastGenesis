import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CreateSessionOptions, SessionMeta, TaskPlanStateView } from '../src/shared/types'
import type { ProjectGoalTaskPrepareInput } from '../src/shared/project-workspace-types'
import type { ManagedSessionCreationOptions } from '../src/main/session-manager-support'
import { ProjectGoalSubmissionService, type GoalSessionIdentity, type ProjectGoalSubmissionRuntime } from '../src/main/project-workspace/goal-submission-service'
import { ProjectGoalSubmissionStore } from '../src/main/project-workspace/goal-submission-store'
import { createProjectGoalTask, goalTaskIds } from '../src/main/project-workspace/goal-task-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'

const root = mkdtempSync(path.join(tmpdir(), 'caogen-goal-preparation-'))
const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = []
const reportPath = path.resolve('test-results/project-goal-preparation/latest.json')
let networkCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { networkCalls += 1; throw new Error('network forbidden in local goal preparation') }

/** Controlled Session boundary; task and versioned plan persistence use production stores. */
class ControlledRuntime implements ProjectGoalSubmissionRuntime {
  readonly active = new Map<string, SessionMeta>()
  saved: { kind: 'history' | 'snapshot' | 'pending'; meta: GoalSessionIdentity }[] = []
  readonly plans: TaskPlanContractStore
  readonly createIds: string[] = []
  planCalls = 0
  compileCalls = 0
  failBeforeCreate = false
  crashAfterJournal = false
  loseSessionResponse = false
  failPlan = false
  losePlanResponse = false

  constructor(readonly rootDir: string) {
    this.plans = new TaskPlanContractStore(() => rootDir)
    const file = this.file()
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      for (const meta of data.active) this.active.set(meta.id, meta)
      this.saved = data.saved
    }
  }
  private file(): string { return path.join(this.rootDir, 'controlled-session-runtime.json') }
  persist(): void { writeFileSync(this.file(), JSON.stringify({ active: [...this.active.values()], saved: this.saved })) }
  async whenInitialized(): Promise<void> {}
  get(id: string) { const meta = this.active.get(id); return meta ? { meta } : undefined }
  async identities(): Promise<GoalSessionIdentity[]> { return [...this.active.values(), ...this.saved.map((entry) => entry.meta)] }
  async createManaged(options: CreateSessionOptions, lifecycle: ManagedSessionCreationOptions): Promise<SessionMeta> {
    assert.match(lifecycle.reservedSessionId!, /^[a-f0-9-]{36}$/)
    assert.equal(lifecycle.awaitStart, true)
    assert.equal(options.taskStrategy, 'plan')
    const id = lifecycle.reservedSessionId!
    this.createIds.push(id)
    if (this.failBeforeCreate) throw new Error('controlled validation failure')
    assert(!this.active.has(id), 'duplicate Session placement')
    const meta = {
      ...options, id, title: options.title ?? '准备任务', status: 'idle', permissionMode: 'default',
      costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextTokens: 0, createdAt: Date.now()
    } as SessionMeta
    if (this.crashAfterJournal) {
      this.saved.push({ kind: 'pending', meta }); this.persist()
      throw new Error('controlled crash after durable Session journal')
    }
    this.active.set(id, meta); this.persist()
    if (this.loseSessionResponse) throw new Error('controlled Session response lost')
    return meta
  }
  getTaskPlan(id: string): TaskPlanStateView { return this.plans.get(id) }
  async generateTaskPlan(id: string, input: { objective: string }): Promise<TaskPlanStateView> {
    this.planCalls += 1
    return this.createPlan(id, input.objective)
  }
  async compileMissionTaskPlan(id: string, input: { expectedGoalRevision: number }): Promise<TaskPlanStateView> {
    this.compileCalls += 1
    const meta = this.active.get(id)!
    const goal = await createProjectWorkspaceReadService(this.rootDir, 'canonical').getGoal(meta.goalId!)
    assert.equal(input.expectedGoalRevision, goal!.revision)
    return this.createPlan(id, goal!.objective)
  }
  private createPlan(id: string, objective: string): TaskPlanStateView {
    if (this.failPlan) throw new Error('controlled planning unavailable')
    const meta = this.active.get(id)!
    const plan = this.plans.createVersion({
      sessionId: id, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId
    }, {
      objective, steps: [{ id: 'draft', title: '完成汇报', expectedArtifacts: ['客户汇报'] }],
      expectedArtifacts: ['客户汇报'], acceptanceCriteria: ['控制在六页'], source: 'genesis'
    }, 'agent')
    if (this.losePlanResponse) throw new Error('controlled plan response lost')
    return plan
  }
}

async function fixture() {
  const rootDir = mkdtempSync(path.join(root, 'case-'))
  const input: ProjectGoalTaskPrepareInput = {
    projectId: 'preparation-project', requestId: 'request-1',
    objective: '把这些数据做成客户汇报，控制在六页。', template: 'auto'
  }
  const workspace = await openProjectWorkspaceStore(rootDir)
  await workspace.createWorkspace({ id: input.projectId, name: 'Preparation local fixture', kind: 'software' })
  const commands = await openProjectWorkspaceCommandService(rootDir)
  const reads = createProjectWorkspaceReadService(rootDir, 'canonical')
  const journal = new ProjectGoalSubmissionStore(rootDir)
  const runtime = new ControlledRuntime(rootDir)
  return { rootDir, input, workspace, commands, reads, journal, runtime,
    service: (port = runtime) => new ProjectGoalSubmissionService(rootDir, port) }
}
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }); console.error(`${name}: ${error}`) }
}

async function main(): Promise<void> {
  try {
    await check('concurrent service instances create one canonical task, one Session and one pending plan', async () => {
      const f = await fixture()
      const [one, two] = await Promise.all([f.service().prepare(f.input), f.service().prepare(f.input)])
      assert.equal(one.sessionId, two.sessionId)
      assert.equal(one.goal.id, two.goal.id)
      assert.equal((await f.reads.listGoals(f.input.projectId)).length, 1)
      assert.equal((await f.reads.listWorkItems(f.input.projectId)).length, 1)
      assert.equal(f.runtime.createIds.length, 1)
      assert.equal(f.runtime.planCalls, 1)
      assert.equal(two.plan.versions.length, 1)
      assert.equal(two.plan.approvalStatus, 'pending')
      assert.equal(f.journal.read(f.input)?.phase, 'ready')
    })
    await check('crash after reservation resumes with the same reserved Session ID', async () => {
      const f = await fixture()
      const reserved = f.journal.reserve(f.input)
      const recovered = await f.service(new ControlledRuntime(f.rootDir)).prepare(f.input)
      assert.equal(recovered.sessionId, reserved.sessionId)
      assert.equal((await f.reads.listGoals(f.input.projectId)).length, 1)
    })
    await check('validation-only create failure retries the same ID without a second canonical task', async () => {
      const f = await fixture(); f.runtime.failBeforeCreate = true
      await assert.rejects(f.service().prepare(f.input), /validation failure/)
      const before = f.journal.read(f.input)!
      f.runtime.failBeforeCreate = false
      const retried = await f.service().prepare(f.input)
      assert.equal(retried.sessionId, before.sessionId)
      assert.deepEqual(f.runtime.createIds, [before.sessionId, before.sessionId])
      assert.equal(f.runtime.active.size, 1)
      assert.equal((await f.reads.listWorkItems(f.input.projectId)).length, 1)
    })
    await check('lost Session response survives runtime reload without duplicate placement', async () => {
      const f = await fixture(); f.runtime.loseSessionResponse = true
      await assert.rejects(f.service().prepare(f.input), /Session response lost/)
      const savedId = f.journal.read(f.input)!.sessionId
      const restored = new ControlledRuntime(f.rootDir)
      const recovered = await f.service(restored).prepare(f.input)
      assert.equal(recovered.sessionId, savedId)
      assert.equal(restored.createIds.length, 0)
      assert.equal(restored.active.size, 1)
      assert.equal((await f.reads.listGoals(f.input.projectId)).length, 1)
    })
    await check('pending Session journal prevents duplicate creation until original Session is recovered', async () => {
      const f = await fixture(); f.runtime.crashAfterJournal = true
      await assert.rejects(f.service().prepare(f.input), /durable Session journal/)
      const restored = new ControlledRuntime(f.rootDir)
      await assert.rejects(f.service(restored).prepare(f.input), /恢复/)
      assert.equal(restored.createIds.length, 0)
      const meta = restored.saved[0].meta as SessionMeta
      restored.active.set(meta.id, meta); restored.saved = []; restored.persist()
      assert.equal((await f.service(restored).prepare(f.input)).sessionId, meta.id)
      assert.equal(restored.createIds.length, 0)
    })
    await check('historical and snapshot identities preserve the original task and require explicit recovery', async () => {
      for (const kind of ['history', 'snapshot'] as const) {
        const f = await fixture()
        const prepared = await f.service().prepare(f.input)
        const meta = f.runtime.active.get(prepared.sessionId)!
        f.runtime.active.clear(); f.runtime.saved = [{ kind, meta }]; f.runtime.persist()
        const restored = new ControlledRuntime(f.rootDir)
        await assert.rejects(f.service(restored).prepare(f.input), /恢复/)
        assert.equal(restored.createIds.length, 0)
        assert.deepEqual(await f.reads.getGoal(prepared.goal.id), prepared.goal)
        assert.equal(restored.plans.get(meta.id).currentVersion?.digest, prepared.plan.currentVersion?.digest)
      }
    })
    await check('failed planning and lost planning responses retain the Session and existing plan version', async () => {
      for (const failure of ['failPlan', 'losePlanResponse'] as const) {
        const f = await fixture(); f.runtime[failure] = true
        await assert.rejects(f.service().prepare(f.input), /planning unavailable|plan response lost/)
        const restored = new ControlledRuntime(f.rootDir)
        const result = await f.service(restored).prepare(f.input)
        assert.equal(result.sessionId, f.runtime.createIds[0])
        assert.equal(restored.createIds.length, 0)
        assert.equal(result.plan.versions.length, 1)
        assert.equal(restored.planCalls, failure === 'failPlan' ? 1 : 0)
      }
    })
    await check('legacy renderer Session is adopted by verified canonical ownership without recreation', async () => {
      const f = await fixture()
      const created = await createProjectGoalTask(f.input, f.rootDir)
      const id = randomUUID()
      f.runtime.active.set(id, {
        id, workspaceId: f.input.projectId, goalId: created.goal.id, workItemId: created.workItem.id,
        businessLineId: created.workItem.businessLineId, status: 'idle', taskStrategy: 'plan'
      } as SessionMeta)
      const result = await f.service().prepare({ ...f.input, legacySessionId: id, legacyCreationClaimed: true })
      assert.equal(result.sessionId, id)
      assert.equal(f.runtime.createIds.length, 0)
      assert.equal(f.journal.read(f.input)?.sessionId, id)
    })
    await check('unverified legacy creation or foreign legacy ID cannot create a task', async () => {
      for (const hint of [{ legacyCreationClaimed: true }, { legacySessionId: randomUUID() }]) {
        const f = await fixture()
        await assert.rejects(f.service().prepare({ ...f.input, ...hint }), /尚未核实/)
        assert.equal(f.runtime.createIds.length, 0)
        assert.equal((await f.reads.listGoals(f.input.projectId)).length, 0)
        assert.equal(f.journal.read(f.input), undefined)
      }
    })
    await check('same request rejects changed objective, template, business line or claimed Session', async () => {
      const f = await fixture()
      const prepared = await f.service().prepare(f.input)
      for (const patch of [
        { objective: '改成另一项工作' }, { template: 'product-launch' as const },
        { businessLineId: 'assistant' }, { legacySessionId: randomUUID() }
      ]) await assert.rejects(f.service().prepare({ ...f.input, ...patch }), /同一提交标识/)
      assert.equal(f.runtime.createIds.length, 1)
      assert.deepEqual(await f.reads.getGoal(prepared.goal.id), prepared.goal)
      assert.equal(f.runtime.plans.get(prepared.sessionId).versions.length, 1)
    })
    await check('duplicate canonical Sessions and foreign ownership fail before planning', async () => {
      for (const failure of ['duplicate', 'foreign-project', 'personal', 'child', 'business-line'] as const) {
        const f = await fixture()
        const prepared = await f.service().prepare(f.input)
        const meta = f.runtime.active.get(prepared.sessionId)!
        if (failure === 'duplicate') f.runtime.active.set(randomUUID(), { ...meta, id: randomUUID() })
        else if (failure === 'foreign-project') meta.workspaceId = 'another-project'
        else if (failure === 'personal') meta.personalWorkspaceId = 'personal-container'
        else if (failure === 'child') meta.parentSessionId = randomUUID()
        else meta.businessLineId = 'assistant'
        await assert.rejects(f.service().prepare(f.input), /多个会话|归属不一致/)
        assert.equal(f.runtime.createIds.length, 1)
        assert.equal(f.runtime.planCalls, 1)
      }
    })
    await check('terminal Goal or WorkItem cannot be resubmitted under the old request', async () => {
      for (const entity of ['goal', 'workItem'] as const) {
        const f = await fixture()
        const prepared = await f.service().prepare(f.input)
        if (entity === 'goal') await f.commands.transitionGoal(prepared.goal.id, 'cancelled', { expectedRevision: prepared.goal.revision })
        else await f.commands.transitionWorkItem(prepared.workItem.id, 'cancelled', { expectedRevision: prepared.workItem.revision })
        await assert.rejects(f.service().prepare(f.input), /terminal/)
        assert.equal(f.runtime.createIds.length, 1)
        assert.equal(f.runtime.planCalls, 1)
      }
    })
    await check('deleted workspace and deleted ready plan never get silently recreated', async () => {
      const f = await fixture()
      const prepared = await f.service().prepare(f.input)
      f.runtime.plans.deleteSession(prepared.sessionId)
      await assert.rejects(f.service().prepare(f.input), /原任务计划记录缺失/)
      assert.equal(f.runtime.planCalls, 1)
      await f.workspace.deleteWorkspace(f.input.projectId)
      await assert.rejects(f.service().prepare(f.input), /not active|已停用|记录缺失/)
      assert.equal(f.runtime.createIds.length, 1)
    })
    await check('wrong plan binding is rejected and explicit product template calls canonical compiler', async () => {
      const f = await fixture()
      const prepared = await f.service().prepare({ ...f.input, template: 'product-launch' })
      assert.equal(f.runtime.compileCalls, 1)
      assert.equal(f.runtime.planCalls, 0)
      const plan = f.runtime.plans.get(prepared.sessionId)
      const port = new ControlledRuntime(f.rootDir)
      port.getTaskPlan = () => ({ ...plan, currentVersion: { ...plan.currentVersion!, binding: { ...plan.currentVersion!.binding, workItemId: 'foreign-item' } } })
      await assert.rejects(f.service(port).prepare({ ...f.input, template: 'product-launch' }), /身份不一致/)
      assert.equal(port.createIds.length, 0)
    })
    await check('corrupt durable journal fails closed and preserves its original bytes', async () => {
      const f = await fixture()
      await f.service().prepare(f.input)
      const file = path.join(f.rootDir, 'private', 'project-goal-submissions', `${goalTaskIds(f.input.projectId, f.input.requestId).goalId}.json`)
      const data = JSON.parse(readFileSync(file, 'utf8')); data.input.objective = '篡改目标'
      const corrupted = JSON.stringify(data); writeFileSync(file, corrupted)
      await assert.rejects(f.service().prepare(f.input), /损坏/)
      assert.equal(readFileSync(file, 'utf8'), corrupted)
      assert.equal(f.runtime.createIds.length, 1)
    })
  } catch (error) {
    checks.push({ name: 'harness setup', status: 'failed', detail: String(error) })
  } finally {
    globalThis.fetch = originalFetch
    const passed = checks.filter((entry) => entry.status === 'passed').length
    const status = passed === checks.length && networkCalls === 0 ? 'passed' : 'failed'
    if (status === 'failed') process.exitCode = 1
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify({
      schemaVersion: 1, kind: 'caogen.project-goal-preparation', generatedAt: new Date().toISOString(), status,
      summary: { passed, total: checks.length }, checks, providerCalls: networkCalls, humanEvidence: false,
      limitations: ['production canonical and TaskPlan stores with a controlled Session runtime', 'Session creation, history and recovery boundaries are fault-injected; not Electron integration evidence', 'no Provider execution or human acceptance']
    }, null, 2) + '\n')
    rmSync(root, { recursive: true, force: true })
    console.log(`Project goal preparation: ${passed}/${checks.length}; ${reportPath}`)
  }
}
void main()
