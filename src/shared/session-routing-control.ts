import type { SessionRoutingControl, SessionRoutingProjection } from './session-routing-control-types'
import { sessionRoutingControl } from './session-routing-control-types'
import { readFailure, readRoutingProviderId, readRoutingTargetRef, readSelection } from './routing-policy-parser'
import { discriminant, record } from './routing-policy-parse-fields'

export function normalizeSessionRoutingControl(value: unknown, meta: SessionRoutingProjection): SessionRoutingControl {
  const kind = discriminant(value, '$')
  if (kind === 'locked') {
    const row = record(value, '$', ['kind', 'target'])
    return { kind, target: readRoutingTargetRef(row.target, '$.target') }
  }
  if (kind === 'preferred') {
    const row = record(value, '$', ['kind', 'primary', 'alternatives', 'failure'])
    const selection = readSelection({ kind, primary: row.primary, alternatives: row.alternatives }, '$')
    if (selection.kind !== 'preferred') throw new Error('请选择有效的首选模型。')
    return { ...selection, failure: readFailure(row.failure, '$.failure') }
  }
  if (kind === 'auto') {
    const row = record(value, '$', ['kind'], ['scope'])
    if (row.scope === undefined) {
      const previous = sessionRoutingControl(meta)
      return { kind, scope: previous.kind === 'auto' && previous.scope ? previous.scope
        : meta.routingScope === 'global' ? { kind: 'global' } : { kind: 'provider', providerId: meta.providerId } }
    }
    const scopeKind = discriminant(row.scope, '$.scope')
    if (scopeKind === 'global') { record(row.scope, '$.scope', ['kind']); return { kind, scope: { kind: 'global' } } }
    const scope = record(row.scope, '$.scope', ['kind', 'providerId'])
    if (scopeKind !== 'provider') throw new Error('自动选择范围必须是全部连接或指定连接。')
    return { kind, scope: { kind: 'provider', providerId: readRoutingProviderId(scope.providerId, '$.scope.providerId') } }
  }
  throw new Error('路由控制必须是自动、优先指定或锁定。')
}
