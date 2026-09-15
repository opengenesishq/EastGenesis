import type { ProviderHealthView, ProviderCircuitState } from './types'

/**
 * Shared, non-secret interpretation of persisted Provider health.
 * An open circuit is blocked, a half-open circuit is reserved for one
 * recovery probe, and an unprobed connection remains explicitly unknown.
 */
export type ProviderHealthCheckState = 'healthy' | 'degraded' | 'unhealthy' | 'unprobed'
export type ProviderHealthCheckAccess = 'automatic' | 'probe_only' | 'blocked'
export type ProviderHealthProbeState = 'passed' | 'failed' | 'unknown'
export type ProviderHealthCheckReason =
  | 'ready'
  | 'recent_failures'
  | 'probe_failed'
  | 'circuit_open'
  | 'circuit_half_open'
  | 'health_flagged'
  | 'missing_observation'

export interface ProviderHealthCheck {
  providerId: string
  state: ProviderHealthCheckState
  access: ProviderHealthCheckAccess
  circuitState: ProviderCircuitState
  probeState: ProviderHealthProbeState
  reason: ProviderHealthCheckReason
}

export function summarizeProviderHealth(health: ProviderHealthView | undefined): ProviderHealthCheck {
  if (!health) return {
    providerId: '', state: 'unprobed', access: 'probe_only', circuitState: 'closed',
    probeState: 'unknown', reason: 'missing_observation'
  }

  const probeState = latestProbeState(health)
  if (health.circuitState === 'open') return result(health, 'unhealthy', 'blocked', probeState, 'circuit_open')
  if (health.circuitState === 'half_open') return result(health, 'degraded', 'probe_only', probeState, 'circuit_half_open')
  if (!health.healthy) return result(health, 'unhealthy', 'blocked', probeState, 'health_flagged')
  if (probeState === 'failed') return result(health, 'unhealthy', 'blocked', probeState, 'probe_failed')
  if (probeState === 'unknown' && health.successes === 0 && health.failures === 0) {
    return result(health, 'unprobed', 'probe_only', probeState, 'missing_observation')
  }
  if (health.recentFailures.length > 0) return result(health, 'degraded', 'automatic', probeState, 'recent_failures')
  return result(health, 'healthy', 'automatic', probeState, 'ready')
}

function latestProbeState(health: ProviderHealthView): ProviderHealthProbeState {
  const successAt = health.lastProbeSuccessAt ?? 0
  const failureAt = health.lastProbeFailureAt ?? 0
  if (successAt > 0 || failureAt > 0) return failureAt > successAt ? 'failed' : 'passed'
  const probeFailures = health.probeFailures ?? 0
  const probeSuccesses = health.probeSuccesses ?? 0
  if (probeFailures > 0 && probeSuccesses === 0) return 'failed'
  if (probeSuccesses > 0 && probeFailures === 0) return 'passed'
  return 'unknown'
}

function result(
  health: ProviderHealthView,
  state: ProviderHealthCheckState,
  access: ProviderHealthCheckAccess,
  probeState: ProviderHealthProbeState,
  reason: ProviderHealthCheckReason
): ProviderHealthCheck {
  return { providerId: health.providerId, state, access, circuitState: health.circuitState, probeState, reason }
}
