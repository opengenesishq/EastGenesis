import type { RoutingLegacyResolution, RoutingLegacyTransition, RoutingPreviewContext, RoutingRuleDraftV1, RoutingRuleFields } from '../../../../../shared/routing-policy-types'
import type { RoutingComparisonResolution, RoutingControllerState } from './routing-controller-types'
import { FAILURE_LABELS, RISK_LABELS, SELECTION_LABELS, STRATEGY_LABELS, TASK_LABELS } from './routing-form-options'

export function initialRoutingPreviewContext(sessionId: string | undefined, businessLineId: string, prompt = ''): RoutingPreviewContext {
  return sessionId ? { kind: 'session', sessionId, prompt }
    : { kind: 'new_task', businessLineId, prompt, routingIntent: { kind: 'global' } }
}

export function resolvePanelLegacy(state: RoutingControllerState, resolution: RoutingLegacyResolution): RoutingLegacyTransition | undefined {
  if (state.read?.mode !== 'legacy_active') return undefined
  return { legacyDigest: state.read.legacyDigest,
    resolutions: [...(state.migration?.resolutions ?? []).filter((item) => item.legacyIndex !== resolution.legacyIndex), resolution] }
}

/** Only the explicit review action adopts current versions. Retired identities never become new rules. */
export function reviewedPanelDraft(state: RoutingControllerState): { resolution?: RoutingComparisonResolution; reason?: string } {
  const current = state.comparison?.current
  if (!current || !state.draft) return { reason: '尚无可比较的规则。' }
  if (current.mode === 'invalid_v1') return { reason: '已保存规则暂时无法读取，请修复后重新读取。' }
  if (current.mode === 'legacy_active') {
    if (state.read?.mode !== 'legacy_active' || current.legacyDigest !== state.read.legacyDigest) {
      return { reason: '旧规则已变化，请采用最新内容后重新处理迁移。' }
    }
    return { resolution: { kind: 'use_reviewed_draft', draft: state.draft, migration: state.migration } }
  }
  const rules: RoutingRuleDraftV1[] = []
  for (const rule of state.draft.rules) {
    const saved = current.ruleSet.rules.find((item) => item.id === rule.id)
    if (current.ruleSet.retiredIdentities.some((item) => item.id === rule.id) || (!saved && rule.expectedVersion !== null)) {
      return { reason: `“${rule.name || '未命名规则'}”已被删除，请采用最新内容后另建规则。` }
    }
    if (saved && rule.expectedVersion === null) return { reason: `“${rule.name || '未命名规则'}”的标识已被使用，请采用最新内容后核对。` }
    rules.push({ ...rule, expectedVersion: saved?.version ?? null })
  }
  return { resolution: { kind: 'use_reviewed_draft', draft: { ...state.draft, rules } } }
}

export function summarizeRoutingRule(rule: RoutingRuleFields, providerName: (id: string) => string, lineName: (id: string) => string): string[] {
  const target = (item: { providerId: string; model: string }): string => `${providerName(item.providerId)} / ${item.model}`
  const selection = rule.selection
  let selectionText: string = SELECTION_LABELS[selection.kind]
  if (selection.kind === 'fixed') selectionText += `：${target(selection.target)}`
  if (selection.kind === 'provider_auto') selectionText += `：${providerName(selection.providerId)}`
  if (selection.kind === 'preferred') selectionText += `：首选 ${target(selection.primary)}；${selection.alternativesOrder === 'configured' ? '依次备选' : '评分备选'} ${selection.alternatives.map(target).join(selection.alternativesOrder === 'configured' ? ' → ' : '；') || '无'}`
  if (selection.kind === 'candidate_set') selectionText += `：${selection.targets.map(target).join('；')}`
  const when = rule.when, conditions: string[] = []
  if (when.keywords) conditions.push(`${when.keywords.mode === 'all' ? '包含全部' : '包含任一'}：${when.keywords.values.join('、')}`)
  if (when.taskKinds) conditions.push(`任务：${when.taskKinds.map((kind) => TASK_LABELS[kind]).join('、')}`)
  if (when.minRiskLevel) conditions.push(`最低风险：${RISK_LABELS[when.minRiskLevel]}`)
  if (when.whenStrategy) conditions.push(`任务偏好：${STRATEGY_LABELS[when.whenStrategy]}`)
  const failure = rule.failure
  return [rule.name || '未命名规则', `${rule.enabled ? '启用' : '停用'} · ${rule.scope.kind === 'global' ? '全局' : lineName(rule.scope.businessLineId)} · 优先级 ${rule.priority}`,
    conditions.length ? conditions.join('；') : '所有任务', selectionText, STRATEGY_LABELS[rule.strategy],
    failure.kind === 'pause' ? FAILURE_LABELS.pause : `${FAILURE_LABELS[failure.kind]} · 最多 ${failure.maxAdditionalAttempts} 次 · ${failure.retryOn.map((reason) => reason === 'rate_limited' ? '限流' : '认证失败').join('、')}`]
}
