import type { SessionEventPayload } from '../../shared/types'
import { showDesktopNotification } from '../desktopNotify'
import { listRoutines } from '../routineStore'
import { sessionManager } from '../sessionManager'
import { buildRoutineRunNotification } from './personal-os'
import {
  listRoutineRuns,
  recordRoutineRunFinalizationError,
  setRoutineRunDispatchState,
  setRoutineRunInboxStatus,
  stageRoutineRunResult,
  settleRoutineRun,
  type RoutineRunRecord
} from './routine-runner'
import { transitionRoutineGoal, transitionRoutineWorkItem } from './routine-project-runtime'
import { getSettings } from '../settings'
import { persistRoutineResultEvidence } from './routine-result-artifact'
import { routineHeartbeatService } from './routine-heartbeat-runtime'

let installedRoot: string | undefined
let installedWorkspaceRoot: string | undefined
let unsubscribe: (() => void) | undefined
const sessionQueues = new Map<string, Promise<void>>()

export async function reconcileRoutineRunsAtStartup(rootDir: string, workspaceRoot: string): Promise<void> {
  initializeRoutineSessionLifecycle(rootDir, workspaceRoot)
  await routineHeartbeatService(rootDir, workspaceRoot).sweep()
  const routines = new Map((await listRoutines(rootDir)).map((routine) => [routine.id, routine]))
  const running = (await listRoutineRuns(rootDir)).filter((record) => record.status === 'running' && !record.heartbeat)
  for (const record of running) {
    try {
      await reconcileRoutineRun(rootDir, workspaceRoot, record, routines.get(record.routineId))
    } catch (error) {
      await failRecoveredRoutineRun(
        rootDir,
        workspaceRoot,
        record,
        `Routine startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

export function initializeRoutineSessionLifecycle(rootDir: string, workspaceRoot: string): void {
  const normalizedRoot = rootDir.trim()
  const normalizedWorkspaceRoot = workspaceRoot.trim()
  if (!normalizedRoot || !normalizedWorkspaceRoot) throw new Error('Routine lifecycle roots are required')
  if (installedRoot === normalizedRoot && installedWorkspaceRoot === normalizedWorkspaceRoot && unsubscribe) return
  disposeRoutineSessionLifecycle()
  installedRoot = normalizedRoot
  installedWorkspaceRoot = normalizedWorkspaceRoot
  unsubscribe = sessionManager.subscribe((payload) => enqueueRoutineEvent(payload))
}

export function disposeRoutineSessionLifecycle(): void {
  unsubscribe?.()
  unsubscribe = undefined
  installedRoot = undefined
  installedWorkspaceRoot = undefined
  sessionQueues.clear()
}

function enqueueRoutineEvent(payload: SessionEventPayload): void {
  if (!installedRoot || !installedWorkspaceRoot || !isRoutineLifecycleEvent(payload)) return
  const previous = sessionQueues.get(payload.sessionId) ?? Promise.resolve()
  const next = previous
    .then(() => handleRoutineEvent(installedRoot!, installedWorkspaceRoot!, payload))
    .catch((error) => console.error('[caogen] routine session lifecycle failed:', error))
    .finally(() => {
      if (sessionQueues.get(payload.sessionId) === next) sessionQueues.delete(payload.sessionId)
    })
  sessionQueues.set(payload.sessionId, next)
}

async function handleRoutineEvent(
  rootDir: string,
  workspaceRoot: string,
  payload: SessionEventPayload
): Promise<void> {
  await routineHeartbeatService(rootDir, workspaceRoot).sweep(payload.sessionId)
  const record = (await listRoutineRuns(rootDir)).find((run) =>
    run.sessionId === payload.sessionId && run.status === 'running' && !run.heartbeat
  )
  if (!record) return
  const event = payload.event
  if (event.kind === 'permission-request') {
    await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'waiting_approval')
    await setRoutineRunInboxStatus(rootDir, record.id, 'waiting_approval')
    return
  }
  if (event.kind === 'permission-resolved') {
    await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'running')
    await setRoutineRunInboxStatus(rootDir, record.id, 'running')
    return
  }
  if (event.kind === 'turn-result') {
    const currentRun = sessionManager.getTaskRun(payload.sessionId)
    const staged = await stageRoutineRunResult(rootDir, record.id, {
      workflowRunId: currentRun?.id,
      resultText: event.resultText,
      resultObservedAt: currentRun?.finishedAt ?? Date.now()
    })
    if (!staged) return
    const taskRun = await sessionManager.persistTaskRunLifecycleBarrier(payload.sessionId)
    if (!event.isError && taskRun && taskRun.status !== 'completed') {
      if (taskRun.status !== 'failed' && taskRun.status !== 'cancelled') return
    }
    await finalizeRoutineEvent(rootDir, workspaceRoot, record, {
      succeeded: !event.isError && taskRun?.status === 'completed',
      resultText: staged.resultText,
      error: event.isError
        ? event.resultText || event.subtype
        : taskRun
          ? `Routine TaskRun ended as ${taskRun.status}`
          : 'Routine TaskRun was unavailable after result persistence',
      workflowRunId: taskRun?.id ?? currentRun?.id,
      observedAt: staged.resultObservedAt ?? taskRun?.finishedAt
    })
    return
  }
  if (event.kind === 'status' && event.status === 'error') {
    await finalizeRoutineEvent(rootDir, workspaceRoot, record, {
      succeeded: false,
      error: event.error || 'Routine session entered error state',
      workflowRunId: sessionManager.getTaskRun(payload.sessionId)?.id
    })
  }
}

async function reconcileRoutineRun(
  rootDir: string,
  workspaceRoot: string,
  record: RoutineRunRecord,
  routine: Awaited<ReturnType<typeof listRoutines>>[number] | undefined
): Promise<void> {
  if (!record.sessionId) {
    await failRecoveredRoutineRun(
      rootDir,
      workspaceRoot,
      record,
      'Routine dispatch was interrupted before a durable Session was bound'
    )
    return
  }

  const taskRun = sessionManager.getTaskRun(record.sessionId)
  if (taskRun) {
    if (taskRun.status === 'completed') {
      await finalizeRoutineEvent(rootDir, workspaceRoot, record, {
        succeeded: true,
        workflowRunId: taskRun.id,
        resultText: record.resultText,
        observedAt: record.resultObservedAt ?? taskRun.finishedAt
      })
      return
    }
    if (taskRun.status === 'failed' || taskRun.status === 'cancelled') {
      await finalizeRoutineEvent(rootDir, workspaceRoot, record, {
        succeeded: false,
        workflowRunId: taskRun.id,
        error: taskRun.error || `Routine TaskRun recovered as ${taskRun.status}`
      })
      return
    }
    if (taskRun.status === 'waiting_approval') {
      await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'waiting_approval')
      await setRoutineRunInboxStatus(rootDir, record.id, 'waiting_approval')
    } else {
      await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'running')
      await setRoutineRunInboxStatus(rootDir, record.id, 'running')
    }
    await setRoutineRunDispatchState(rootDir, record.id, 'prompt_accepted', taskRun.id)
    return
  }

  const session = sessionManager.get(record.sessionId)
  const sessionCanResume = session && session.meta.status !== 'error' && session.meta.status !== 'closed'
  if (record.dispatchState === 'session_created' && sessionCanResume && routine) {
    await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'running')
    if (await sessionManager.send(record.sessionId, routine.prompt)) {
      await setRoutineRunDispatchState(
        rootDir,
        record.id,
        'prompt_accepted',
        sessionManager.getTaskRun(record.sessionId)?.id
      )
      return
    }
  }

  if (session) await sessionManager.close(record.sessionId).catch(() => undefined)
  const reason = record.dispatchState === 'prompt_accepted'
    ? 'Routine prompt acceptance was recorded but its TaskRun outcome is unavailable; duplicate execution was prevented'
    : 'Routine Session could not be resumed before prompt execution started'
  await failRecoveredRoutineRun(rootDir, workspaceRoot, record, reason)
}

async function failRecoveredRoutineRun(
  rootDir: string,
  workspaceRoot: string,
  record: RoutineRunRecord,
  error: string
): Promise<void> {
  await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'failed').catch(() => undefined)
  if (record.goalId) await transitionRoutineGoal(workspaceRoot, record.goalId, 'failed').catch(() => undefined)
  await settleRoutineRun(rootDir, record.id, { status: 'failed', error })
}

async function finalizeRoutineEvent(
  rootDir: string,
  workspaceRoot: string,
  record: RoutineRunRecord,
  outcome: {
    succeeded: boolean
    resultText?: string
    error?: string
    workflowRunId?: string
    observedAt?: number
  }
): Promise<void> {
  let resultBinding: { artifactId: string; evidenceId: string } | undefined
  if (outcome.succeeded && record.projectId) {
    try {
      resultBinding = await persistRoutineResultEvidence(
        workspaceRoot,
        workspaceRoot,
        record,
        outcome.workflowRunId ?? record.workflowRunId ?? '',
        outcome.resultText ?? record.resultText,
        outcome.observedAt ?? record.resultObservedAt ?? record.startedAt
      )
    } catch (error) {
      const message = `Routine result finalization failed: ${error instanceof Error ? error.message : String(error)}`
      await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'verifying').catch(() => undefined)
      await recordRoutineRunFinalizationError(rootDir, record.id, message)
      return
    }
  }
  try {
    await transitionRoutineWorkItem(
      workspaceRoot,
      record.workItemId,
      outcome.succeeded ? 'verifying' : 'failed'
    )
  } catch (error) {
    outcome = {
      succeeded: false,
      workflowRunId: outcome.workflowRunId,
      error: `Routine canonical WorkItem update failed: ${error instanceof Error ? error.message : String(error)}`
    }
    await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'failed').catch(() => undefined)
  }
  const settled = await settleRoutineRun(rootDir, record.id, {
    status: outcome.succeeded ? 'succeeded' : 'failed',
    workflowRunId: outcome.workflowRunId,
    artifactId: resultBinding?.artifactId,
    evidenceId: resultBinding?.evidenceId,
    resultObservedAt: outcome.observedAt,
    resultText: outcome.resultText,
    error: outcome.error
  })
  if (!settled) return
  const routine = (await listRoutines(rootDir)).find((candidate) => candidate.id === settled.routineId)
  if (!routine) return
  const notification = buildRoutineRunNotification(routine, settled, getSettings())
  if (notification) showDesktopNotification(notification)
}

function isRoutineLifecycleEvent(payload: SessionEventPayload): boolean {
  const event = payload.event
  return event.kind === 'permission-request' || event.kind === 'permission-resolved' ||
    event.kind === 'turn-result' || event.kind === 'status'
}
