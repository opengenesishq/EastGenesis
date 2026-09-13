import { isBusinessLineId } from './business-line-types'
import type { RoutingPreviewContext, RoutingPreviewReceipt, RoutingRulePreviewInput, RoutingRuleSaveInput, RoutingRuleSetDraftV1, RoutingRuleSetV1, RoutingDiagnostic, RoutingUserIntent } from './routing-policy-types'
import { digest, discriminant, fail, integer, parseResult, record, stableId } from './routing-policy-parse-fields'
import { parseRoutingRuleSetDraft, readRoutingProviderId, readRoutingTargetRef } from './routing-policy-parser'
import { readRoutingLegacyTransition } from './routing-policy-history-parser'

export function parseRoutingRulePreviewInput(value: unknown) {
  return parseResult<RoutingRulePreviewInput>(() => {
    const row = record(value, '$', ['draft', 'context'])
    return { draft: readDraft(row.draft), context: readContext(row.context) }
  })
}
export function parseRoutingRuleSaveInput(value: unknown) {
  return parseResult<RoutingRuleSaveInput>(() => {
    const row = record(value, '$', ['expectedRevision', 'draft'], ['preview', 'migration'])
    return { expectedRevision: integer(row.expectedRevision, '$.expectedRevision', 0), draft: readDraft(row.draft),
      ...(row.preview === undefined ? {} : { preview: readPreview(row.preview) }),
      ...(row.migration === undefined ? {} : { migration: readRoutingLegacyTransition(row.migration, '$.migration') }) }
  })
}
function readDraft(value: unknown): RoutingRuleSetDraftV1 {
  const result = parseRoutingRuleSetDraft(value)
  if (result.ok === true) return result.value
  const issue = result.diagnostics[0]
  return fail(issue.code, issue.path.replace(/^\$/, '$.draft'), issue.message)
}
function readContext(value: unknown): RoutingPreviewContext {
  const kind = discriminant(value, '$.context')
  if (kind === 'new_task') {
    const row = record(value, '$.context', ['kind', 'businessLineId', 'prompt', 'routingIntent'])
    if (!isBusinessLineId(row.businessLineId)) fail('INVALID_VALUE', '$.context.businessLineId', 'Invalid business-line identity.')
    return { kind, businessLineId: row.businessLineId, prompt: prompt(row.prompt), routingIntent: readRoutingIntent(row.routingIntent) }
  }
  if (kind === 'session') {
    const row = record(value, '$.context', ['kind', 'sessionId', 'prompt'])
    return { kind, sessionId: stableId(row.sessionId, '$.context.sessionId'), prompt: prompt(row.prompt) }
  }
  return fail('INVALID_VALUE', '$.context.kind', 'Unsupported preview context.')
}
export function readRoutingIntent(value: unknown, path = '$.context.routingIntent'): RoutingUserIntent {
  const kind = discriminant(value, path)
  if (kind === 'global') { record(value, path, ['kind']); return { kind } }
  if (kind === 'provider') {
    const row = record(value, path, ['kind', 'providerId'])
    return { kind, providerId: readRoutingProviderId(row.providerId, `${path}.providerId`) }
  }
  if (kind === 'fixed') {
    const row = record(value, path, ['kind', 'target'])
    return { kind, target: readRoutingTargetRef(row.target, `${path}.target`) }
  }
  return fail('INVALID_VALUE', `${path}.kind`, 'Unknown user routing intent.')
}
function prompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000 || value.includes('\0')) {
    fail('INVALID_VALUE', '$.context.prompt', 'Expected a nonempty prompt of at most 20000 characters.')
  }
  return value
}
function readPreview(value: unknown): RoutingPreviewReceipt {
  const row = record(value, '$.preview', ['draftDigest', 'catalogDigest', 'contextDigest', 'previewDigest'])
  return { draftDigest: digest(row.draftDigest, '$.preview.draftDigest'), catalogDigest: digest(row.catalogDigest, '$.preview.catalogDigest'),
    contextDigest: digest(row.contextDigest, '$.preview.contextDigest'), previewDigest: digest(row.previewDigest, '$.preview.previewDigest') }
}

/** Pure precondition only. Main must still CAS the set revision and assign versions. */
export function validateRoutingRuleDraftBase(current: RoutingRuleSetV1, draft: RoutingRuleSetDraftV1): RoutingDiagnostic[] {
  const saved = new Map(current.rules.map((rule) => [rule.id, rule]))
  const retired = new Set(current.retiredIdentities.map((entry) => entry.id))
  return draft.rules.flatMap<RoutingDiagnostic>((rule, index) => {
    if (retired.has(rule.id)) return [{ code: 'RETIRED_RULE_ID', severity: 'error', ruleId: rule.id,
      path: `$.rules[${index}].id`, message: 'This rule ID was retired and cannot be reused, including as a new version.' } satisfies RoutingDiagnostic]
    const expected = saved.get(rule.id)?.version ?? null
    return expected === rule.expectedVersion ? [] : [{ code: 'RULE_VERSION_CONFLICT' as const, severity: 'error' as const,
      ruleId: rule.id, path: `$.rules[${index}].expectedVersion`, message: 'Rule changed, was removed, or already exists; preserve the draft and reload its saved base.' }]
  })
}
