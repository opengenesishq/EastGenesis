import type { RoutingRuleDraftV1, RoutingRuleSaveInput, RoutingRuleSetV1, RoutingRuleSource, RoutingRuleV1 } from '../../shared/routing-policy-types'
import { parseRoutingRuleSet } from '../../shared/routing-policy-parser'
import { validateRoutingRuleDraftBase } from '../../shared/routing-policy-command-parser'
import { validateRoutingMigrationCutover, validateRoutingRetirementTransition } from '../../shared/routing-policy-history-validation'
import { canonicalRoutingJson } from './routing-settings-json'
import { assertSettingsDiagnostics, rejectSettings } from './routing-settings-state'
import type { StoredRoutingState } from './routing-settings-types'

/** Construct a candidate transaction only. No caller-visible state changes before commit. */
export function buildRoutingSettingsTransaction(state: StoredRoutingState, input: RoutingRuleSaveInput): RoutingRuleSetV1 {
  const base = state.mode === 'legacy_active'
    ? { kind: 'legacy' as const, legacyDigest: state.legacyDigest, legacyCount: state.originalRules.length }
    : { kind: 'v1' as const }
  assertSettingsDiagnostics(validateRoutingMigrationCutover(base, input))
  if (state.mode === 'legacy_active') return buildFirstRuleSet(state, input)
  assertSettingsDiagnostics(validateRoutingRuleDraftBase(state.ruleSet, input.draft))
  return buildNextRuleSet(state.ruleSet, input)
}
function buildFirstRuleSet(state: Extract<StoredRoutingState, { mode: 'legacy_active' }>, input: RoutingRuleSaveInput): RoutingRuleSetV1 {
  const migration = input.migration
  if (!migration) return rejectSettings('MIGRATION_REQUIRED', '$.migration', 'First activation requires a migration disposition.')
  for (const rule of input.draft.rules) if (rule.expectedVersion !== null) rejectSettings('RULE_VERSION_CONFLICT', '$.draft.rules', 'A first activation draft contains no existing V1 versions.')
  return validateBuiltSet({ schemaVersion: 1, revision: 1,
    rules: input.draft.rules.map((rule) => ({ ...draftFields(rule), version: 1, source: migrationSource(rule.id, state, migration.resolutions) })),
    retiredIdentities: [], legacyMigration: { schemaVersion: 1, migratedAtRevision: 1, legacyDigest: state.legacyDigest,
      originalRules: structuredClone(state.originalRules), resolutions: structuredClone(migration.resolutions) } })
}
function migrationSource(ruleId: string, state: Extract<StoredRoutingState, { mode: 'legacy_active' }>, resolutions: NonNullable<RoutingRuleSaveInput['migration']>['resolutions']): RoutingRuleSource {
  const resolution = resolutions.find((entry) => entry.kind === 'replace' && entry.ruleId === ruleId)
  if (!resolution) return { kind: 'user' }
  return { kind: 'legacy_settings', legacyDigest: state.legacyDigest, legacyIndex: resolution.legacyIndex }
}
function buildNextRuleSet(current: RoutingRuleSetV1, input: RoutingRuleSaveInput): RoutingRuleSetV1 {
  const rules = input.draft.rules.map((draft) => assignRuleVersion(draft, current.rules.find((rule) => rule.id === draft.id)))
  const deleted = current.rules.filter((rule) => !rules.some((next) => next.id === rule.id))
  if (deleted.length === 0 && canonicalRoutingJson(rules) === canonicalRoutingJson(current.rules)) return current
  const revision = incrementVersion(current.revision, '$.revision')
  const candidate = validateBuiltSet({ ...current, revision, rules, retiredIdentities: [...current.retiredIdentities,
    ...deleted.map((rule) => ({ id: rule.id, lastVersion: rule.version, retiredAtRevision: revision }))] })
  assertSettingsDiagnostics(validateRoutingRetirementTransition(current, candidate))
  return candidate
}
function assignRuleVersion(draft: RoutingRuleDraftV1, previous: RoutingRuleV1 | undefined): RoutingRuleV1 {
  const fields = draftFields(draft)
  if (!previous) return { ...fields, version: 1, source: { kind: 'user' } }
  const { version, source, ...oldFields } = previous
  const unchanged = canonicalRoutingJson(fields) === canonicalRoutingJson(oldFields)
  return { ...fields, version: unchanged ? version : incrementVersion(version, '$.draft.rules'), source: structuredClone(source) }
}
function draftFields(draft: RoutingRuleDraftV1): Omit<RoutingRuleV1, 'version' | 'source'> {
  const { expectedVersion: _expectedVersion, ...fields } = draft
  return structuredClone(fields)
}
function incrementVersion(value: number, path: string): number {
  if (!Number.isSafeInteger(value + 1)) rejectSettings('INVALID_VALUE', path, 'The rule version cannot advance beyond the safe integer range.')
  return value + 1
}
function validateBuiltSet(value: unknown): RoutingRuleSetV1 {
  const result = parseRoutingRuleSet(value)
  if (result.ok === false) { assertSettingsDiagnostics(result.diagnostics); throw new Error('Unreachable invalid rule set') }
  return result.value
}
