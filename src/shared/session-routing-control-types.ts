import type { RoutingFailurePolicy, RoutingTargetRef, RoutingUserIntent } from './routing-policy-types'
import type { SessionRoutingScope } from './types'

/** A task-local choice. It never edits the global routing rule set. */
export type SessionRoutingControl =
  | { kind: 'auto'; scope?: { kind: 'global' } | { kind: 'provider'; providerId: string } }
  | { kind: 'preferred'; primary: RoutingTargetRef; alternatives: RoutingTargetRef[]; failure: RoutingFailurePolicy }
  | { kind: 'locked'; target: RoutingTargetRef }

export interface SessionRoutingProjection {
  providerId: string
  model: string
  routingScope?: SessionRoutingScope
  routingControl?: SessionRoutingControl
}

/** Legacy sessions keep their original provider/global boundary. */
export function sessionRoutingControl(meta: SessionRoutingProjection): SessionRoutingControl {
  if (meta.routingControl) return meta.routingControl
  if (meta.model !== 'auto') return { kind: 'locked', target: { providerId: meta.providerId, model: meta.model } }
  return { kind: 'auto', scope: meta.routingScope === 'global'
    ? { kind: 'global' } : { kind: 'provider', providerId: meta.providerId } }
}

export function sessionRoutingIntent(meta: SessionRoutingProjection): RoutingUserIntent {
  const control = sessionRoutingControl(meta)
  if (control.kind === 'locked') return { kind: 'fixed', target: control.target }
  if (control.kind === 'preferred') return { kind: 'global' }
  return control.scope ?? (meta.routingScope === 'global' ? { kind: 'global' } : { kind: 'provider', providerId: meta.providerId })
}
