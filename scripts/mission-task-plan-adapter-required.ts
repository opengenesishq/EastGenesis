import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { compileMission, missionCompilationToTaskPlanDraft } from '../src/main/task/mission-compiler'

const checks: { id: string; status: 'passed' | 'failed'; detail?: string }[] = []
const record = (id: string, operation: () => void): void => {
  try { operation(); checks.push({ id, status: 'passed' }) }
  catch (error) { checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
}

const compilation = compileMission({
  projectId: 'project-mission-plan-adapter',
  goalId: 'goal-mission-plan-adapter',
  objective: '形成可审查的产品发布包',
  constraints: ['未经批准不得外发', '每个成果必须可追溯'],
  deliverables: ['运行页面', '使用说明', 'Proof Pack'],
  materials: [{ id: 'brief', title: '脱敏需求' }],
  now: 1700000000000
})

record('maps-objective-and-steps', () => {
  const draft = missionCompilationToTaskPlanDraft(compilation)
  assert.equal(draft.objective, compilation.goal.objective)
  assert.equal(draft.steps.length, compilation.workItems.length)
  assert.deepEqual(draft.steps.map((step) => step.id), compilation.workItems.map((item) => item.id))
})

record('maps-dag-dependencies', () => {
  const draft = missionCompilationToTaskPlanDraft(compilation)
  const byRole = new Map(compilation.workItems.map((item) => [item.role, item.id]))
  const build = draft.steps.find((step) => step.id === byRole.get('build'))
  const verify = draft.steps.find((step) => step.id === byRole.get('verify'))
  assert.deepEqual(build?.dependsOn, [byRole.get('research')])
  assert.deepEqual(verify?.dependsOn, [byRole.get('build'), byRole.get('document')])
})

record('pending-boundary-and-no-egress', () => {
  const draft = missionCompilationToTaskPlanDraft(compilation)
  assert.equal(draft.source, 'genesis')
  assert.deepEqual(draft.dataEgress, [])
  assert.ok(draft.acceptanceCriteria[0].includes('用户确认'))
  assert.ok(draft.acceptanceCriteria[0].includes('不得执行'))
  assert.ok(!('executionAuthorization' in draft))
})

record('preserves-acceptance-criteria', () => {
  const draft = missionCompilationToTaskPlanDraft(compilation)
  for (const acceptance of compilation.acceptances) {
    for (const criterion of acceptance.criteria) assert.ok(draft.acceptanceCriteria.includes(criterion))
  }
})

record('preserves-structured-roles-types-and-individual-acceptance', () => {
  const draft = missionCompilationToTaskPlanDraft(compilation)
  assert.deepEqual(draft.steps.map((step) => [step.role, step.workItemType, step.executionRole]), [
    ['research', 'research', 'general'], ['build', 'coding', 'general'],
    ['document', 'documentation', 'docs'], ['verify', 'testing', 'qa']
  ])
  for (const acceptance of compilation.acceptances) {
    const step = draft.steps.find((step) => step.id === acceptance.workItemId)!
    assert.ok(step.acceptanceSpec?.some((entry) => entry.id === 'artifact-1'))
    acceptance.criteria.forEach((criterion, index) => assert.deepEqual(
      step.acceptanceSpec?.find((entry) => entry.id === `${acceptance.id}:criterion:${index + 1}`),
      { id: `${acceptance.id}:criterion:${index + 1}`, criterion, required: true }
    ))
    assert.ok(step.acceptanceSpec?.every((entry) => entry.id === 'artifact-1' || entry.id.startsWith(`${acceptance.id}:criterion:`)))
  }
})

record('pure-and-deterministic', () => {
  const before = JSON.stringify(compilation)
  const first = missionCompilationToTaskPlanDraft(compilation)
  first.steps.reverse()
  first.acceptanceCriteria.push('caller mutation')
  const second = missionCompilationToTaskPlanDraft(compilation)
  assert.equal(JSON.stringify(compilation), before)
  assert.deepEqual(second.steps.map((step) => step.id), compilation.workItems.map((item) => item.id))
})

record('rejects-invalid-compilation', () => {
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, workItems: [] }), /work items/)
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, acceptances: [] }), /acceptances/)
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, acceptances: [{ ...compilation.acceptances[0], status: 'passed' as const }, ...compilation.acceptances.slice(1)] }), /remain pending/)
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, acceptances: compilation.acceptances.slice(1) }), /exactly once/)
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, dependencies: [{ fromWorkItemId: compilation.workItems[0].id, toWorkItemId: compilation.workItems[0].id }] }), /self-reference/)
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, schemaVersion: 2 as 1 }), /schema/)
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, workItems: [{ ...compilation.workItems[0], role: 'unknown' }, ...compilation.workItems.slice(1)] }), /role\/type/)
  assert.throws(() => missionCompilationToTaskPlanDraft({ ...compilation, workItems: [{ ...compilation.workItems[0], type: 'coding' }, ...compilation.workItems.slice(1)] }), /role\/type/)
})

const failed = checks.filter((item) => item.status === 'failed')
const report = {
  schemaVersion: 1,
  contract: 'V2-002 Mission Compiler to TaskPlan Draft',
  status: failed.length ? 'failed' : 'passed',
  checks,
  summary: `${checks.length - failed.length}/${checks.length} checks passed`,
  coverage: {
    verified: ['纯函数映射目标、步骤和 DAG 依赖', '草稿保持 genesis/pending 边界且无外发授权', '验收标准完整保留', '输入不可变与非法编译结果 fail-closed'],
    explicitlyNotVerified: ['用户审批、canonical 投影、Provider 调用和执行授权']
  },
  generatedAt: new Date().toISOString()
}
const output = resolve(process.cwd(), 'test-results/mission-task-plan-adapter/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
if (failed.length) process.exitCode = 1
