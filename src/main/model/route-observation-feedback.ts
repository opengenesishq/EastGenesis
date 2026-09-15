import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { WorkflowRunRecord } from '../../shared/workflow-types'
import { frozenRoutingPolicyForRun } from '../task/frozen-routing-policy'
import { routeObservationKey, type RouteObservationIdentity, type RouteObservationSignal } from './route-observation-signal'

/** Never infer the connection that produced an old attempt from today's Provider settings. */
export function attemptObservationIdentity(attempt: ModelAttemptRecord,
  run: WorkflowRunRecord | undefined): RouteObservationIdentity | undefined {
  if (!run || run.id !== attempt.runId || run.projectId !== attempt.projectId ||
      run.goalId !== attempt.goalId || run.workItemId !== attempt.workItemId) return undefined
  const policy = frozenRoutingPolicyForRun(run.taskRun)
  if (!policy) return undefined
  if (policy.owner.runId !== run.id || policy.owner.projectId !== run.projectId ||
      policy.owner.goalId !== run.goalId || policy.owner.workItemId !== run.workItemId) return undefined
  const matches = policy.qualifiedTargets.filter((target) => target.providerId === attempt.providerId &&
    target.model === attempt.model && target.protocol === attempt.protocol)
  if (matches.length !== 1) return undefined
  const { providerId, model, protocol, connectionIdentity } = matches[0]
  return { providerId, model, protocol, connectionIdentity: { ...connectionIdentity } }
}

/** Verified existing attempts, ordered by completion, own all transport observations. */
export function deriveRouteObservationSnapshot(input: {
  runs: readonly WorkflowRunRecord[]; attempts: readonly ModelAttemptRecord[]
}): Map<string, RouteObservationSignal> {
  const runs = new Map(input.runs.map((run) => [run.id, run]))
  const result = new Map<string, RouteObservationSignal>()
  for (const attempt of [...input.attempts].sort((a, b) =>
    (a.completedAt ?? 0) - (b.completedAt ?? 0) || a.id.localeCompare(b.id))) {
    // Cancellation and unknown outcome say nothing about transport reliability.
    if (attempt.status !== 'succeeded' && attempt.status !== 'failed') continue
    if (attempt.outcome === 'unknown' || attempt.completedAt === undefined) continue
    const identity = attemptObservationIdentity(attempt, runs.get(attempt.runId))
    if (!identity) continue
    const key = routeObservationKey(identity)
    const signal = result.get(key) ?? { ...identity, successes: 0, failures: 0, reliability: 0.5 }
    if (attempt.status === 'succeeded') {
      signal.successes += 1
      if (attempt.latencyMs !== undefined && Number.isFinite(attempt.latencyMs) && attempt.latencyMs > 0) {
        signal.latencyEmaMs = signal.latencyEmaMs === undefined ? attempt.latencyMs
          : Math.round(signal.latencyEmaMs * 0.7 + attempt.latencyMs * 0.3)
      }
    } else signal.failures += 1
    const total = signal.successes + signal.failures
    const confidence = Math.min(1, total / 5)
    signal.reliability = signal.successes / total * confidence + 0.5 * (1 - confidence)
    result.set(key, signal)
  }
  return result
}
