import { join } from 'node:path'
import { getTaskHostExecutionGate, taskHostSubject } from '../task-handoff/execution-gate'
import { digest } from '../project-workspace/codec'
import type { RemoteCommandRecord } from '../../shared/remote-types'
import { listRoutines } from '../routineStore'
import { executeRoutine } from '../routines/routine-executor'
import { getRemoteContinuationStore } from './store'
import { SupervisorStateStore } from '../task/supervisor-state'
import { sessionManager } from '../sessionManager'
import { getSessionInputService } from '../task/session-input-runtime'
import { startProjectGoalTask } from '../project-workspace/goal-submission-runtime'
import { listHistory } from '../history'
import type { SupervisorRunRecord } from '../../shared/supervisor-types'
import { pauseSessionContinuations } from '../routines/pause-session-continuations'
import { remoteCreatedTaskResult } from './created-task-projection'

const inFlight = new Map<string, Promise<RemoteCommandRecord | null>>()

/**
 * Dispatches only commands with a concrete local executor. Claiming happens
 * in the durable remote store before any Session or Routine side effect.
 */
export async function executeRemoteCommand(rootDir: string, commandId: string): Promise<RemoteCommandRecord | null> {
  const key = `${rootDir}\0${commandId}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const execution = executeRemoteCommandOnce(rootDir, commandId)
  inFlight.set(key, execution)
  try { return await execution } finally { if (inFlight.get(key) === execution) inFlight.delete(key) }
}

async function executeRemoteCommandOnce(rootDir: string, commandId: string): Promise<RemoteCommandRecord | null> {
  const store = getRemoteContinuationStore(rootDir)
  const claimed = await store.claimCommandExecution(commandId)
  if (!claimed) return null
  if (claimed.status !== 'accepted' || claimed.execution?.status !== 'running') return claimed
  if (claimed.envelope.kind === 'resume_work_item') {
    return executeRemoteResume(rootDir, claimed)
  }
  if (claimed.envelope.kind === 'create_task') return executeRemoteCreateTask(rootDir, claimed)
  if (claimed.envelope.kind === 'append_task') return executeRemoteAppendTask(rootDir, claimed)
  if (claimed.envelope.kind === 'pause_work_item' || claimed.envelope.kind === 'cancel_work_item') {
    return executeRemoteWorkItemControl(rootDir, claimed)
  }
  if (claimed.envelope.kind === 'approve_effect') {
    return executeRemoteApproval(rootDir, claimed)
  }
  if (claimed.envelope.kind === 'view_result') {
    try {
      await store.resultProjection(claimed.envelope.scope.projectId)
      return store.finishCommandExecution(commandId, { status: 'succeeded' })
    } catch (error) {
      return store.finishCommandExecution(commandId, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (claimed.envelope.kind !== 'trigger_routine' || !claimed.envelope.scope.routineId) {
    return store.finishCommandExecution(commandId, {
      status: 'failed',
      error: `No local executor for remote command kind: ${claimed.envelope.kind}`
    })
  }

  try {
    const routines = await listRoutines(join(rootDir, 'routines'))
    const routine = routines.find((item) => item.id === claimed.envelope.scope.routineId)
    if (!routine || routine.projectId !== claimed.envelope.scope.projectId) {
      return store.finishCommandExecution(commandId, { status: 'failed', error: 'Remote Routine is not available in the bound Project' })
    }
    // A remote signed command is not an approval. Routines configured to bypass
    // native permission checks must therefore fail closed on this control plane;
    // they can only be started through the local approval-aware workbench.
    if (routine.permissionMode === 'bypassPermissions') {
      return store.finishCommandExecution(commandId, {
        status: 'failed',
        error: 'Remote routine requires local approval; bypassPermissions is not executable remotely'
      })
    }
    const run = await executeRoutine(join(rootDir, 'routines'), routine, {
      sendDelayMs: 0,
      workspaceRoot: rootDir,
      runId: claimed.execution.routineRunId
    })
    return store.finishCommandExecution(commandId, {
      status: run.status === 'failed' ? 'failed' : run.status === 'succeeded' ? 'succeeded' : 'running',
      routineRunId: run.id,
      ...(run.error ? { error: run.error } : {})
    })
  } catch (error) {
    return store.finishCommandExecution(commandId, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function executeRemoteCreateTask(rootDir: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord> {
  const payload = command.envelope.payload
  if (!payload || payload.kind !== 'create_task') return failRemote(rootDir, command, 'Remote create task payload is missing')
  try {
    const started = await startProjectGoalTask({ requestId: `remote-${command.envelope.commandId}`, projectId: command.envelope.scope.projectId,
      objective: payload.objective, businessLineId: payload.businessLineId, template: 'auto', mode: 'auto' }, rootDir)
    return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'succeeded', runId: started.sessionId, ...remoteCreatedTaskResult(started) }))!
  } catch (error) { return failRemote(rootDir, command, errorText(error)) }
}

async function executeRemoteAppendTask(rootDir: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord> {
  const payload = command.envelope.payload
  if (!payload || payload.kind !== 'append_task') return failRemote(rootDir, command, 'Remote append task payload is missing')
  try {
    const scope = command.envelope.scope
    const matches = (item: { workspaceId?: string; workItemId?: string; goalId?: string; parentSessionId?: string }) =>
      item.workspaceId === scope.projectId && item.workItemId === scope.workItemId && (!scope.goalId || item.goalId === scope.goalId) && !item.parentSessionId
    const active = sessionManager.list().filter(item => item.status !== 'closed' && matches(item))
    if (active.length > 1) throw new Error('当前 WorkItem 存在多个任务会话，请先在电脑端选择')
    let meta = active[0]
    const boundSessionId = command.execution?.runId
    if (boundSessionId && meta?.id !== boundSessionId) throw new Error('原追加请求的任务会话尚未恢复，请先在电脑端核对接收记录')
    if (!meta) {
      const saved = listHistory().filter(matches)
      if (saved.length !== 1 || !saved[0].sdkSessionId) throw new Error('当前 WorkItem 没有唯一可恢复的历史任务，请先在电脑端选择')
      getTaskHostExecutionGate(rootDir).assert(taskHostSubject(saved[0]))
      meta = await sessionManager.create({ cwd: saved[0].cwd, resumeSdkSessionId: saved[0].sdkSessionId })
    }
    const session = sessionManager.get(meta.id)
    if (!session || !matches(session.meta)) throw new Error('当前 WorkItem 的本地任务归属不匹配')
    getTaskHostExecutionGate(rootDir).assert(taskHostSubject(session.meta))
    await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'running', runId: session.meta.id })
    const inputs = getSessionInputService(rootDir)
    const queued = await inputs.queue(session.meta.id, payload.clientRequestId, { text: payload.text })
    const applied = queued.phase === 'applied' || queued.phase === 'requirements_applied' ? queued : await inputs.apply(session.meta.id, payload.clientRequestId)
    if (applied.phase !== 'applied' && applied.phase !== 'requirements_applied') throw new Error(applied.error ?? '追加要求尚未被任务接收')
    return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'succeeded', runId: session.meta.id }))!
  } catch (error) { return failRemote(rootDir, command, errorText(error)) }
}

async function executeRemoteWorkItemControl(rootDir: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord> {
  try {
    const projectId = command.envelope.scope.projectId, workItemId = command.envelope.scope.workItemId
    if (!workItemId) throw new Error('远程控制需要 WorkItem')
    const supervisorStore = new SupervisorStateStore(rootDir)
    const candidates = (await supervisorStore.listRuns({ projectId })).filter(run => run.workItemId === workItemId && ['queued', 'running', 'waiting_approval', 'waiting_reconciliation', 'paused', 'blocked'].includes(run.status))
    if (candidates.length !== 1) throw new Error(candidates.length ? 'WorkItem 存在多个可控运行，请先在电脑端选择' : 'WorkItem 没有可控运行')
    const supervisor = candidates[0], ownerId = `remote-device:${command.envelope.issuerDeviceId}`
    const sessions = sessionManager.list().filter(meta => meta.workspaceId === projectId && meta.workItemId === workItemId)
    for (const session of sessions) await pauseSessionContinuations(join(rootDir, 'routines'), session.id)
    const action = command.envelope.kind === 'pause_work_item' ? 'pause' : 'cancel'
    if (action === 'pause' && supervisor.status === 'paused') return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'succeeded', runId: supervisor.id }))!
    if (action === 'pause' && !['running', 'waiting_approval'].includes(supervisor.status)) throw new Error('当前运行状态无法暂停，请先在电脑端恢复或核对运行结果')
    const leased = action === 'pause' ? await claimRemoteControlLease(supervisorStore, supervisor, ownerId) : supervisor
    const controlled = await sessionManager.controlSupervisorRun(supervisorStore, action === 'pause'
      ? { action, runId: supervisor.id, options: { ownerId, leaseId: leased.lease?.id, fencingToken: leased.lease?.fencingToken, expectedRevision: leased.revision, actorId: ownerId } }
      : { action, runId: supervisor.id, options: { expectedRevision: supervisor.revision, actorId: ownerId } })
    if (!controlled) throw new Error('WorkItem 没有活动会话绑定')
    return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'succeeded', runId: controlled.supervisorRun.id }))!
  } catch (error) { return failRemote(rootDir, command, errorText(error)) }
}

async function failRemote(rootDir: string, command: RemoteCommandRecord, error: string): Promise<RemoteCommandRecord> {
  return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'failed', error }))!
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function claimRemoteControlLease(store: SupervisorStateStore, run: SupervisorRunRecord, ownerId: string): Promise<SupervisorRunRecord> {
  const lease = run.lease
  if (lease && lease.expiresAt > Date.now() && lease.ownerId === ownerId) {
    return store.heartbeatLease(run.id, { ownerId, expectedRevision: run.revision, actorId: ownerId, leaseId: lease.id, fencingToken: lease.fencingToken, ttlMs: 30_000 })
  }
  return store.acquireLease(run.id, { ownerId, expectedRevision: run.revision, actorId: ownerId, ttlMs: 30_000 })
}

/**
 * Applies a remote approval only to the still-live native permission request.
 * The durable approval record is the intent; the Session is the authority that
 * resolves the actual pending Promise. Missing or changed requests fail closed.
 */
async function executeRemoteApproval(rootDir: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord> {
  const store = getRemoteContinuationStore(rootDir)
  let approval = await store.getApprovalForCommand(command.envelope.commandId)
  const payload = command.envelope.payload
  if (!approval && payload?.kind === 'approve_effect') {
    try {
      approval = await store.createApproval({ commandId: command.envelope.commandId, sessionId: payload.sessionId,
        permissionRequestId: payload.permissionRequestId, action: payload.action, targetDigest: payload.targetDigest,
        dataScope: payload.dataScope, revision: command.envelope.revision, expiresAt: command.envelope.expiresAt })
    } catch (error) { return failRemote(rootDir, command, errorText(error)) }
  }
  if (!approval) return command
  if (approval.applicationStatus === 'applied' || approval.applicationStatus === 'failed') return command

  const fail = async (error: string): Promise<RemoteCommandRecord> => {
    await store.finishApprovalApplication(approval.id, { status: 'failed', error })
    return (await store.finishCommandExecution(command.envelope.commandId, { status: 'failed', error }))!
  }

  const session = sessionManager.get(approval.sessionId)
  if (!session || session.meta.workspaceId !== command.envelope.scope.projectId) {
    return fail('Remote approval Session is outside the bound Project')
  }
  try { getTaskHostExecutionGate(rootDir).assert(taskHostSubject(session.meta)) }
  catch (error) { return fail(errorText(error)) }
  if (command.envelope.scope.workItemId && session.meta.workItemId !== command.envelope.scope.workItemId) {
    return fail('Remote approval Session is outside the bound WorkItem')
  }
  if (approval.revision !== command.envelope.revision || approval.expiresAt !== command.envelope.expiresAt) {
    return fail('Remote approval revision or expiry is stale')
  }
  if (approval.costLimitUsd !== undefined && session.meta.costUsd > approval.costLimitUsd) {
    return fail('Remote approval cost limit has been exceeded')
  }

  const pending = session.pendingPermissions().find((request) => request.requestId === approval.permissionRequestId)
  if (!pending || pending.toolName !== approval.action) {
    return fail('Remote approval permission request is no longer pending')
  }
  const expectedDataScope = digest({
    toolName: pending.toolName,
    capabilities: pending.capabilities,
    effectScope: pending.effectScope ?? null,
    riskLevel: pending.riskLevel ?? null
  })
  if (expectedDataScope !== approval.dataScope) return fail('Remote approval data scope no longer matches')
  if (pending.effectScope?.targetDigest !== approval.targetDigest) return fail('Remote approval Effect target has changed')

  const allow = approval.status === 'approved'
  if (approval.status === 'pending') return command
  if (approval.status === 'expired') {
    session.respondPermission(approval.permissionRequestId, false, '远程审批已过期')
  } else {
    session.respondPermission(approval.permissionRequestId, allow, allow ? '远程设备已批准' : '远程设备已拒绝')
  }
  const rejected = approval.status === 'rejected' || approval.status === 'expired'
  await store.finishApprovalApplication(approval.id, { status: 'applied' })
  return (await store.finishCommandExecution(command.envelope.commandId, {
    status: rejected ? 'failed' : 'succeeded',
    ...(approval.status === 'rejected' ? { error: 'Remote approval rejected the Effect' } : approval.status === 'expired' ? { error: 'Remote approval expired' } : {})
  }))!
}

async function executeRemoteResume(rootDir: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord> {
  const workItemId = command.envelope.scope.workItemId
  if (!workItemId) {
    return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'failed', error: 'Remote resume command requires a WorkItem' }))!
  }
  try {
    const supervisorStore = new SupervisorStateStore(rootDir)
    for (const meta of [...sessionManager.list(), ...listHistory()].filter(meta => meta.workspaceId === command.envelope.scope.projectId && meta.workItemId === workItemId)) {
      getTaskHostExecutionGate(rootDir).assert(taskHostSubject(meta))
    }
    const candidates = (await supervisorStore.listRuns({ projectId: command.envelope.scope.projectId }))
      .filter((run) => run.workItemId === workItemId && ['paused', 'blocked', 'waiting_reconciliation'].includes(run.status))
    if (candidates.length !== 1) throw new Error(candidates.length === 0 ? 'No resumable Supervisor Run owns this WorkItem' : 'WorkItem has multiple resumable Supervisor Runs')
    const supervisor = candidates[0]
    const ownerId = `remote-device:${command.envelope.issuerDeviceId}`
    const leased = await claimRemoteControlLease(supervisorStore, supervisor, ownerId)
    const controlled = await sessionManager.controlSupervisorRun(supervisorStore, {
      action: 'resume',
      runId: supervisor.id,
      options: {
        ownerId,
        leaseId: leased.lease?.id,
        fencingToken: leased.lease?.fencingToken,
        expectedRevision: leased.revision,
        actorId: ownerId
      }
    })
    if (!controlled) throw new Error('Supervisor Run has no active canonical Session')
    return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'succeeded', runId: controlled.supervisorRun.id }))!
  } catch (error) {
    return (await getRemoteContinuationStore(rootDir).finishCommandExecution(command.envelope.commandId, { status: 'failed', error: error instanceof Error ? error.message : String(error) }))!
  }
}

export async function executePendingRemoteCommands(rootDir: string): Promise<void> {
  const store = getRemoteContinuationStore(rootDir)
  const snapshot = await store.getSnapshot()
  for (const command of snapshot.commands) {
    if (command.status === 'pending' || (command.status === 'accepted' && command.execution?.status === 'running')) {
      await executeRemoteCommand(rootDir, command.envelope.commandId)
    }
  }
}

/** Converges commands left running after the Session lifecycle finishes. */
export async function reconcileRemoteExecutions(rootDir: string): Promise<void> {
  const store = getRemoteContinuationStore(rootDir)
  const snapshot = await store.getSnapshot()
  const commandById = new Map(snapshot.commands.map((command) => [command.envelope.commandId, command]))
  for (const approval of snapshot.approvals) {
    if (approval.applicationStatus !== 'applying') continue
    const command = commandById.get(approval.commandId)
    if (!command) {
      await store.finishApprovalApplication(approval.id, { status: 'failed', error: 'Remote approval command is missing' })
      continue
    }
    if (command.execution?.status === 'running' || command.status === 'pending' || command.status === 'accepted') {
      await executeRemoteCommand(rootDir, command.envelope.commandId)
      continue
    }
    if (approval.status === 'expired' || command.envelope.expiresAt <= Date.now()) {
      await denyExpiredRemoteApproval(rootDir, command, approval)
    }
  }
  const runs = await (await import('../routines/routine-runner.js')).listRoutineRuns(join(rootDir, 'routines'))
  const byId = new Map(runs.map((run) => [run.id, run]))
  for (const command of snapshot.commands) {
    if (command.envelope.kind === 'approve_effect' && command.execution?.status === 'running') {
      await executeRemoteCommand(rootDir, command.envelope.commandId)
      continue
    }
    const execution = command.execution
    if (!execution || execution.status !== 'running' || !execution.routineRunId) continue
    const run = byId.get(execution.routineRunId)
    if (!run || (run.status !== 'succeeded' && run.status !== 'failed')) continue
    await store.finishCommandExecution(command.envelope.commandId, {
      status: run.status,
      routineRunId: run.id,
      ...(run.error ? { error: run.error } : {})
    })
  }
}

async function denyExpiredRemoteApproval(
  rootDir: string,
  command: RemoteCommandRecord,
  approval: NonNullable<Awaited<ReturnType<ReturnType<typeof getRemoteContinuationStore>['getApprovalForCommand']>>>
): Promise<void> {
  const store = getRemoteContinuationStore(rootDir)
  const session = sessionManager.get(approval.sessionId)
  const pending = session?.pendingPermissions().find((request) => request.requestId === approval.permissionRequestId)
  if (session && pending?.toolName === approval.action) {
    session.respondPermission(approval.permissionRequestId, false, '远程审批已过期')
  }
  await store.finishApprovalApplication(approval.id, { status: 'applied', error: 'Remote approval expired' })
  await store.finishCommandExecution(command.envelope.commandId, { status: 'failed', error: 'Remote approval expired' })
}
