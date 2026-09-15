#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import assert from 'node:assert/strict'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'plan-confirmation-contract')
const reportPath = path.join(outputRoot, 'latest.json')
const rootDir = mkdtempSync(path.join(tmpdir(), 'caogen-plan-confirmation-'))
const sessionId = 'plan-confirmation-session-v2'
const projectId = 'plan-confirmation-project-v2'
const goalId = 'plan-confirmation-goal-v2'
const parentWorkItemId = 'plan-confirmation-parent-v2'
const actorId = 'local-user:plan-confirmation-fixture'
const checks = []

const {
  openProjectWorkspaceCommandService,
} = await import('../src/main/project-workspace/command-service.ts')
const { createProjectWorkspaceReadService } = await import('../src/main/project-workspace/canonical-read-service.ts')
const { TaskPlanContractStore } = await import('../src/main/task/task-plan-contract-store.ts')
const { TaskPlanCanonicalProjector, projectedWorkItemId } = await import('../src/main/task/task-plan-canonical-projection.ts')
const { syncTaskPlanLedger, countTaskPlanLedgerForSession } = await import('../src/main/task/task-plan-ledger.ts')

const report = {
  schemaVersion: 1,
  kind: 'caogen.plan-confirmation-contract-report',
  requirement: 'V2-002',
  gate: 'test:plan-confirmation:required',
  runId,
  status: 'running',
  rootDir: '<temporary fixture removed after run>',
  checks,
  coverage: {
    verified: [],
    explicitlyNotVerified: [
      '真实 Provider 调用和真实用户审批',
      'Electron renderer 视觉与点击路径',
      '跨设备或远程多用户审批'
    ]
  }
}

