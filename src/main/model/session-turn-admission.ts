import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../../shared/types'
import { ModelRouteError } from './model-route-error'

export interface SessionTurnTarget {
  providerId: string
  model: string
}

/** Automatic sessions must arrive with a route selected for this message. */
export function assertSessionTurnRouteAvailable(metaModel: string, route?: SessionTurnTarget): void {
  if (metaModel.trim() === AUTO_MODEL && !route) {
    throw new ModelRouteError(
      'ROUTING_NO_CANDIDATES',
      '自动会话缺少本轮冻结路由，已阻止协议适配器重新选择 Provider 首个模型。'
    )
  }
}

/**
 * Admit the target selected for one message before a protocol adapter resolves
 * endpoint details.  A prepared route is authoritative; the fallback is only
 * for explicit non-auto sessions.  In particular, this boundary must never
 * pass `auto` through to Provider runtime-target resolution, which otherwise
 * defaults to the Provider's first saved model.
 */
export function admitSessionTurnTarget(input: {
  route?: SessionTurnTarget
  fallback: SessionTurnTarget
}): SessionTurnTarget {
  const selected = input.route ?? input.fallback
  const providerId = selected.providerId?.trim() ?? ''
  const model = selected.model?.trim() ?? ''
  if (!providerId || providerId === AUTO_PROVIDER_ID || !model || model === AUTO_MODEL) {
    throw new ModelRouteError(
      'ROUTING_NO_CANDIDATES',
      '本轮路由没有冻结的具体 Provider/Model，已阻止协议适配器回退到 Provider 首个模型。'
    )
  }
  return { providerId, model }
}
