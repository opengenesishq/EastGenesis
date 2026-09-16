import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from '../src/main/engine'
import type { SessionMeta } from '../src/shared/types'
import { createAutomaticTaskPlan } from '../src/main/task/automatic-task-plan'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { LEGACY_PROJECT_INSTITUTION_TEMPLATE } from '../src/shared/project-institution-template'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'caogen-automatic-plan-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Planning must not call a Provider') }
  try {
    const scenarios = [
      { objective: '把这些数据做成客户汇报，控制在六页。', types: ['writing'], institutions: ['libu_ritual'] },
      { objective: '调研三家产品，分析成本与差异，制作六页客户汇报。', types: ['research', 'analysis', 'writing'], institutions: ['hanlinyuan', 'hanlinyuan', 'libu_ritual'] },
      { objective: '把已有研究报告转换成 PPT。', types: ['writing'], institutions: ['libu_ritual'] },
      { objective: 'Create a report about API authentication.', types: ['writing'], institutions: ['libu_ritual'] },
      { objective: '研究这份报告中的结论。', types: ['research'], institutions: ['hanlinyuan'] },
      { objective: '制作汇报并独立复核，然后发送给指定客户。', types: ['writing', 'review', 'operations'], institutions: ['libu_ritual', 'duchayuan', 'bingbu'] },
      { objective: '整理本次会谈的待办事项。', types: ['custom'], institutions: ['neige'] }
    ]
    const workspace = await openProjectWorkspaceStore(root)
    const commands = await openProjectWorkspaceCommandService(root)
    const reads = createProjectWorkspaceReadService(root, 'canonical')
    const sessions = new Map<string, Engine>()
    const coordinator = new TaskPlanSessionCoordinator(id => sessions.get(id), () => root)
    for (const [index, scenario] of scenarios.entries()) {
      const projectId = `project-${index}`
      await workspace.createWorkspace({ id: projectId, name: projectId })
      const goal = await commands.createGoal({ projectId, title: scenario.objective, objective: scenario.objective, status: 'waiting_approval' })
      const parent = await commands.createWorkItem({ projectId, goalId: goal.id, title: scenario.objective, type: 'planning', status: 'waiting_approval', businessLineId: 'studio' })
      const meta = { id: `session-${index}`, workspaceId: projectId, goalId: goal.id, workItemId: parent.id, businessLineId: 'studio', status: 'idle', taskStrategy: 'plan' } as SessionMeta
      sessions.set(meta.id, { meta } as Engine)
      const draft = await createAutomaticTaskPlan(scenario.objective)
      const state = await coordinator.createGeneratedVersion(meta.id, draft)
      const version = state.currentVersion!
      assert.equal(version.objective, scenario.objective)
      assert.deepEqual(version.steps.map(step => step.workItemType), scenario.types)
      assert.deepEqual(version.steps.map(step => step.institution?.id), scenario.institutions)
      assert.equal((await reads.listWorkItems(projectId)).length, 1, 'planning must not create executable children')
      const approved = await coordinator.approve(meta.id, version)
      const dag = approvedTaskPlanToDag(meta.id, version, approved.projection)
      assert.equal(dag.tasks.length, scenario.types.length)
      for (const [stepIndex, task] of dag.tasks.entries()) {
        const workItem = await reads.getWorkItem(task.workItemId!)
        assert.equal(workItem?.parentId, parent.id)
        assert.equal(workItem?.type, scenario.types[stepIndex])
        assert(task.prompt.includes(scenario.objective))
        assert.deepEqual(task.dependencies, stepIndex ? [dag.tasks[stepIndex - 1].id] : [])
      }
      assert.deepEqual(new TaskPlanContractStore(() => root).get(meta.id), approved)
      assert.deepEqual(await coordinator.createGeneratedVersion(meta.id, draft), approved, 'existing approved plan must remain unchanged')
    }
    const engineering = await createAutomaticTaskPlan('实现前端界面、后端 API 和数据库的完整登录功能并验证。')
    assert(engineering.steps.some(step => step.executionRole === 'frontend'))
    assert(engineering.steps.some(step => step.executionRole === 'backend'))
    const legacyId = 'legacy-project'
    await workspace.createWorkspace({ id: legacyId, name: legacyId, institutionTemplate: LEGACY_PROJECT_INSTITUTION_TEMPLATE })
    const goal = await commands.createGoal({ projectId: legacyId, title: '历史项目', objective: '制作客户汇报', status: 'waiting_approval' })
    const item = await commands.createWorkItem({ projectId: legacyId, goalId: goal.id, title: goal.title, type: 'planning', businessLineId: 'studio', status: 'waiting_approval' })
    const meta = { id: 'legacy-session', workspaceId: legacyId, goalId: goal.id, workItemId: item.id, businessLineId: 'studio', status: 'idle', taskStrategy: 'plan' } as SessionMeta
    sessions.set(meta.id, { meta } as Engine)
    const legacy = await coordinator.createGeneratedVersion(meta.id, await createAutomaticTaskPlan(goal.objective))
    assert.equal(legacy.currentVersion?.institutionTemplate, undefined)
    console.log('Automatic planning: 7 canonical goal/approval/dispatch scenarios, engineering compatibility and legacy template preservation passed. No Provider calls.')
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
