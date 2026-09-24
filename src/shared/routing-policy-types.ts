import type { ModelRoutingRiskLevel, ModelRoutingTaskKind, SchedulerStrategy } from './types'

export interface RoutingTargetRef { providerId: string; model: string }
/** The user's selection is a hard intersection with rule candidates. */
export type RoutingUserIntent =
  | { kind: 'global' }
  | { kind: 'provider'; providerId: string }
  | { kind: 'fixed'; target: RoutingTargetRef }
export type RoutingRuleScope = { kind: 'global' } | { kind: 'business_line'; businessLineId: string }
/** Digest/index identifies even a legacy entry with a missing or duplicate old ID. */
export type RoutingRuleSource = { kind: 'user' } | { kind: 'legacy_settings'; legacyDigest: string; legacyIndex: number; legacyId?: string }
export type RoutingSelection =
  | { kind: 'global_auto' }
  | { kind: 'provider_auto'; providerId: string }
  | { kind: 'candidate_set'; targets: RoutingTargetRef[] }
  | { kind: 'preferred'; primary: RoutingTargetRef; alternatives: RoutingTargetRef[];
      /** Omitted on existing rules: retain scored recovery. Explicit order never silently skips a target. */
      alternativesOrder?: 'configured' }
  | { kind: 'fixed'; target: RoutingTargetRef }

/** Only known refusal categories. Unknown charges/effects never authorize replay. */
export type RoutingRetryReason = 'rate_limited' | 'auth_failed'
export type RoutingFailurePolicy =
  | { kind: 'pause' }
  | { kind: 'retry_same_target'; maxAdditionalAttempts: number; retryOn: RoutingRetryReason[] }
  | { kind: 'retry_allowed_targets'; maxAdditionalAttempts: number; retryOn: RoutingRetryReason[] }

/** An empty object is an explicit catch-all for newly authored rules. */
export interface RoutingRuleCondition {
  keywords?: { mode: 'any' | 'all'; values: string[] }
  taskKinds?: ModelRoutingTaskKind[]
  minRiskLevel?: ModelRoutingRiskLevel
  whenStrategy?: SchedulerStrategy
}

export interface RoutingRuleFields {
  id: string
  name: string
  enabled: boolean
  priority: number
  scope: RoutingRuleScope
  when: RoutingRuleCondition
  selection: RoutingSelection
  strategy: SchedulerStrategy
  failure: RoutingFailurePolicy
}

/** version and source are assigned by main and retained across edits. */
export interface RoutingRuleV1 extends RoutingRuleFields { version: number; source: RoutingRuleSource }
/** Main-owned, append-only identities prevent any deleted rule ID from being reused. */
export interface RoutingRetiredIdentity { id: string; lastVersion: number; retiredAtRevision: number }
export interface RoutingRuleSetV1 {
  schemaVersion: 1
  revision: number
  rules: RoutingRuleV1[]
  retiredIdentities: RoutingRetiredIdentity[]
  /** Same settings record; audit material never becomes a second interpreter. */
  legacyMigration?: RoutingLegacyMigrationRecord
}
/** null means a new stable ID. Renderer cannot choose a resulting version/source. */
export interface RoutingRuleDraftV1 extends RoutingRuleFields { expectedVersion: number | null }
export interface RoutingRuleSetDraftV1 { schemaVersion: 1; rules: RoutingRuleDraftV1[] }

export type RoutingDiagnosticCode =
  | 'INVALID_SHAPE' | 'UNKNOWN_FIELD' | 'MISSING_FIELD' | 'INVALID_VALUE' | 'DUPLICATE_VALUE'
  | 'FIXED_CROSS_TARGET_RETRY' | 'PRIORITY_CONFLICT'
  | 'RULE_VERSION_CONFLICT' | 'REVISION_CONFLICT' | 'PREVIEW_STALE'
  | 'RETIRED_RULE_ID' | 'RETIREMENT_HISTORY_CONFLICT'
  | 'MIGRATION_REQUIRED' | 'MIGRATION_UNEXPECTED' | 'MIGRATION_INCOMPLETE'
  | 'LEGACY_DIGEST_CONFLICT' | 'MIGRATION_TARGET_UNAVAILABLE' | 'MIGRATION_RECORD_CONFLICT'
  | 'INVALID_PERSISTED_RULE_SET' | 'INVALID_LEGACY_RULES' | 'SETTINGS_READ_FAILED' | 'SETTINGS_WRITE_FAILED' | 'SETTINGS_COMMIT_UNKNOWN'
  | 'ROUTING_DOMAIN_WRITE_REQUIRED' | 'PREVIEW_UNAVAILABLE' | 'CATALOG_VALIDATION_FAILED'
  | 'TARGET_UNAVAILABLE' | 'BUSINESS_LINE_UNAVAILABLE' | 'HARD_CONSTRAINT_EXCLUDED'
  | 'LEGACY_MODEL_ONLY' | 'LEGACY_NO_CONDITION' | 'LEGACY_NO_TARGET' | 'LEGACY_REVIEW_REQUIRED'

export interface RoutingDiagnostic {
  code: RoutingDiagnosticCode
  severity: 'error' | 'warning' | 'info'
  /** JSON-style path for a form field; never parse message to determine behavior. */
  path: string
  ruleId?: string
  relatedRuleIds?: string[]
  message: string
}
export type RoutingParseResult<T> = { ok: true; value: T } | { ok: false; diagnostics: RoutingDiagnostic[] }

