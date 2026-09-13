import { randomUUID } from 'node:crypto'
import type { OfficeRevisionDraftInput, OfficeRevisionIntent, OfficeRevisionPlan } from '../../shared/office-revision-types'
import { officeBytesDigest, officeValueDigest } from './digest'
import { officeError } from './errors'
import { normalizeOfficeDraft, normalizeOfficeIntent } from './input'
import { generateOfficeRevision, officeArtifactSnapshot } from './inspection'
import { readScopedOfficeArtifact, type OfficeContext, type ScopedOfficeArtifact } from './scope'

export interface PreparedOfficePlan { context: OfficeContext; draft: OfficeRevisionDraftInput; view: OfficeRevisionPlan; loaded: ScopedOfficeArtifact; outputDigest: string; outputBytes: number }
// Only previews live here. Durable Effect targets and canonical Artifact records own execution/version history.
const previews = new Map<string, PreparedOfficePlan>()
const MAX_PREVIEWS = 128, TTL_MS = 30 * 60_000
export async function inspectScopedOffice(context: OfficeContext, artifactId: string, expectedDigest?: string) {
  return officeArtifactSnapshot(await readScopedOfficeArtifact(context, artifactId, expectedDigest))
}
export async function prepareOfficeRevision(context: OfficeContext, input: unknown): Promise<OfficeRevisionPlan> {
  const draft = normalizeOfficeDraft(input)
  const loaded = await readScopedOfficeArtifact(context, draft.baseArtifactId, draft.expectedDigest)
  if (!loaded.latest) officeError('OFFICE_BASE_NOT_HEAD', '原稿已被后续版本替代，请重新选择最新成果。')
  const result = await generateOfficeRevision(loaded.record.kind as 'document' | 'spreadsheet', loaded.bytes, draft.operations)
  const planId = `office-plan:${randomUUID()}`, expiresAt = Date.now() + TTL_MS
  const view: OfficeRevisionPlan = { schemaVersion: 1, planId,
    planDigest: officeValueDigest({ schemaVersion: 1, sessionId: context.meta.id, scope: loaded.scope, draft, unchangedScopeDigest: result.unchangedScopeDigest }),
    sessionId: context.meta.id, baseArtifactId: draft.baseArtifactId, baseDigest: draft.expectedDigest,
    nextVersion: loaded.record.version + 1, changes: result.changes, unchangedScopeDigest: result.unchangedScopeDigest,
    checks: result.checks, blockedReasons: [], expiresAt }
  evictOfficePreviews()
  previews.set(planId, { context: { ...context, meta: { ...context.meta } }, draft, view, loaded: { ...loaded, bytes: Buffer.alloc(0) },
    outputDigest: officeBytesDigest(result.bytes), outputBytes: result.bytes.length })
  return structuredClone(view)
}
export function getPreparedOfficePlan(sessionId: string, rawIntent: unknown): PreparedOfficePlan {
  const intent = normalizeOfficeIntent(rawIntent)
  const prepared = previews.get(intent.planId)
  if (!prepared || prepared.view.expiresAt < Date.now()) officeError('OFFICE_PLAN_EXPIRED', '修订预览已过期或应用已重启，请重新检查并生成预览。')
  if (prepared.view.sessionId !== sessionId || !officeIntentMatches(intent, prepared.view)) officeError('OFFICE_PLAN_MISMATCH', '修订意图与当前任务、原稿或预览摘要不一致。')
  return prepared
}
export function officeIntentMatches(intent: OfficeRevisionIntent, plan: Pick<OfficeRevisionPlan, 'planId' | 'planDigest' | 'baseArtifactId' | 'baseDigest'>): boolean {
  return ['planId', 'planDigest', 'baseArtifactId', 'baseDigest'].every((key) => intent[key as keyof OfficeRevisionIntent] === plan[key as keyof OfficeRevisionIntent])
}
function evictOfficePreviews(): void {
  for (const [id, plan] of previews) if (plan.view.expiresAt < Date.now()) previews.delete(id)
  while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value!)
}
