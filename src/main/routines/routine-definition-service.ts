import type { CreateRoutineInput, UpdateRoutineInput, Routine } from '../routineStore'
import { listRoutines, createRoutine, updateRoutine } from '../routineStore'
import { sessionManager } from '../sessionManager'
import { calculateRoutineSchedule, isRRuleSchedule, normalizeRoutineStartAt, type RoutineScheduleDefinition } from '../../shared/routine-schedule'
import { assertRoutineSessionTarget, captureRoutineSessionTarget } from './routine-heartbeat-target'
import { normalizeRoutineGoalContinuation } from '../../shared/routine-heartbeat-types'

function binding(input: CreateRoutineInput | UpdateRoutineInput, previous?: Routine): Partial<Routine> {
  if (input.executionTarget === null) return { executionTarget: undefined }
  if (input.executionTarget === undefined) {
    if (previous?.executionTarget && input.enabled === true) {
      assertRoutineSessionTarget(previous.executionTarget, sessionManager.get(previous.executionTarget.sessionId)?.meta)
    }
    return {}
  }
  const raw = input.executionTarget
  if (!raw || raw.kind !== 'existing_session' || typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) throw new Error('请选择要定时继续的原任务。')
  const meta = sessionManager.get(raw.sessionId)?.meta
  const target = captureRoutineSessionTarget(meta)
  return { executionTarget: target, projectId: target.workspaceId, projectCwd: target.cwd,
    goalTemplateId: undefined, digitalWorkerId: undefined, providerId: '', model: '', engine: undefined,
    budgetUsd: 0, reasoningEffort: undefined, executionLocation: undefined, permissionMode: meta!.permissionMode }
}

function nextRun(definition: RoutineScheduleDefinition): number | null {
  const result = calculateRoutineSchedule(definition, Date.now())
  if (result.state === 'invalid') throw new Error(result.error)
  return result.nextRunAt
}

export async function createRoutineDefinition(root: string, input: CreateRoutineInput): Promise<Routine> {
  if (!input || typeof input !== 'object') throw new Error('定时任务参数无效。')
  const targetBinding = binding(input)
  const goalContinuation = normalizeRoutineGoalContinuation(input.goalContinuation)
  if (goalContinuation && (!targetBinding.executionTarget?.goalId || !targetBinding.executionTarget.workItemId)) throw new Error('持续推进需要当前任务关联的目标与分工。')
  if (goalContinuation) await assertSingleGoalContinuation(root, targetBinding.executionTarget!.sessionId)
  const { goalContinuationState: _state, scheduleState: _scheduleState, scheduleError: _scheduleError, ...definition } = input
  const schedule = String(input.schedule ?? input.frequency ?? '')
  const startAt = normalizeRoutineStartAt(input.startAt) ?? (isRRuleSchedule(schedule) ? Math.floor(Date.now() / 1000) * 1000 : undefined)
  return createRoutine(root, { ...definition, ...targetBinding, goalContinuation, startAt,
    ...(goalContinuation ? { id: `goal-continuation-${targetBinding.executionTarget!.sessionId}` } : {}),
    nextRunAt: nextRun({ schedule, timeZone: input.timeZone, startAt }) })
}

export async function updateRoutineDefinition(root: string, id: string, patch: UpdateRoutineInput): Promise<Routine | null> {
  const previous = (await listRoutines(root)).find((routine) => routine.id === id)
  if (!previous) return null
  if (!patch || typeof patch !== 'object') throw new Error('定时任务参数无效。')
  if (previous.goalContinuation && (patch.goalContinuation === null || patch.executionTarget === null ||
      (patch.executionTarget && patch.executionTarget.sessionId !== previous.executionTarget?.sessionId))) throw new Error('持续目标须保留原任务与轮数；请使用清除持续目标模式')
  const targetBinding = binding(patch, previous)
  const goalContinuation = patch.goalContinuation === undefined ? previous.goalContinuation : normalizeRoutineGoalContinuation(patch.goalContinuation)
  const target = targetBinding.executionTarget ?? previous.executionTarget
  if (goalContinuation && (!target?.goalId || !target.workItemId || patch.executionTarget === null)) throw new Error('持续推进需要当前任务关联的目标与分工。')
  if (goalContinuation) await assertSingleGoalContinuation(root, target!.sessionId, id)
  const { goalContinuationState: _state, scheduleState: _scheduleState, scheduleError: _scheduleError, ...definition } = patch
  const progress = previous.goalContinuationState
  if (goalContinuation && patch.enabled === true && (progress?.turns ?? 0) >= goalContinuation.maxTurns) throw new Error('已达到总轮数上限，请先提高轮数上限再恢复。')
  const schedule = patch.schedule ?? patch.frequency ?? previous.schedule
  const timeZone = patch.timeZone === undefined ? previous.timeZone : patch.timeZone
  const startAt = patch.startAt === undefined ? previous.startAt : patch.startAt
  const scheduleChanged = schedule !== previous.schedule || timeZone !== previous.timeZone || startAt !== previous.startAt || (patch.enabled === true && !previous.enabled)
  return updateRoutine(root, id, { ...definition, ...targetBinding, goalContinuation,
    ...(goalContinuation && patch.enabled === true && !previous.enabled && progress
      ? { goalContinuationState: { ...progress, repeatedResults: 0, resultDigest: undefined, exitedAt: undefined, status: 'active', reason: undefined } } : {}),
    ...(scheduleChanged ? { nextRunAt: nextRun({ schedule, timeZone, startAt }) } : {}), ...(patch.enabled === true ? { lastError: null } : {}) })
}

async function assertSingleGoalContinuation(root: string, sessionId: string, ownId?: string): Promise<void> {
  if ((await listRoutines(root)).some(routine => routine.id !== ownId && routine.goalContinuation && routine.executionTarget?.sessionId === sessionId)) {
    throw new Error('该任务已有持续推进计划，请编辑或恢复原计划。')
  }
}
