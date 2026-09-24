import type { SessionMeta } from '../../../../shared/types'
import type { SessionRoutingControl } from '../../../../shared/session-routing-control-types'
import type { RoutingTargetRef } from '../../../../shared/routing-policy-types'

export function sessionRoutingForm(meta: SessionMeta | undefined): SessionRoutingControl {
  const change = meta?.modelChange?.state === 'prepared' ? meta.modelChange.to : undefined
  const saved = change?.routingControl ?? meta?.routingControl
  if (saved) return structuredClone(saved)
  const model = change?.model ?? meta?.model ?? 'auto'
  const providerId = change?.providerId ?? meta?.providerId ?? ''
  const scope = change?.routingScope ?? meta?.routingScope
  return model !== 'auto' ? { kind: 'locked', target: { providerId, model } }
    : { kind: 'auto', scope: scope === 'global' ? { kind: 'global' } : { kind: 'provider', providerId } }
}

export function routingFormTarget(control: SessionRoutingControl): RoutingTargetRef {
  return control.kind === 'locked' ? control.target : control.kind === 'preferred' ? control.primary : { providerId: '', model: '' }
}

export function changeRoutingFormKind(control: SessionRoutingControl, kind: SessionRoutingControl['kind']): SessionRoutingControl {
  if (control.kind === kind) return control
  const target = routingFormTarget(control)
  if (kind === 'auto') return { kind: 'auto', scope: target.providerId
    ? { kind: 'provider', providerId: target.providerId } : { kind: 'global' } }
  return kind === 'locked' ? { kind, target } : { kind, primary: target, alternatives: [], failure: { kind: 'pause' } }
}

export function sessionRoutingLabel(meta: SessionMeta, zh: boolean): string {
  const control = sessionRoutingForm(meta)
  if (control.kind === 'preferred') return `${zh ? '优先' : 'Prefer'} · ${control.primary.model}`
  if (control.kind === 'locked') return `${zh ? '锁定' : 'Lock'} · ${control.target.model}`
  return zh ? '智能路由' : 'Smart routing'
}
