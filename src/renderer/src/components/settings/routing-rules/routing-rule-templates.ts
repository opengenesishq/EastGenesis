import type { RoutingRuleDraftV1 } from '../../../../../shared/routing-policy-types'
import { ROUTING_RULE_LIMITS } from '../../../../../shared/routing-policy-parser'

export const ROUTING_RULE_TEMPLATES = [
  { id: 'balanced', label: '智能均衡', description: '自动平衡任务质量、费用和速度', strategy: 'balanced', when: {} },
  { id: 'quality', label: '质量优先', description: '任务优先选择质量更高的可用模型', strategy: 'quality', when: {} },
  { id: 'cost', label: '费用优先', description: '满足任务要求时优先选择费用较低的模型', strategy: 'cost', when: {} },
  { id: 'speed', label: '速度优先', description: '满足任务要求时优先选择更快的模型', strategy: 'speed', when: {} },
  { id: 'coding', label: '代码开发', description: '开发、测试和审查任务优先考虑质量', strategy: 'quality', when: { taskKinds: ['coding', 'testing', 'review'] } },
  { id: 'research', label: '研究与文档', description: '研究、摘要和文档任务自动选择合适模型', strategy: 'balanced', when: { taskKinds: ['research', 'summarization', 'documentation'] } }
] as const satisfies readonly { id: string; label: string; description: string; strategy: RoutingRuleDraftV1['strategy']; when: RoutingRuleDraftV1['when'] }[]

export type RoutingRuleTemplateId = typeof ROUTING_RULE_TEMPLATES[number]['id']

/** Templates create ordinary editable drafts. They never persist or bypass routing constraints. */
export function createRoutingRuleDraft(rules: readonly RoutingRuleDraftV1[], templateId?: RoutingRuleTemplateId): RoutingRuleDraftV1 {
  const template = ROUTING_RULE_TEMPLATES.find(item => item.id === templateId) ?? ROUTING_RULE_TEMPLATES[0]
  const baseName = templateId ? template.label : '自定义规则'
  let name = baseName, suffix = 2
  while (rules.some(rule => rule.name === name)) name = `${baseName} ${suffix++}`
  return {
    id: `route-${crypto.randomUUID()}`, name, enabled: true,
    priority: Math.min(ROUTING_RULE_LIMITS.maxPriority, Math.max(-1, ...rules.map(rule => rule.priority)) + 1),
    scope: { kind: 'global' }, when: JSON.parse(JSON.stringify(template.when)) as RoutingRuleDraftV1['when'],
    selection: { kind: 'global_auto' }, strategy: template.strategy, failure: { kind: 'pause' }, expectedVersion: null
  }
}
