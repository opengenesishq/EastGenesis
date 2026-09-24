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
    ...(!blocked && result.status === 'ready' ? { initialTarget: result.initialTarget, explanation: previewExplanation(result) } : {}),
    allowedAlternatives: !blocked && result.status === 'ready' ? result.allowedAlternatives : [],
    excludedTargets: result.excludedTargets,
    conflicts: diagnostics.filter((item) => item.code === 'PRIORITY_CONFLICT'), diagnostics,
    limitations: { kind: 'local_configuration_only', providerRequestsMade: false, realTaskVerified: false } }
}

function previewExplanation(result: Extract<RoutingEvaluationResult, { status: 'ready' }>): NonNullable<RoutingRulePreviewResult['explanation']> {
  const sameTarget = (left: { providerId: string; model: string }, right: { providerId: string; model: string }): boolean =>
    left.providerId === right.providerId && left.model === right.model
  const strategy = { balanced: '均衡', quality: '质量优先', cost: '费用优先', speed: '速度优先' }[result.effectivePolicy.strategy]
  const selection = result.effectivePolicy.selection
  const selectionReason = selection.kind === 'fixed' ? '规则锁定此厂商和模型，选择偏好不会更换目标。'
    : selection.kind === 'preferred' ? `规则要求先使用首选模型，备选仅在允许的失败条件下参与。${selection.alternativesOrder === 'configured' ? '模型切换遵循你设置的备选顺序；下一目标不合格时暂停。' : '备选由系统评分选择。'}`
      : result.modelDecision.manualOverrideApplied ? '当前任务明确指定的目标或本地优先策略决定了选择。'
        : `通过本次约束检查的 ${result.qualifiedTargets.length} 个模型，按“${strategy}”排序后选择此目标。`
  return { selectionReason, taskKinds: [...result.task.taskKinds], warnings: [...result.modelDecision.warnings],
    candidates: result.rankedCandidates.map((candidate) => {
      const target = { providerId: candidate.profile.providerId, model: candidate.profile.model }
      return { target, selected: sameTarget(target, result.initialTarget), reasons: [...candidate.reasons],
        pricingBasis: result.pricing.find((row) => sameTarget(row.target, target))?.basis ?? 'heuristic_estimate',
        acceptanceSamples: candidate.scoreBreakdown.acceptanceSamples }
    }) }
}
