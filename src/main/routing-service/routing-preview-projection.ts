import type { RoutingDiagnostic, RoutingPreviewReceipt, RoutingRulePreviewResult, RoutingRuleSetDraftV1, RoutingRuleSource } from '../../shared/routing-policy-types'
import { validateRoutingRuleDraftBase } from '../../shared/routing-policy-command-parser'
import { buildRoutingCatalog } from '../model/routing-policy/evaluator-catalog'
import type { RoutingEvaluationResult } from '../model/routing-policy/evaluator-types'
import { assertSettingsDiagnostics, rejectSettings } from '../routing-settings/routing-settings-state'
import { copyNormalizedSettingsCandidate, routingSettingsDigest } from '../routing-settings/routing-settings-json'
import type { StoredRoutingState } from '../routing-settings/routing-settings-types'
import type { RoutingPreviewCapture } from './routing-preview-types'

export function trustedDraftSources(state: StoredRoutingState, draft: RoutingRuleSetDraftV1): Record<string, RoutingRuleSource> {
  const sources: Record<string, RoutingRuleSource> = Object.create(null)
  if (state.mode === 'v1_active') assertSettingsDiagnostics(validateRoutingRuleDraftBase(state.ruleSet, draft))
  for (const rule of draft.rules) {
    if (state.mode === 'legacy_active' && rule.expectedVersion !== null) {
      rejectSettings('RULE_VERSION_CONFLICT', '$.draft.rules', '首次迁移不能引用尚不存在的规则版本。')
    }
    sources[rule.id] = state.mode === 'v1_active'
      ? state.ruleSet.rules.find((saved) => saved.id === rule.id)?.source ?? { kind: 'user' } : { kind: 'user' }
  }
  return sources
}

/** Full routing observations are bound, without copying endpoint/header/secret data. */
export function routingPreviewContextDigest(capture: RoutingPreviewCapture): string {
  const snapshots = capture.snapshots
  return routingSettingsDigest(copyNormalizedSettingsCandidate({ context: capture.context, authority: capture.authority,
    expertPolicy: snapshots.expertPolicy, budget: snapshots.budget, eligibility: snapshots.targetEligibility,
    health: snapshots.providerHealth, scoringSignals: snapshots.scoringSignals,
    models: buildRoutingCatalog(snapshots.providers).map((entry) => ({ target: entry.target, profile: entry.profile, pricingBasis: entry.pricingBasis })) }))
}

export function projectRoutingPreview(result: RoutingEvaluationResult, receipt: RoutingPreviewReceipt,
  catalogDiagnostics: RoutingDiagnostic[]): RoutingRulePreviewResult {
  const diagnostics = [...catalogDiagnostics, ...result.diagnostics]
  const blocked = result.status === 'blocked' || diagnostics.some((item) => item.severity === 'error')
  return { ...receipt, status: blocked ? 'blocked' : 'ready',
    matchedRules: result.matchedRules.map((rule) => ({ id: rule.id, expectedVersion: rule.version, scope: rule.scope, source: rule.source })),
    ...(result.effectivePolicy ? { effectivePolicy: { selection: result.effectivePolicy.selection,
      strategy: result.effectivePolicy.strategy, failure: result.effectivePolicy.failure } } : {}),
    ...(!blocked && result.status === 'ready' ? { initialTarget: result.initialTarget } : {}),
    allowedAlternatives: !blocked && result.status === 'ready' ? result.allowedAlternatives : [],
    excludedTargets: result.excludedTargets,
    conflicts: diagnostics.filter((item) => item.code === 'PRIORITY_CONFLICT'), diagnostics,
    limitations: { kind: 'local_configuration_only', providerRequestsMade: false, realTaskVerified: false } }
}
