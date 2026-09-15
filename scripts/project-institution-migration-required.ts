import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Engine } from '../src/main/engine'
import type { SessionMeta } from '../src/shared/types'
import { DEFAULT_PROJECT_INSTITUTION_TEMPLATE, LEGACY_PROJECT_INSTITUTION_TEMPLATE,
  PROJECT_INSTITUTION_MIGRATION_EVENT, type ProjectInstitutionTemplateRef } from '../src/shared/project-institution-template'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { createProjectWorkspaceReadService } from '../src/main/project-workspace/canonical-read-service'
import { readGoalInstitutionContext, resolveGoalInstitutionTemplate } from '../src/main/project-workspace/institution-goal-binding'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import { buildCanonicalMissionTaskPlan, enrichCanonicalTaskPlanInstitutions } from '../src/main/task/mission-task-plan'
import { buildTaskSnapshot, listTaskRuns, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { createTaskRun } from '../src/main/task/task-run'
import { listPersistedWorkflowLedger } from '../src/main/task/workflow-ledger-api'

const root = mkdtempSync(join(tmpdir(), 'caogen-institution-migration-'))
const reportPath = resolve('test-results/project-institution-migration/latest.json')
const checks: { name: string; status: 'passed' | 'failed'; detail?: string }[] = []
const originalFetch = globalThis.fetch
let providerCalls = 0
globalThis.fetch = async () => { providerCalls++; throw new Error('Provider calls forbidden in institution migration checks') }

async function check(name: string, operation: () => Promise<void>) {
  try { await operation(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }); throw error }
}

