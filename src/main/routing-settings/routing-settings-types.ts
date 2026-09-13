import type { SchedulerStrategy } from '../../shared/types'
import type { RoutingDiagnostic, RoutingLegacyJsonValue, RoutingPreviewReceipt, RoutingRuleFields, RoutingRuleReadResult, RoutingRuleSaveResult, RoutingRuleSetDraftV1, RoutingRuleSetV1 } from '../../shared/routing-policy-types'

export type RoutingSettingsDocument = { [key: string]: RoutingLegacyJsonValue }
/** A snapshot of the existing complete settings document, never a separate rules file. */
export interface RoutingSettingsSnapshot { document: RoutingSettingsDocument; token: string }
export type RoutingSettingsCommitResult = { status: 'committed' } | { status: 'conflict' }
export interface RoutingSettingsBoundary {
  read(): RoutingSettingsSnapshot
  /** Must serialize compare-token + atomic replace. It may compare-only for equal data.
   * Succeed only after durable commit; do not mutate any application cache before success. */
  commit(input: { expectedToken: string; document: RoutingSettingsDocument }): RoutingSettingsCommitResult
}
export interface RoutingCatalogValidation {
  /** Sanitized catalog JSON from trusted main configuration; main computes its digest. */
  catalog: RoutingLegacyJsonValue
  diagnostics: RoutingDiagnostic[]
}
export interface RoutingSettingsDependencies extends RoutingSettingsBoundary {
  validateCatalog(input: { document: RoutingSettingsDocument; rules: readonly RoutingRuleFields[] }): RoutingCatalogValidation
  /** Main-issued receipt verification against this exact save snapshot, after local catalog validation. */
  validatePreview?(input: { receipt: RoutingPreviewReceipt; draft: RoutingRuleSetDraftV1; snapshot: RoutingSettingsSnapshot; catalogDigest: string }): RoutingDiagnostic[]
  inheritedStrategy?: SchedulerStrategy
}
export type RoutingSettingsReadOutcome =
  | { status: 'ready'; value: RoutingRuleReadResult }
  | { status: 'invalid' | 'storage_error'; diagnostics: RoutingDiagnostic[] }
export type RoutingSettingsSaveOutcome = RoutingRuleSaveResult
export type StoredRoutingState =
  | { mode: 'legacy_active'; originalRules: RoutingLegacyJsonValue[]; legacyDigest: string }
  | { mode: 'v1_active'; ruleSet: RoutingRuleSetV1 }

/** An adapter may distinguish a known pre-commit failure from an uncertain commit.
 * Unclassified commit exceptions are conservatively treated as unknown. */
export class RoutingSettingsWriteError extends Error {
  constructor(readonly outcome: 'not_committed' | 'unknown', message: string) { super(message) }
}
export class RoutingSettingsRejected extends Error {
  constructor(readonly diagnostics: RoutingDiagnostic[]) { super(diagnostics[0]?.message ?? 'Routing settings rejected.') }
}
export class RoutingCatalogUnavailableError extends Error {}
