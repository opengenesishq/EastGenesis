import { isBusinessLineId } from './business-line-types'
import type { ModelRoutingTaskKind, SchedulerStrategy } from './types'
import type {
  RoutingFailurePolicy, RoutingRuleCondition, RoutingRuleDraftV1, RoutingRuleFields, RoutingRuleScope,
  RoutingRuleSetDraftV1, RoutingRuleSetV1, RoutingRuleSource, RoutingRuleV1, RoutingSelection, RoutingTargetRef
} from './routing-policy-types'
import { boolean, digest, discriminant, fail, integer, list, oneOf, parseResult, record, stableId, string, unique } from './routing-policy-parse-fields'
import { readRoutingLegacyMigrationRecord, readRoutingRetiredIdentities } from './routing-policy-history-parser'
import { assertSavedRoutingHistory } from './routing-policy-history-validation'

const STRATEGIES = ['balanced', 'quality', 'cost', 'speed'] as const satisfies readonly SchedulerStrategy[]
const TASK_KINDS = ['chat', 'coding', 'reasoning', 'vision', 'toolUse', 'longContext', 'review', 'summarization', 'research', 'planning', 'testing', 'documentation'] as const satisfies readonly ModelRoutingTaskKind[]
const RULE_FIELDS = ['id', 'name', 'enabled', 'priority', 'scope', 'when', 'selection', 'strategy', 'failure'] as const
export const ROUTING_RULE_LIMITS = Object.freeze({ rules: 100, targets: 32, keywords: 32, retries: 5, maxPriority: 1_000_000 })

