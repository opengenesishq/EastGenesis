import { setTimeout as delay } from 'node:timers/promises'
import { dirname } from 'node:path'
import { powerSaveBlocker } from 'electron'
import { computeNextRun } from '../routineScheduler'
import { showDesktopNotification } from '../desktopNotify'
import { listRoutines, type Routine } from '../routineStore'
import { sessionManager } from '../sessionManager'
import { getSettings } from '../settings'
import {
  buildRoutineRunNotification,
  runWithPersonalOsPowerBlocker,
  type PowerSaveBlockerAdapter
} from './personal-os'
import {
  runRoutineWithHistory,
  setRoutineRunDispatchState,
  setRoutineRunExecutionBinding,
  settleRoutineRun,
  type RoutineRunRecord
} from './routine-runner'
import {
  prepareRoutineProjectExecution,
  transitionRoutineGoal,
  transitionRoutineWorkItem
} from './routine-project-runtime'
import { initializeRoutineSessionLifecycle } from './routine-session-lifecycle'

export interface RoutineExecutionOptions {
  nextRunAt?: number | null
  sendDelayMs?: number
  workspaceRoot?: string
  /** Stable external trigger identity used to suppress duplicate Routine Runs. */
  runId?: string
}

interface RoutinePromptTarget {
  sessionId: string
  prompt: string
}

const routinePowerAdapter: PowerSaveBlockerAdapter = {
  start: (type) => powerSaveBlocker.start(type),
  stop: (id) => powerSaveBlocker.stop(id),
  isStarted: (id) => powerSaveBlocker.isStarted(id)
}

export async function executeRoutine(
  rootDir: string,
  routine: Routine,
  options: RoutineExecutionOptions = {}
): Promise<RoutineRunRecord> {
  return runWithPersonalOsPowerBlocker(
    {
      adapter: routinePowerAdapter,
      enabled: getSettings().preventDisplaySleep,
      reason: `routine:${routine.id}`,
      onError: (error) => console.error('[caogen] routine prevent-display-sleep failed:', error)
    },
    async () => {
      const workspaceRoot = options.workspaceRoot ?? dirname(rootDir)
      initializeRoutineSessionLifecycle(rootDir, workspaceRoot)
      const nextRunAt = options.nextRunAt === undefined ? computeNextRun(routine.schedule, Date.now()) : options.nextRunAt
      const sendDelayMs = options.sendDelayMs ?? 1200
      const promptTargets: RoutinePromptTarget[] = []

      const record = await runRoutineWithHistory(
        rootDir,
        routine,
        async (current, run) => {
          const execution = await prepareRoutineProjectExecution(
            workspaceRoot,
            current,
            run,
            async (binding) => {
              const persisted = await setRoutineRunExecutionBinding(rootDir, run.id, {
                projectId: binding.projectId,
                goalId: binding.goalId,
                workItemId: binding.workItemId,
                projectCwd: binding.cwd
              })
              if (!persisted) throw new Error(`Routine Run disappeared before execution binding:${run.id}`)
            }
          )
          let sessionId: string | undefined
          try {
            const meta = await sessionManager.createManaged(
              {
                cwd: execution.cwd,
                workspaceId: execution.projectId,
                goalId: execution.goalId,
                workItemId: execution.workItemId,
                isolated: false,
                model: current.model || undefined,
                providerId: current.providerId || undefined,
                budgetUsd: current.budgetUsd,
                engine: current.engine,
                executorEngine: current.engine,
                initialPrompt: current.prompt,
                taskStrategy: current.permissionMode === 'plan' ? 'plan' : 'execute',
                title: `Routine: ${current.name}`
              },
              {
                beforeStart: async (created) => {
                  const persisted = await setRoutineRunDispatchState(
                    rootDir,
                    run.id,
                    'session_created',
                    undefined,
                    created.id
                  )
                  if (!persisted) throw new Error(`Routine Run disappeared before Session start:${run.id}`)
                }
              }
            )
            sessionId = meta.id
            await transitionRoutineWorkItem(workspaceRoot, execution.workItemId, 'running')
          } catch (error) {
            if (sessionId) await sessionManager.close(sessionId).catch(() => undefined)
            await transitionRoutineWorkItem(workspaceRoot, execution.workItemId, 'failed').catch(() => undefined)
            if (execution.goalId) {
              await transitionRoutineGoal(workspaceRoot, execution.goalId, 'failed').catch(() => undefined)
            }
            throw error
          }
          if (!sessionId) throw new Error('Routine session creation returned no session id')
          // History is persisted before prompt delivery so UI events do not outrun run records.
          promptTargets.push({ sessionId, prompt: current.prompt })
          return {
            sessionId,
            projectId: execution.projectId,
            goalId: execution.goalId,
            workItemId: execution.workItemId,
            projectCwd: execution.cwd,
            dispatchState: 'session_created',
            pending: true
          }
        },
        nextRunAt,
        options.runId
      )

      let latestRecord = record
      for (const target of promptTargets) {
        if (sendDelayMs > 0) await delay(sendDelayMs)
        if (!await sessionManager.send(target.sessionId, target.prompt)) {
          await sessionManager.close(target.sessionId).catch(() => undefined)
          await transitionRoutineWorkItem(workspaceRoot, record.workItemId, 'failed').catch(() => undefined)
          const failed = await settleRoutineRun(rootDir, record.id, {
            status: 'failed',
            error: 'Routine prompt was rejected before execution started'
          })
          if (failed) notifyRoutineResult(routine, failed)
          return failed ?? record
        }
        const accepted = await setRoutineRunDispatchState(
          rootDir,
          record.id,
          'prompt_accepted',
          sessionManager.getTaskRun(target.sessionId)?.id
        )
        if (accepted) latestRecord = accepted
      }

      if (latestRecord.status === 'failed') notifyRoutineResult(routine, latestRecord)
      return latestRecord
    }
  )
}

export async function runRoutineNow(rootDir: string, routineId: string): Promise<RoutineRunRecord | null> {
  const routines = await listRoutines(rootDir)
  const routine = routines.find((item) => item.id === routineId)
  if (!routine) return null
  return executeRoutine(rootDir, routine)
}

function notifyRoutineResult(routine: Routine, record: RoutineRunRecord): void {
  const payload = buildRoutineRunNotification(routine, record, getSettings())
  if (!payload) return
  showDesktopNotification(payload)
}
