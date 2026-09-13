export type OfficePrewarmTrigger = 'app-idle' | 'pointer-intent' | 'keyboard-intent'

export interface OfficePrewarmSnapshot {
  firstTrigger: OfficePrewarmTrigger | null
  triggers: Array<{ trigger: OfficePrewarmTrigger; atEpochMs: number }>
  moduleRequestedAtEpochMs: number | null
  moduleReadyAtEpochMs: number | null
  shellMountedAtEpochMs: number | null
  moduleRequestCount: number
}

const state: OfficePrewarmSnapshot = {
  firstTrigger: null,
  triggers: [],
  moduleRequestedAtEpochMs: null,
  moduleReadyAtEpochMs: null,
  shellMountedAtEpochMs: null,
  moduleRequestCount: 0
}

type OfficePrewarmWindow = Window & { __caogenOfficePrewarm?: OfficePrewarmSnapshot }

function nowEpochMs(): number {
  return performance.timeOrigin + performance.now()
}

export function readOfficePrewarmSnapshot(): OfficePrewarmSnapshot {
  return {
    ...state,
    triggers: state.triggers.map((entry) => ({ ...entry }))
  }
}

function publish(): void {
  if (typeof window === 'undefined') return
  ;(window as OfficePrewarmWindow).__caogenOfficePrewarm = readOfficePrewarmSnapshot()
}

export function recordOfficePrewarmTrigger(trigger: OfficePrewarmTrigger): void {
  state.firstTrigger ??= trigger
  state.triggers.push({ trigger, atEpochMs: nowEpochMs() })
  publish()
}

export function recordOfficeModuleRequested(): void {
  state.moduleRequestCount += 1
  state.moduleRequestedAtEpochMs ??= nowEpochMs()
  publish()
}

export function recordOfficeModuleReady(): void {
  state.moduleReadyAtEpochMs ??= nowEpochMs()
  publish()
}

export function recordOfficeShellMounted(): void {
  state.shellMountedAtEpochMs ??= nowEpochMs()
  publish()
}
