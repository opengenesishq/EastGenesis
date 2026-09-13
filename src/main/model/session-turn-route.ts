import type { SendMessagePayload, SessionMeta } from '../../shared/types'
import type { ResolvedSessionRoute } from './session-runtime-routing'

const prepared = new WeakMap<SessionMeta, { messageId: string; route: ResolvedSessionRoute }>()

/** One selected target belongs to one user message; rejection/cancellation must clear it. */
export function prepareSessionTurnRoute(meta: SessionMeta, payload: SendMessagePayload, route: ResolvedSessionRoute): void {
  if (!payload.messageId) throw new Error('单轮路由缺少消息身份')
  prepared.set(meta, { messageId: payload.messageId, route })
}

export function takeSessionTurnRoute(meta: SessionMeta, payload: SendMessagePayload): ResolvedSessionRoute | undefined {
  const selected = prepared.get(meta)
  prepared.delete(meta)
  return selected && selected.messageId === payload.messageId ? selected.route : undefined
}

export function clearSessionTurnRoute(meta: SessionMeta): void { prepared.delete(meta) }