try {
  const commands = await openProjectWorkspaceCommandService(rootDir)
  const workspaceStore = await import('../src/main/project-workspace/store.ts').then(({ openProjectWorkspaceStore }) =>
    openProjectWorkspaceStore(rootDir))
  await workspaceStore.createWorkspace({
    id: projectId,
    name: '计划确认契约府',
    kind: 'opc',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const goal = await commands.createGoal({
    id: goalId,
    projectId,
    title: '计划确认契约目标',
    objective: '验证太子计划在用户确认后才能生成 canonical 依赖关系。',
    constraints: ['未经确认不得执行', '依赖必须无环且可回写'],
    successCriteria: ['审批状态可持久化', '依赖关系与计划一致'],
    forbiddenActions: ['绕过用户审批直接执行'],
    riskLevel: 'high',
    status: 'planned',
    createdBy: 'plan-confirmation-contract',
    acceptance: [{ id: 'plan-confirmation-goal-acceptance', criterion: '计划确认契约可复查', required: true }]
  })
  const parent = await commands.createWorkItem({
    id: parentWorkItemId,
    projectId,
    goalId: goal.id,
    businessLineId: 'studio',
    type: 'custom',
    title: '产品发布父任务',
    description: '承载已确认计划的 canonical WorkItem。',
    status: 'ready',
    owner: { type: 'digital_worker', id: 'plan-confirmation-owner', displayName: 'Plan Confirmation' },
    acceptanceSpec: [{ id: 'parent-acceptance', criterion: '父任务具备计划确认记录', required: true }]
  })

  const store = new TaskPlanContractStore(() => rootDir)
  const projector = new TaskPlanCanonicalProjector(() => rootDir)
  const binding = { sessionId, workspaceId: projectId, goalId: goal.id, workItemId: parent.id }
  const firstDraft = draft({
    titleSuffix: '初版',
    dependencies: {
      research: [],
      build: ['research'],
      verify: ['build'],
      proof: ['verify']
    }
  })

  const initial = store.get(sessionId)
  check('初始计划状态为 not_created', initial.approvalStatus === 'not_created' && !initial.currentVersion)
  const pending = store.createVersion(binding, firstDraft, 'agent')
  await syncTaskPlanLedger(rootDir, pending)
  check('生成太子计划后必须等待确认', pending.approvalStatus === 'pending' && pending.currentVersion?.version === 1)
  assert.throws(() => store.assertExecutionAuthorized(sessionId, true), /尚未批准|执行授权/)
  check('未确认计划无法获得执行授权', true)

  const version1 = pending.currentVersion
  assert(version1)
  const projection1 = await projector.project(version1)
  const approved = store.approve(sessionId, {
    version: version1.version,
    digest: version1.digest,
    reason: '用户确认本周产品发布拆解'
  }, projection1, actorId)
  await syncTaskPlanLedger(rootDir, approved)
  check('确认事件绑定当前版本摘要和审批主体', approved.approvalStatus === 'approved' &&
    approved.approvedVersion === version1.version &&
    approved.approvedDigest === version1.digest &&
    approved.approvalEvents.at(-1)?.actorId === actorId)
  check('确认后生成 canonical WorkItem 投影回执', approved.projection?.mode === 'canonical' &&
    approved.projection.steps.length === version1.steps.length)

  const reads = createProjectWorkspaceReadService(rootDir, 'canonical')
  const projected1 = await reads.listWorkItems(projectId)
  const projectedById1 = new Map(projected1.map((item) => [item.id, item]))
  for (const step of version1.steps) {
    const item = projectedById1.get(projectedWorkItemId(sessionId, step.id))
    assert(item, `missing projected WorkItem for ${step.id}`)
    assert.deepEqual(item.dependencyIds, step.dependsOn.map((id) => projectedWorkItemId(sessionId, id)))
    assert.equal(item.parentId, parent.id)
  }
  check('确认后的依赖关系逐项回写 canonical WorkItem 且保持父任务归属', true)
  check('canonical WorkItem 依赖关系无环', acyclic(projected1.filter((item) => item.parentId === parent.id)))

  assert.throws(() => store.approve(sessionId, { version: 1, digest: `sha256:${'0'.repeat(64)}` }), /摘要|版本/)
  check('过期或篡改摘要无法确认计划', true)

  const secondDraft = draft({
    titleSuffix: '修订版',
    dependencies: {
      research: [],
      build: ['research'],
      verify: ['research'],
      proof: ['build', 'verify']
    },
    changeReason: '用户确认后补充并行验证依赖'
  })
  const revised = store.createVersion(binding, secondDraft, 'agent')
  await syncTaskPlanLedger(rootDir, revised)
  check('计划改版会使旧确认失效并回到 pending', revised.approvalStatus === 'pending' &&
    revised.currentVersion?.version === 2 &&
    revised.approvalEvents.at(-1)?.kind === 'superseded')
  assert.throws(() => store.assertExecutionAuthorized(sessionId, true), /尚未批准|执行授权/)
  check('旧确认不能授权新计划执行', true)
  const version2 = revised.currentVersion
  assert(version2)
  const projection2 = await projector.project(version2, revised.projection)
  const approved2 = store.approve(sessionId, {
    version: version2.version,
    digest: version2.digest,
    reason: '用户确认修订后的依赖关系'
  }, projection2, actorId)
  await syncTaskPlanLedger(rootDir, approved2)
  check('修订版重新确认后恢复 approved', approved2.approvalStatus === 'approved' &&
    approved2.approvedVersion === 2 && approved2.projection?.steps.length === version2.steps.length)

  const projected2 = await reads.listWorkItems(projectId)
  const projectedById2 = new Map(projected2.map((item) => [item.id, item]))
  assert.deepEqual(
    projectedById2.get(projectedWorkItemId(sessionId, 'proof'))?.dependencyIds,
    ['build', 'verify'].map((id) => projectedWorkItemId(sessionId, id))
  )
  check('修订版依赖回写反映最新计划且没有残留旧依赖', true)

  assert.throws(() => store.createVersion(binding, draft({
    titleSuffix: '循环版',
    dependencies: { research: ['proof'], build: ['research'], verify: ['build'], proof: ['verify'] },
    changeReason: '契约负例'
  }), 'agent'), /循环/)
  check('循环依赖在计划版本创建阶段被拒绝', true)

  const restarted = new TaskPlanContractStore(() => rootDir).get(sessionId)
  check('重启后仍可读回最新确认状态和依赖投影', restarted.approvalStatus === 'approved' &&
    restarted.approvedDigest === version2.digest &&
    restarted.projection?.mode === 'canonical')
  const ledgerCount = await countTaskPlanLedgerForSession(rootDir, sessionId)
  check('计划版本和审批事件已同步到 Workflow Ledger', ledgerCount >= 5)

  report.coverage.verified = [
    '太子计划版本生成后默认 pending',
    '未确认计划 fail-closed，不能获得执行授权',
    '审批事件绑定版本号、摘要、投影回执和审批主体',
    '审批后 canonical WorkItem 依赖关系回写且保持 DAG',
    '计划改版自动 supersede 旧审批，旧审批不能授权新版本',
    '循环依赖拒绝和重启读回',
    'TaskPlan 版本与审批事件同步到 Workflow Ledger'
  ]
  report.status = checks.every((item) => item.status === 'passed') ? 'passed' : 'failed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  mkdirSync(outputRoot, { recursive: true })
  report.finishedAt = new Date().toISOString()
  report.summary = {
    passedChecks: checks.filter((item) => item.status === 'passed').length,
    totalChecks: checks.length
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  rmSync(rootDir, { recursive: true, force: true })
}

function draft({ titleSuffix, dependencies, changeReason }) {
  return {
    objective: '在用户确认后生成可执行的产品发布计划与 canonical 依赖关系。',
    steps: Object.entries(dependencies).map(([id, dependsOn]) => ({
      id,
      title: `${id}：产品发布${titleSuffix}`,
      description: `太子计划步骤 ${id}`,
      dependsOn,
      expectedArtifacts: [`${id} 结果`],
      dataEgress: ['仅限已授权 Provider'],
      estimatedCostUsd: null,
      riskLevel: 'medium'
    })),
    expectedArtifacts: ['产品发布包', '依赖关系回执'],
    dataEgress: ['仅限已授权 Provider'],
    estimatedCostUsd: null,
    riskLevel: 'high',
    acceptanceCriteria: ['每个步骤按依赖顺序执行', '依赖关系与 canonical WorkItem 一致'],
    ...(changeReason ? { changeReason } : {}),
    source: 'genesis'
  }
}

function check(name, passed) {
  checks.push({ name, status: passed ? 'passed' : 'failed' })
  if (!passed) throw new Error(`契约失败：${name}`)
}

function acyclic(items) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencyIds ?? []) {
      if (!visit(dependency)) return false
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }
  return items.every((item) => visit(item.id))
}
