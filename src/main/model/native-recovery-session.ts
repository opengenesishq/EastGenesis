import type { AppSettings, ProviderView, RoutingExpertPolicy, SendMessagePayload, SessionMeta } from '../../shared/types'
import { getBusinessLines } from '../../shared/business-line-types'
import { getSettings } from '../settings'
import { listProviders } from '../providers'
import { ModelRouteError } from './model-route-error'
import { assertRoutingExpertTargetAllowed, providerAllowedByRoutingExpertPolicy } from './routing-expert-policy'
import { createNativeRecoveryAnchor, assertNativeRecoveryTargetAllowed,
  type NativeRecoveryAnchor, type NativeRecoveryCapability, type NativeRecoveryCheck, type NativeRecoveryTarget } from './native-recovery-eligibility'
import { resolveRuntimeSessionRoute, type ResolvedSessionRoute } from './session-runtime-routing'
import { takeSessionTurnRoute } from './session-turn-route'
import { admitSessionTurnTarget, assertSessionTurnRouteAvailable } from './session-turn-admission'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { assertFrozenRunRequestTarget, frozenRoutingPolicyForRun } from '../task/frozen-routing-policy'
import { getProviderConnectionIdentity } from '../providers'
import type { FrozenNativeProtocol, FrozenRunRoutingPolicyV1 } from '../../shared/frozen-routing-types'
import type { RoutingRetryReason } from '../../shared/routing-policy-types'
import { resolveNativeExecutorProtocol } from './executor-compatibility'

export type FrozenRetryProjection = Readonly<Pick<FrozenRunRoutingPolicyV1, 'initialTarget' | 'retryTargets' | 'effectivePolicy'>>
export type NativeSessionRecoveryContext = Pick<NativeRecoveryCheck, 'anchor' | 'currentRequiredCapabilities'> & { initialExpertPolicy: RoutingExpertPolicy; frozenRetry?: FrozenRetryProjection }
const turnAnchors = new WeakMap<SessionMeta, { anchor: NativeRecoveryAnchor; initialExpertPolicy: RoutingExpertPolicy; frozenRetry?: FrozenRetryProjection }>()

/** Initial selection owns this snapshot. Recovery must never recapture after it mutates SessionMeta. */
export function captureNativeSessionRecovery(input: {
  meta: SessionMeta; target: NativeRecoveryTarget; route?: ResolvedSessionRoute
  providers?: ProviderView[]; settings?: AppSettings
}): void {
  const settings = input.settings ?? getSettings()
  const catalog = input.route?.recoveryCatalog
  const providers = (input.providers ?? listProviders()).filter((provider) =>
    providerAllowedByRoutingExpertPolicy(provider, settings.routingExpertPolicy)).map((provider) => catalog
      ? { ...provider, models: provider.models.filter((model) => catalog.some((target) => target.providerId === provider.id && target.model === model)) }
      : provider)
  const task = input.route?.recoveryTask
  const requiredCapabilities: NativeRecoveryCapability[] = [...businessLineCapabilities(input.meta, settings)]
  if (task?.requiresTools) requiredCapabilities.push('tools')
  if (task?.requiresVision) requiredCapabilities.push('vision')
  const anchor = createNativeRecoveryAnchor({ meta: input.meta, target: input.target, providers,
    ruleTarget: input.route?.recoveryRuleTarget, requiredCapabilities, minContextTokens: task?.minContextTokens })
  const initialExpertPolicy = { allowedProviderIds: [...(settings.routingExpertPolicy.allowedProviderIds ?? [])], locality: settings.routingExpertPolicy.locality,
    allowedRegions: [...(settings.routingExpertPolicy.allowedRegions ?? [])], allowedDomains: [...(settings.routingExpertPolicy.allowedDomains ?? [])], requiredPermissions: [...(settings.routingExpertPolicy.requiredPermissions ?? [])] }
  Object.freeze(initialExpertPolicy.allowedProviderIds)
  const run = taskRuntimeRegistry.get(input.meta.id)
  const frozen = run && frozenRoutingPolicyForRun(run)
  turnAnchors.set(input.meta, { anchor, initialExpertPolicy: Object.freeze(initialExpertPolicy),
    ...(frozen ? { frozenRetry: Object.freeze({ initialTarget: frozen.initialTarget, retryTargets: frozen.retryTargets, effectivePolicy: frozen.effectivePolicy }) } : {}) })
}

