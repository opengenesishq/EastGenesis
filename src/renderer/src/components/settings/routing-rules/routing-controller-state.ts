import type { RoutingLegacyTransition, RoutingPreviewContext, RoutingRuleReadResult, RoutingRuleSetDraftV1 } from '../../../../../shared/routing-policy-types'
import type { RoutingComparisonResolution, RoutingControllerState } from './routing-controller-types'

export function createRoutingControllerState(): RoutingControllerState {
  return { read: null, draft: null, dirty: false, nextRequestId: 1 }
}
export function routingOutcomeUnknown(state: RoutingControllerState): boolean {
  return Boolean(state.uncertainSave && !state.uncertainSave.reviewed)
}
export function routingEditBlocked(state: RoutingControllerState): boolean {
  return Boolean(state.pending) || routingOutcomeUnknown(state) || state.read?.mode === 'invalid_v1'
}
export function editRoutingDraft(state: RoutingControllerState, draft: RoutingRuleSetDraftV1): RoutingControllerState {
  if (routingEditBlocked(state)) return state
  return { ...state, draft: structuredClone(draft), selectedRuleId: retainedSelection(draft, state.selectedRuleId), dirty: true, preview: undefined, error: undefined }
}
export function selectRoutingRule(state: RoutingControllerState, id: string): RoutingControllerState {
  if (state.pending || !state.draft?.rules.some((rule) => rule.id === id)) return state
  return state.selectedRuleId === id ? state : { ...state, selectedRuleId: id }
}
export function editRoutingMigration(state: RoutingControllerState, migration: RoutingLegacyTransition): RoutingControllerState {
  if (routingEditBlocked(state)) return state
  return { ...state, migration: structuredClone(migration), dirty: true, preview: undefined, error: undefined }
}
export function setRoutingPreviewContext(state: RoutingControllerState, context: RoutingPreviewContext): RoutingControllerState {
  if (state.pending) return state
  return { ...state, context: structuredClone(context), preview: undefined }
}
/** Only a trusted read or an actual saved receipt supplies versions/source for the local base. */
export function adoptRoutingRead(state: RoutingControllerState, read: RoutingRuleReadResult): RoutingControllerState {
  if (read.mode === 'invalid_v1') return { ...state, read: structuredClone(read), preview: undefined }
  const draft: RoutingRuleSetDraftV1 = { schemaVersion: 1, rules: read.mode === 'v1_active'
    ? read.ruleSet.rules.map(({ version, source: _source, ...fields }) => ({ ...fields, expectedVersion: version })) : [] }
  return { ...state, read: structuredClone(read), draft: structuredClone(draft), selectedRuleId: retainedSelection(draft, state.selectedRuleId), dirty: false, preview: undefined,
    migration: read.mode === 'legacy_active' ? { legacyDigest: read.legacyDigest, resolutions: [] } : undefined }
}
/** Call only from an explicit compare/review action, never automatically after get/read completes. */
export function resolveRoutingComparison(state: RoutingControllerState, resolution: RoutingComparisonResolution): RoutingControllerState {
  if (state.pending || !state.comparison || state.comparison.current.mode === 'invalid_v1') return state
  const reviewed = { ...state, comparison: undefined, lastSave: undefined, error: undefined,
    uncertainSave: state.uncertainSave ? { ...state.uncertainSave, reviewed: true } : undefined }
  if (resolution.kind === 'adopt_latest') return adoptRoutingRead(reviewed, state.comparison.current)
  return { ...reviewed, read: structuredClone(state.comparison.current), draft: structuredClone(resolution.draft),
    selectedRuleId: retainedSelection(resolution.draft, state.selectedRuleId), migration: structuredClone(resolution.migration), dirty: true, preview: undefined }
}
function retainedSelection(draft: RoutingRuleSetDraftV1, selectedId?: string | null): string | null {
  return draft.rules.some((rule) => rule.id === selectedId) ? selectedId! : draft.rules[0]?.id ?? null
}
