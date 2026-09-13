import type { RoutingDiagnostic } from '../../shared/routing-policy-types'
import { parseRoutingRuleSet } from '../../shared/routing-policy-parser'
import { copyNormalizedSettingsCandidate, copySettingsDocument, copySettingsObjectFields, routingSettingsDigest } from './routing-settings-json'
import { RoutingSettingsRejected, type RoutingSettingsDocument, type StoredRoutingState } from './routing-settings-types'

export function readStoredRoutingState(document: RoutingSettingsDocument): StoredRoutingState {
  if (Object.hasOwn(document, 'routingRuleSet')) {
    const parsed = parseRoutingRuleSet(document.routingRuleSet)
    if (parsed.ok === false) rejectSettings('INVALID_PERSISTED_RULE_SET', '$.routingRuleSet', 'A stored V1 rule set is invalid; legacy fallback is forbidden.', parsed.diagnostics)
    const archive = parsed.value.legacyMigration
    if (archive && routingSettingsDigest(archive.originalRules) !== archive.legacyDigest) {
      rejectSettings('MIGRATION_RECORD_CONFLICT', '$.routingRuleSet.legacyMigration', 'The archived legacy JSON does not match its main-computed digest.')
    }
    return { mode: 'v1_active', ruleSet: parsed.value }
  }
  const originalRules = Object.hasOwn(document, 'modelRoutingRules') ? document.modelRoutingRules : []
  if (!Array.isArray(originalRules)) rejectSettings('INVALID_LEGACY_RULES', '$.modelRoutingRules', 'Raw legacy rules must remain an array for review.')
  return { mode: 'legacy_active', originalRules, legacyDigest: routingSettingsDigest(originalRules) }
}
export function rejectSettings(code: RoutingDiagnostic['code'], path: string, message: string, extra: RoutingDiagnostic[] = []): never {
  throw new RoutingSettingsRejected([{ code, severity: 'error', path, message }, ...extra])
}
export function assertSettingsDiagnostics(diagnostics: RoutingDiagnostic[]): void {
  if (diagnostics.some((issue) => issue.severity === 'error')) throw new RoutingSettingsRejected(diagnostics)
}

const ROUTING_FIELDS = ['routingRuleSet', 'modelRoutingRules'] as const
export function assertOrdinaryRoutingPatchAllowed(authoritative: RoutingSettingsDocument, patch: Record<string, unknown>): void {
  if (Object.hasOwn(patch, 'routingRuleSet')) rejectSettings('ROUTING_DOMAIN_WRITE_REQUIRED', '$.routingRuleSet', 'V1 routing changes require the dedicated CAS command.')
  if (Object.hasOwn(authoritative, 'routingRuleSet') && Object.hasOwn(patch, 'modelRoutingRules')) {
    rejectSettings('ROUTING_DOMAIN_WRITE_REQUIRED', '$.modelRoutingRules', 'Legacy writes are disabled while a V1 routing record exists.')
  }
}
/** Hook for the existing ordinary-settings update path, after its normalizers run.
 * Preserve authoritative raw routing data, even when normalized candidate data lost it.
 * Existing GUI grant/circuit-breaker side effects remain owned by that update path. */
export function preserveRoutingSettingsDomain(input: { authoritative: RoutingSettingsDocument; candidate: unknown; requestedPatch: unknown }): RoutingSettingsDocument {
  const patch = copySettingsObjectFields(input.requestedPatch)
  assertOrdinaryRoutingPatchAllowed(input.authoritative, patch)
  const candidate = copySettingsObjectFields(input.candidate)
  const original = copySettingsDocument(input.authoritative)
  for (const key of ROUTING_FIELDS) {
    // Until explicit V1 activation, the existing legacy editor retains its normalized write semantics.
    if (key === 'modelRoutingRules' && Object.hasOwn(patch, key) && patch[key] !== undefined) continue
    if (Object.hasOwn(original, key)) candidate[key] = original[key]
    else delete candidate[key]
  }
  return copyNormalizedSettingsCandidate(candidate)
}
