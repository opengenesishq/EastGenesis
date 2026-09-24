import type { AgentEvent, EngineKind, SendMessagePayload, SessionMeta } from '../../shared/types'
import { AUTO_MODEL } from '../../shared/types'
import type { AnthropicEngineDependencies } from '../anthropic-engine-dependencies'
import { assertRoutingExpertTargetAllowed } from './routing-expert-policy'
import { resolveRuntimeSessionRoute, sessionRouteEvent } from './session-runtime-routing'
import { ModelRouteError, isModelRouteError } from './model-route-error'
import { takeSessionTurnRoute } from './session-turn-route'
import { admitSessionTurnTarget, assertSessionTurnRouteAvailable } from './session-turn-admission'
import { captureNativeSessionRecovery } from './native-recovery-session'
import { withTaskReasoning } from '../../shared/task-reasoning'

/** Resolve the whole Provider/model pair before building protocol-specific wire data. */
export function resolveNativeSessionTarget(input: {
  meta: SessionMeta
  dependencies: AnthropicEngineDependencies
  emit: (event: AgentEvent) => void
  payload?: SendMessagePayload
}) {
  const { meta, dependencies, emit, payload } = input
  const settings = dependencies.getSettings()
  const route = payload ? takeSessionTurnRoute(meta, payload) ?? resolveRuntimeSessionRoute({
    meta: { ...meta, engine: dependencies.recoveryEngineKind }, payload,
    settings, providers: dependencies.listProviders()
  }) : undefined
  // `start()` calls this helper without a payload to validate saved Provider
  // credentials and initialize the UI.  The strict admission applies to a
  // physical message request; startup keeps its non-networking legacy target
  // projection until that request supplies a frozen route.
  if (payload) assertSessionTurnRouteAvailable(meta.model, route)
  const decision = route?.decision ?? (meta.model === AUTO_MODEL ? meta.modelRoutingDecision : undefined)
  // A prepared/frozen route is the sole source of the physical target. Never
  // feed `auto` to a protocol resolver: Provider runtime-target resolution
  // intentionally treats that sentinel as "first saved model" for legacy
  // callers, which would silently diverge from the canonical Run route.
  const fallbackProviderId = route?.providerId ?? meta.providerId
  const fallbackModel = decision?.providerId === fallbackProviderId ? decision.model : meta.model
  const admitted = payload
    ? admitSessionTurnTarget({ route, fallback: { providerId: fallbackProviderId, model: fallbackModel } })
    : { providerId: fallbackProviderId, model: fallbackModel }
  const target = dependencies.resolveTarget(admitted)
  target.credentialProvider = withTaskReasoning(target.credentialProvider, meta.reasoningEffort, dependencies.recoveryEngineKind)
  assertRoutingExpertTargetAllowed(target.providerId, target.baseUrl, settings.routingExpertPolicy)
  if (route && target.model !== route.model) {
    throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', 'Provider 的模型映射与自动路由结果不一致，请修正模型配置后重试。')
  }
  if (route) {
    meta.providerId = target.providerId
    meta.modelRoutingDecision = route.decision
    emit(sessionRouteEvent(route))
    emit({ kind: 'meta', meta: { ...meta } })
  }
  if (payload) captureNativeSessionRecovery({ meta, target, route,
    providers: dependencies.listProviders(), settings })
  return target
}

export function nativeModelProtocol(engine: EngineKind): 'anthropic.messages' | 'google.generative-language' {
  return engine === 'gemini' ? 'google.generative-language' : 'anthropic.messages'
}

export function nativeModelErrorSubtype(error: unknown): 'routing-blocked' | 'error' {
  return isModelRouteError(error) ? 'routing-blocked' : 'error'
}
