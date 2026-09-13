import type { RoutingDiagnostic, RoutingMigrationBase, RoutingRuleSaveInput, RoutingRuleSetV1 } from './routing-policy-types'
import { fail, integer, parseResult } from './routing-policy-parse-fields'
import { assertLegacyCoverage } from './routing-policy-history-parser'

export function assertSavedRoutingHistory(saved: RoutingRuleSetV1): void {
  const retired = new Set(saved.retiredIdentities.map((entry) => entry.id))
  for (const rule of saved.rules) {
    if (retired.has(rule.id)) fail('RETIRED_RULE_ID', '$.retiredIdentities', 'An active rule ID cannot also be retired.')
    if (rule.source.kind === 'legacy_settings') assertLegacySource(rule, saved)
  }
  for (const resolution of saved.legacyMigration?.resolutions ?? []) {
    if (resolution.kind !== 'replace') continue
    const rule = saved.rules.find((entry) => entry.id === resolution.ruleId)
    if (!rule && !retired.has(resolution.ruleId)) fail('MIGRATION_RECORD_CONFLICT', '$.legacyMigration.resolutions', 'A replacement identity must remain active or retired.')
    if (rule?.source.kind === 'user') fail('MIGRATION_RECORD_CONFLICT', '$.legacyMigration.resolutions', 'A migration replacement must retain its main-owned legacy source.')
  }
}
function assertLegacySource(rule: RoutingRuleSetV1['rules'][number], saved: RoutingRuleSetV1): void {
  const source = rule.source
  if (source.kind !== 'legacy_settings') return
  const record = saved.legacyMigration
  if (!record || source.legacyDigest !== record.legacyDigest) fail('MIGRATION_RECORD_CONFLICT', '$.rules', 'Legacy provenance requires its archived migration record.')
  const resolution = record.resolutions.find((entry) => entry.legacyIndex === source.legacyIndex)
  if (resolution?.kind !== 'replace' || resolution.ruleId !== rule.id) fail('MIGRATION_RECORD_CONFLICT', '$.rules', 'Legacy provenance does not match the original replacement disposition.')
}

/** Only checks the state transition contract. It never saves settings or switches an interpreter. */
export function validateRoutingMigrationCutover(base: RoutingMigrationBase, input: RoutingRuleSaveInput): RoutingDiagnostic[] {
  const result = parseResult(() => {
    if (base.kind === 'v1') {
      if (input.expectedRevision === 0) fail('REVISION_CONFLICT', '$.expectedRevision', 'Revision zero cannot replace an already active V1 set.')
      if (input.migration) fail('MIGRATION_UNEXPECTED', '$.migration', 'V1 is already active; legacy cutover cannot be replayed.')
      return
    }
    if (input.expectedRevision !== 0) fail('REVISION_CONFLICT', '$.expectedRevision', 'First V1 activation must compare against revision zero.')
    const migration = input.migration
    if (!migration) fail('MIGRATION_REQUIRED', '$.migration', 'First activation must explicitly resolve every legacy entry.')
    if (migration.legacyDigest !== base.legacyDigest) fail('LEGACY_DIGEST_CONFLICT', '$.migration.legacyDigest', 'Legacy settings changed; preserve the draft and reload its migration base.')
    assertLegacyCoverage(migration.resolutions, integer(base.legacyCount, '$.trustedLegacyCount', 0, 100), '$.migration.resolutions')
    const ruleIds = new Set(input.draft.rules.map((rule) => rule.id))
    for (const resolution of migration.resolutions) {
      if (resolution.kind === 'replace' && !ruleIds.has(resolution.ruleId)) fail('MIGRATION_TARGET_UNAVAILABLE', '$.migration.resolutions', 'A replacement must reference a rule in this draft.')
    }
  })
  return result.ok === true ? [] : result.diagnostics
}

/** Main calls after constructing a candidate saved set, within the same atomic CAS.
 * Existing tombstones and the original one-time migration archive cannot be dropped. */
export function validateRoutingRetirementTransition(current: RoutingRuleSetV1, next: RoutingRuleSetV1): RoutingDiagnostic[] {
  const result = parseResult(() => {
    assertSavedRoutingHistory(next)
    if (next.revision !== current.revision + 1) fail('REVISION_CONFLICT', '$.revision', 'A changed saved set advances exactly one revision.')
    preserveRetiredIdentities(current, next)
    preserveDeletedIdentities(current, next)
    if (JSON.stringify(current.legacyMigration) !== JSON.stringify(next.legacyMigration)) {
      fail('MIGRATION_RECORD_CONFLICT', '$.legacyMigration', 'The original migration record is immutable after activation.')
    }
  })
  return result.ok === true ? [] : result.diagnostics
}
function preserveRetiredIdentities(current: RoutingRuleSetV1, next: RoutingRuleSetV1): void {
  for (const old of current.retiredIdentities) {
    const found = next.retiredIdentities.find((entry) => entry.id === old.id)
    if (!found || found.lastVersion !== old.lastVersion || found.retiredAtRevision !== old.retiredAtRevision) {
      fail('RETIREMENT_HISTORY_CONFLICT', '$.retiredIdentities', 'A retired identity cannot be removed, renumbered, or rewritten.')
    }
  }
  for (const added of next.retiredIdentities) {
    if (current.retiredIdentities.some((entry) => entry.id === added.id)) continue
    const previousRule = current.rules.find((entry) => entry.id === added.id)
    if (!previousRule || next.rules.some((entry) => entry.id === added.id)) fail('RETIREMENT_HISTORY_CONFLICT', '$.retiredIdentities', 'Only a deleted current rule may create a tombstone.')
  }
}
function preserveDeletedIdentities(current: RoutingRuleSetV1, next: RoutingRuleSetV1): void {
  for (const rule of current.rules) {
    if (next.rules.some((entry) => entry.id === rule.id)) continue
    const retired = next.retiredIdentities.find((entry) => entry.id === rule.id)
    if (!retired || retired.lastVersion !== rule.version || retired.retiredAtRevision !== next.revision) {
      fail('RETIREMENT_HISTORY_CONFLICT', '$.retiredIdentities', 'Deletion must atomically retain the ID, last version and deletion revision.')
    }
  }
}
