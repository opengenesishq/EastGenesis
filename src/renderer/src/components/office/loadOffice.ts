type OfficeViewModule = typeof import('./OfficeView')

import {
  recordOfficeModuleReady,
  recordOfficeModuleRequested,
  recordOfficePrewarmTrigger
} from './officePrewarm'

let officeViewPromise: Promise<OfficeViewModule> | null = null
let cancelScheduledIdlePrewarm: (() => void) | null = null
// Keep the heavy 3D surface out of the first useful Assistant frame. An
// idle callback may run immediately on a quiet renderer, so it still needs a
// deliberate quiet-period delay before requesting the Office chunk.
const OFFICE_IDLE_PREWARM_DELAY_MS = 5_000

type OptionalIdleApi = {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  cancelIdleCallback?: (handle: number) => void
}

export function loadOfficeView(): Promise<OfficeViewModule> {
  if (!officeViewPromise) {
    recordOfficeModuleRequested()
    officeViewPromise = import('./OfficeView')
      .then((module) => {
        recordOfficeModuleReady()
        return module
      })
      .catch((error: unknown) => {
        officeViewPromise = null
        throw error
      })
  }
  return officeViewPromise
}

export function preloadOfficeView(): void {
  void loadOfficeView().catch(() => undefined)
}

async function prepareOfficeResourcesDuringIdle(): Promise<void> {
  try {
    await loadOfficeView()
    // Warm only the loader module. Calling loadPalaceResource here would parse
    // the multi-megabyte GLB on the main thread before the first useful frame.
    await import('./kit/palace/palaceResource')
  } catch {
    // The visible entry retries module loading. Palace parsing is deliberately
    // owned by the staged renderer so idle prewarm cannot block first pixels.
  }
}

export function cancelOfficeIdlePrewarm(): void {
  cancelScheduledIdlePrewarm?.()
  cancelScheduledIdlePrewarm = null
}

export function scheduleOfficeIdlePrewarm(): () => void {
  cancelOfficeIdlePrewarm()
  const idleApi = window as unknown as OptionalIdleApi
  let frameId = 0
  let idleId = 0
  let timeoutId = 0
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    if (frameId) window.cancelAnimationFrame(frameId)
    if (idleId) idleApi.cancelIdleCallback?.(idleId)
    if (timeoutId) window.clearTimeout(timeoutId)
    if (cancelScheduledIdlePrewarm === cancel) cancelScheduledIdlePrewarm = null
  }

  frameId = window.requestAnimationFrame(() => {
    if (cancelled) return
    timeoutId = window.setTimeout(() => {
      if (cancelled) return
      const run = (): void => {
        if (cancelled) return
        cancelScheduledIdlePrewarm = null
        recordOfficePrewarmTrigger('app-idle')
        void prepareOfficeResourcesDuringIdle()
      }
      if (idleApi.requestIdleCallback) {
        idleId = idleApi.requestIdleCallback(run, { timeout: 2_000 })
      } else {
        run()
      }
    }, OFFICE_IDLE_PREWARM_DELAY_MS)
  })
  cancelScheduledIdlePrewarm = cancel
  return cancel
}
