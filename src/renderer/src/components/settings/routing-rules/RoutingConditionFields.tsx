import { useId } from 'react'
import type { RoutingRuleCondition } from '../../../../../shared/routing-policy-types'
import { conditionWithMode, toggleValue, withoutConditionField } from './routing-form-state'
import { options, RISK_LABELS, STRATEGY_LABELS, TASK_LABELS } from './routing-form-options'

interface Props { value: RoutingRuleCondition; maxKeywords: number; onChange(value: RoutingRuleCondition): void }
export default function RoutingConditionFields(props: Props): React.JSX.Element {
  const id = useId(), all = !Object.keys(props.value).length
  return <section className="rr-section">
    <h4>当</h4>
    <label htmlFor={id}>适用条件<select id={id} data-routing-condition-mode value={all ? 'all' : 'conditions'}
      onChange={(event) => props.onChange(conditionWithMode(props.value, event.target.value as 'all' | 'conditions'))}>
      <option value="conditions">满足以下条件</option><option value="all">此范围内所有任务（明确无条件）</option>
    </select></label>
    {all ? <p className="rr-hint">此范围内的所有任务均适用，仍遵守任务指定的模型、预算和权限。</p> : <>
      <KeywordFields {...props} />
      <AdvancedConditions value={props.value} onChange={props.onChange} />
    </>}
  </section>
}
function KeywordFields({ value, maxKeywords, onChange }: Props): React.JSX.Element {
  const keyword = value.keywords
  const values = keyword?.values ?? []
  const setValues = (next: string[]): void => onChange({ ...value, keywords: { mode: keyword?.mode ?? 'any', values: next } })
  return <fieldset className="rr-keywords"><legend>关键词</legend>
    <label>匹配方式<select data-routing-keyword-mode value={keyword?.mode ?? 'any'}
      onChange={(event) => onChange({ ...value, keywords: { mode: event.target.value as 'any' | 'all', values } })}>
      <option value="any">包含任一关键词</option><option value="all">包含全部关键词</option>
    </select></label>
    {values.map((text, index) => <div className="rr-keyword-row" key={index}>
      <input data-routing-keyword={index} aria-label={`关键词 ${index + 1}`} value={text} onChange={(event) => setValues(values.map((item, at) => at === index ? event.target.value : item))} />
      <button type="button" aria-label={`移除关键词 ${index + 1}`} onClick={() => setValues(values.filter((_, at) => at !== index))}>移除</button>
    </div>)}
    <button type="button" data-routing-add-keyword disabled={values.length >= maxKeywords} onClick={() => setValues([...values, ''])}>添加关键词</button>
    {keyword && !values.length && <p className="rr-error">关键词尚未填写；可添加关键词，或明确移除关键词条件。不会自动变成无条件规则。</p>}
    {keyword && <button type="button" data-routing-remove-keywords onClick={() => onChange(withoutConditionField(value, 'keywords'))}>移除关键词条件</button>}
  </fieldset>
}
function AdvancedConditions({ value, onChange }: Pick<Props, 'value' | 'onChange'>): React.JSX.Element {
  const id = useId()
  return <details className="rr-advanced" data-routing-advanced-conditions><summary>更多条件：任务类型、风险与任务原有偏好</summary>
    <fieldset><legend>任务类型（任一）</legend><div className="rr-checks">{options(TASK_LABELS).map((option) => <label key={option.value}>
      <input type="checkbox" data-routing-task-kind={option.value} checked={value.taskKinds?.includes(option.value) ?? false}
        onChange={(event) => { const kinds = toggleValue(value.taskKinds ?? [], option.value, event.target.checked)
          onChange(kinds.length ? { ...value, taskKinds: kinds } : withoutConditionField(value, 'taskKinds')) }} />{option.label}
    </label>)}</div></fieldset>
    <label htmlFor={`${id}-risk`}>最低风险<select id={`${id}-risk`} data-routing-min-risk value={value.minRiskLevel ?? ''}
      onChange={(event) => onChange(event.target.value ? { ...value, minRiskLevel: event.target.value as RoutingRuleCondition['minRiskLevel'] } : withoutConditionField(value, 'minRiskLevel'))}>
      <option value="">不限</option>{options(RISK_LABELS).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select></label>
    <label htmlFor={`${id}-strategy`}>仅当任务原有偏好为<select id={`${id}-strategy`} data-routing-when-strategy value={value.whenStrategy ?? ''}
      onChange={(event) => onChange(event.target.value ? { ...value, whenStrategy: event.target.value as RoutingRuleCondition['whenStrategy'] } : withoutConditionField(value, 'whenStrategy'))}>
      <option value="">不限</option>{options(STRATEGY_LABELS).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select></label>
    <p className="rr-hint">这些条件决定何时使用规则；选择偏好决定多个模型可用时更看重什么。</p>
  </details>
}
