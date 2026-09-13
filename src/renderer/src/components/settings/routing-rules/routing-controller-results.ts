import type { RoutingRulePreviewResult, RoutingRuleReadResult, RoutingRuleSaveResult } from '../../../../../shared/routing-policy-types'
import type { RoutingControllerState } from './routing-controller-types'
import { adoptRoutingRead, routingOutcomeUnknown } from './routing-controller-state'

function pendingMatches(state: RoutingControllerState, requestId: number, kind: 'read' | 'preview' | 'save'): boolean {
  return state.pending?.requestId === requestId && state.pending.kind === kind
}
export function receiveRoutingRead(state: RoutingControllerState, requestId: number, result: RoutingRuleReadResult): RoutingControllerState {
  if (!pendingMatches(state, requestId, 'read')) return state
  const next = { ...state, pending: undefined, error: undefined }
  if (routingOutcomeUnknown(state)) return { ...next, comparison: { kind: 'unknown', current: structuredClone(result) } }
  if (state.dirty || state.comparison) return { ...next, comparison: { kind: 'refresh', current: structuredClone(result) } }
  return adoptRoutingRead(next, result)
}
export function receiveRoutingPreview(state: RoutingControllerState, requestId: number, result: RoutingRulePreviewResult): RoutingControllerState {
  if (!pendingMatches(state, requestId, 'preview')) return state
  return { ...state, pending: undefined, preview: structuredClone(result), error: undefined }
}
export function receiveRoutingSave(state: RoutingControllerState, requestId: number, result: RoutingRuleSaveResult): RoutingControllerState {
  if (!pendingMatches(state, requestId, 'save')) return state
  const next: RoutingControllerState = { ...state, pending: undefined, lastSave: structuredClone(result), error: undefined }
  switch (result.status) {
    case 'saved': return adoptRoutingRead(next, { mode: 'v1_active', ruleSet: result.ruleSet, catalogDigest: result.catalogDigest, diagnostics: result.diagnostics })
    case 'conflict': return { ...next, comparison: { kind: 'conflict', current: structuredClone(result.current) } }
    case 'invalid': return next
    case 'storage_error': return result.commitState === 'unknown' ? rememberUnknownSave(state, next) : next
  }
}
function rememberUnknownSave(state: RoutingControllerState, next: RoutingControllerState): RoutingControllerState {
  if (state.pending?.kind !== 'save' || !state.read) return next
  return { ...next, uncertainSave: { input: structuredClone(state.pending.input), originalRead: structuredClone(state.read), reviewed: false } }
}
/** IPC rejection while saving is a local unknown state, not a fabricated server receipt. */
export function rejectRoutingOperation(state: RoutingControllerState, requestId: number, message: string): RoutingControllerState {
  if (state.pending?.requestId !== requestId) return state
  const next: RoutingControllerState = { ...state, pending: undefined, error: { kind: 'transport', message } }
  if (state.pending.kind !== 'save') return next
  return rememberUnknownSave(state, { ...next, error: { kind: 'save_outcome_unknown', message } })
}