async function main() {
  try {
    const workspace = await openProjectWorkspaceStore(root)
    const commands = await openProjectWorkspaceCommandService(root)
    const reads = createProjectWorkspaceReadService(root, 'canonical')
    const plans = new TaskPlanContractStore(() => root)
    const sessions = new Map<string, Engine>()
    const coordinator = new TaskPlanSessionCoordinator(id => sessions.get(id), () => root)
    const projectId = 'migration-project'
    await workspace.createWorkspace({ id: projectId, name: 'Historical institution migration',
      institutionTemplate: LEGACY_PROJECT_INSTITUTION_TEMPLATE,
      permissionPolicy: { legacyRoleIds: ['taizi', 'xichang'], dataEgress: 'approval_required' },
      budgetPolicy: { maxUsd: 5 }, resources: [{ id: 'brief', kind: 'directory', label: '原始材料', path: root }] })

    const createGoal = async (suffix: string) => {
      const goal = await commands.createGoal({ id: `goal-${suffix}`, projectId, title: `报告 ${suffix}`,
        objective: `根据资料生成客户报告 ${suffix}`, status: 'waiting_approval', constraints: ['引用来源，保留原始记录'],
        successCriteria: ['交付物：客户报告'], acceptance: [{ id: 'source', criterion: '报告引用来源', required: true }] })
      const parent = await commands.createWorkItem({ id: `parent-${suffix}`, projectId, goalId: goal.id,
        title: goal.title, type: 'planning', status: 'waiting_approval', businessLineId: 'studio' })
      const meta = { id: `session-${suffix}`, title: goal.title, cwd: root, workspaceId: projectId, projectId,
        goalId: goal.id, workItemId: parent.id, businessLineId: 'studio', taskStrategy: 'plan', permissionMode: 'default',
        status: 'idle', engine: 'openai', model: 'fixture-model', providerId: 'fixture-provider', createdAt: 1,
        digitalWorkerBinding: { kind: 'unscoped' }, costUsd: 0, contextTokens: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } } as SessionMeta
      sessions.set(meta.id, { meta } as Engine)
      let plan = await coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision })
      plan = await coordinator.approve(meta.id, plan.currentVersion!, 'local-user:fixture')
      const run = createTaskRun({ id: `run-${suffix}`, sessionId: meta.id, taskId: meta.id,
        digitalWorkerBinding: { kind: 'unscoped' }, now: 100 })
      await saveTaskSnapshot(buildTaskSnapshot({ meta, transcript: [], lastSeq: 0, eventCount: 0,
        reason: 'created', run, now: 100 }), root)
      meta.taskStrategy = 'execute'; meta.permissionMode = 'acceptEdits'
      return { goal, parent, meta, plan, run }
    }
    const snapshotTask = async (id: string, goalId: string) => ({
      plan: plans.get(id), goal: await reads.getGoal(goalId),
      workItems: (await reads.listWorkItems(projectId)).filter(item => item.goalId === goalId).sort((a, b) => a.id.localeCompare(b.id)),
      runs: await listTaskRuns(id, root),
      ledgerRuns: (await listPersistedWorkflowLedger({ projectId, limit: 500 }, root)).runs.items.filter(run => run.sessionId === id)
    })
    const apply = async (target: ProjectInstitutionTemplateRef) => {
      const preview = await workspace.previewInstitutionMigration(projectId, { scope: 'future_goals', target })
      return { preview, input: { scope: 'future_goals' as const, target,
        expectedWorkspaceRevision: preview.expectedWorkspaceRevision, previewDigest: preview.previewDigest } }
    }

    const orphan = await commands.createWorkItem({ id: 'legacy-work-without-goal', projectId,
      title: '旧独立任务', type: 'documentation', businessLineId: 'studio' })
    const orphanMeta = { workspaceId: projectId, workItemId: orphan.id }
    const orphanDraft = { objective: '整理说明', steps: [{ id: 'old-docs', title: '整理说明', executionRole: 'docs' as const }] }
    const orphanBefore = await enrichCanonicalTaskPlanInstitutions(orphanMeta, orphanDraft, root)
    const first = await createGoal('legacy')
    assert.equal(first.plan.currentVersion!.institutionTemplate, undefined)
    const firstBefore = await snapshotTask(first.meta.id, first.goal.id)
    const originalWorkspace = (await workspace.getWorkspace(projectId))!
    let firstMigration: Awaited<ReturnType<typeof apply>>
    await check('preview is read-only and lists retained historical Goals with stable identities', async () => {
      const bytes = readFileSync(workspace.filePath, 'utf8')
      firstMigration = await apply(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
      assert.equal(firstMigration.preview.canApply, true)
      assert(firstMigration.preview.preservedGoalIds.includes(first.goal.id))
      assert.equal(firstMigration.preview.recordedGoalCount, 1)
      assert(firstMigration.preview.preservedWorkItemIds.includes(orphan.id))
      assert.equal(readFileSync(workspace.filePath, 'utf8'), bytes)
      assert.deepEqual(await snapshotTask(first.meta.id, first.goal.id), firstBefore)
    })
    await check('legacy approved Mission, child roles and persisted Run survive migration unchanged', async () => {
      const result = await workspace.applyInstitutionMigration(projectId, firstMigration.input)
      assert.equal(result.replayed, false)
      assert.deepEqual(result.workspace.institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
      assert.deepEqual(result.workspace.permissionPolicy, originalWorkspace.permissionPolicy)
      assert.deepEqual(result.workspace.budgetPolicy, originalWorkspace.budgetPolicy)
      assert.deepEqual(await snapshotTask(first.meta.id, first.goal.id), firstBefore)
      await coordinator.requireApprovedVersion(first.meta.id, first.plan.currentVersion!)
      await coordinator.assertExecution(first.meta, 'continue historical Mission')
      const source = await buildCanonicalMissionTaskPlan(first.meta, { expectedGoalRevision: first.goal.revision }, root)
      assert.equal(source.institutionTemplate, undefined)
      assert.equal(source.missionSource!.inputDigest, first.plan.currentVersion!.missionSource!.inputDigest)
    })
    await check('same preview replay is idempotent without workspace revision or event duplication', async () => {
      const before = await workspace.exportManifest(projectId)
      const result = await workspace.applyInstitutionMigration(projectId, firstMigration.input)
      assert.equal(result.replayed, true)
      const after = await workspace.exportManifest(projectId)
      assert.equal(after.workspace.revision, before.workspace.revision)
      assert.deepEqual(after.events, before.events)
      assert.equal(after.events.filter(event => event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT).length, 1)
    })
    await check('legacy WorkItem without a Goal preserves its own prior institution interpretation', async () => {
      assert.deepEqual((await readGoalInstitutionContext(root, projectId, undefined, orphan.id)).template, LEGACY_PROJECT_INSTITUTION_TEMPLATE)
      assert.deepEqual(await enrichCanonicalTaskPlanInstitutions(orphanMeta, orphanDraft, root), orphanBefore)
      assert.deepEqual(await reads.getWorkItem(orphan.id), orphan)
    })

    const second = await createGoal('cabinet')
    const secondBefore = await snapshotTask(second.meta.id, second.goal.id)
    await check('new Goal adopts cabinet while the legacy Goal keeps legacy across both plan builders', async () => {
      assert.deepEqual(second.plan.currentVersion!.institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
      assert.deepEqual(second.plan.currentVersion!.steps.map(step => step.institution!.id), ['hanlinyuan', 'gongbu', 'libu_ritual', 'duchayuan'])
      const draft = { objective: '制作文档', steps: [{ id: 'docs', title: '制作文档', executionRole: 'docs' as const }] }
      assert.equal((await enrichCanonicalTaskPlanInstitutions(first.meta, draft, root)).institutionTemplate, undefined)
      assert.deepEqual((await enrichCanonicalTaskPlanInstitutions(second.meta, draft, root)).institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
      assert.deepEqual((await readGoalInstitutionContext(root, projectId, first.goal.id)).template, LEGACY_PROJECT_INSTITUTION_TEMPLATE)
      assert.deepEqual((await readGoalInstitutionContext(root, projectId, second.goal.id)).template, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    })
    await check('second migration keeps the intermediate cabinet Goal and both approved plans executable', async () => {
      const next = await apply(LEGACY_PROJECT_INSTITUTION_TEMPLATE)
      assert.deepEqual([...next.preview.preservedGoalIds].sort(), [first.goal.id, second.goal.id].sort())
      await workspace.applyInstitutionMigration(projectId, next.input)
      assert.deepEqual(await snapshotTask(first.meta.id, first.goal.id), firstBefore)
      assert.deepEqual(await snapshotTask(second.meta.id, second.goal.id), secondBefore)
      const manifest = await workspace.exportManifest(projectId)
      const events = [...manifest.events].reverse() // Resolver must sort by revision, not caller order.
      assert.deepEqual(resolveGoalInstitutionTemplate(manifest.workspace, events, first.goal.id), LEGACY_PROJECT_INSTITUTION_TEMPLATE)
      assert.deepEqual(resolveGoalInstitutionTemplate(manifest.workspace, events, second.goal.id), DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
      await coordinator.assertExecution(first.meta, 'continue legacy Goal')
      await coordinator.assertExecution(second.meta, 'continue intermediate Goal')
      await coordinator.requireApprovedVersion(second.meta.id, second.plan.currentVersion!)
      assert.deepEqual(approvedTaskPlanToDag(second.meta.id, plans.get(second.meta.id).currentVersion!, plans.get(second.meta.id).projection),
        approvedTaskPlanToDag(second.meta.id, second.plan.currentVersion!, second.plan.projection))
    })
    const third = await createGoal('latest-legacy')
    await check('Goal created after second migration uses the current legacy template', async () => {
      assert.equal(third.plan.currentVersion!.institutionTemplate, undefined)
      assert(third.plan.currentVersion!.steps.every(step => step.institution === undefined))
      assert.deepEqual((await readGoalInstitutionContext(root, projectId, third.goal.id)).template, LEGACY_PROJECT_INSTITUTION_TEMPLATE)
    })
    await check('project slice import retains all template generations and rejects corrupt migration payload atomically', async () => {
      const manifest = await workspace.exportManifest(projectId)
      const importedRoot = join(root, 'imported-institutions')
      const imported = await openProjectWorkspaceStore(importedRoot)
      await imported.importProjectSlice(manifest)
      const reloaded = await imported.getState()
      assert.deepEqual(reloaded.events.filter(event => event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT),
        manifest.events.filter(event => event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT))
      for (const [goalId, template] of [
        [first.goal.id, LEGACY_PROJECT_INSTITUTION_TEMPLATE],
        [second.goal.id, DEFAULT_PROJECT_INSTITUTION_TEMPLATE],
        [third.goal.id, LEGACY_PROJECT_INSTITUTION_TEMPLATE]
      ] as const) {
        assert.deepEqual((await readGoalInstitutionContext(importedRoot, projectId, goalId)).template, template)
      }
      assert.deepEqual((await readGoalInstitutionContext(importedRoot, projectId, undefined, orphan.id)).template, LEGACY_PROJECT_INSTITUTION_TEMPLATE)

      const corrupt = structuredClone(manifest)
      corrupt.events.find(event => event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT)!.payload.scope = 'all_goals'
      const rejected = await openProjectWorkspaceStore(join(root, 'rejected-institutions'))
      await rejected.createWorkspace({ id: 'existing-destination', name: 'Preserve destination bytes' })
      const beforeState = await rejected.getState()
      const beforeBytes = readFileSync(rejected.filePath, 'utf8')
      await assert.rejects(rejected.importProjectSlice(corrupt), /机构迁移记录损坏/)
      assert.deepEqual(await rejected.getState(), beforeState)
      assert.equal(readFileSync(rejected.filePath, 'utf8'), beforeBytes)
      assert.equal(await rejected.getWorkspace(projectId), undefined)
    })
    await check('new Goal or changed WorkItem invalidates an old preview without partial application', async () => {
      const goalPreview = await apply(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
      const added = await commands.createGoal({ id: 'goal-preview-drift', projectId, title: 'preview drift', objective: '新增目标' })
      const before = await workspace.exportManifest(projectId)
      await assert.rejects(workspace.applyInstitutionMigration(projectId, goalPreview.input), /预览|变化|过期|stale|digest/)
      const after = await workspace.exportManifest(projectId)
      assert.equal(after.workspace.revision, before.workspace.revision)
      assert.deepEqual(after.events, before.events)
      const item = await commands.createWorkItem({ projectId, goalId: added.id, title: '保留任务', type: 'custom', businessLineId: 'studio' })
      const itemPreview = await apply(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
      await commands.updateWorkItem(item.id, { description: 'changed after preview' }, { expectedRevision: item.revision })
      await assert.rejects(workspace.applyInstitutionMigration(projectId, itemPreview.input), /预览|变化|过期|stale|digest/)
      assert.deepEqual((await workspace.getWorkspace(projectId))!.institutionTemplate, LEGACY_PROJECT_INSTITUTION_TEMPLATE)
    })
    await check('historical template retention does not bypass actual resource or Goal changes', async () => {
      const current = (await workspace.getWorkspace(projectId))!
      await workspace.updateWorkspace(projectId, { resources: [] }, { expectedRevision: current.revision })
      await assert.rejects(coordinator.requireApprovedVersion(first.meta.id, first.plan.currentVersion!), /资料或策略已变化/)
      await assert.rejects(coordinator.requireApprovedVersion(second.meta.id, second.plan.currentVersion!), /资料或策略已变化/)
      await commands.updateGoal(third.goal.id, { constraints: ['changed constraint'] }, { expectedRevision: third.goal.revision })
      await assert.rejects(coordinator.requireApprovedVersion(third.meta.id, third.plan.currentVersion!), /revision|变化/)
      assert.equal(plans.get(first.meta.id).approvedDigest, first.plan.approvedDigest)
      assert.equal(plans.get(second.meta.id).approvedDigest, second.plan.approvedDigest)
    })
    assert.equal(providerCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    const failed = checks.filter(check => check.status === 'failed')
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), status: failed.length ? 'failed' : 'passed',
      providerCalls, checks, limitations: ['Real workspace, canonical task, plan and Run stores with a controlled Engine boundary.', 'Checks migration and execution authorization only; no Provider request, UI interaction or human acceptance.'] }, null, 2) + '\n')
    rmSync(root, { recursive: true, force: true })
    console.log(`Project institution migration: ${checks.length - failed.length}/${checks.length} passed\n${reportPath}`)
    if (failed.length) process.exitCode = 1
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
