import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Engine } from '../src/main/engine'
import type { SessionMeta, TaskPlanStateView } from '../src/shared/types'
import { sessionManager } from '../src/main/sessionManager'
import { TaskPlanSessionCoordinator } from '../src/main/task/task-plan-session-coordinator'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { approvedTaskPlanToDag } from '../src/main/task/task-plan-dag'
import { createSessionTaskRun } from '../src/main/task/task-run'
import { sealFrozenRoutingPolicy } from '../src/main/task/frozen-routing-policy'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { registerTerminalMutationIpc } from '../src/main/ipc/terminal-mutation-ipc'
import { registerInteractiveMutationIpc } from '../src/main/ipc/interactive-mutation-handlers'
import { ipcMain } from 'electron'
import { assertTrustedWorkflowLedgerSender } from '../src/main/ipc/workflow-ledger-handlers'

const root = process.argv[2]
const checks: string[] = []
let providerCalls = 0
globalThis.fetch = async () => { providerCalls++; throw new Error('network forbidden') }
// Node resolves __dirname through macOS's /var -> /private/var symlink.
// Use that same canonical path for the production file-renderer trust check.
const trustedRendererUrl = new URL('../renderer/index.html', pathToFileURL(realpathSync(process.argv[1])).href).href
const trustedSender = { id: 9001, isDestroyed: () => false, mainFrame: { url: trustedRendererUrl } }
;(globalThis as typeof globalThis & { __caogenTrustedSender?: typeof trustedSender }).__caogenTrustedSender = trustedSender
const trustedEvent = { sender: trustedSender, senderFrame: trustedSender.mainFrame }
const sessions = new Map<string, Engine>()
const coordinator = new TaskPlanSessionCoordinator((id) => sessions.get(id), () => root)
const store = new TaskPlanContractStore(() => root)
const manager: any = Object.create(Object.getPrototypeOf(sessionManager))
manager.sessions = sessions
manager.taskPlans = coordinator
manager.taskRuns = new Map()
manager.dagSchedulers = new Map()
manager.dagExecutionSnapshots = new Map()
manager.dagAutoMergeOptions = new Map()
manager.council = { loadSnapshots: async () => {}, snapshots: () => [], stopForParent: async () => {} }
manager.dagFinalizationCoordinator = { hasIncomplete: () => false }
manager.agentCapacity = { tryReserve: () => () => {} }
manager.emitTaskDagUpdate = () => {}
manager.persistDagProvisioning = async () => {}
manager.acknowledgeSessionCreation = () => {}
manager.finishTaskDag = async () => {}
let provisioned = 0
let prompts = 0
manager.createManaged = async (input: Partial<SessionMeta>) => {
  provisioned++
  const meta = { ...input, id: `provisioned-${provisioned}` } as SessionMeta
  return meta
}
manager.send = async () => { prompts++; return true }

async function fixture(id: string) {
  const workspace = await openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id, name: id, kind: 'opc', resources: [{ id: 'brief', kind: 'directory', label: 'brief', path: '/fixture' }] })
  const commands = await openProjectWorkspaceCommandService(root)
  const goal = await commands.createGoal({ id: `${id}-goal`, projectId: id, title: 'Mission', objective: 'Deliver a reviewable project', status: 'planned', constraints: ['Keep data local'], successCriteria: ['交付物：code and docs'] })
  const parent = await commands.createWorkItem({ id: `${id}-parent`, projectId: id, goalId: goal.id, businessLineId: 'studio', title: 'Mission parent', status: 'ready' })
  const meta = { id: `${id}-session`, projectId: id, workspaceId: id, goalId: goal.id, workItemId: parent.id,
    businessLineId: 'studio', taskStrategy: 'plan', status: 'idle', engine: 'openai', model: 'fixture-model',
    providerId: 'fixture-provider', routingScope: 'fixed', permissionMode: 'default', cwd: process.cwd(), createdAt: 1,
    digitalWorkerBinding: { kind: 'unscoped' },
    costUsd: 0, contextTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, title: 'Mission' } as SessionMeta
  let engineSends = 0
  const engine = { meta, setTaskStrategy: async (strategy: SessionMeta['taskStrategy']) => { meta.taskStrategy = strategy },
    send: () => { engineSends++ }, rejectSend: (error: string) => { meta.lastError = error } } as unknown as Engine
  sessions.set(meta.id, engine)
  let plan = await coordinator.compileMission(meta.id, { expectedGoalRevision: goal.revision })
  plan = await coordinator.approve(meta.id, plan.currentVersion!)
  await coordinator.setStrategy(meta.id, 'execute')
  return { workspace, commands, goal, parent, meta, engine, plan, engineSends: () => engineSends }
}

