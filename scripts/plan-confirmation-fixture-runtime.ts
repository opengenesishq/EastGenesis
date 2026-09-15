import { mkdir } from 'node:fs/promises'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { syncTaskPlanLedger } from '../src/main/task/task-plan-ledger'
import { ensureSupervisorRunBinding } from '../src/main/task/supervisor-taskrun-bridge'
import { SupervisorStateStore } from '../src/main/task/supervisor-state'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { createTaskRun } from '../src/main/task/task-run'
import type { SessionMeta } from '../src/shared/types'

const rootDir = process.argv[2]
if (!rootDir) throw new Error('usage: tsx scripts/plan-confirmation-fixture-runtime.ts <user-data-root>')

const now = Date.now()
const projectId = 'fixture-plan-confirmation-project'
const goalId = 'fixture-plan-confirmation-goal'
const workItemId = 'fixture-plan-confirmation-work-item'
const sessionId = 'fixture-plan-confirmation-session'
const runId = 'fixture-plan-confirmation-run'

async function main(): Promise<void> {
  await mkdir(rootDir, { recursive: true })
  const workspace = await openProjectWorkspaceStore(rootDir)
  await workspace.createWorkspace({
    id: projectId,
    name: 'Plan Confirmation 本地验证夹具',
    kind: 'opc',
    ownerId: 'fixture-local-user',
    createdAt: now,
    updatedAt: now
  })
  const commands = await openProjectWorkspaceCommandService(rootDir)
  const goal = await commands.createGoal({
    id: goalId,
    projectId,
    title: 'Plan Confirmation canonical fixture',
    objective: '验证 Run 入口可打开 pending 计划，并通过本地 IPC 完成审批和撤销。',
    constraints: ['仅本地 fixture', '不得调用 Provider'],
    successCriteria: ['pending 计划可见', '审批状态可回读', '撤销恢复 pending'],
    forbiddenActions: ['外部 Provider 调用'],
    riskLevel: 'high',
    status: 'waiting_approval',
    createdBy: 'plan-confirmation-ui-fixture',
    acceptance: [{ id: 'fixture-plan-acceptance', criterion: '计划确认入口可复查', required: true }]
  })
  const item = await commands.createWorkItem({
    id: workItemId,
    projectId,
    goalId: goal.id,
    businessLineId: 'studio',
    type: 'planning',
    title: '待确认的本地执行计划',
    description: 'Local-only pending TaskPlan WorkItem.',
    status: 'waiting_approval',
    owner: { type: 'digital_worker', id: 'fixture-worker', displayName: 'Fixture Worker' },
    acceptanceSpec: [{ id: 'fixture-plan-work-item-acceptance', criterion: 'TaskPlan pending 状态可见', required: true }]
  })

  const taskRun = createTaskRun({
    id: runId,
    sessionId,
    taskId: 'fixture-plan-confirmation-task',
    digitalWorkerBinding: { kind: 'unscoped' },
    now
  })
  const meta = {
    id: sessionId,
    title: item.title,
    cwd: rootDir,
    childTaskId: taskRun.taskId,
    workspaceId: projectId,
    projectId,
    goalId,
    workItemId: item.id,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    engine: 'openai',
    digitalWorkerBinding: { kind: 'unscoped' },
    taskStrategy: 'plan',
    permissionMode: 'plan',
    status: 'starting',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    contextPressure: 'normal',
    createdAt: now
  } as SessionMeta
  const snapshot = await saveTaskSnapshot(buildTaskSnapshot({
    meta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: taskRun,
    now
  }), rootDir)
  const supervisorStore = new SupervisorStateStore(rootDir)
  const binding = await ensureSupervisorRunBinding(meta, taskRun, { rootDir, store: supervisorStore })
  if (binding.disposition !== 'attached' && binding.disposition !== 'existing') {
    throw new Error(`expected canonical TaskRun binding, got ${binding.disposition}`)
  }

  const planStore = new TaskPlanContractStore(() => rootDir)
  const plan = planStore.createVersion({
    sessionId,
    workspaceId: projectId,
    goalId,
    workItemId
  }, {
    objective: '在用户确认后执行本地计划。',
    steps: [{
      id: 'inspect',
      title: '检查本地计划边界',
      description: '只读 fixture step',
      dependsOn: [],
      expectedArtifacts: ['本地检查记录'],
      dataEgress: ['无'],
      estimatedCostUsd: null,
      riskLevel: 'medium'
    }],
    expectedArtifacts: ['本地计划确认回执'],
    dataEgress: ['无'],
    estimatedCostUsd: null,
    riskLevel: 'high',
    acceptanceCriteria: ['审批前保持 pending', '撤销后恢复 pending'],
    source: 'genesis'
  }, 'agent')
  await syncTaskPlanLedger(rootDir, plan)
  if (plan.approvalStatus !== 'pending') throw new Error('fixture TaskPlan did not remain pending')
  console.log(JSON.stringify({
    status: 'passed',
    kind: 'caogen.plan-confirmation-ui-fixture',
    projectId,
    goalId,
    workItemId,
    sessionId,
    runId,
    snapshotId: snapshot.id,
    planStatus: plan.approvalStatus,
    providerCalls: false
  }, null, 2))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
