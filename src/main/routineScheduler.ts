import { listRoutines, updateRoutine, type Routine } from './routineStore'
import { calculateRoutineSchedule } from '../shared/routine-schedule'

/**
 * Routine 定时调度器(主进程内)。
 *
 * - 每 `intervalMs`(默认 30s)轮询一次 routine store。
 * - 对 `enabled` 且 `nextRunAt <= now` 的 routine 触发 `onTrigger(routine)`。
 * - 触发后按 `schedule` 计算下一个 `nextRunAt` 并 `markRun`。
 * - `enabled` 但缺失 `nextRunAt` 的 routine 会被回填(不立即触发),使调度器自洽。
 *
 * 触发回调由 index.ts 注入,用于起会话跑 `routine.prompt`。
 */

export type RoutineTriggerCallback = (routine: Routine, nextRunAt: number | null) => void | Promise<void>

export interface StartRoutineSchedulerOptions {
  onTick?: () => Promise<void>
  /** routine store 的根目录(同 ipc.ts 的 routineStoreRoot(),即 userData/routines) */
  rootDir: string
  /** 触发回调:拿到到点的 routine,由调用方决定如何起会话 */
  onTrigger: RoutineTriggerCallback
  /** 轮询间隔,毫秒。默认 30000 */
  intervalMs?: number
  /** 可注入的时钟,便于测试。默认 Date.now */
  now?: () => number
}

interface SchedulerState {
  onTick?: () => Promise<void>
  timer: ReturnType<typeof setInterval>
  rootDir: string
  onTrigger: RoutineTriggerCallback
  now: () => number
  /** 防止上一轮异步 tick 未完又进入下一轮 */
  ticking: boolean
}

const DEFAULT_INTERVAL_MS = 30_000

let state: SchedulerState | null = null

/** 启动调度器(幂等:重复调用会先停旧的再起新的) */
export function startRoutineScheduler(opts: StartRoutineSchedulerOptions): void {
  stopRoutineScheduler()
  const intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS
  const now = opts.now ?? Date.now
  const local: SchedulerState = {
    timer: setInterval(() => {
      void runTick(local)
    }, intervalMs),
    rootDir: opts.rootDir,
    onTrigger: opts.onTrigger,
    now,
    ticking: false,
    onTick: opts.onTick
  }
  // Node 定时器:不要阻止进程退出
  if (typeof local.timer.unref === 'function') local.timer.unref()
  state = local
  // 启动即跑一轮,不必等第一个 interval
  void runTick(local)
}

/** 停止调度器(幂等) */
export function stopRoutineScheduler(): void {
  if (!state) return
  clearInterval(state.timer)
  state = null
}

/** 是否正在运行(便于测试/诊断) */
export function isRoutineSchedulerRunning(): boolean {
  return state !== null
}

async function runTick(local: SchedulerState): Promise<void> {
  // 若调度器已被替换/停止,或上一轮仍在跑,跳过
  if (state !== local || local.ticking) return
  local.ticking = true
  try {
    await local.onTick?.()
    const now = local.now()
    const routines = await listRoutines(local.rootDir)
    for (const routine of routines) {
      if (state !== local) break
      if (!routine.enabled || routine.scheduleState === 'exhausted' || routine.scheduleState === 'invalid') continue

      const nextRunAt = typeof routine.nextRunAt === 'number' ? routine.nextRunAt : null

      if (nextRunAt === null) {
        // enabled 但没排期:回填一个 nextRunAt,本轮不触发
        const seeded = calculateRoutineSchedule(routine, now)
        if (seeded.nextRunAt !== null) await safeUpdateNextRun(local.rootDir, routine, seeded.nextRunAt)
        else await updateRoutine(local.rootDir, routine.id, { nextRunAt: null, scheduleState: seeded.state, scheduleError: seeded.error }, routine)
        continue
      }

      if (nextRunAt > now) continue

      // 到点:先触发回调,再排下一次
      try {
        const upcoming = calculateRoutineSchedule(routine, now)
        if (upcoming.state === 'invalid') {
          await updateRoutine(local.rootDir, routine.id, { nextRunAt: null, scheduleState: 'invalid', scheduleError: upcoming.error }, routine)
          continue
        }
        await local.onTrigger(routine, upcoming.nextRunAt)
      } catch (err) {
        console.error('[caogen] routine 触发回调异常:', routine.id, err)
      }

    }
  } catch (err) {
    console.error('[caogen] routine 调度轮询失败:', err)
  } finally {
    local.ticking = false
  }
}

async function safeUpdateNextRun(rootDir: string, routine: Routine, nextRunAt: number): Promise<void> {
  try {
    await updateRoutine(rootDir, routine.id, { nextRunAt }, routine)
  } catch (err) {
    console.error('[caogen] routine 回填 nextRunAt 失败:', routine.id, err)
  }
}

/** Compatibility entry; all scheduling paths share the same computation. */
export function computeNextRun(schedule: string, from: number, options: { timeZone?: string; startAt?: number } = {}): number | null {
  return calculateRoutineSchedule({ schedule, ...options }, from).nextRunAt
}