async function main(): Promise<void> {
  assertTrustedWorkflowLedgerSender(trustedEvent)
  assert.throws(() => assertTrustedWorkflowLedgerSender({ ...trustedEvent, senderFrame: { url: trustedRendererUrl } }), /not trusted/)
  const first = await fixture('source-goal')
  const childMeta = { ...first.meta, id: 'source-child', parentSessionId: first.meta.id, workItemId: first.plan.projection!.steps[0].workItemId }
  const child = { meta: childMeta } as Engine
  sessions.set(childMeta.id, child)
  assert.equal(await coordinator.authorizeSend(first.engine), true)
  assert.equal(await coordinator.authorizeSend(child), true)
  checks.push('parent and child use the owning Mission source, not the child WorkItem as its source')

  const childPlan = store.createVersion({ sessionId: childMeta.id }, { objective: 'Child plan', steps: [{ id: 'step', title: 'Child work' }], acceptanceCriteria: ['Review'] }, 'local-user')
  store.approve(childMeta.id, childPlan.currentVersion!)
  await first.commands.updateGoal(first.goal.id, { constraints: ['Changed after execute'] }, { expectedRevision: first.goal.revision })
  assert.equal(await coordinator.authorizeSend(first.engine), false)
  assert.equal(await coordinator.authorizeSend(child), false)
  await assert.rejects(coordinator.assertExecution(first.meta, 'dispatch'), /revision|变化/)
  await assert.rejects(coordinator.assertInteractiveExecution(first.meta.id, 'write'), /revision|变化/)
  checks.push('changed Goal blocks execute, child own-plan override and interactive execution')

  assert.equal(await manager.performSend(first.meta.id, 'stale send', {}), false)
  const staleInput = { dag: approvedTaskPlanToDag(first.meta.id, first.plan.currentVersion!, first.plan.projection), taskTimeoutMs: 0, maxRetries: 0 }
  await assert.rejects(manager.dispatchTaskDag(first.meta.id, staleInput), /revision|变化/)
  const recovered = manager.createTaskDagSchedulerCallbacks(first.meta.id, staleInput)
  await assert.rejects(recovered.runTask(staleInput.dag.tasks[0], { attempt: 1, dependencyResults: [] }), /revision|变化/)
  await assert.rejects(manager.dispatchSubagents(first.meta.id, { tasks: [{ prompt: 'stale child' }] }), /revision|变化/)
  assert.equal(provisioned, 0)
  assert.equal(first.engineSends(), 0)
  checks.push('actual SessionManager send, DAG, recovered runTask and direct subagent entrypoints stop before provisioning or Engine.send')

  const ordinary = { ...first.meta, id: 'ordinary', workspaceId: undefined, projectId: undefined, goalId: undefined, workItemId: undefined }
  const ordinaryEngine = { meta: ordinary } as Engine
  sessions.set(ordinary.id, ordinaryEngine)
  for (const strategy of ['execute', 'view', 'plan'] as const) { ordinary.taskStrategy = strategy; assert.equal(await coordinator.authorizeSend(ordinaryEngine), true) }
  ordinary.taskStrategy = 'execute'
  await coordinator.assertExecution(ordinary, 'ordinary execution')
  checks.push('ordinary unplanned execution and view/plan sends retain their existing behavior')

  const second = await fixture('source-race')
  const pending = coordinator.assertExecution(second.meta, 'approval race')
  store.revoke(second.meta.id, second.plan.currentVersion!)
  await assert.rejects(pending, /尚未批准|授权|变化/)
  store.approve(second.meta.id, second.plan.currentVersion!, second.plan.projection)
  const raceChild = { ...second.meta, id: 'race-child', parentSessionId: second.meta.id, workItemId: second.plan.projection!.steps[0].workItemId }
  sessions.set(raceChild.id, { meta: raceChild } as Engine)
  const relink = coordinator.assertExecution(raceChild, 'parent race')
  raceChild.parentSessionId = 'missing-parent'
  await assert.rejects(relink, /父会话|归属/)
  raceChild.parentSessionId = second.meta.id
  second.meta.taskStrategy = 'plan'
  await assert.rejects(coordinator.assertExecution(raceChild, 'parent stopped'), /规划策略/)
  second.meta.taskStrategy = 'execute'
  checks.push('approval revocation, parent relinking and a parent leaving execute fail closed across asynchronous reads')

  const dagInput = { dag: approvedTaskPlanToDag(second.meta.id, second.plan.currentVersion!, second.plan.projection), taskTimeoutMs: 0, maxRetries: 0 }
  const launched = await manager.dispatchTaskDag(second.meta.id, dagInput)
  assert.equal(launched.children.length, 1)
  assert.equal(provisioned, 1)
  assert.equal(prompts, 1)
  const project = await second.workspace.getWorkspace(second.meta.workspaceId!)
  await second.workspace.updateWorkspace(project!.id, { resources: [] }, { expectedRevision: project!.revision })
  const scheduler = manager.dagSchedulers.get(dagInput.dag.id)
  await scheduler.completeSession(launched.children[0].meta.id, { ok: true, resultText: 'research complete' })
  assert.equal(provisioned, 1)
  assert.equal(prompts, 1)
  assert(scheduler.view().tasks.some((task: any) => task.status === 'failed' && /Mission|变化/.test(task.error ?? '')))
  checks.push('actual running DAG refuses later dependency steps after project resources change')

  const third = await fixture('source-late')
  const run = createSessionTaskRun(third.meta)
  const digest = 'a'.repeat(64)
  const target = { providerId: third.meta.providerId, model: third.meta.model, protocol: 'openai.chat-completions' as const }
  run.routingPolicy = sealFrozenRoutingPolicy({ schemaVersion: 1, evaluatorVersion: 1, executionDomain: 'native_text',
    owner: { runId: run.id, sessionId: run.sessionId, taskId: run.taskId, workItemId: third.meta.workItemId!, businessLineId: 'studio' },
    messageId: 'late-message', frozenAt: 1, originalPromptDigest: digest, ruleSetRevision: 1, ruleSetDigest: digest,
    matchedRules: [], contextDigest: digest, catalogDigest: digest, evaluationDigest: digest, baseStrategy: 'balanced', baseStrategySource: { kind: 'global' },
    userIntent: { kind: 'global' }, effectivePolicy: { selection: { kind: 'global_auto' }, strategy: 'balanced', failure: { kind: 'pause' } },
    initialTarget: target, qualifiedTargets: [{ ...target, connectionIdentity: { generationId: 'b348a599-2c16-4f27-a9e7-e5898f9c2817', revision: 1 } }], retryTargets: [],
    hardBounds: { requiredCapabilities: [], minContextTokens: 1, allowedProviderIds: [target.providerId], locality: 'any' } })
  manager.taskRuns.set(third.meta.id, run)
  manager.taskSnapshotReplay = { blocksOrdinarySend: () => false }
  manager.supervisor = { blocksSend: () => false, authorizeSend: async () => {}, observeAfterEvent: () => {}, settleAcceptedSend: async () => {} }
  manager.modelAttemptRecoveryGate = { refreshBeforeSend: async () => {}, decideSend: () => ({ allowed: true }), acceptedSend: () => {} }
  manager.budgetError = () => null
  manager.sessionStarts = { ensure: async () => {} }
  let prepared = 0
  manager.writeTaskSnapshot = async () => {
    prepared++
    await third.commands.updateGoal(third.goal.id, { constraints: ['Changed while preparing the Run'] }, { expectedRevision: third.goal.revision })
  }
  assert.equal(await manager.performSend(third.meta.id, { text: 'send', messageId: 'late-message' }, {}), false)
  assert.equal(prepared, 1, third.meta.lastError)
  assert.equal(third.engineSends(), 0)
  assert.match(third.meta.lastError!, /revision|变化/)
  assert.equal(manager.taskRuns.get(third.meta.id).status, 'failed')
  checks.push('actual performSend rechecks after awaited preparation and fails the Run before Engine.send')

  const handlers = (ipcMain as any).handlers as Map<string, (...args: any[]) => unknown>
  registerTerminalMutationIpc({ assertExecutionAuthorized: () => Promise.reject(new Error('async-source-stale')),
    getSessionMeta: () => third.meta, manager: { get: () => ({ sessionId: third.meta.id }) } as never })
  for (const channel of ['terminals:start', 'terminals:write', 'terminals:resize', 'terminals:close']) {
    await assert.rejects(Promise.resolve(handlers.get(channel)!(trustedEvent, third.meta.id)), /async-source-stale/)
  }
  const realManager = sessionManager as any
  realManager.assertInteractiveExecutionAuthorized = () => Promise.reject(new Error('async-source-stale'))
  registerInteractiveMutationIpc()
  for (const channel of ['files:write', 'git:stage', 'git:commit', 'workspace:discardHunk', 'worktrees:mergePatch', 'worktrees:applyPatch']) {
    await assert.rejects(Promise.resolve(handlers.get(channel)!(trustedEvent, third.meta.id)), /async-source-stale/)
  }
  checks.push('terminal and interactive mutation IPC await asynchronous denial before executing effects')
  assert.equal(providerCalls, 0)
  console.log(JSON.stringify({ status: 'passed', checks, providerCalls, humanEvidence: false,
    limitations: ['real stores, SessionManager methods and DAG scheduler; shell and Engine sends are controlled fixtures', 'late-send fixture supplies a sealed existing route and controlled snapshot/supervisor boundaries', 'no physical Provider request or human acceptance'] }))
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