export function parseRoutingRuleSet(value: unknown) {
  return parseResult<RoutingRuleSetV1>(() => {
    const row = record(value, '$', ['schemaVersion', 'revision', 'rules', 'retiredIdentities'], ['legacyMigration'])
    schemaVersion(row.schemaVersion)
    const revision = integer(row.revision, '$.revision', 1)
    const parsed: RoutingRuleSetV1 = { schemaVersion: 1, revision, rules: ruleList(row.rules, readSavedRule),
      retiredIdentities: readRoutingRetiredIdentities(row.retiredIdentities, revision),
      ...(row.legacyMigration === undefined ? {} : { legacyMigration: readRoutingLegacyMigrationRecord(row.legacyMigration, revision) }) }
    assertSavedRoutingHistory(parsed)
    return parsed
  })
}
export function parseRoutingRuleSetDraft(value: unknown) {
  return parseResult<RoutingRuleSetDraftV1>(() => {
    const row = record(value, '$', ['schemaVersion', 'rules'])
    schemaVersion(row.schemaVersion)
    return { schemaVersion: 1, rules: ruleList(row.rules, readDraftRule) }
  })
}
function schemaVersion(value: unknown): void {
  if (value !== 1) fail('INVALID_VALUE', '$.schemaVersion', 'Only schema version 1 is supported.')
}
function ruleList<T extends RoutingRuleFields>(value: unknown, read: (value: unknown, path: string) => T): T[] {
  return unique(list(value, '$.rules', read, ROUTING_RULE_LIMITS.rules, 0), '$.rules', (rule) => rule.id)
}
function readSavedRule(value: unknown, path: string): RoutingRuleV1 {
  const row = record(value, path, [...RULE_FIELDS, 'version', 'source'])
  return { ...ruleFields(row, path), version: integer(row.version, `${path}.version`, 1), source: readSource(row.source, `${path}.source`) }
}
function readDraftRule(value: unknown, path: string): RoutingRuleDraftV1 {
  const row = record(value, path, [...RULE_FIELDS, 'expectedVersion'])
  return { ...ruleFields(row, path), expectedVersion: row.expectedVersion === null ? null : integer(row.expectedVersion, `${path}.expectedVersion`, 1) }
}
function ruleFields(row: Record<string, unknown>, path: string): RoutingRuleFields {
  const selection = readSelection(row.selection, `${path}.selection`)
  const failure = readFailure(row.failure, `${path}.failure`)
  if (selection.kind === 'fixed' && failure.kind === 'retry_allowed_targets') {
    fail('FIXED_CROSS_TARGET_RETRY', `${path}.failure.kind`, 'A fixed target cannot authorize cross-target recovery.')
  }
  return { id: stableId(row.id, `${path}.id`), name: string(row.name, `${path}.name`, 80), enabled: boolean(row.enabled, `${path}.enabled`),
    priority: integer(row.priority, `${path}.priority`, 0, ROUTING_RULE_LIMITS.maxPriority), scope: readScope(row.scope, `${path}.scope`),
    when: readCondition(row.when, `${path}.when`), selection, strategy: oneOf(row.strategy, `${path}.strategy`, STRATEGIES), failure }
}
export function readScope(value: unknown, path: string): RoutingRuleScope {
  const kind = discriminant(value, path)
  if (kind === 'global') { record(value, path, ['kind']); return { kind } }
  if (kind === 'business_line') {
    const row = record(value, path, ['kind', 'businessLineId'])
    if (!isBusinessLineId(row.businessLineId)) fail('INVALID_VALUE', `${path}.businessLineId`, 'Expected an existing business-line identifier shape.')
    return { kind, businessLineId: row.businessLineId }
  }
  return fail('INVALID_VALUE', `${path}.kind`, 'Only global and business_line scopes are supported.')
}
export function readSource(value: unknown, path: string): RoutingRuleSource {
  const kind = discriminant(value, path)
  if (kind === 'user') { record(value, path, ['kind']); return { kind } }
  if (kind === 'legacy_settings') {
    const row = record(value, path, ['kind', 'legacyDigest', 'legacyIndex'], ['legacyId'])
    return { kind, legacyDigest: digest(row.legacyDigest, `${path}.legacyDigest`), legacyIndex: integer(row.legacyIndex, `${path}.legacyIndex`, 0, 99),
      ...(row.legacyId === undefined ? {} : { legacyId: string(row.legacyId, `${path}.legacyId`, 128) }) }
  }
  return fail('INVALID_VALUE', `${path}.kind`, 'Unknown rule provenance.')
}
export function readRoutingProviderId(value: unknown, path: string): string {
  const id = stableId(value, path)
  if (id === 'auto-provider') fail('INVALID_VALUE', path, 'An automatic selection is not a provider target.')
  return id
}
export function readRoutingTargetRef(value: unknown, path: string): RoutingTargetRef {
  const row = record(value, path, ['providerId', 'model'])
  const model = string(row.model, `${path}.model`, 200)
  if (model === 'auto') fail('INVALID_VALUE', `${path}.model`, 'A target must name a concrete model.')
  return { providerId: readRoutingProviderId(row.providerId, `${path}.providerId`), model }
}
function targetKey(target: RoutingTargetRef): string { return JSON.stringify([target.providerId, target.model]) }
function targets(value: unknown, path: string, min = 1, max: number = ROUTING_RULE_LIMITS.targets): RoutingTargetRef[] {
  return unique(list(value, path, readRoutingTargetRef, max, min), path, targetKey)
}
export function readSelection(value: unknown, path: string): RoutingSelection {
  const kind = discriminant(value, path)
  if (kind === 'global_auto') { record(value, path, ['kind']); return { kind } }
  if (kind === 'provider_auto') {
    const row = record(value, path, ['kind', 'providerId'])
    return { kind, providerId: readRoutingProviderId(row.providerId, `${path}.providerId`) }
  }
  if (kind === 'candidate_set') {
    const row = record(value, path, ['kind', 'targets'])
    return { kind, targets: targets(row.targets, `${path}.targets`) }
  }
  if (kind === 'preferred') {
    const row = record(value, path, ['kind', 'primary', 'alternatives'], ['alternativesOrder'])
    const primary = readRoutingTargetRef(row.primary, `${path}.primary`)
    const alternatives = targets(row.alternatives, `${path}.alternatives`, 0, ROUTING_RULE_LIMITS.targets - 1)
    unique([primary, ...alternatives], path, targetKey)
    return { kind, primary, alternatives,
      ...(row.alternativesOrder === undefined ? {} : { alternativesOrder: oneOf(row.alternativesOrder, `${path}.alternativesOrder`, ['configured'] as const) }) }
  }
  if (kind === 'fixed') {
    const row = record(value, path, ['kind', 'target'])
    return { kind, target: readRoutingTargetRef(row.target, `${path}.target`) }
  }
  return fail('INVALID_VALUE', `${path}.kind`, 'Unknown model selection kind.')
}
export function readFailure(value: unknown, path: string): RoutingFailurePolicy {
  const kind = discriminant(value, path)
  if (kind === 'pause') { record(value, path, ['kind']); return { kind } }
  if (kind !== 'retry_same_target' && kind !== 'retry_allowed_targets') return fail('INVALID_VALUE', `${path}.kind`, 'Unknown recovery kind.')
  const row = record(value, path, ['kind', 'maxAdditionalAttempts', 'retryOn'])
  const retryOn = unique(list(row.retryOn, `${path}.retryOn`, (entry, at) => oneOf(entry, at, ['rate_limited', 'auth_failed'] as const), 2), `${path}.retryOn`, (entry) => entry)
  return { kind, maxAdditionalAttempts: integer(row.maxAdditionalAttempts, `${path}.maxAdditionalAttempts`, 1, ROUTING_RULE_LIMITS.retries), retryOn }
}
function readCondition(value: unknown, path: string): RoutingRuleCondition {
  const row = record(value, path, [], ['keywords', 'taskKinds', 'minRiskLevel', 'whenStrategy'])
  return {
    ...(row.keywords === undefined ? {} : { keywords: readKeywords(row.keywords, `${path}.keywords`) }),
    ...(row.taskKinds === undefined ? {} : { taskKinds: unique(list(row.taskKinds, `${path}.taskKinds`, (entry, at) => oneOf(entry, at, TASK_KINDS), TASK_KINDS.length), `${path}.taskKinds`, (entry) => entry) }),
    ...(row.minRiskLevel === undefined ? {} : { minRiskLevel: oneOf(row.minRiskLevel, `${path}.minRiskLevel`, ['low', 'medium', 'high'] as const) }),
    ...(row.whenStrategy === undefined ? {} : { whenStrategy: oneOf(row.whenStrategy, `${path}.whenStrategy`, STRATEGIES) })
  }
}
function readKeywords(value: unknown, path: string): NonNullable<RoutingRuleCondition['keywords']> {
  const row = record(value, path, ['mode', 'values'])
  return { mode: oneOf(row.mode, `${path}.mode`, ['any', 'all'] as const),
    values: unique(list(row.values, `${path}.values`, (entry, at) => string(entry, at, 200), ROUTING_RULE_LIMITS.keywords), `${path}.values`, (entry) => entry.toLowerCase()) }
}
