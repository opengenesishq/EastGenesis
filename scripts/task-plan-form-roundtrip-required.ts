import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compileMission, missionCompilationToTaskPlanDraft } from '../src/main/task/mission-compiler'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import { newPlanStep, planFormFromVersion, taskPlanDraftFromForm, updatePlanStep, type PlanFormSetter } from '../src/renderer/src/components/experience/task-plan-form'
import type { TaskPlanStepInput } from '../src/shared/types'

const root = mkdtempSync(path.join(tmpdir(), 'caogen-task-plan-form-'))
const reportPath = path.resolve('test-results/task-plan-form-roundtrip/latest.json')
const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = []
const fields = ['role', 'executionRole', 'workItemType', 'acceptanceSpec'] as const
const contractFields = (step: TaskPlanStepInput) => Object.fromEntries(fields.filter((field) => Object.hasOwn(step, field)).map((field) => [field, step[field]]))
const check = (name: string, run: () => void): void => {
  try { run(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }); throw error }
}

try {
  const store = new TaskPlanContractStore(() => root)
  const binding = { sessionId: 'mission-form-roundtrip' }
  const draft = missionCompilationToTaskPlanDraft(compileMission({
    projectId: 'form-project', goalId: 'form-goal', objective: '发布可验证的交付包',
    constraints: ['所有成果可追溯'], deliverables: ['应用与说明'], now: 1700000000000
  }))
  const original = store.createVersion(binding, draft, 'agent').currentVersion!
  let form = planFormFromVersion(original)
  const setForm: PlanFormSetter = (action) => { form = typeof action === 'function' ? action(form) : action }

  check('production form roundtrip preserves every structured step field', () => {
    const roundtrip = taskPlanDraftFromForm(form)
    assert.deepEqual(roundtrip.steps.map(contractFields), original.steps.map(contractFields))
  })
  check('editing prose then saving, approving and reopening retains roles and acceptance for execution', () => {
    updatePlanStep(setForm, 0, { title: 'API UI 测试 发布 文档', description: '修改说明，不改变岗位职责。' })
    form.changeReason = '修改展示文字'
    const revised = store.createVersion(binding, taskPlanDraftFromForm(form), 'local-user')
    assert.equal(revised.approvalStatus, 'pending')
    store.approve(binding.sessionId, revised.currentVersion!)
    const reopened = new TaskPlanContractStore(() => root).get(binding.sessionId)
    assert.equal(reopened.approvalStatus, 'approved')
    assert.deepEqual(reopened.currentVersion!.steps.map(contractFields), original.steps.map(contractFields))
    assert.equal(reopened.currentVersion!.steps[0].title, 'API UI 测试 发布 文档')
    const dag = approvedTaskPlanToDag(binding.sessionId, reopened.currentVersion!, reopened.projection)
    assert.deepEqual(dag.tasks.map((task) => task.role), ['general', 'general', 'docs', 'qa'])
    original.steps.forEach((step, index) => {
      assert(dag.tasks[index].prompt.includes(`岗位：${step.role}`))
      for (const acceptance of step.acceptanceSpec!) assert(dag.tasks[index].prompt.includes(acceptance.criterion))
    })
  })
  check('new steps do not inherit structured fields even when reusing a deleted step id', () => {
    const changed = planFormFromVersion(original)
    const [removed, ...retained] = changed.steps
    const added = { ...newPlanStep(4), id: removed.id, title: '新建通用步骤' }
    changed.steps = [...retained.reverse(), added]
    changed.changeReason = '删除旧步骤并新增通用步骤'
    const converted = taskPlanDraftFromForm(changed)
    assert.deepEqual(contractFields(converted.steps.at(-1)!), {})
    for (const step of converted.steps.slice(0, -1)) {
      assert.deepEqual(contractFields(step), contractFields(original.steps.find((entry) => entry.id === step.id)!))
    }
    const saved = store.createVersion({ sessionId: 'deleted-reordered-step' }, converted, 'local-user')
    assert.deepEqual(contractFields(saved.currentVersion!.steps.at(-1)!), {})
  })
  check('renaming an existing row preserves its own fields without matching another step id', () => {
    const changed = planFormFromVersion(original)
    const document = changed.steps[2]
    document.id = 'renamed-document-step'
    const converted = taskPlanDraftFromForm(changed)
    assert.deepEqual(contractFields(converted.steps[2]), contractFields(original.steps[2]))
    assert.equal(converted.steps[2].id, 'renamed-document-step')
  })
  check('acceptance entries are isolated between persisted versions, forms and returned drafts', () => {
    const changed = planFormFromVersion(original)
    const criterion = original.steps[0].acceptanceSpec![0].criterion
    changed.steps[0].acceptanceSpec![0].criterion = 'form-only change'
    assert.equal(original.steps[0].acceptanceSpec![0].criterion, criterion)
    const converted = taskPlanDraftFromForm(changed)
    converted.steps[0].acceptanceSpec![0].criterion = 'draft-only change'
    assert.equal(changed.steps[0].acceptanceSpec![0].criterion, 'form-only change')
    assert.equal(taskPlanDraftFromForm(planFormFromVersion(original)).steps[0].acceptanceSpec![0].criterion, criterion)
  })
  check('legacy steps retain absent extensions and their original plan digest after a no-op roundtrip', () => {
    const legacyDraft = { objective: '旧版计划', steps: [{ id: 'legacy', title: '执行旧步骤' }], acceptanceCriteria: ['提供证据'] }
    const legacyBinding = { sessionId: 'legacy-form-roundtrip' }
    const first = store.createVersion(legacyBinding, legacyDraft, 'local-user').currentVersion!
    const converted = taskPlanDraftFromForm(planFormFromVersion(first))
    assert.deepEqual(contractFields(converted.steps[0]), {})
    converted.changeReason = '旧版表单原样保存'
    assert.throws(() => store.createVersion(legacyBinding, converted, 'local-user'), /没有实质变化/)
    assert.equal(store.get(legacyBinding.sessionId).currentVersion!.digest, first.digest)
    assert.equal(store.get(legacyBinding.sessionId).versions.length, 1)
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  mkdirSync(path.dirname(reportPath), { recursive: true })
  const passed = checks.filter((entry) => entry.status === 'passed').length
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1, kind: 'caogen.task-plan-form-roundtrip-report', status: process.exitCode ? 'failed' : 'passed',
    generatedAt: new Date().toISOString(), checks, summary: { passed, total: checks.length },
    limitations: ['actual form converters, plan store and DAG projection', 'Electron UI clicks and Provider execution are separate gates']
  }, null, 2)}\n`)
  rmSync(root, { recursive: true, force: true })
  console.log(`TaskPlan form roundtrip: ${passed}/${checks.length}; ${reportPath}`)
}
