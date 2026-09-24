import { mkdir } from 'node:fs/promises'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { ensureSupervisorRunBinding } from '../src/main/task/supervisor-taskrun-bridge'
import { SupervisorStateStore } from '../src/main/task/supervisor-state'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'
import { saveWorkflowAcceptance } from '../src/main/task/workflow-ledger-api'

/**
 * Seed a disposable, local-only canonical aggregate for the Runs/Review UI
 * smoke. This creates ProjectWorkspace/Goal/WorkItem/Supervisor rows through
 * their production command boundaries and never dispatches a Provider.
 */
const rootDir = process.argv[2]
if (!rootDir) throw new Error('usage: tsx scripts/runs-review-fixture-runtime.ts <user-data-root>')

const now = Date.now()
const projectId = 'fixture-runs-review-project'
const goalId = 'fixture-runs-review-goal'
const runWorkItemId = 'fixture-runs-review-run-item'
const reviewWorkItemId = 'fixture-runs-review-review-item'
const runId = 'fixture-runs-review-task-run'
const recoveryWorkItemId = 'fixture-runs-review-recovery-item'
const recoveryRunId = 'fixture-runs-review-recovery-run'

async function main(): Promise<void> {
await mkdir(rootDir, { recursive: true })
const workspace = await openProjectWorkspaceStore(rootDir)
await workspace.createWorkspace({
  id: projectId,
  name: 'Runs Review 本地验证夹具',
  kind: 'opc',
  ownerId: 'fixture-local-user',
  createdAt: now,
  updatedAt: now
})
const commands = await openProjectWorkspaceCommandService(rootDir)
const goal = await commands.createGoal({
  id: goalId,
  projectId,
  title: 'Runs/Review canonical fixture',
  objective: '验证全局 Runs 与 Review 使用 canonical 数据投影。',
  constraints: ['仅本地 fixture', '不得调用 Provider'],
  successCriteria: ['Runs 可读取 TaskRun-owned Supervisor row', 'Review 可读取失败验收 WorkItem'],
  forbiddenActions: ['外部 Provider 调用'],
  riskLevel: 'low',
  status: 'planned',
  createdBy: 'runs-review-ui-fixture',
  acceptance: [{ id: 'fixture-goal-acceptance', criterion: 'Runs/Review 投影可复查', required: true }]
})
const runItem = await commands.createWorkItem({
  id: runWorkItemId,
  projectId,
  goalId: goal.id,
  businessLineId: 'studio',
  type: 'testing',
  title: 'Canonical TaskRun fixture',
  description: 'Local-only TaskRun-owned Supervisor projection.',
  status: 'ready',
  owner: { type: 'digital_worker', id: 'fixture-worker', displayName: 'Fixture Worker' },
  acceptanceSpec: [{ id: 'fixture-run-acceptance', criterion: 'TaskRun projection exists', required: true }]
})
const reviewItem = await commands.createWorkItem({
  id: reviewWorkItemId,
  projectId,
  goalId: goal.id,
  businessLineId: 'studio',
  type: 'review',
  title: 'Failed acceptance fixture',
  description: 'Local-only WorkItem requiring delivery review.',
  status: 'verifying',
  owner: { type: 'digital_worker', id: 'fixture-reviewer', displayName: 'Fixture Reviewer' },
  acceptanceSpec: [{ id: 'fixture-review-acceptance', criterion: 'Delivery review is visible', required: true }]
})
await commands.setWorkItemAcceptance(reviewItem.id, {
  status: 'failed',
  evidenceRefs: ['fixture-evidence-review'],
  verifiedBy: 'runs-review-ui-fixture',
  verifiedAt: now
})

const taskRun: TaskRunRecord = {
  schemaVersion: 1,
  id: runId,
  sessionId: 'fixture-runs-review-session',
  taskId: 'fixture-runs-review-task',
  status: 'queued',
  revision: 1,
  attempt: 1,
  recoveryCount: 0,
  digitalWorkerBinding: { kind: 'unscoped' },
  createdAt: now,
  updatedAt: now
}
const meta: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'> = {
  id: taskRun.sessionId,
  workspaceId: projectId,
  goalId,
  workItemId: runItem.id
}
await saveTaskSnapshot(buildTaskSnapshot({
  meta: {
    ...meta,
    title: runItem.title,
    cwd: rootDir,
    childTaskId: taskRun.taskId,
    engine: 'openai',
    model: 'fixture-model',
    providerId: 'fixture-provider',
    taskStrategy: 'plan',
    permissionMode: 'plan',
    digitalWorkerBinding: { kind: 'unscoped' },
    status: 'starting',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: now
  } as SessionMeta,
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
const [runs, workItems] = await Promise.all([
  supervisorStore.listRuns(),
  workspace.listWorkItems(undefined, { includeArchived: true })
])
const seededRun = runs.find((candidate) => candidate.id === runId)
const seededReview = workItems.find((candidate) => candidate.id === reviewWorkItemId)
if (seededRun?.origin !== 'task_run') throw new Error('fixture Supervisor row is not TaskRun-owned')
if (seededReview?.acceptance?.status !== 'failed') throw new Error('fixture Review WorkItem acceptance is not failed')

const recoveryItem = await commands.createWorkItem({
  id: recoveryWorkItemId,
  projectId,
  goalId,
  businessLineId: 'studio',
  type: 'testing',
  title: 'Failed Run recovery fixture',
  description: 'Local-only failed Run with a canonical recovery snapshot.',
  status: 'failed',
  owner: { type: 'digital_worker', id: 'fixture-recovery-worker', displayName: 'Fixture Recovery Worker' },
  acceptanceSpec: [{ id: 'fixture-recovery-acceptance', criterion: 'Recovery remains locally actionable', required: true }]
})
await commands.setWorkItemAcceptance(recoveryItem.id, {
  status: 'failed',
  evidenceRefs: [],
  verifiedBy: 'runs-review-ui-fixture',
  verifiedAt: now
})
await saveWorkflowAcceptance({
  id: 'fixture-runs-review-recovery-acceptance',
  projectId,
  goalId,
  workItemId: recoveryItem.id,
  criteria: ['Recovery remains locally actionable'],
  status: 'pending',
  evidenceRefs: []
}, rootDir, { caller: 'system', actorId: 'runs-review-ui-fixture' })
const recoveryRun: TaskRunRecord = {
  schemaVersion: 1,
  id: recoveryRunId,
  sessionId: 'fixture-runs-review-recovery-session',
  taskId: 'fixture-runs-review-recovery-task',
  status: 'failed',
  revision: 2,
  attempt: 1,
  recoveryCount: 0,
  error: 'fixture failure; recovery is local-only',
  digitalWorkerBinding: { kind: 'unscoped' },
  createdAt: now,
  updatedAt: now + 1
}
const recoveryMeta: SessionMeta = {
  ...({
    id: recoveryRun.sessionId,
    title: recoveryItem.title,
    cwd: rootDir,
    childTaskId: recoveryRun.taskId,
    engine: 'openai',
    workspaceId: projectId,
    goalId,
    workItemId: recoveryItem.id,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    taskStrategy: 'plan',
    permissionMode: 'plan',
    digitalWorkerBinding: { kind: 'unscoped' },
    status: 'error',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: now
  } as SessionMeta)
}
await saveTaskSnapshot(buildTaskSnapshot({
  meta: recoveryMeta,
  transcript: [],
  lastSeq: 0,
  eventCount: 0,
  reason: 'created',
  run: recoveryRun,
  now
}), rootDir)
const recoveryBinding = await ensureSupervisorRunBinding(recoveryMeta, recoveryRun, { rootDir, store: supervisorStore })
if (recoveryBinding.disposition !== 'attached' && recoveryBinding.disposition !== 'existing') {
  throw new Error(`expected recovery fixture binding, got ${recoveryBinding.disposition}`)
}
await saveWorkflowAcceptance({
  id: 'fixture-runs-review-recovery-acceptance',
  projectId,
  goalId,
  workItemId: recoveryItem.id,
  criteria: ['Recovery remains locally actionable'],
  status: 'verifying',
  evidenceRefs: [],
  revision: 2
}, rootDir, { caller: 'system', actorId: 'runs-review-ui-fixture' })
await saveWorkflowAcceptance({
  id: 'fixture-runs-review-recovery-acceptance',
  projectId,
  goalId,
  workItemId: recoveryItem.id,
  criteria: ['Recovery remains locally actionable'],
  status: 'failed',
  evidenceRefs: [],
  revision: 3,
  verifier: 'runs-review-ui-fixture',
  verifiedAt: now
}, rootDir, { caller: 'system', actorId: 'runs-review-ui-fixture' })
console.log(JSON.stringify({
  status: 'passed',
  kind: 'caogen.runs-review-ui-fixture',
  projectId,
  goalId,
  runId,
  reviewWorkItemId,
  runOrigin: seededRun.origin,
  reviewAcceptance: seededReview.acceptance.status,
  recoveryRunId,
  recoveryWorkItemId,
  providerCalls: false
}, null, 2))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
