import type { RoutingDiagnostic, RoutingRuleReadResult, RoutingRuleFields } from '../../shared/routing-policy-types'
import { parseRoutingRuleSaveInput } from '../../shared/routing-policy-command-parser'
import { proposeLegacyRoutingMigration } from '../../shared/routing-policy-legacy-migration'
import { RoutingParseFault } from '../../shared/routing-policy-parse-fields'
import { copySettingsDocument, routingSettingsDigest } from './routing-settings-json'
import { assertSettingsDiagnostics, readStoredRoutingState, rejectSettings } from './routing-settings-state'
import { buildRoutingSettingsTransaction } from './routing-settings-transaction'
import { RoutingCatalogUnavailableError, RoutingSettingsRejected, RoutingSettingsWriteError, type RoutingSettingsDependencies, type RoutingSettingsReadOutcome,
  type RoutingSettingsSaveOutcome, type RoutingSettingsSnapshot, type StoredRoutingState } from './routing-settings-types'

/** One synchronous authority over the existing settings document. No rule cache is kept. */
export function createRoutingSettingsCore(deps: RoutingSettingsDependencies) {
  function load(): RoutingSettingsSnapshot {
    const snapshot = deps.read()
    if (typeof snapshot.token !== 'string' || !snapshot.token) throw new Error('Authoritative settings snapshot has no CAS token.')
    return { token: snapshot.token, document: copySettingsDocument(snapshot.document) }
  }
  function catalog(snapshot: RoutingSettingsSnapshot, rules: readonly RoutingRuleFields[]) {
    try {
      const result = deps.validateCatalog({ document: copySettingsDocument(snapshot.document), rules: structuredClone(rules) })
      return { catalogDigest: routingSettingsDigest(result.catalog), diagnostics: structuredClone(result.diagnostics) }
    } catch { throw new RoutingCatalogUnavailableError('Local catalog could not be validated.') }
  }
  function project(snapshot: RoutingSettingsSnapshot, state: StoredRoutingState): RoutingRuleReadResult {
    const inspection = catalog(snapshot, state.mode === 'v1_active' ? state.ruleSet.rules : [])
    if (state.mode === 'v1_active') return { mode: 'v1_active', ruleSet: state.ruleSet, ...inspection }
    return { mode: 'legacy_active', expectedRevision: 0, legacyDigest: state.legacyDigest, legacyCount: state.originalRules.length,
      migration: proposeLegacyRoutingMigration(state.originalRules, deps.inheritedStrategy ?? 'balanced'), ...inspection }
  }
  function read(): RoutingSettingsReadOutcome {
    try {
      const snapshot = load()
      let state: StoredRoutingState
      try { state = readStoredRoutingState(snapshot.document) } catch (error) {
        if (!Object.hasOwn(snapshot.document, 'routingRuleSet')) throw error
        return { status: 'ready', value: { mode: 'invalid_v1', ...catalog(snapshot, []), diagnostics: readFailureDiagnostics(error) } }
      }
      return { status: 'ready', value: project(snapshot, state) }
    } catch (error) {
      const diagnostics = readFailureDiagnostics(error)
      return { status: error instanceof RoutingSettingsRejected || error instanceof RoutingParseFault ? 'invalid' : 'storage_error', diagnostics }
    }
  }
  function conflict(diagnostics: RoutingDiagnostic[], commitState: 'not_attempted' | 'not_committed' = 'not_attempted'): RoutingSettingsSaveOutcome {
    const current = read()
    if (current.status === 'ready') return { status: 'conflict', current: current.value, diagnostics }
    return current.status === 'storage_error' ? { status: 'storage_error', commitState, diagnostics: current.diagnostics } : { status: 'invalid', diagnostics: current.diagnostics }
  }
  function save(value: unknown): RoutingSettingsSaveOutcome {
    const parsed = parseRoutingRuleSaveInput(value)
    if (parsed.ok === false) return { status: 'invalid', diagnostics: parsed.diagnostics }
    let writeStarted = false
    try {
      const snapshot = load(), state = readStoredRoutingState(snapshot.document)
      const expected = state.mode === 'legacy_active' ? 0 : state.ruleSet.revision
      if (parsed.value.expectedRevision !== expected) return conflict([issue('REVISION_CONFLICT', '$.expectedRevision', 'The saved routing revision changed; keep the draft.')])
      const inspection = catalog(snapshot, parsed.value.draft.rules)
      assertSettingsDiagnostics(inspection.diagnostics)
      if (parsed.value.preview) {
        if (!deps.validatePreview) rejectSettings('PREVIEW_UNAVAILABLE', '$.preview', 'Preview receipt verification is not connected.')
        const validation = deps.validatePreview({ receipt: structuredClone(parsed.value.preview), draft: structuredClone(parsed.value.draft),
          snapshot: structuredClone(snapshot), catalogDigest: inspection.catalogDigest })
        assertSettingsDiagnostics(validation)
        inspection.diagnostics.push(...validation)
      }
      const ruleSet = buildRoutingSettingsTransaction(state, parsed.value)
      const document = copySettingsDocument({ ...snapshot.document, routingRuleSet: ruleSet })
      writeStarted = true
      const committed = deps.commit({ expectedToken: snapshot.token, document })
      if (committed.status === 'conflict') return conflict([issue('REVISION_CONFLICT', '$', 'The complete settings document changed before commit; keep the draft.')], 'not_committed')
      if (committed.status !== 'committed') throw new RoutingSettingsWriteError('unknown', 'Invalid commit receipt.')
      return { status: 'saved', ruleSet, ...inspection }
    } catch (error) {
      if (error instanceof RoutingSettingsRejected) return { status: 'invalid', diagnostics: error.diagnostics }
      if (error instanceof RoutingParseFault) return { status: 'invalid', diagnostics: [issue(error.code, error.path, error.message)] }
      return storageFailure(error, writeStarted)
    }
  }
  return { read, save }
}
function issue(code: RoutingDiagnostic['code'], path: string, message: string): RoutingDiagnostic { return { code, path, message, severity: 'error' } }
function readFailureDiagnostics(error: unknown): RoutingDiagnostic[] {
  if (error instanceof RoutingSettingsRejected) return error.diagnostics
  if (error instanceof RoutingParseFault) return [issue(error.code, error.path, error.message)]
  if (error instanceof RoutingCatalogUnavailableError) return [issue('CATALOG_VALIDATION_FAILED', '$.catalog', 'Local catalog could not be validated.')]
  return [issue('SETTINGS_READ_FAILED', '$', 'Authoritative settings could not be read; no fallback state was invented.')]
}
function storageFailure(error: unknown, writeStarted: boolean): Extract<RoutingSettingsSaveOutcome, { status: 'storage_error' }> {
  if (!writeStarted) return { status: 'storage_error', commitState: 'not_attempted', diagnostics: readFailureDiagnostics(error) }
  if (error instanceof RoutingSettingsWriteError && error.outcome === 'not_committed') {
    return { status: 'storage_error', commitState: 'not_committed', diagnostics: [issue('SETTINGS_WRITE_FAILED', '$', 'Settings were not committed; the previous state remains authoritative.')] }
  }
  return { status: 'storage_error', commitState: 'unknown', diagnostics: [issue('SETTINGS_COMMIT_UNKNOWN', '$', 'Commit outcome is uncertain; reread authoritative settings before retrying.')] }
}
