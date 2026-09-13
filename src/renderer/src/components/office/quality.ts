import type { OfficeQualityMode } from '../../../../shared/types'

export type OfficeQualityTier = Exclude<OfficeQualityMode, 'auto'>
export type OfficeContactShadowMode = 'dynamic' | 'static' | 'off'

export interface OfficeQualityProfile {
  dpr: number | [number, number]
  shadows: boolean
  shadowMapSize: number
  contactShadows: OfficeContactShadowMode
  contactShadowFrames: number
  contactShadowResolution: number
}

export const OFFICE_QUALITY_PROFILES: Record<OfficeQualityTier, OfficeQualityProfile> = {
  high: {
    dpr: [1, 1.5],
    shadows: true,
    shadowMapSize: 1024,
    contactShadows: 'static',
    contactShadowFrames: 2,
    contactShadowResolution: 512
  },
  balanced: {
    dpr: [0.85, 1],
    shadows: false,
    shadowMapSize: 0,
    contactShadows: 'static',
    contactShadowFrames: 2,
    contactShadowResolution: 256
  },
  low: {
    dpr: 0.8,
    shadows: false,
    shadowMapSize: 0,
    contactShadows: 'off',
    contactShadowFrames: 0,
    contactShadowResolution: 256
  }
}

export function officeResolutionDpr(tier: OfficeQualityTier, mode: 'sharp' | 'adaptive', deviceRatio: number): number | [number, number] {
  if (mode === 'adaptive') {
    // Adaptive mode is the performance contract for integrated GPUs. Keep the
    // explicit sharp mode at native density, while giving the control room a
    // bounded lower pixel budget before it has to hide real task actors.
    if (tier === 'balanced') return [0.7, 0.82]
    if (tier === 'low') return 0.6
    // Adaptive High keeps realtime shadow quality while capping pixel fill on
    // integrated GPUs. Sharp mode remains native Retina/native-DPR when the
    // user explicitly requests it; this bound only applies to adaptive mode.
    return [0.7, 0.85]
  }
  return Math.max(1, Math.min(2, Number.isFinite(deviceRatio) ? deviceRatio : 1))
}

export interface OfficeFrameSummary {
  medianFrameMs: number
  p95FrameMs: number
}

export interface OfficeAutoQualityState {
  tier: OfficeQualityTier
  healthyWindows: number
  overloadedWindows: number
  lastChangedAt: number
  upgradeBlockedUntil: number
  upgradeFailures: number
  probationTier: OfficeQualityTier | null
  probationUntil: number
  lastTransition: 'initial' | 'upgrade' | 'downgrade'
}

const QUALITY_ORDER: OfficeQualityTier[] = ['low', 'balanced', 'high']
const AUTO_MIN_DOWNGRADE_INTERVAL_MS = 4_000
const AUTO_DOWNGRADE_WINDOWS = 2
const AUTO_MIN_UPGRADE_INTERVAL_MS = 12_000
const AUTO_UPGRADE_WINDOWS = 6
const AUTO_UPGRADE_PROBATION_MS = 8_000
const AUTO_UPGRADE_BACKOFF_MS = 60_000

const AUTO_THRESHOLDS: Record<
  OfficeQualityTier,
  { degradeMedianMs: number; degradeP95Ms: number; upgradeMedianMs: number; upgradeP95Ms: number }
> = {
  high: { degradeMedianMs: 24, degradeP95Ms: 35, upgradeMedianMs: 0, upgradeP95Ms: 0 },
  balanced: { degradeMedianMs: 34, degradeP95Ms: 50, upgradeMedianMs: 18, upgradeP95Ms: 26 },
  low: { degradeMedianMs: Infinity, degradeP95Ms: Infinity, upgradeMedianMs: 30, upgradeP95Ms: 42 }
}

export function initialOfficeAutoQuality(now = 0): OfficeAutoQualityState {
  return {
    tier: 'balanced',
    healthyWindows: 0,
    overloadedWindows: 0,
    lastChangedAt: now,
    upgradeBlockedUntil: 0,
    upgradeFailures: 0,
    probationTier: null,
    probationUntil: 0,
    lastTransition: 'initial'
  }
}

export function summarizeOfficeFrameTimes(samples: number[]): OfficeFrameSummary {
  if (samples.length === 0) return { medianFrameMs: 0, p95FrameMs: 0 }
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  return { medianFrameMs: at(0.5), p95FrameMs: at(0.95) }
}

export function nextOfficeAutoQuality(
  state: OfficeAutoQualityState,
  sample: OfficeFrameSummary,
  now: number
): OfficeAutoQualityState {
  const thresholds = AUTO_THRESHOLDS[state.tier]
  const overloaded =
    sample.medianFrameMs > thresholds.degradeMedianMs || sample.p95FrameMs > thresholds.degradeP95Ms
  const probationSucceeded =
    state.probationTier !== null &&
    now >= state.probationUntil &&
    state.overloadedWindows === 0 &&
    !overloaded
  const current = probationSucceeded
    ? {
        ...state,
        upgradeFailures: 0,
        probationTier: null,
        probationUntil: 0,
        lastTransition: 'initial' as const
      }
    : state
  const tierIndex = QUALITY_ORDER.indexOf(current.tier)
  const timeSinceChange = now - current.lastChangedAt

  if (overloaded) {
    const overloadedWindows = current.overloadedWindows + 1
    if (
      timeSinceChange >= AUTO_MIN_DOWNGRADE_INTERVAL_MS &&
      overloadedWindows >= AUTO_DOWNGRADE_WINDOWS &&
      tierIndex > 0
    ) {
      const upgradeFailures =
        current.probationTier !== null ? current.upgradeFailures + 1 : current.upgradeFailures
      const backoff = AUTO_UPGRADE_BACKOFF_MS * 2 ** Math.min(upgradeFailures, 2)
      return {
        ...current,
        tier: QUALITY_ORDER[tierIndex - 1],
        healthyWindows: 0,
        overloadedWindows: 0,
        lastChangedAt: now,
        upgradeBlockedUntil: now + backoff,
        upgradeFailures,
        probationTier: null,
        probationUntil: 0,
        lastTransition: 'downgrade'
      }
    }
    return { ...current, healthyWindows: 0, overloadedWindows }
  }

  const healthy =
    sample.medianFrameMs < thresholds.upgradeMedianMs && sample.p95FrameMs < thresholds.upgradeP95Ms
  const healthyWindows = healthy ? current.healthyWindows + 1 : 0
  if (
    healthy &&
    timeSinceChange >= AUTO_MIN_UPGRADE_INTERVAL_MS &&
    now >= current.upgradeBlockedUntil &&
    healthyWindows >= AUTO_UPGRADE_WINDOWS &&
    tierIndex < QUALITY_ORDER.length - 1
  ) {
    return {
      ...current,
      tier: QUALITY_ORDER[tierIndex + 1],
      healthyWindows: 0,
      overloadedWindows: 0,
      lastChangedAt: now,
      probationTier: current.tier,
      probationUntil: now + AUTO_UPGRADE_PROBATION_MS,
      lastTransition: 'upgrade'
    }
  }
  return { ...current, healthyWindows, overloadedWindows: 0 }
}
