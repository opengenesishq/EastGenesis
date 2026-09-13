import type { RoutingControllerState } from './routing-controller-types'
import { reviewedPanelDraft, summarizeRoutingRule } from './routing-panel-state'

export default function RoutingPanelComparison({ state, providerName, lineName, onAdopt, onKeepDraft, onReread }: {
  state: RoutingControllerState
  providerName(id: string): string
  lineName(id: string): string
  onAdopt(): void
  onKeepDraft(): void
  onReread(): void
}): React.JSX.Element | null {
  const current = state.comparison?.current
  if (!current) return null
  const reviewed = reviewedPanelDraft(state)
  const local = state.draft?.rules ?? []
  const saved = current.mode === 'v1_active' ? current.ruleSet.rules : []
  const ids = [...new Set([...local.map((rule) => rule.id), ...saved.map((rule) => rule.id)])]
  const format = (rule: (typeof local)[number] | (typeof saved)[number] | undefined): React.JSX.Element => rule
    ? <ul>{summarizeRoutingRule(rule, providerName, lineName).map((value, index) => <li key={index}>{value}</li>)}</ul>
    : <span>无此规则</span>
  return <section className="rr-panel-comparison" data-routing-comparison aria-label="路由规则比较">
    <h3>核对规则变化</h3>
    {current.mode === 'v1_active' && <p>已保存版本 {current.ruleSet.revision}</p>}
    {current.mode === 'legacy_active' && <p>已保存旧规则 {current.legacyCount} 条</p>}
    {current.mode === 'invalid_v1' && <p role="alert">已保存规则无法读取，草稿已保留。</p>}
    {ids.map((id) => <div className="rr-panel-comparison-row" data-routing-comparison-rule={id} key={id}>
      <div><h4>本地草稿</h4>{format(local.find((rule) => rule.id === id))}</div>
      <div><h4>已保存内容</h4>{format(saved.find((rule) => rule.id === id))}</div>
    </div>)}
    {reviewed.reason && <p role="alert">{reviewed.reason}</p>}
    <div className="rr-editor-actions">
      <button type="button" data-routing-comparison-keep disabled={Boolean(state.pending) || !reviewed.resolution} onClick={onKeepDraft}>确认保留本地草稿</button>
      <button type="button" data-routing-comparison-adopt disabled={Boolean(state.pending) || current.mode === 'invalid_v1'} onClick={onAdopt}>放弃草稿，采用已保存内容</button>
      <button type="button" data-routing-comparison-reread disabled={Boolean(state.pending)} onClick={onReread}>重新读取</button>
    </div>
  </section>
}