export function frozenRetryAllows(input: {
  recovery: NativeSessionRecoveryContext
  providerId: string
  model: string
  protocol: FrozenNativeProtocol
  attempt: number
  refusal?: { outcome: RoutingRetryReason }
}): boolean {
  const policy = input.recovery.frozenRetry
  if (!policy || !input.refusal) return !policy
  const failure = policy.effectivePolicy.failure
  if (failure.kind === 'pause' || input.attempt > failure.maxAdditionalAttempts || !failure.retryOn.includes(input.refusal.outcome)) return false
  const same = (target: { providerId: string; model: string; protocol: FrozenNativeProtocol }) =>
    target.providerId === input.providerId && target.model === input.model && target.protocol === input.protocol
  if (failure.kind === 'retry_same_target') return same(policy.initialTarget)
  return [policy.initialTarget, ...policy.retryTargets].some(same)
}

export function nativeSessionRecoveryContext(meta: SessionMeta, settings = getSettings()): NativeSessionRecoveryContext {
  const frozen = turnAnchors.get(meta)
  if (!frozen) throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '本轮缺少初始故障恢复范围，已阻止重新选择目标。')
  const run = taskRuntimeRegistry.get(meta.id)
  const policy = run && frozenRoutingPolicyForRun(run)
  const frozenRetry = frozen.frozenRetry ?? (policy ? Object.freeze({ initialTarget: policy.initialTarget, retryTargets: policy.retryTargets, effectivePolicy: policy.effectivePolicy }) : undefined)
  return { ...frozen, ...(frozenRetry ? { frozenRetry } : {}), currentRequiredCapabilities: businessLineCapabilities(meta, settings) }
}

export function assertNativeSessionRecoveryTarget(meta: SessionMeta, target: NativeRecoveryTarget & { baseUrl: string },
  providers = listProviders(), settings = getSettings()): void {
  assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, settings.routingExpertPolicy)
  const recovery = nativeSessionRecoveryContext(meta, settings)
  assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, recovery.initialExpertPolicy)
  const provider = providers.find((item) => item.id === target.providerId)
  if (!provider) throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '本轮目标连接已不存在。')
  assertNativeRecoveryTargetAllowed({ ...recovery, provider, model: target.model })
  // The recovery anchor bounds the logical turn.  The canonical Run policy is
  // the final physical-request gate and also detects a rotated/deleted
  // Provider connection between attempts.
  const run = taskRuntimeRegistry.get(meta.id)
  const frozen = run && frozenRoutingPolicyForRun(run)
  // Legacy/unscoped sessions do not have a canonical WorkItem Run.  Their
  // existing recovery anchor remains the authority until SessionManager has
  // created the canonical binding.  A canonical Run, once present, is always
  // checked below and cannot silently fall back to mutable SessionMeta.
  if (!frozen) return
  const protocol = resolveNativeExecutorProtocol(provider, target.model)
  try {
    assertFrozenRunRequestTarget({ run, providerId: target.providerId, model: target.model, protocol,
      connectionIdentity: getProviderConnectionIdentity(target.providerId) })
  } catch (error) {
    if (error instanceof ModelRouteError) throw error
    throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  }
}

export function resolveOpenAiSessionTurnRoute(meta: SessionMeta, payload: SendMessagePayload, fixedModel: string) {
  const route = takeSessionTurnRoute(meta, payload) ?? resolveRuntimeSessionRoute({ meta: { ...meta, engine: 'openai' }, payload })
  assertSessionTurnRouteAvailable(meta.model, route)
  const fallback = { providerId: meta.providerId, model: fixedModel }
  const target = admitSessionTurnTarget({ route, fallback })
  captureNativeSessionRecovery({ meta, target, route })
  return route
}

function businessLineCapabilities(meta: SessionMeta, settings: AppSettings) {
  if (!meta.businessLineId) return []
  const line = getBusinessLines(settings).find((item) => item.id === meta.businessLineId)
  if (!line?.enabled) throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '业务线已停用或不存在，不能继续请求。')
  return line.requiredCapabilities ?? []
}
