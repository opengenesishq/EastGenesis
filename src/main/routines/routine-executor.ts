import { setTimeout as delay } from 'node:timers/promises'
import { dirname } from 'node:path'
import { powerSaveBlocker } from 'electron'
import { calculateRoutineSchedule } from '../../shared/routine-schedule'
import { showDesktopNotification } from '../desktopNotify'
import { listRoutines, updateRoutine, type Routine } from '../routineStore'
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
import { routineHeartbeatService } from './routine-heartbeat-runtime'

export interface RoutineExecutionOptions {
  scheduledAt?: number
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
      if (options.scheduledAt !== undefined) {
        const current = (await listRoutines(rootDir)).find(item => item.id === routine.id)
        if (!current?.enabled || current.scheduleState === 'exhausted' || current.scheduleState === 'invalid' ||
            current.schedule !== routine.schedule || current.timeZone !== routine.timeZone || current.startAt !== routine.startAt || current.nextRunAt !== options.scheduledAt) {
          throw new Error('计划时间或状态已变化，旧的定时触发已停止')
        }
      }
      const workspaceRoot = options.workspaceRoot ?? dirname(rootDir)
      initializeRoutineSessionLifecycle(rootDir, workspaceRoot)
      const timing = calculateRoutineSchedule(routine, Date.now())
      if (timing.state === 'invalid') throw new Error(timing.error)
      const nextRunAt = options.nextRunAt === undefined ? timing.nextRunAt : options.nextRunAt
      if (routine.executionTarget) return routineHeartbeatService(rootDir, workspaceRoot).trigger(routine, nextRunAt, options.scheduledAt)
      const sendDelayMs = options.sendDelayMs ?? 1200
      const promptTargets: RoutinePromptTarget[] = []

      const record = await runRoutineWithHistory(
        rootDir,
        routine,
        async (current, run) => {
          let execution
          try {
            execution = await prepareRoutineProjectExecution(
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
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/Routine Project (?:does not exist|is not active):/i.test(message)) {
              await updateRoutine(rootDir, current.id, {
                enabled: false,
                lastError: '关联项目已失效，请重新绑定项目。'
              }).catch(() => undefined)
            }
            throw error
          }
          let sessionId: string | undefined
          try {
            const meta = await sessionManager.createManaged(
              {
                cwd: execution.cwd,
                workspaceId: execution.projectId,
                goalId: execution.goalId,
                workItemId: execution.workItemId,
                isolated: current.executionLocation === 'worktree',
                reasoningEffort: current.reasoningEffort,
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
