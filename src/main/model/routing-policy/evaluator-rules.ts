import { parseRoutingRuleSet, parseRoutingRuleSetDraft } from '../../../shared/routing-policy-parser'
import type { RoutingDiagnostic, RoutingRuleCondition } from '../../../shared/routing-policy-types'
import type { TaskProfile } from '../model-profile'
import type { EffectiveRoutingPolicy, EvaluatedRule, RoutingRuleSourceInput, TrustedRoutingContext } from './evaluator-types'

export function readEvaluatorRules(input: RoutingRuleSourceInput):
  { ok: true; rules: EvaluatedRule[] } | { ok: false; diagnostics: RoutingDiagnostic[] } {
  if (input.kind === 'saved') {
    const parsed = parseRoutingRuleSet(input.value)
    if (parsed.ok) return { ok: true, rules: parsed.value.rules }
    return { ok: false, diagnostics: (parsed as { ok: false; diagnostics: RoutingDiagnostic[] }).diagnostics }
  }
  if (input.kind !== 'draft') return { ok: false, diagnostics: [issue('INVALID_VALUE', '$.rules.kind', 'Expected a saved set or preview draft; invalid V1 never enters legacy routing.')] }
  const parsed = parseRoutingRuleSetDraft(input.value)
  if (parsed.ok === false) return { ok: false, diagnostics: parsed.diagnostics }
  const missing = parsed.value.rules.filter((rule) => !Object.hasOwn(input.sourcesById, rule.id) || !input.sourcesById[rule.id])
  if (missing.length) return { ok: false, diagnostics: missing.map((rule) => issue(
    'INVALID_VALUE', `$.rules.${rule.id}.source`, 'Main must resolve draft provenance before evaluation.', rule.id)) }
  return { ok: true, rules: parsed.value.rules.map((rule) => {
    const { expectedVersion, ...fields } = rule
    return { ...fields, version: expectedVersion, source: input.sourcesById[rule.id] }
  }) }
}

/** The only rule scope/priority/condition interpreter. Recovery consumes its output. */
export function matchRoutingRules(rules: EvaluatedRule[], context: TrustedRoutingContext, task: TaskProfile): {
  matched: EvaluatedRule[]; overriddenRuleIds: string[]; conflicts: RoutingDiagnostic[]
} {
  const matches = rules.filter((rule) => rule.enabled && scopeMatches(rule, context)
    && conditionMatches(rule.when, context.originalPrompt, task, context.baseStrategy))
  if (!matches.length) return { matched: [], overriddenRuleIds: [], conflicts: [] }
  const scoped = matches.some((rule) => rule.scope.kind === 'business_line')
    ? matches.filter((rule) => rule.scope.kind === 'business_line') : matches
  const priority = Math.max(...scoped.map((rule) => rule.priority))
  const matched = scoped.filter((rule) => rule.priority === priority).sort((a, b) => a.id.localeCompare(b.id))
  const selected = new Set(matched.map((rule) => rule.id))
  const conflicts: RoutingDiagnostic[] = matched.length < 2 ? [] : [{
    ...issue('PRIORITY_CONFLICT', '$.rules', 'Multiple matching rules have equal scope and priority.'),
    relatedRuleIds: matched.map((rule) => rule.id)
  }]
  return { matched, overriddenRuleIds: matches.filter((rule) => !selected.has(rule.id)).map((rule) => rule.id).sort(), conflicts }
}

export function effectivePolicy(rule: EvaluatedRule | undefined, context: TrustedRoutingContext): EffectiveRoutingPolicy {
  if (rule) return { selection: rule.selection, strategy: rule.strategy, failure: rule.failure, source: 'matched_rule' }
  return { selection: { kind: 'global_auto' }, strategy: context.baseStrategy,
    failure: { kind: 'pause' }, source: 'explicit_v1_default' }
}

function scopeMatches(rule: EvaluatedRule, context: TrustedRoutingContext): boolean {
  return rule.scope.kind === 'global' || rule.scope.businessLineId === context.businessLine.id
}

function conditionMatches(condition: RoutingRuleCondition, prompt: string, task: TaskProfile, baselineStrategy: TaskProfile['strategy']): boolean {
  if (condition.whenStrategy && condition.whenStrategy !== baselineStrategy) return false
  if (condition.taskKinds && !condition.taskKinds.some((kind) => task.taskKinds.includes(kind))) return false
  if (condition.minRiskLevel && riskRank(task.riskLevel) < riskRank(condition.minRiskLevel)) return false
  if (!condition.keywords) return true
  const text = prompt.toLocaleLowerCase('en-US')
  const matches = condition.keywords.values.map((value) => text.includes(value.toLocaleLowerCase('en-US')))
  return condition.keywords.mode === 'all' ? matches.every(Boolean) : matches.some(Boolean)
}

function riskRank(level: TaskProfile['riskLevel']): number { return { low: 0, medium: 1, high: 2 }[level] }

export function issue(code: RoutingDiagnostic['code'], path: string, message: string, ruleId?: string): RoutingDiagnostic {
  return { code, severity: 'error', path, message, ...(ruleId ? { ruleId } : {}) }
}
