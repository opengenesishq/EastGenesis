import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from '../src/main/engine'
import type { SessionMeta } from '../src/shared/types'
import type { TaskPlanDraftInput } from '../src/shared/task-plan-types'
import { DEFAULT_PROJECT_INSTITUTION_TEMPLATE, LEGACY_PROJECT_INSTITUTION_TEMPLATE } from '../src/shared/project-institution-template'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import { bindTaskPlanInstitutions } from '../src/main/task/task-plan-institutions'
import { buildCanonicalMissionTaskPlan } from '../src/main/task/mission-task-plan'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'caogen-task-plan-institutions-'))
  const originalFetch = globalThis.fetch
  let providerCalls = 0
  globalThis.fetch = async () => { providerCalls++; throw new Error('No Provider calls in institution contract checks') }
  try {
    const workspace = await openProjectWorkspaceStore(root)
    const commands = await openProjectWorkspaceCommandService(root)
    const sessions = new Map<string, Engine>()
    const coordinator = new TaskPlanSessionCoordinator((id) => sessions.get(id), () => root)
    const reads = createProjectWorkspaceReadService(root, 'canonical')
    const store = new TaskPlanContractStore(() => root)
    const setup = async (id: string, legacy = false): Promise<SessionMeta> => {
      await workspace.createWorkspace({ id, name: id, ...(legacy ? { institutionTemplate: LEGACY_PROJECT_INSTITUTION_TEMPLATE } : {}) })
      const goal = await commands.createGoal({ projectId: id, title: '六页客户汇报', objective: '把数据做成六页客户汇报', status: 'waiting_approval', successCriteria: ['六页客户汇报有来源'], acceptance: [{ id: 'pages', criterion: '汇报不超过六页', required: true }] })
      const parent = await commands.createWorkItem({ projectId: id, goalId: goal.id, title: goal.title, type: 'planning', businessLineId: 'studio', status: 'waiting_approval' })
      const meta = { id: `${id}-session`, workspaceId: id, goalId: goal.id, workItemId: parent.id, businessLineId: 'studio', taskStrategy: 'plan', status: 'idle' } as SessionMeta
      sessions.set(meta.id, { meta } as Engine)
      return meta
    }
    const draft: TaskPlanDraftInput = {
      objective: '把数据做成六页客户汇报',
      steps: [{ id: 'presentation', title: '制作六页客户汇报', executionRole: 'docs', dependsOn: [], expectedArtifacts: ['六页客户汇报'] }],
      acceptanceCriteria: ['汇报不超过六页'], dataEgress: [], riskLevel: 'low'
    }
    const autoMeta = await setup('auto-cabinet')
    const first = await coordinator.createGeneratedVersion(autoMeta.id, draft)
    const firstVersion = first.currentVersion!
    assert.equal(first.approvalStatus, 'pending')
    assert.equal(firstVersion.steps.length, 1)
    assert.deepEqual(firstVersion.institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    assert.equal(firstVersion.steps[0].institution?.id, 'libu_ritual')
    assert.equal(firstVersion.steps[0].executionRole, 'docs')
    assert.equal(firstVersion.steps[0].role, undefined)
    assert.deepEqual(firstVersion.dataEgress, [])
    assert.equal((await reads.listWorkItems(autoMeta.workspaceId)).length, 1)
    assert.deepEqual(await coordinator.createGeneratedVersion(autoMeta.id, draft), first)
    const approved = await coordinator.approve(autoMeta.id, firstVersion)
    await coordinator.requireApprovedVersion(autoMeta.id, firstVersion)
    const receipt = approved.projection!.steps[0]
    const child = (await reads.getWorkItem(receipt.workItemId))!
    assert.equal(child.parentId, autoMeta.workItemId)
    assert.equal(child.role, undefined)
    assert.equal(child.type, 'documentation')
    assert.ok(child.description?.includes('礼部（libu_ritual）'))
    assert.ok(child.description?.includes('cabinet-six-ministries@1'))
    assert.equal(child.owner, undefined)
    const dag = approvedTaskPlanToDag(autoMeta.id, firstVersion, approved.projection)
    assert.equal(dag.tasks.length, 1)
    assert.equal(dag.tasks[0].role, 'docs')
    assert.equal(dag.tasks[0].workItemId, child.id)
    assert.ok(dag.tasks[0].prompt.includes(firstVersion.steps[0].institution!.duty))
    assert.deepEqual(new TaskPlanContractStore(() => root).get(autoMeta.id), approved)

    const file = join(root, 'task-plans/task-plan-contracts.json')
    const original = readFileSync(file, 'utf8')
    for (const mutate of [
      (version: any) => { version.steps[0].institution.id = 'gongbu' },
      (version: any) => { version.steps[0].institution.label = 'forged name' },
      (version: any) => { version.steps[0].institution.duty = 'forged duty' },
      (version: any) => { version.institutionTemplate.templateId = 'legacy-compatible' }
    ]) {
      const state = JSON.parse(original)
      mutate(state.sessions[autoMeta.id].versions[0])
      writeFileSync(file, JSON.stringify(state))
      assert.throws(() => store.get(autoMeta.id), /摘要校验失败/)
    }
    writeFileSync(file, original)

    const ready = await commands.transitionWorkItem(child.id, 'ready', { expectedRevision: child.revision })
    const owned = await commands.updateWorkItem(child.id, { owner: { type: 'human', id: 'local-user' } }, { expectedRevision: ready.revision })
    const leased = await commands.acquireWorkItemLease(child.id, { expectedRevision: owned.revision })
    const running = await commands.transitionWorkItem(child.id, 'running', { expectedRevision: leased.revision })
    const revised = await coordinator.createManualVersion(autoMeta.id, {
      ...draft, changeReason: '改为研究步骤', steps: [{ ...draft.steps[0], workItemType: 'research' }]
    })
    assert.equal(revised.currentVersion!.steps[0].institution?.id, 'hanlinyuan')
    assert.notEqual(revised.currentVersion!.digest, firstVersion.digest)
    assert.equal(revised.approvalStatus, 'pending')
    await assert.rejects(coordinator.approve(autoMeta.id, revised.currentVersion!), /已启动或结束/)
    assert.deepEqual(await reads.getWorkItem(child.id), running)

    const missionMeta = await setup('explicit-mission')
    const mission = await coordinator.compileMission(missionMeta.id, { expectedGoalRevision: 1 })
    assert.deepEqual(mission.currentVersion!.steps.map((step) => [step.role, step.executionRole, step.institution?.id]), [
      ['research', 'general', 'hanlinyuan'], ['build', 'general', 'gongbu'], ['document', 'docs', 'libu_ritual'], ['verify', 'qa', 'duchayuan']
    ])
    const legacyMeta = await setup('legacy-mission', true)
    const legacyDraft = await buildCanonicalMissionTaskPlan(legacyMeta, { expectedGoalRevision: 1 }, root, { legacyInstitutions: true })
    const legacyVersion = store.createVersion({ sessionId: legacyMeta.id, workspaceId: legacyMeta.workspaceId, goalId: legacyMeta.goalId, workItemId: legacyMeta.workItemId }, legacyDraft, 'agent')
    const legacyApproved = await coordinator.approve(legacyMeta.id, legacyVersion.currentVersion!)
    assert.equal(legacyApproved.currentVersion!.institutionTemplate, undefined)
    assert.equal(legacyApproved.currentVersion!.steps[0].institution, undefined)
    await coordinator.requireApprovedVersion(legacyMeta.id, legacyApproved.currentVersion!)

    const simple = bindTaskPlanInstitutions({ ...draft, steps: [{ id: 'simple', title: '生成客户汇报', executionRole: 'general' }] }, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    assert.equal(simple.steps.length, 1)
    assert.equal(simple.steps[0].institution?.id, 'libu_ritual')
    const priorStyleMeta = await setup('existing-unextended')
    const priorStyle = await buildCanonicalMissionTaskPlan(priorStyleMeta, { expectedGoalRevision: 1 }, root, { legacyInstitutions: true })
    const priorVersion = store.createVersion({ sessionId: priorStyleMeta.id, workspaceId: priorStyleMeta.workspaceId, goalId: priorStyleMeta.goalId, workItemId: priorStyleMeta.workItemId }, priorStyle, 'agent')
    await coordinator.approve(priorStyleMeta.id, priorVersion.currentVersion!)
    await coordinator.requireApprovedVersion(priorStyleMeta.id, priorVersion.currentVersion!)
    assert.equal(store.get(priorStyleMeta.id).approvedDigest, priorVersion.currentVersion!.digest)
    assert.equal(providerCalls, 0)
    console.log('Institution plans: automatic step count, frozen digest, approval, canonical children, DAG roles, history compatibility and started-work protection passed. Provider calls: 0.')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
