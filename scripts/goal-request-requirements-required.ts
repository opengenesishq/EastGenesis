import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractGoalRequestRequirements } from '../src/shared/goal-request-requirements'
import { createProjectGoalTask } from '../src/main/project-workspace/goal-task-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { createAutomaticTaskPlan } from '../src/main/task/automatic-task-plan'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import type { Engine } from '../src/main/engine'
import type { SessionMeta } from '../src/shared/types'

async function main(): Promise<void> {
  const objective = '把这些数据做成客户汇报，控制在六页，输出 PPTX，标注来源，不要修改原始数据。'
  const requirements = extractGoalRequestRequirements(objective)
  assert.deepEqual(requirements.map(item => item.kind), ['page_count', 'format', 'sources', 'constraint'])
  assert.deepEqual(requirements[0].pageCount, { value: 6, operator: 'lte' })
  assert.equal(requirements[1].format, 'pptx')
  for (const [text, count, operator] of [
    ['制作十二页汇报', 12, 'eq'], ['至少三页', 3, 'gte'], ['不超过二十六页', 26, 'lte'],
    ['改成八页', 8, 'eq'], ['把汇报压缩到六页', 6, 'eq'], ['扩展到十页', 10, 'eq'],
    ['Create a six-page report', 6, 'eq'], ['up to 12 slides', 12, 'lte']
  ] as const) assert.deepEqual(extractGoalRequestRequirements(text)[0]?.pageCount, { value: count, operator })
  for (const text of [
    '总结以下原文：“控制在六页，输出 PDF，标注来源。”', '把已有共六页的报告总结成一句话',
    '阅读不超过三页的论文', '不要制作六页汇报', '不要求标注来源', '第六页补充一张图', '不要改成八页'
  ]) assert(!extractGoalRequestRequirements(text).some(item => item.kind !== 'constraint'), text)
  assert.deepEqual(extractGoalRequestRequirements('把 Excel 数据转换为 PDF').map(item => item.format), ['pdf'])
  const conflicting = extractGoalRequestRequirements('至少八页，最多六页')
  assert.equal(conflicting.length, 2, 'contradictory instructions remain visible; do not silently pick one')
  for (const text of ['制作六页客户汇报，不要发送给客户', '编写产品发布说明', 'Draft an email to the client']) {
    const plan = await createAutomaticTaskPlan(text)
    assert(!plan.steps.some(step => step.id === 'requested-action'), text)
  }
  assert((await createAutomaticTaskPlan('制作客户汇报并发送邮件给客户')).steps.some(step => step.id === 'requested-action'))

  const root = mkdtempSync(join(tmpdir(), 'caogen-goal-requirements-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Local goal extraction must not call Providers') }
  try {
    await (await openProjectWorkspaceStore(root)).createWorkspace({ id: 'requirements-project', name: 'Requirements' })
    const input = { projectId: 'requirements-project', requestId: 'six-pages', objective }
    const created = await createProjectGoalTask(input, root)
    const reads = createProjectWorkspaceReadService(root, 'canonical')
    const goal = (await reads.getGoal(created.goal.id))!
    assert(goal.contract.successCriteria.includes(objective))
    for (const requirement of requirements) assert(goal.contract.acceptance.some(item => item.id === requirement.id && item.criterion === requirement.text))
    assert.deepEqual(created.workItem.acceptanceSpec, goal.contract.acceptance)
    const replayed = await createProjectGoalTask(input, root)
    assert.equal(replayed.goal.revision, goal.revision)
    assert.deepEqual(replayed.workItem, created.workItem)
    const meta = { id: 'requirements-session', workspaceId: input.projectId, goalId: goal.id, workItemId: created.workItem.id,
      businessLineId: 'studio', taskStrategy: 'plan', status: 'idle' } as SessionMeta
    const coordinator = new TaskPlanSessionCoordinator(id => id === meta.id ? { meta } as Engine : undefined, () => root)
    const plan = await coordinator.createGeneratedVersion(meta.id, await createAutomaticTaskPlan(objective))
    assert(plan.currentVersion!.acceptanceCriteria.includes('控制在六页'))
    const approved = await coordinator.approve(meta.id, plan.currentVersion!)
    const dag = approvedTaskPlanToDag(meta.id, plan.currentVersion!, approved.projection)
    assert.equal(dag.tasks.length, 1)
    const child = (await reads.getWorkItem(dag.tasks[0].workItemId!))!
    assert(child.acceptanceSpec.some(item => item.id === 'request:pages:lte:6'))
    assert(dag.tasks[0].prompt.includes('[request:pages:lte:6] 控制在六页'))
    assert.deepEqual(new TaskPlanContractStore(() => root).get(meta.id), approved)
    const longObjective = '制作一份报告。' + '这里是需要保留的完整背景资料。'.repeat(200)
    new TaskPlanContractStore(() => root).createVersion({ sessionId: 'long-objective' }, await createAutomaticTaskPlan(longObjective), 'agent')
    console.log('Goal requirements: explicit extraction, source/negation boundaries, canonical persistence, replay, approval, child acceptance and long objectives passed. No Provider calls.')
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
