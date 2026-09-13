import type { SchedulerStrategy } from './types'
import type { LegacyRoutingMigrationEntry, RoutingDiagnostic, RoutingSelection } from './routing-policy-types'
import { fail, parseResult, record, stableId } from './routing-policy-parse-fields'
import { parseRoutingRuleSetDraft, ROUTING_RULE_LIMITS } from './routing-policy-parser'

const LEGACY_REQUIRED = ['id', 'enabled', 'name', 'match', 'providerId', 'model']
const LEGACY_OPTIONAL = ['keywordMode', 'taskKinds', 'minRiskLevel', 'whenStrategy']

/** Input is the existing settings JSON array. This produces review material only:
 * no active rules, settings writes, target discovery, or guessed provider identity. */
export function proposeLegacyRoutingMigration(value: unknown, inheritedStrategy: SchedulerStrategy): LegacyRoutingMigrationEntry[] {
  if (!Array.isArray(value)) return [entry(value, 0, [{ code: 'INVALID_SHAPE', severity: 'error', path: '$', message: 'Legacy rules must be an array.' }])]
  const ids = legacyIdCounts(value)
  return value.map((raw, index) => migrateEntry(raw, index, inheritedStrategy, ids))
}
function legacyIdCounts(values: unknown[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const raw of values) {
    const id = safeLegacyId(raw)
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}
function safeLegacyId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const field = Object.getOwnPropertyDescriptor(value, 'id')
  return field && 'value' in field && typeof field.value === 'string' ? field.value : undefined
}
function migrateEntry(raw: unknown, index: number, strategy: SchedulerStrategy, ids: Map<string, number>): LegacyRoutingMigrationEntry {
  const result = parseResult(() => readLegacyProposal(raw, index, strategy, ids))
  if (result.ok === false) return entry(raw, index, result.diagnostics)
  const parsed = parseRoutingRuleSetDraft({ schemaVersion: 1, rules: [result.value] })
  if (parsed.ok === false) return entry(raw, index, parsed.diagnostics)
  return { ...entry(raw, index, [{ code: 'LEGACY_REVIEW_REQUIRED', severity: 'warning', path: `$[${index}]`,
    message: 'Review inherited strategy and pause-on-failure before explicitly saving this proposal.' }]), status: 'ready_for_review', proposedRule: parsed.value.rules[0] }
}
function readLegacyProposal(value: unknown, index: number, strategy: SchedulerStrategy, ids: Map<string, number>): unknown {
  const at = `$[${index}]`
  const row = readLegacyRecord(value, at)
  const id = stableId(row.id, `${at}.id`)
  if ((ids.get(id) ?? 0) > 1) fail('DUPLICATE_VALUE', `${at}.id`, 'Every occurrence of a duplicate legacy ID needs repair; no replacement ID is invented.')
  const selection = legacySelection(row, at)
  const when = legacyCondition(row, at)
  return { id, expectedVersion: null, name: row.name, enabled: row.enabled,
    priority: ROUTING_RULE_LIMITS.maxPriority - index, scope: { kind: 'global' }, when, selection, strategy, failure: { kind: 'pause' } }
}
function legacySelection(row: Record<string, unknown>, at: string): RoutingSelection {
  if (typeof row.providerId !== 'string' || typeof row.model !== 'string') fail('INVALID_VALUE', at, 'Legacy provider/model fields must be strings.')
  if (!row.providerId && row.model) fail('LEGACY_MODEL_ONLY', `${at}.model`, 'Model-only legacy rules require an explicit provider choice; no provider is inferred.')
  if (!row.providerId) fail('LEGACY_NO_TARGET', `${at}.providerId`, 'A targetless legacy rule was ineffective; it cannot silently become global automatic routing.')
  return row.model ? { kind: 'fixed', target: { providerId: row.providerId, model: row.model } } : { kind: 'provider_auto', providerId: row.providerId }
}
function legacyCondition(row: Record<string, unknown>, at: string): Record<string, unknown> {
  if (typeof row.match !== 'string') fail('INVALID_VALUE', `${at}.match`, 'Legacy match must be a string.')
  const values = [...new Set(row.match.split(/[\n,，;；]+/g).map((word) => word.trim().toLowerCase()).filter(Boolean))]
  const condition: Record<string, unknown> = {}
  if (values.length) condition.keywords = { mode: row.keywordMode ?? 'any', values }
  if (Array.isArray(row.taskKinds) && row.taskKinds.length) condition.taskKinds = row.taskKinds
  if (row.taskKinds !== undefined && !Array.isArray(row.taskKinds)) fail('INVALID_VALUE', `${at}.taskKinds`, 'Legacy task kinds must be an array.')
  if (row.minRiskLevel !== undefined) condition.minRiskLevel = row.minRiskLevel
  if (row.whenStrategy !== undefined) condition.whenStrategy = row.whenStrategy
  if (Object.keys(condition).length === 0) fail('LEGACY_NO_CONDITION', at, 'A conditionless legacy rule never matched; it cannot become an enabled catch-all.')
  return condition
}
function readLegacyRecord(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return record(value, at, LEGACY_REQUIRED, LEGACY_OPTIONAL)
  if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail('INVALID_SHAPE', at, 'Legacy rules must be plain objects.')
  const copy = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    // Existing getSettings normalization explicitly includes absent optional fields as undefined.
    if (typeof key === 'string' && LEGACY_OPTIONAL.includes(key) && descriptor && 'value' in descriptor && descriptor.value === undefined) continue
    if (descriptor) Object.defineProperty(copy, key, descriptor)
  }
  return record(copy, at, LEGACY_REQUIRED, LEGACY_OPTIONAL)
}
function entry(original: unknown, index: number, diagnostics: RoutingDiagnostic[]): LegacyRoutingMigrationEntry {
  return { legacyIndex: index, ...(safeLegacyId(original) ? { legacyId: safeLegacyId(original) } : {}),
    original: structuredClone(original), status: 'needs_repair', diagnostics }
}