interface RoutingRuleReadBase {
  catalogDigest: string
  diagnostics: RoutingDiagnostic[]
}
/** Legacy read has no invented saved V1 entity; first activation uses revision zero. */
export type RoutingRuleReadResult = RoutingRuleReadBase & (
  | { mode: 'legacy_active'; expectedRevision: 0; legacyDigest: string; legacyCount: number; migration: LegacyRoutingMigrationEntry[] }
  | { mode: 'v1_active'; ruleSet: RoutingRuleSetV1 }
  | { mode: 'invalid_v1' }
)
/** Main resolves IDs and verifies ownership; renderer cannot assert Project/Run authority. */
export type RoutingPreviewContext =
  | { kind: 'new_task'; businessLineId: string; prompt: string; routingIntent: RoutingUserIntent }
  | { kind: 'session'; sessionId: string; prompt: string }
export interface RoutingRulePreviewInput { draft: RoutingRuleSetDraftV1; context: RoutingPreviewContext }
/** Main computes previewDigest from canonical draft, catalog and trusted context.
 * It is an opaque receipt. Echoing it grants no authority; main revalidates the binding. */
export interface RoutingPreviewReceipt { draftDigest: string; catalogDigest: string; contextDigest: string; previewDigest: string }
/** Read-only scoring evidence from the same evaluation used to choose the target. */
export interface RoutingPreviewExplanation {
  selectionReason: string
  taskKinds: ModelRoutingTaskKind[]
  warnings: string[]
  candidates: Array<{
    target: RoutingTargetRef
    selected: boolean
    reasons: string[]
    pricingBasis: 'declared' | 'heuristic_estimate'
    acceptanceSamples: number
  }>
}
export interface RoutingRulePreviewResult extends RoutingPreviewReceipt {
  status: 'ready' | 'blocked'
  /** Source is resolved by main from saved IDs or assigned user for a new draft. */
  matchedRules: { id: string; expectedVersion: number | null; scope: RoutingRuleScope; source: RoutingRuleSource }[]
  effectivePolicy?: { selection: RoutingSelection; strategy: SchedulerStrategy; failure: RoutingFailurePolicy }
  initialTarget?: RoutingTargetRef
  explanation?: RoutingPreviewExplanation
  allowedAlternatives: RoutingTargetRef[]
  excludedTargets: { target: RoutingTargetRef; diagnostics: RoutingDiagnostic[] }[]
  conflicts: RoutingDiagnostic[]
  diagnostics: RoutingDiagnostic[]
  limitations: { kind: 'local_configuration_only'; providerRequestsMade: false; realTaskVerified: false }
}
export interface RoutingRuleSaveInput {
  expectedRevision: number
  draft: RoutingRuleSetDraftV1
  preview?: RoutingPreviewReceipt
  /** Required for first cutover, forbidden after V1 activation. Main checks every old entry. */
  migration?: RoutingLegacyTransition
}
/** Failure never clears the client's draft. Conflict returns the latest saved state. */
export type RoutingRuleSaveResult =
  | { status: 'saved'; ruleSet: RoutingRuleSetV1; catalogDigest: string; diagnostics: RoutingDiagnostic[] }
  | { status: 'conflict'; current: RoutingRuleReadResult; diagnostics: RoutingDiagnostic[] }
  | { status: 'invalid'; diagnostics: RoutingDiagnostic[] }
  | { status: 'storage_error'; commitState: 'not_attempted' | 'not_committed' | 'unknown'; diagnostics: RoutingDiagnostic[] }
export interface RoutingRuleApi {
  getRoutingRuleSet(): Promise<RoutingRuleReadResult>
  previewRoutingRuleSet(input: RoutingRulePreviewInput): Promise<RoutingRulePreviewResult>
  saveRoutingRuleSet(input: RoutingRuleSaveInput): Promise<RoutingRuleSaveResult>
}

/** A migration proposal is review material, never an executable rule set. */
export interface LegacyRoutingMigrationEntry {
  legacyIndex: number
  legacyId?: string
  original: unknown
  status: 'ready_for_review' | 'needs_repair'
  proposedRule?: RoutingRuleDraftV1
  diagnostics: RoutingDiagnostic[]
}

export type RoutingLegacyResolution =
  | { legacyIndex: number; kind: 'replace'; ruleId: string }
  | { legacyIndex: number; kind: 'retire' }
export interface RoutingLegacyTransition { legacyDigest: string; resolutions: RoutingLegacyResolution[] }
export type RoutingLegacyJsonValue = null | boolean | number | string | RoutingLegacyJsonValue[] | { [key: string]: RoutingLegacyJsonValue }
/** Main archives the exact JSON values and their one-time dispositions atomically with V1. */
export interface RoutingLegacyMigrationRecord extends RoutingLegacyTransition {
  schemaVersion: 1
  migratedAtRevision: number
  originalRules: RoutingLegacyJsonValue[]
}
/** Trusted state supplied by main, never an IPC argument or UI-owned authority. */
export type RoutingMigrationBase =
  | { kind: 'legacy'; legacyDigest: string; legacyCount: number }
  | { kind: 'v1' }
