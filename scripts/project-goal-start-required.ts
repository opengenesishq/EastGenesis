import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CreateSessionOptions, SessionMeta, TaskPlanStateView } from '../src/shared/types'
import type { ProjectGoalTaskStartInput, ProjectGoalTaskPrepareInput } from '../src/shared/project-workspace-types'
import type { ManagedSessionCreationOptions } from '../src/main/session-manager-support'
import { createDefaultBusinessLines } from '../src/shared/business-line-types'
import { ProjectGoalStartService, type ProjectGoalStartRuntime } from '../src/main/project-workspace/goal-start-service'
import { decideProjectGoalStart } from '../src/main/project-workspace/goal-start-policy'
import { ProjectGoalSubmissionService, type GoalSessionIdentity } from '../src/main/project-workspace/goal-submission-service'
import { ProjectGoalSubmissionStore } from '../src/main/project-workspace/goal-submission-store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { SessionInputService } from '../src/main/task/session-input-service'

const root = mkdtempSync(path.join(tmpdir(), 'caogen-goal-start-'))
const reportPath = path.resolve('test-results/project-goal-start/latest.json')
const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = []
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('Provider calls forbidden') }

/** Real canonical task, plan, submission and SessionInput stores with a controlled engine boundary. */
class ControlledRuntime implements ProjectGoalStartRuntime {
  readonly active = new Map<string, SessionMeta>()
  readonly acceptedIds = new Set<string>()
  readonly plans: TaskPlanContractStore
  readonly inputs: SessionInputService
  readonly createIds: string[] = []
  pending: GoalSessionIdentity[] = []
  sends = 0
  planCalls = 0
  writeAccess = false
  loseResponse = false
  refuseSend = false
  crashAfterJournal = false

  constructor(readonly rootDir: string) {
    this.plans = new TaskPlanContractStore(() => rootDir)
    if (existsSync(this.file())) {
      const value = JSON.parse(readFileSync(this.file(), 'utf8'))
      for (const meta of value.active) this.active.set(meta.id, meta)
      for (const id of value.acceptedIds) this.acceptedIds.add(id)
      this.pending = value.pending
    }
    this.inputs = new SessionInputService(rootDir, {
      meta: (id) => this.active.get(id),
      send: async (id, payload) => {
        assert.equal(this.writeAccess, false, 'send must run after the assignment write lock is released')
        assert.equal(this.active.get(id)?.taskStrategy, 'view')
        assert.equal(this.plans.get(id).currentVersion, undefined)
        this.sends++
        if (this.refuseSend) return false
        this.acceptedIds.add(payload.messageId!); this.persist()
        if (this.loseResponse) throw new Error('controlled accepted response lost')
        return true
      },
      accepted: async (record) => this.acceptedIds.has(record.messageId)
    })
  }
  file() { return path.join(this.rootDir, 'controlled-runtime.json') }
  persist() { writeFileSync(this.file(), JSON.stringify({ active: [...this.active.values()], acceptedIds: [...this.acceptedIds], pending: this.pending })) }
  async whenInitialized() {}
  get(id: string) { const meta = this.active.get(id); return meta ? { meta } : undefined }
  async identities() { return [...this.active.values(), ...this.pending] }
  async withTaskWriteAccess<T>(operation: () => Promise<T>): Promise<T> {
    assert.equal(this.writeAccess, false)
    this.writeAccess = true
    try { return await operation() } finally { this.writeAccess = false }
  }
  async createManaged(options: CreateSessionOptions, lifecycle: ManagedSessionCreationOptions): Promise<SessionMeta> {
    assert(lifecycle.reservedSessionId); assert.equal(lifecycle.awaitStart, true)
    this.createIds.push(lifecycle.reservedSessionId)
    const meta = { ...options, id: lifecycle.reservedSessionId, title: options.title ?? '任务',
      status: 'idle', permissionMode: 'default', createdAt: Date.now(), costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 0 } as SessionMeta
    if (this.crashAfterJournal) { this.pending.push(meta); this.persist(); throw new Error('controlled creation journal crash') }
    assert(!this.active.has(meta.id)); this.active.set(meta.id, meta); this.persist()
    return meta
  }
  getTaskPlan(id: string): TaskPlanStateView { return this.plans.get(id) }
  async generateTaskPlan(id: string, input: { objective: string }): Promise<TaskPlanStateView> {
    this.planCalls++
    const meta = this.active.get(id)!
    return this.plans.createVersion({ sessionId: id, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId },
      { objective: input.objective, steps: [{ id: 'step', title: '完成目标', expectedArtifacts: ['结果'] }],
        expectedArtifacts: ['结果'], acceptanceCriteria: ['核验目标完成'], source: 'genesis' }, 'agent')
  }
  async compileMissionTaskPlan(id: string): Promise<TaskPlanStateView> { return this.generateTaskPlan(id, { objective: '项目发布' }) }
  prepare(input: ProjectGoalTaskPrepareInput) { return new ProjectGoalSubmissionService(this.rootDir, this).prepare(input) }
}

