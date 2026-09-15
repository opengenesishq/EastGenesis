import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Engine } from '../src/main/engine'
import type { SessionMeta, TaskPlanStateView } from '../src/shared/types'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { countTaskPlanLedgerForSession } from '../src/main/task/task-plan-ledger'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import { TaskPlanCanonicalProjector } from '../src/main/task/task-plan-canonical-projection'
import { listPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-api'

const root = mkdtempSync(path.join(tmpdir(), 'caogen-mission-plan-production-'))
const checks: { name: string; status: string; detail?: string }[] = []
const reportPath = path.resolve('test-results/mission-task-plan-production/latest.json')
const runId = new Date().toISOString()
let runtimeCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { runtimeCalls += 1; throw new Error('network forbidden in local Mission compilation') }
const check = async (name: string, run: () => Promise<void> | void) => {
  try { await run(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }); throw error }
}

async function main(): Promise<void> {
try {
  const workspace = await openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: 'mission-project', name: 'Mission Local', kind: 'opc', resources: [
    { id: 'brief', kind: 'directory', label: '产品资料', path: '/not-read-by-mission-compiler' }
  ] })
  const commands = await openProjectWorkspaceCommandService(root)
  let goal = await commands.createGoal({
    id: 'mission-goal', projectId: 'mission-project', title: '本周上线产品',
    objective: '为小团队交付 API UI 测试 发布 文档组成的产品发布包', status: 'waiting_approval',
    constraints: ['保留已经确认的登录功能'], forbiddenActions: ['未经批准公开发布'],
    successCriteria: ['交付物：代码和使用说明', '所有关键成果有证据'],
    riskLevel: 'high', budget: { amount: 12, currency: 'CNY', maxRuns: 4 },
    acceptance: [
      { id: 'sources', criterion: '研究结论包含来源', required: true },
      { id: 'demo', criterion: '最终交付包附演示录像', required: false }
    ]
  })
  const parent = await commands.createWorkItem({
    id: 'mission-parent', projectId: 'mission-project', goalId: goal.id, businessLineId: 'studio',
    type: 'planning', title: goal.title, status: 'waiting_approval'
  })
  const meta = {
    id: 'mission-session', workspaceId: 'mission-project', projectId: 'mission-project',
    goalId: goal.id, workItemId: parent.id, businessLineId: 'studio',
    status: 'idle', taskStrategy: 'plan', permissionMode: 'plan'
  } as SessionMeta
  const engine = {
    meta,
    start: async () => { runtimeCalls += 1; throw new Error('compile must not start an Engine') },
    send: () => { runtimeCalls += 1; throw new Error('compile must not send to a Provider') }
  } as unknown as Engine
  const coordinator = new TaskPlanSessionCoordinator((id) => id === meta.id ? engine : undefined, () => root)
  const reads = createProjectWorkspaceReadService(root, 'canonical')
  const store = new TaskPlanContractStore(() => root)
  let plan: TaskPlanStateView

  await check('canonical Mission compiles four pending steps and preserves constraints, budget, acceptance and materials', async () => {
    plan = await coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision })
    assert.equal(plan.approvalStatus, 'pending')
    assert.equal(plan.currentVersion?.source, 'genesis')
    assert.equal(plan.currentVersion?.steps.length, 4)
    assert.equal(plan.currentVersion?.steps.flatMap((step) => step.dependsOn).length, 4)
    assert.equal(plan.currentVersion?.riskLevel, 'high')
    assert.equal(plan.currentVersion?.missionSource?.goalRevision, goal.revision)
    const criteria = plan.currentVersion!.acceptanceCriteria.join('\n')
    for (const text of ['保留已经确认的登录功能', '禁止：未经批准公开发布', '研究结论包含来源', 'CNY', '资料引用：产品资料']) assert(criteria.includes(text), text)
    assert.deepEqual(plan.currentVersion?.dataEgress, [])
    assert.equal((await reads.listWorkItems('mission-project')).length, 1)
    assert.equal(await countTaskPlanLedgerForSession(root, meta.id), 1)
    await assert.rejects(coordinator.requireApprovedVersion(meta.id, plan.currentVersion!), /尚未批准/)
  })
  await check('repeated compile is idempotent and concurrent compile cannot create duplicate versions', async () => {
    const results = await Promise.allSettled([
      coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision }),
      coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision })
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(store.get(meta.id).versions.length, 1)
    assert.equal(await countTaskPlanLedgerForSession(root, meta.id), 1)
  })
  await check('renderer cannot override canonical inputs or compile for a stale revision, other project or running session', async () => {
    await assert.rejects(coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision, objective: 'forged' } as never), /canonical/)
    await assert.rejects(coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision + 1 }), /revision/)
    meta.workspaceId = 'other-project'
    await assert.rejects(coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision }), /Project 不存在或不可用/)
    meta.workspaceId = 'mission-project'
    meta.status = 'running'
    await assert.rejects(coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision }), /正在运行/)
    meta.status = 'idle'
    assert.equal(store.get(meta.id).versions.length, 1)
  })
  await check('changed Goal rejects old approval before creating any canonical child WorkItem', async () => {
    goal = await commands.updateGoal(goal.id, { constraints: [...goal.constraints, '面向小团队而非个人客户'] }, { expectedRevision: goal.revision })
    await assert.rejects(coordinator.approve(meta.id, plan.currentVersion!, 'local-user:test'), /revision/)
    assert.equal((await reads.listWorkItems('mission-project')).length, 1)
    assert.equal(store.get(meta.id).approvalStatus, 'pending')
  })
  await check('recompile creates a new pending version and explicit approval projects exactly four canonical children', async () => {
    plan = await coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision })
    assert.equal(plan.currentVersion?.version, 2)
    assert.equal(plan.approvalStatus, 'pending')
    assert.equal((await reads.listWorkItems('mission-project')).length, 1)
    plan = await coordinator.approve(meta.id, plan.currentVersion!, 'local-user:test')
    assert.equal(plan.approvalStatus, 'approved')
    const children = (await reads.listWorkItems('mission-project')).filter((item) => item.parentId === parent.id)
    assert.equal(children.length, 4)
    assert(children.every((item) => item.goalId === goal.id && item.projectId === 'mission-project' && item.status === 'backlog'))
    assert.equal(children.flatMap((item) => item.dependencyIds).length, 4)
    assert.equal(runtimeCalls, 0)
  })
  await check('canonical children retain four structured roles, types and individually bound acceptance in the same business line', async () => {
    const children = (await reads.listWorkItems('mission-project')).filter((item) => item.parentId === parent.id)
    for (const step of plan.currentVersion!.steps) {
      const receipt = plan.projection!.steps.find((entry) => entry.stepId === step.id)!
      const child = children.find((item) => item.id === receipt.workItemId)!
      assert.equal(child.businessLineId, parent.businessLineId)
      assert.equal(child.role, step.role)
      assert.equal(child.type, step.workItemType)
      assert.deepEqual(child.acceptanceSpec, step.acceptanceSpec)
      assert.deepEqual(child.inheritedGoalContract?.acceptance, goal.contract.acceptance)
      const finalChecks = child.acceptanceSpec.filter((entry) => entry.id.startsWith('goal:'))
      assert.deepEqual(finalChecks, step.role === 'verify'
        ? goal.contract.acceptance.map((entry) => ({ ...entry, id: `goal:${entry.id}` })) : [])
    }
    assert.deepEqual(children.map((child) => child.role).sort(), ['build', 'document', 'research', 'verify'])
    const dag = approvedTaskPlanToDag(meta.id, plan.currentVersion!, plan.projection)
    assert.deepEqual(dag.tasks.map((task) => task.role), ['general', 'general', 'docs', 'qa'])
    for (const task of dag.tasks) assert(children.some((child) => child.id === task.workItemId))
  })
  await check('a fresh coordinator and store recover the same plan, source digest, approval and Ledger events', async () => {
    const restored = new TaskPlanSessionCoordinator((id) => id === meta.id ? engine : undefined, () => root)
    await restored.reconcileLedger()
    assert.deepEqual(restored.get(meta.id), plan)
    assert.equal(await countTaskPlanLedgerForSession(root, meta.id), 3)
    await restored.requireApprovedVersion(meta.id, plan.currentVersion!)
  })
  await check('fresh canonical reads and Workflow Ledger preserve the same structured roles and types', async () => {
    const freshReads = createProjectWorkspaceReadService(root, 'canonical')
    const children = (await freshReads.listWorkItems('mission-project')).filter((item) => item.parentId === parent.id)
    const ledger = await listPersistedWorkflowLedger({ projectId: 'mission-project' }, root)
    for (const child of children) {
      const slim = ledger.workItems.items.find((item) => item.id === child.id)!
      assert.equal(slim.role, child.role)
      assert.equal(slim.type, child.type)
      assert.equal(slim.businessLineId, child.businessLineId)
    }
  })
  await check('resource authorization changes reject previously approved Mission dispatch', async () => {
    const project = await workspace.getWorkspace('mission-project')
    await workspace.updateWorkspace(project!.id, { resources: [] }, { expectedRevision: project!.revision })
    await assert.rejects(coordinator.requireApprovedVersion(meta.id, plan.currentVersion!), /资料或策略已变化/)
    plan = await coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision })
    assert.equal(plan.approvalStatus, 'pending')
    assert.equal(plan.currentVersion?.version, 3)
    assert(plan.approvalEvents.some((event) => event.kind === 'superseded'))
  })
  await check('changing structured role cannot rewrite an already started canonical child', async () => {
    const prior = store.get(meta.id).versions[1]
    const research = (await reads.listWorkItems('mission-project')).find((item) => item.parentId === parent.id && item.role === 'research')!
    const ready = await commands.transitionWorkItem(research.id, 'ready', { expectedRevision: research.revision })
    const owned = await commands.updateWorkItem(ready.id, { owner: { type: 'human', id: 'local-user:test' } }, { expectedRevision: ready.revision })
    const leased = await commands.acquireWorkItemLease(owned.id, { expectedRevision: owned.revision })
    const running = await commands.transitionWorkItem(leased.id, 'running', { expectedRevision: leased.revision })
    const changed = store.createVersion(prior.binding, {
      ...prior, source: 'manual', missionSource: undefined, changeReason: 'change role on started child',
      steps: prior.steps.map((step) => step.role === 'research' ? { ...step, role: 'review' } : step)
    }, 'local-user')
    assert.equal(changed.approvalStatus, 'pending')
    await assert.rejects(new TaskPlanCanonicalProjector(() => root).project(changed.currentVersion!), /已启动或结束/)
    assert.deepEqual(await reads.getWorkItem(running.id), running)
  })
  await check('persisted canonical source metadata is digest protected', () => {
    const file = path.join(root, 'task-plans', 'task-plan-contracts.json')
    const original = readFileSync(file, 'utf8')
    const data = JSON.parse(original)
    data.sessions[meta.id].versions[0].missionSource.inputDigest = 'a'.repeat(64)
    writeFileSync(file, JSON.stringify(data))
    assert.throws(() => new TaskPlanContractStore(() => root).get(meta.id), /摘要校验失败/)
    writeFileSync(file, original)
  })
  await check('compilation and approval do not call Runtime or network', () => assert.equal(runtimeCalls, 0))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  mkdirSync(path.dirname(reportPath), { recursive: true })
  const passed = checks.filter((entry) => entry.status === 'passed').length
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1, kind: 'caogen.mission-task-plan-production-report', runId,
    status: process.exitCode ? 'failed' : 'passed', checks, summary: { passed, total: checks.length },
    providerCalls: runtimeCalls, humanEvidence: false,
    limitations: ['local canonical stores and a controlled idle Engine', 'Electron IPC/UI clicks are a separate gate', 'no real Provider execution or human acceptance']
  }, null, 2)}\n`)
  rmSync(root, { recursive: true, force: true })
  console.log(`Mission production planning: ${passed}/${checks.length}; ${reportPath}`)
}
}

void main()
