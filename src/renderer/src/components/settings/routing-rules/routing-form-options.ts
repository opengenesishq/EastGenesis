import type { RoutingFailurePolicy, RoutingRetryReason, RoutingRuleCondition, RoutingRuleDraftV1, RoutingSelection } from '../../../../../shared/routing-policy-types'

// Presentation dictionaries only. The shared parser remains the sole schema validator.
export const SELECTION_LABELS: Record<RoutingSelection['kind'], string> = {
  global_auto: '在全局允许的模型中自动选择', provider_auto: '在指定厂商内自动选择',
  candidate_set: '只在候选集合中选择', preferred: '使用首选和明确备选', fixed: '固定厂商和模型'
}
export const STRATEGY_LABELS: Record<RoutingRuleDraftV1['strategy'], string> = {
  balanced: '均衡', quality: '质量优先', cost: '成本优先', speed: '速度优先'
}
export const FAILURE_LABELS: Record<RoutingFailurePolicy['kind'], string> = {
  pause: '暂停并提示', retry_same_target: '在原目标重试', retry_allowed_targets: '在允许目标内重试'
}
export const RETRY_LABELS: Record<RoutingRetryReason, string> = {
  rate_limited: '请求明确因限流被拒绝', auth_failed: '请求明确因认证失败被拒绝'
}
export const TASK_LABELS: Record<NonNullable<RoutingRuleCondition['taskKinds']>[number], string> = {
  chat: '对话', coding: '代码', reasoning: '推理', vision: '图片理解', toolUse: '工具使用',
  longContext: '长上下文', review: '审查', summarization: '摘要', research: '研究', planning: '计划',
  testing: '测试', documentation: '文档'
}
export const RISK_LABELS: Record<NonNullable<RoutingRuleCondition['minRiskLevel']>, string> = {
  low: '低', medium: '中', high: '高'
}
export function options<T extends string>(labels: Record<T, string>): Array<{ value: T; label: string }> {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))
}