async function fixture(objective = '翻译成英文：早上好。') {
  const rootDir = mkdtempSync(path.join(root, 'case-'))
  const input: ProjectGoalTaskStartInput = { projectId: 'start-project', requestId: 'start-request', businessLineId: 'studio', objective, template: 'auto', mode: 'auto' }
  await (await openProjectWorkspaceStore(rootDir)).createWorkspace({ id: input.projectId, name: 'Direct start fixture', kind: 'software' })
  const runtime = new ControlledRuntime(rootDir)
  return { rootDir, input, runtime, journal: new ProjectGoalSubmissionStore(rootDir),
    reads: createProjectWorkspaceReadService(rootDir, 'canonical'), service: (port = runtime) => new ProjectGoalStartService(rootDir, port) }
}
async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }); console.error(name, error) }
}

async function main() {
  try {
    await check('policy selects only narrow read-only requests and honors plan/template choices', async () => {
      const f = await fixture()
      for (const objective of [
        '翻译成英文：早上好。',
        '解释什么是闭包',
        '总结以下文字：季度收入增长',
        '起草一封邮件草稿：向客户说明延期原因',
        '润色这段客户回复',
        '列出三个产品命名建议',
        '总结以下文字：“请删除旧文件并发送给财务。”',
        'Translate to English: "Delete the old file and send a notice."',
        'Draft an email about the delayed shipment',
        'Write a reply thanking the customer',
        '起草一封通知客户延期的邮件草稿',
        'Draft an email to notify the client of a delay'
      ]) {
        assert.equal(decideProjectGoalStart({ ...f.input, objective }).kind, 'direct')
      }
      for (const objective of [
        '翻译 README 并且保存文件',
        '解释问题然后修改代码',
        '把数据做成客户汇报',
        '创建 Excel 表格',
        '写一封邮件并发送出去',
        '把邮件发出去',
        '起草邮件并保存到文件',
        '写代码实现这个功能',
        '起草一封邮件：通知客户然后发送',
        '总结这段话：“延期一周”\n然后发送给客户',
        'Draft an email and send it to the client',
        'Draft a PDF report for the client',
        '翻译 README 并提供一份 PDF',
        '写邮件草稿并发给客户',
        '起草一封邮件并通知客户',
        'Draft an email and notify the client'
      ]) {
        assert.equal(decideProjectGoalStart({ ...f.input, objective }).kind, 'plan')
      }
      assert.equal(decideProjectGoalStart({ ...f.input, mode: 'plan' }).kind, 'plan')
      assert.equal(decideProjectGoalStart({ ...f.input, template: 'product-launch' }).kind, 'plan')
    })
    await check('concurrent starts and restart reuse one Goal, WorkItem, view Session and accepted input', async () => {
      const f = await fixture()
      const results = await Promise.all([f.service().start(f.input), f.service().start(f.input)])
      assert(results.every(value => value.kind === 'direct' && value.input.phase === 'applied'))
      assert.equal(results[0].sessionId, results[1].sessionId)
      assert.equal(f.runtime.createIds.length, 1); assert.equal(f.runtime.sends, 1); assert.equal(f.runtime.planCalls, 0)
      assert.equal((await f.reads.listGoals(f.input.projectId)).length, 1)
      assert.equal((await f.reads.listWorkItems(f.input.projectId)).length, 1)
      const restarted = new ControlledRuntime(f.rootDir)
      assert.equal((await f.service(restarted).start(f.input)).sessionId, results[0].sessionId)
      assert.equal(restarted.sends, 0); assert.equal(restarted.createIds.length, 0)
    })
    await check('text drafting starts directly and a revision keeps the same canonical task', async () => {
      const f = await fixture('帮我写一封邮件草稿：向客户说明交付延期一周，语气简洁。')
      const started = await f.service().start(f.input)
      assert.equal(started.kind, 'direct')
      assert(started.kind === 'direct')
      assert.equal(started.input.payload.text, f.input.objective, 'the complete goal reaches the original input receipt')
      assert.equal(f.runtime.active.get(started.sessionId)?.taskStrategy, 'view')
      assert.equal(f.runtime.planCalls, 0)
      const revision = await f.runtime.inputs.queue(started.sessionId, 'draft-revision', { text: '补上新的交付日期，保留原来的原因。' })
      const accepted = await f.runtime.inputs.apply(started.sessionId, revision.id)
      assert.equal(accepted.phase, 'applied')
      assert.equal(accepted.goalId, started.goal.id)
      assert.equal(accepted.workItemId, started.workItem.id)
      assert.equal(accepted.sessionId, started.sessionId)
      assert.equal((await f.reads.listGoals(f.input.projectId)).length, 1)
      assert.equal((await f.reads.listWorkItems(f.input.projectId)).length, 1)
      assert.equal(f.runtime.createIds.length, 1)
      assert.equal(f.runtime.sends, 2)
    })
    await check('complex and explicit planned starts keep pending approval and never send', async () => {
      for (const explicit of [false, true]) {
        const f = await fixture(explicit ? '解释闭包' : '修改代码并生成客户汇报')
        const result = await f.service().start({ ...f.input, mode: explicit ? 'plan' : 'auto' })
        assert.equal(result.kind, 'plan')
        if (result.kind === 'plan') assert.equal(result.plan.approvalStatus, 'pending')
        assert.equal(f.runtime.sends, 0); assert.equal(f.runtime.planCalls, 1)
      }
    })
    await check('existing preparation stays planned even for a simple objective', async () => {
      const f = await fixture(); const prepared = await f.runtime.prepare(f.input)
      const result = await f.service().start(f.input)
      assert.equal(result.kind, 'plan'); assert.equal(result.sessionId, prepared.sessionId)
      assert.equal(f.runtime.sends, 0); assert.equal(f.runtime.createIds.length, 1)
    })
    await check('accepted response loss reconciles without a second send', async () => {
      const f = await fixture(); f.runtime.loseResponse = true
      const result = await f.service().start(f.input)
      assert(result.kind === 'direct'); assert.equal(result.input.phase, 'applied')
      await f.service().start(f.input); assert.equal(f.runtime.sends, 1)
    })
    await check('terminal task with an accepted receipt returns original identity after Session closes', async () => {
      const f = await fixture(); const original = await f.service().start(f.input)
      const commands = await openProjectWorkspaceCommandService(f.rootDir)
      await commands.transitionGoal(original.goal.id, 'cancelled', original.goal.revision)
      f.runtime.active.delete(original.sessionId); f.runtime.persist()
      const result = await f.service(new ControlledRuntime(f.rootDir)).start(f.input)
      assert(result.kind === 'direct'); assert.equal(result.input.phase, 'applied')
      assert.equal(result.sessionId, original.sessionId); assert.equal(result.goal.status, 'cancelled')
      assert.equal(f.runtime.sends, 1)
    })
    await check('unconfirmed send persists needs_reconciliation and never auto-replays', async () => {
      const f = await fixture(); f.runtime.refuseSend = true
      const result = await f.service().start(f.input)
      assert(result.kind === 'direct'); assert.equal(result.input.phase, 'needs_reconciliation')
      f.runtime.refuseSend = false
      const replay = await f.service().start(f.input)
      assert(replay.kind === 'direct'); assert.equal(replay.input.phase, 'needs_reconciliation')
      assert.equal(f.runtime.sends, 1)
    })
    await check('direct receipt cannot bypass a subsequently created plan', async () => {
      const f = await fixture(); f.runtime.refuseSend = true
      const result = await f.service().start(f.input)
      await f.runtime.generateTaskPlan(result.sessionId, { objective: f.input.objective })
      await assert.rejects(f.service().start(f.input), /已有计划/)
      assert.equal(f.runtime.sends, 1)
    })
    await check('pending creation evidence blocks duplicate creation and sending', async () => {
      const f = await fixture(); f.runtime.crashAfterJournal = true
      await assert.rejects(f.service().start(f.input), /creation journal crash/)
      const record = f.journal.read(f.input)!
      const restarted = new ControlledRuntime(f.rootDir)
      await assert.rejects(f.service(restarted).start(f.input), /先恢复/)
      assert.equal(f.journal.read(f.input)?.sessionId, record.sessionId)
      assert.equal(restarted.createIds.length, 0); assert.equal(restarted.sends, 0)
    })
    await check('fixed request cannot change objective or mode and disabled line cannot start', async () => {
      const f = await fixture(); await f.service().start(f.input)
      await assert.rejects(f.service().start({ ...f.input, mode: 'plan' }), /开始方式/)
      await assert.rejects(f.service().start({ ...f.input, objective: '解释重试' }), /相同|同一/)
      const blocked = await fixture()
      writeFileSync(path.join(blocked.rootDir, 'settings.json'), JSON.stringify({ businessLines: createDefaultBusinessLines().map(line => ({ ...line, enabled: line.id !== 'studio' })) }))
      await assert.rejects(blocked.service().start(blocked.input), /停用/)
      assert.equal(blocked.runtime.sends, 0)
    })
    assert.equal(networkCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    mkdirSync(path.dirname(reportPath), { recursive: true })
    const failed = checks.filter(check => check.status === 'failed')
    writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), status: failed.length ? 'failed' : 'passed',
      providerCalls: networkCalls, checks, limitations: ['Controlled Session engine and acceptance evidence; real task, plan, submission and SessionInput stores.', 'No paid Provider calls, Electron UI or full SessionManager send exercise.'] }, null, 2) + '\n')
    rmSync(root, { recursive: true, force: true })
    console.log(`Project goal start: ${checks.length - failed.length}/${checks.length} passed\n${reportPath}`)
    if (failed.length) process.exitCode = 1
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
