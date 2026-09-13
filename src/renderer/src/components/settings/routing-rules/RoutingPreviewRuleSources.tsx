import type { RoutingRulePreviewResult, RoutingRuleSource } from '../../../../../shared/routing-policy-types'

interface Props {
  preview: Pick<RoutingRulePreviewResult, 'matchedRules' | 'diagnostics'>
  rules?: readonly { id: string; name: string }[]
}

/** Source is main-owned evidence. A first migration preview cannot yet identify
 * which legacy disposition will assign the saved source. Never infer it here. */
export default function RoutingPreviewRuleSources({ preview, rules = [] }: Props): React.JSX.Element {
  const migrationPending = preview.diagnostics.some((item) => item.code === 'LEGACY_REVIEW_REQUIRED'
    && item.path === '$.migration' && item.severity === 'info')
  return <section data-routing-preview-rule-sources aria-label="命中的规则来源">
    <h4>命中的规则</h4>
    <ul>{preview.matchedRules.map((rule, index) => <li key={rule.id} data-routing-preview-source-rule={rule.id}>
      <strong>{rules.find((item) => item.id === rule.id)?.name || `规则 ${index + 1}`}</strong>
      <p data-routing-preview-source-label>{sourceLabel(rule.source, migrationPending)}</p>
      {rule.source.kind === 'legacy_settings' && <LegacySourceRecord source={rule.source} />}
    </li>)}</ul>
    {!preview.matchedRules.length && <p>这次检查没有命中已配置的规则。</p>}
  </section>
}
function sourceLabel(source: RoutingRuleSource, migrationPending: boolean): string {
  if (source.kind === 'legacy_settings') return `旧规则第 ${source.legacyIndex + 1} 条`
  return migrationPending ? '迁移来源待确认' : '手动配置'
}
function LegacySourceRecord({ source }: { source: Extract<RoutingRuleSource, { kind: 'legacy_settings' }> }): React.JSX.Element {
  return <details data-routing-preview-source-record><summary>查看来源记录</summary>
    <dl><dt>原配置摘要</dt><dd>{source.legacyDigest}</dd><dt>原条目序号</dt><dd>{source.legacyIndex + 1}</dd>
      {source.legacyId && <><dt>原规则标识</dt><dd>{source.legacyId}</dd></>}
    </dl>
  </details>
}
