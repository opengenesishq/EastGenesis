import type { RoutingFailurePolicy, RoutingRuleCondition, RoutingRuleDraftV1, RoutingSelection, RoutingTargetRef } from '../../../../../shared/routing-policy-types'

export function emptyTarget(): RoutingTargetRef { return { providerId: '', model: '' } }

/** An explicit provider change never selects a same-named model at the new provider implicitly. */
export function changeTargetProvider(target: RoutingTargetRef, providerId: string): RoutingTargetRef {
  return target.providerId === providerId ? target : { providerId, model: '' }
}
export function selectionWithKind(current: RoutingSelection, kind: RoutingSelection['kind']): RoutingSelection {
  if (current.kind === kind) return current
  const target = explicitTarget(current)
  switch (kind) {
    case 'global_auto': return { kind }
    case 'provider_auto': return { kind, providerId: target.providerId }
    case 'candidate_set': return { kind, targets: current.kind === 'preferred'
      ? [current.primary, ...current.alternatives].filter(hasTarget) : hasTarget(target) ? [target] : [] }
    case 'preferred': return { kind, primary: target,
      alternatives: current.kind === 'candidate_set' ? current.targets.slice(1) : [], alternativesOrder: 'configured' }
    case 'fixed': return { kind, target }
  }
}
function explicitTarget(selection: RoutingSelection): RoutingTargetRef {
  if (selection.kind === 'fixed') return { ...selection.target }
  if (selection.kind === 'preferred') return { ...selection.primary }
  if (selection.kind === 'provider_auto') return { providerId: selection.providerId, model: '' }
  if (selection.kind === 'candidate_set') return { ...(selection.targets[0] ?? emptyTarget()) }
  return emptyTarget()
}
function hasTarget(target: RoutingTargetRef): boolean { return Boolean(target.providerId && target.model) }

/** Selection and scoring are independent. An incompatible failure policy stays visible until repaired. */
export function changeRuleSelection(draft: RoutingRuleDraftV1, kind: RoutingSelection['kind']): RoutingRuleDraftV1 {
  return { ...draft, selection: selectionWithKind(draft.selection, kind) }
}
export function hasFixedCrossTargetRetry(draft: Pick<RoutingRuleDraftV1, 'selection' | 'failure'>): boolean {
  return draft.selection.kind === 'fixed' && draft.failure.kind === 'retry_allowed_targets'
}
export function failureWithKind(current: RoutingFailurePolicy, kind: RoutingFailurePolicy['kind']): RoutingFailurePolicy {
  if (current.kind === kind) return current
  if (kind === 'pause') return { kind }
  if (current.kind !== 'pause') return { ...current, kind }
  return { kind, maxAdditionalAttempts: 1, retryOn: ['rate_limited'] }
}
/** Clearing the last condition leaves an incomplete condition, never silently creates a catch-all. */
export function conditionWithMode(current: RoutingRuleCondition, mode: 'all' | 'conditions'): RoutingRuleCondition {
  if (mode === 'all') return {}
  return Object.keys(current).length ? current : { keywords: { mode: 'any', values: [] } }
}
export function withoutConditionField<K extends keyof RoutingRuleCondition>(condition: RoutingRuleCondition, field: K): RoutingRuleCondition {
  const next = { ...condition }; delete next[field]
  return Object.keys(next).length ? next : { keywords: { mode: 'any', values: [] } }
}
export function replaceTarget(targets: readonly RoutingTargetRef[], index: number, target: RoutingTargetRef): RoutingTargetRef[] {
  return targets.map((item, at) => at === index ? target : item)
}
export function moveTarget(targets: readonly RoutingTargetRef[], index: number, offset: -1 | 1): RoutingTargetRef[] {
  const next = [...targets], destination = index + offset
  if (index < 0 || index >= next.length || destination < 0 || destination >= next.length) return next
  ;[next[index], next[destination]] = [next[destination], next[index]]
  return next
}
export function toggleValue<T>(values: readonly T[], value: T, enabled: boolean): T[] {
  return enabled ? values.includes(value) ? [...values] : [...values, value] : values.filter((item) => item !== value)
}
