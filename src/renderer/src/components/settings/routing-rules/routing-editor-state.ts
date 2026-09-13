import type { RoutingRuleEditorShellProps } from './routing-editor-props'
import type { RoutingLegacyResolution } from '../../../../../shared/routing-policy-types'

export function commitNeedsReread(props: Pick<RoutingRuleEditorShellProps, 'lastSave'>): boolean {
  return props.lastSave?.status === 'storage_error' && props.lastSave.commitState === 'unknown'
}
export function editorLocked(props: Pick<RoutingRuleEditorShellProps, 'read' | 'busy' | 'lastSave'>): boolean {
  return Boolean(props.busy) || props.read.mode === 'invalid_v1' || commitNeedsReread(props)
}
export function saveBlocked(props: RoutingRuleEditorShellProps): boolean {
  return editorLocked(props) || !props.dirty || props.lastSave?.status === 'conflict' || !legacyReviewProgress(props).complete
}
/** Local review bookkeeping, never schema validation or authority to commit. Main revalidates. */
export function legacyReviewProgress({ read, migration, draft }: Pick<RoutingRuleEditorShellProps, 'read' | 'migration' | 'draft'>): {
  complete: boolean; resolved: number; total: number; reason?: string
} {
  if (read.mode !== 'legacy_active') return { complete: true, resolved: 0, total: 0 }
  const total = read.legacyCount
  if (total === 0) return { complete: true, resolved: 0, total }
  if (migration?.legacyDigest !== read.legacyDigest) return { complete: false, resolved: 0, total, reason: '旧规则已变化或尚未检查，请先完成逐条处理。' }
  const resolutions = migration.resolutions
  const uniqueRows = new Set(resolutions.map((item) => item.legacyIndex)).size === resolutions.length
  const targets = resolutions.filter((item) => item.kind === 'replace').map((item) => item.ruleId)
  const uniqueTargets = new Set(targets).size === targets.length
  const resolved = read.migration.filter((entry) => resolutionExists(resolutions, entry.legacyIndex, draft.rules.map((rule) => rule.id))).length
  const complete = uniqueRows && uniqueTargets && resolved === total && resolutions.length === total
  return { complete, resolved, total, reason: complete ? undefined : '请为每条旧规则选择唯一替换规则或停用；失效和重复的选择需要修复。' }
}
function resolutionExists(resolutions: readonly RoutingLegacyResolution[], index: number, ruleIds: readonly string[]): boolean {
  const resolution = resolutions.find((item) => item.legacyIndex === index)
  if (!resolution) return false
  return resolution.kind === 'retire' || ruleIds.includes(resolution.ruleId)
}
