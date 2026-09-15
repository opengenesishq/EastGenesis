import { join } from 'node:path'
import { digest } from '../project-workspace/codec'
import type { RemoteCommandRecord } from '../../shared/remote-types'
import { listRoutines } from '../routineStore'
import { executeRoutine } from '../routines/routine-executor'
import { getRemoteContinuationStore } from './store'
import { SupervisorStateStore } from '../task/supervisor-state'
import { sessionManager } from '../sessionManager'

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
  if (claimed.execution?.status !== 'running') return claimed
  if (claimed.envelope.kind === 'resume_work_item') {
    return executeRemoteResume(rootDir, claimed)
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

/**
 * Applies a remote approval only to the still-live native permission request.
 * The durable approval record is the intent; the Session is the authority that
 * resolves the actual pending Promise. Missing or changed requests fail closed.
 */
async function executeRemoteApproval(rootDir: string, command: RemoteCommandRecord): Promise<RemoteCommandRecord> {
  const store = getRemoteContinuationStore(rootDir)
  const approval = await store.getApprovalForCommand(command.envelope.commandId)
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
    const candidates = (await supervisorStore.listRuns({ projectId: command.envelope.scope.projectId }))
      .filter((run) => run.workItemId === workItemId && ['paused', 'blocked', 'waiting_reconciliation'].includes(run.status))
    if (candidates.length !== 1) throw new Error(candidates.length === 0 ? 'No resumable Supervisor Run owns this WorkItem' : 'WorkItem has multiple resumable Supervisor Runs')
    const supervisor = candidates[0]
    const ownerId = `remote-device:${command.envelope.issuerDeviceId}`
    const leased = await supervisorStore.acquireLease(supervisor.id, { ownerId, expectedRevision: supervisor.revision, actorId: ownerId })
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
