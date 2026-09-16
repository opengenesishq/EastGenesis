import { resolve } from 'node:path'
import { resumeProjectPermanentDeletionEffects } from '../project-deletion-effect'
import { resumeSessionDeletions } from './session-deletion-coordinator'
import { sweepMemoryRetention } from '../memory/memory-retention'
import { resolveMemoryRoot } from '../memory/memory-root'

const SWEEP_INTERVAL_MS = 30_000

interface SchedulerState {
  root: string
  timer?: NodeJS.Timeout
  running?: Promise<void>
  rerun: boolean
}

let scheduler: SchedulerState | undefined

export function startDataRetentionExpiryScheduler(userDataRoot: string): void {
  stopDataRetentionExpiryScheduler()
  scheduler = { root: requiredRoot(userDataRoot), rerun: false }
  schedule(0)
}

export function requestDataRetentionExpirySweep(): void {
  if (!scheduler) return
  schedule(0)
}

export function stopDataRetentionExpiryScheduler(): void {
  if (scheduler?.timer) clearTimeout(scheduler.timer)
  scheduler = undefined
}

function schedule(delay: number): void {
  const state = scheduler
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = undefined
    void sweep(state)
  }, delay)
  state.timer.unref?.()
}

async function sweep(state: SchedulerState): Promise<void> {
  if (scheduler !== state) return
  if (state.running) {
    state.rerun = true
    return
  }
  state.running = performSweep(state.root).finally(() => {
    state.running = undefined
  })
  await state.running
  if (scheduler !== state) return
  const delay = state.rerun ? 0 : SWEEP_INTERVAL_MS
  state.rerun = false
  schedule(delay)
}

async function performSweep(root: string): Promise<void> {
  try {
    await sweepMemoryRetention(resolveMemoryRoot(root))
  } catch (error) {
    console.error('[caogen] Memory retention expiry sweep failed:', error)
  }
  try {
    await resumeProjectPermanentDeletionEffects(root)
  } catch (error) {
    console.error('[caogen] Project retention expiry sweep failed:', error)
  }
  try {
    await resumeSessionDeletions(root)
  } catch (error) {
    console.error('[caogen] Session retention expiry sweep failed:', error)
  }
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('userDataRoot is required')
  }
  return resolve(value)
}
