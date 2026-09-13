import type { RoutingDiagnostic, RoutingPreviewContext, RoutingPreviewReceipt, RoutingRuleReadResult, RoutingRuleSaveResult, RoutingRuleSetDraftV1 } from '../../shared/routing-policy-types'
import { parseRoutingRulePreviewInput, parseRoutingRuleSaveInput } from '../../shared/routing-policy-command-parser'
import { evaluateRoutingRuleSet } from '../model/routing-policy/routing-policy-evaluator'
import { createRoutingSettingsCore } from '../routing-settings/routing-settings-core'
import { copySettingsDocument, routingSettingsDigest } from '../routing-settings/routing-settings-json'
import { readStoredRoutingState, rejectSettings } from '../routing-settings/routing-settings-state'
import { RoutingSettingsRejected, type RoutingSettingsSnapshot } from '../routing-settings/routing-settings-types'
import { createRoutingPreviewReceipts } from './routing-preview-receipts'
import { projectRoutingPreview, routingPreviewContextDigest, trustedDraftSources } from './routing-preview-projection'
import type { RoutingPreviewCapture, RoutingRuleServiceDependencies } from './routing-preview-types'

/** Composes the one storage authority and one evaluator. Public activation is
 * separate: the application must wire frozen Run execution before exposing save. */
export function createRoutingRuleService(deps: RoutingRuleServiceDependencies) {
  const receipts = createRoutingPreviewReceipts(deps.now)
  function read(): RoutingRuleReadResult {
    const result = createRoutingSettingsCore(deps).read()
    if (result.status !== 'ready') throw new RoutingSettingsRejected(result.diagnostics)
    return result.value
  }
  async function preview(raw: unknown) {
    const parsed = parseRoutingRulePreviewInput(raw)
    if (!parsed.ok) throw new RoutingSettingsRejected(parsed.diagnostics)
    const { draft, context } = parsed.value
    const snapshot = readSnapshot(deps)
    const state = readStoredRoutingState(snapshot.document)
    const sourcesById = trustedDraftSources(state, draft)
    const inspection = inspectCatalog(deps, snapshot, draft)
    if (state.mode === 'legacy_active' && state.originalRules.length > 0) inspection.diagnostics.push({
      code: 'LEGACY_REVIEW_REQUIRED', severity: 'info', path: '$.migration',
      message: '旧规则的迁移处置尚未绑定到本次预演；规则来源将在保存时按逐条处置确认。'
    })
    const capture = await deps.capturePreview({ context, settings: snapshot })
    assertCurrentPreview(deps, snapshot, capture, draft, inspection.catalogDigest)
    const result = evaluateRoutingRuleSet({ rules: { kind: 'draft', value: draft, sourcesById }, ...capture })
    const receipt = receipts.issue({ draftDigest: routingSettingsDigest(draft), catalogDigest: inspection.catalogDigest,
      contextDigest: routingPreviewContextDigest(capture) }, context)
    return projectRoutingPreview(result, receipt, inspection.diagnostics)
  }
  async function save(raw: unknown): Promise<RoutingRuleSaveResult> {
    const parsed = parseRoutingRuleSaveInput(raw)
    if (!parsed.ok) return { status: 'invalid', diagnostics: parsed.diagnostics }
    const input = parsed.value
    if (!input.preview) return createRoutingSettingsCore(deps).save(input)
    const context = receipts.read(input.preview)
    if (!context) return staleResult('预演记录不存在或已过期，请重新预演。')
    try {
      const snapshot = readSnapshot(deps)
      const capture = await deps.capturePreview({ context, settings: snapshot })
      return createRoutingSettingsCore({ ...deps, validatePreview: (validation) => validateReceipt({
        deps, capture, capturedSnapshot: snapshot, currentSnapshot: validation.snapshot,
        draft: validation.draft, receipt: validation.receipt, catalogDigest: validation.catalogDigest,
        issuedContext: receipts.read(validation.receipt)
      }) }).save(input)
    } catch (error) {
      if (error instanceof RoutingSettingsRejected) return { status: 'invalid', diagnostics: error.diagnostics }
      return { status: 'storage_error', commitState: 'not_attempted', diagnostics: [{ code: 'PREVIEW_UNAVAILABLE',
        severity: 'error', path: '$.preview', message: '无法核验预演所用的本地状态，尚未尝试保存。' }] }
    }
  }
  return { read, preview, save }
}

function readSnapshot(deps: RoutingRuleServiceDependencies): RoutingSettingsSnapshot {
  const value = deps.read()
  if (!value.token) throw new Error('Settings CAS token is missing')
  return { token: value.token, document: copySettingsDocument(value.document) }
}
function inspectCatalog(deps: RoutingRuleServiceDependencies, snapshot: RoutingSettingsSnapshot, draft: RoutingRuleSetDraftV1) {
  const inspected = deps.validateCatalog({ document: copySettingsDocument(snapshot.document), rules: structuredClone(draft.rules) })
  return { catalogDigest: routingSettingsDigest(inspected.catalog), diagnostics: structuredClone(inspected.diagnostics) }
}
function assertCurrentPreview(deps: RoutingRuleServiceDependencies, snapshot: RoutingSettingsSnapshot, capture: RoutingPreviewCapture,
  draft: RoutingRuleSetDraftV1, catalogDigest: string): void {
  const current = readSnapshot(deps)
  if (current.token !== snapshot.token || !deps.isPreviewCaptureCurrent(capture)
    || inspectCatalog(deps, current, draft).catalogDigest !== catalogDigest) {
    rejectSettings('PREVIEW_STALE', '$.preview', '预演期间本地配置或任务归属发生变化，请重新预演。')
  }
}
function validateReceipt(input: {
  deps: RoutingRuleServiceDependencies; capture: RoutingPreviewCapture
  capturedSnapshot: RoutingSettingsSnapshot; currentSnapshot: RoutingSettingsSnapshot
  draft: RoutingRuleSetDraftV1; receipt: RoutingPreviewReceipt; catalogDigest: string
  issuedContext: RoutingPreviewContext | undefined
}): RoutingDiagnostic[] {
  const matches = input.issuedContext && input.capturedSnapshot.token === input.currentSnapshot.token
    && input.deps.isPreviewCaptureCurrent(input.capture)
    && routingSettingsDigest(input.draft) === input.receipt.draftDigest
    && input.catalogDigest === input.receipt.catalogDigest
    && routingPreviewContextDigest(input.capture) === input.receipt.contextDigest
  return matches ? [] : staleResult('草稿、目录或任务约束已变化，请保留草稿并重新预演。').diagnostics
}
function staleResult(message: string): Extract<RoutingRuleSaveResult, { status: 'invalid' }> {
  return { status: 'invalid', diagnostics: [{ code: 'PREVIEW_STALE', severity: 'error', path: '$.preview', message }] }
}
