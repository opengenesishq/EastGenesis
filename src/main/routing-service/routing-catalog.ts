import { createDefaultBusinessLines, parseBusinessLine, type BusinessLineDefinition } from '../../shared/business-line-types'
import type { ProviderView } from '../../shared/types'
import type { RoutingDiagnostic, RoutingRuleFields, RoutingTargetRef } from '../../shared/routing-policy-types'
import { buildRoutingCatalog, resolveCatalogTarget } from '../model/routing-policy/evaluator-catalog'
import type { RoutingCatalogEntry } from '../model/routing-policy/evaluator-types'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { copyNormalizedSettingsCandidate } from '../routing-settings/routing-settings-json'
import { rejectSettings } from '../routing-settings/routing-settings-state'
import type { RoutingCatalogValidation, RoutingSettingsDocument } from '../routing-settings/routing-settings-types'

/** Raw invalid definitions must not turn into enabled defaults at a routing boundary. */
export function readRoutingBusinessLines(document: RoutingSettingsDocument): BusinessLineDefinition[] {
  const lines = new Map(createDefaultBusinessLines().map((line) => [line.id, line]))
  if (!Object.hasOwn(document, 'businessLines')) return [...lines.values()]
  const raw = document.businessLines
  if (!Array.isArray(raw) || raw.length > 100) return invalidRegistry()
  const seen = new Set<string>()
  for (const item of raw) {
    const line = parseBusinessLine(item)
    if (!line || seen.has(line.id)) return invalidRegistry()
    seen.add(line.id)
    lines.set(line.id, line)
  }
  return [...lines.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function invalidRegistry(): never {
  return rejectSettings('BUSINESS_LINE_UNAVAILABLE', '$.businessLines', '业务线配置无效，无法验证规则范围。')
}

/** No endpoint/header/credential values are returned or hashed into this catalog. */
export function buildRoutingSettingsCatalog(input: {
  document: RoutingSettingsDocument; providers: ProviderView[]; rules: readonly RoutingRuleFields[]
  connectionIdentities: ReadonlyMap<string, string>
}): RoutingCatalogValidation {
  const lines = readRoutingBusinessLines(input.document)
  const entries = buildRoutingCatalog(input.providers)
  const diagnostics = input.rules.flatMap((rule) => validateRuleCatalog(rule, entries, lines))
  const providers = input.providers.map((provider) => {
    const identity = input.connectionIdentities.get(provider.id)
    if (!identity) rejectSettings('CATALOG_VALIDATION_FAILED', '$.catalog', '连接缺少主进程配置身份，无法验证目录。')
    return { id: provider.id, name: provider.name, engine: provider.engine, ready: provider.ready, connectionIdentity: identity }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const catalog = copyNormalizedSettingsCandidate({ schemaVersion: 1, executionDomain: 'native_text', providers,
    models: entries.map((entry) => ({ target: entry.target, profile: entry.profile, pricingBasis: entry.pricingBasis })),
    businessLines: lines, schedulerStrategy: input.document.schedulerStrategy,
    routingExpertPolicy: input.document.routingExpertPolicy, budgetUsdPerSession: input.document.budgetUsdPerSession,
    budgetUsdPerMonth: input.document.budgetUsdPerMonth })
  return { catalog, diagnostics }
}

function validateRuleCatalog(rule: RoutingRuleFields, entries: RoutingCatalogEntry[], lines: BusinessLineDefinition[]): RoutingDiagnostic[] {
  const diagnostics: RoutingDiagnostic[] = []
  if (rule.scope.kind === 'business_line') {
    const id = rule.scope.businessLineId
    if (!lines.some((line) => line.id === id && line.enabled)) diagnostics.push(issue(rule, 'BUSINESS_LINE_UNAVAILABLE', 'scope', '业务线不存在或已停用。'))
  }
  const selection = rule.selection
  if (selection.kind === 'provider_auto' && !entries.some((entry) => entry.provider.id === selection.providerId && usable(entry))) {
    diagnostics.push(issue(rule, 'TARGET_UNAVAILABLE', 'selection', '指定厂商没有可用的文本模型。'))
  }
  for (const target of explicitTargets(rule)) {
    const entry = resolveCatalogTarget(entries, target)
    if (!entry || !usable(entry)) diagnostics.push(issue(rule, 'TARGET_UNAVAILABLE', 'selection', `目标不可用：${target.providerId} / ${target.model}`))
  }
  return diagnostics
}

function explicitTargets(rule: RoutingRuleFields): RoutingTargetRef[] {
  switch (rule.selection.kind) {
    case 'candidate_set': return rule.selection.targets
    case 'preferred': return [rule.selection.primary, ...rule.selection.alternatives]
    case 'fixed': return [rule.selection.target]
    default: return []
  }
}

function usable(entry: RoutingCatalogEntry): boolean {
  if (!entry.provider.ready || entry.profile.supportsText === false) return false
  try {
    const { provider, target } = entry
    const resolved = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: entry.profile.model })
    const canonical = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: target.model })
    const wireModel = (model: string) => provider.engine === 'gemini' ? model.replace(/^models\//, '') : model
    return wireModel(resolved.model) === target.model && wireModel(canonical.model) === target.model
  } catch { return false }
}
function issue(rule: RoutingRuleFields, code: RoutingDiagnostic['code'], field: string, message: string): RoutingDiagnostic {
  return { code, severity: 'error', ruleId: rule.id, path: `$.rules.${rule.id}.${field}`, message }
}
