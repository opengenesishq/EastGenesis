import type { RoutingLegacyResolution, RoutingRuleReadResult, RoutingRuleSetDraftV1 } from '../../../../../shared/routing-policy-types'
import type { RoutingRuleEditorShellProps } from './routing-editor-props'
import { EditorDiagnostics } from './RoutingEditorFeedback'
import { editorLocked, legacyReviewProgress } from './routing-editor-state'

export default function LegacyReview(props: RoutingRuleEditorShellProps & { read: Extract<RoutingRuleReadResult, { mode: 'legacy_active' }> }): React.JSX.Element {
  const progress = legacyReviewProgress(props), locked = editorLocked(props)
  return <section className="rr-legacy-review" data-routing-legacy-review>
    <h3>检查旧规则</h3><p>旧规则仍在使用。首次保存新版前，每条旧规则都需要明确替换或停用。</p>
    <p data-routing-legacy-progress>已处理 {progress.resolved} / {progress.total} 条</p>
    {progress.reason && <p role="alert">{progress.reason}</p>}
    {props.read.migration.map((entry) => <div key={entry.legacyIndex} data-routing-legacy-index={entry.legacyIndex}>
      <h4>旧规则 {entry.legacyIndex + 1}</h4>
      <p>{legacyResolutionLabel(props.migration?.resolutions.find((item) => item.legacyIndex === entry.legacyIndex), props.draft)}</p>
      <EditorDiagnostics diagnostics={entry.diagnostics} />
      <button type="button" data-routing-legacy-replace={entry.legacyIndex} disabled={locked || !props.selectedRuleId}
        onClick={() => { if (!locked && props.selectedRuleId) props.onResolveLegacy({ kind: 'replace', legacyIndex: entry.legacyIndex, ruleId: props.selectedRuleId }) }}>用所选新版规则替换</button>
      <button type="button" data-routing-legacy-retire={entry.legacyIndex} disabled={locked}
        onClick={() => { if (!locked) props.onResolveLegacy({ kind: 'retire', legacyIndex: entry.legacyIndex }) }}>停用这条旧规则</button>
    </div>)}
  </section>
}
function legacyResolutionLabel(resolution: RoutingLegacyResolution | undefined, draft: RoutingRuleSetDraftV1): string {
  if (!resolution) return '尚未处理'
  if (resolution.kind === 'retire') return '已选择停用；保存成功后生效'
  const rule = draft.rules.find((item) => item.id === resolution.ruleId)
  return rule ? `已选择替换为“${rule.name || '未命名规则'}”；保存成功后生效` : '替换规则已不存在，请重新选择'
}
