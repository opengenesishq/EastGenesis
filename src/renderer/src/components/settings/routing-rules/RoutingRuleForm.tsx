import { useId } from 'react'
import type { RoutingRuleFormProps } from './routing-ui-props'
import { hasFixedCrossTargetRetry } from './routing-form-state'
import { options, STRATEGY_LABELS } from './routing-form-options'
import RoutingConditionFields from './RoutingConditionFields'
import RoutingSelectionFields from './RoutingSelectionFields'
import RoutingFailureFields from './RoutingFailureFields'
import './routing-rule-form.css'

/** Draft-only surface. Version/source, migration, CAS, validation and execution belong to the outer editor/main. */
export default function RoutingRuleForm(props: RoutingRuleFormProps): React.JSX.Element {
  const { draft, onChange, limits, disabled } = props
  const id = useId()
  return <section className="rr-form" data-routing-rule-form={draft.id}>
    <h3>编辑路由规则</h3><p className="rr-hint">明确适用条件、模型选择和失败后的处理方式。修改后需要保存。</p>
    <fieldset className="rr-body" disabled={disabled}>
      <legend className="rr-sr-only">规则草稿</legend>
      <label htmlFor={`${id}-name`}>规则名称<input id={`${id}-name`} data-routing-rule-name value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
      <label className="rr-check"><input type="checkbox" data-routing-rule-enabled checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} />启用此规则</label>
      <ScopeFields />
      <RoutingConditionFields value={draft.when} maxKeywords={limits.keywords} onChange={(when) => onChange({ ...draft, when })} />
      <RoutingSelectionFields value={draft.selection} providers={props.providers} maxTargets={limits.targets} onChange={(selection) => onChange({ ...draft, selection })} />
      <SelectionPreference {...props} />
      <RoutingFailureFields value={draft.failure} fixed={draft.selection.kind === 'fixed'} maxRetries={limits.retries} onChange={(failure) => onChange({ ...draft, failure })} />
      <AdvancedPreferences {...props} />
    </fieldset>
    <RuleDiagnostics {...props} />
  </section>
}
function AdvancedPreferences({ draft, onChange, limits }: RoutingRuleFormProps): React.JSX.Element {
  const id = useId()
  return <details className="rr-advanced" data-routing-advanced-preferences><summary>高级选项：规则优先级</summary>
      <label htmlFor={`${id}-priority`}>同一范围内的优先级<input id={`${id}-priority`} type="number" min={0} max={limits.maxPriority} step={1}
        data-routing-rule-priority value={Number.isNaN(draft.priority) ? '' : draft.priority} onChange={(event) => onChange({ ...draft, priority: event.target.valueAsNumber })} /></label>
      <p className="rr-hint">数值越大越优先。相同范围和优先级的规则同时命中时会提示冲突；可通过“检查会使用哪个模型”核对。</p>
  </details>
}
function SelectionPreference({ draft, onChange }: RoutingRuleFormProps): React.JSX.Element {
  const id = useId()
  return <section className="rr-section" data-routing-selection-preference>
      <h4>选择偏好</h4>
      <label htmlFor={`${id}-strategy`}>多个模型可用时更看重<select id={`${id}-strategy`} data-routing-rule-strategy value={draft.strategy}
        onChange={(event) => onChange({ ...draft, strategy: event.target.value as typeof draft.strategy })}>
        {options(STRATEGY_LABELS).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      {draft.selection.kind === 'fixed' && <p className="rr-hint">当前固定为一个模型，选择偏好不会替换它。</p>}
      {draft.selection.kind === 'preferred' && <p className="rr-hint">{draft.selection.alternativesOrder === 'configured'
        ? '先使用首选模型。失败切换遵循指定顺序，选择偏好不会重排备选。'
        : '先使用首选模型。只有允许失败切换时，才按此偏好从明确备选中选择。'}</p>}
  </section>
}
function ScopeFields(): React.JSX.Element {
  return <p className="rr-hint" data-routing-rule-scope>作用范围：所有对话任务</p>
}
function RuleDiagnostics({ draft, diagnostics = [] }: RoutingRuleFormProps): React.JSX.Element {
  const relevant = diagnostics.filter((item) => !item.ruleId || item.ruleId === draft.id || item.relatedRuleIds?.includes(draft.id))
  return <div className="rr-diagnostics" data-routing-rule-diagnostics>
    {hasFixedCrossTargetRetry(draft) && <p className="rr-error" role="alert" data-routing-compatibility-error>
      固定模型不能在失败后换用其它目标。现有失败策略已保留，请明确改为暂停或在原目标重试。
    </p>}
    {relevant.map((item, index) => <p key={`${item.code}:${item.path}:${index}`} className={`rr-diagnostic rr-${item.severity}`}
      role={item.severity === 'error' ? 'alert' : 'status'} data-routing-rule-diagnostic={item.code} data-routing-diagnostic-path={item.path}>{item.message}</p>)}
  </div>
}
