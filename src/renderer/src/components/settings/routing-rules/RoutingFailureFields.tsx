import { useId } from 'react'
import type { RoutingFailurePolicy } from '../../../../../shared/routing-policy-types'
import { failureWithKind, toggleValue } from './routing-form-state'
import { FAILURE_LABELS, options, RETRY_LABELS } from './routing-form-options'

export default function RoutingFailureFields({ value, fixed, maxRetries, onChange }: {
  value: RoutingFailurePolicy; fixed: boolean; maxRetries: number; onChange(value: RoutingFailurePolicy): void
}): React.JSX.Element {
  const id = useId()
  return <section className="rr-section">
    <h4>失败后</h4>
    <label htmlFor={id}>处理方式<select id={id} data-routing-failure-kind value={value.kind}
      onChange={(event) => onChange(failureWithKind(value, event.target.value as RoutingFailurePolicy['kind']))}>
      {options(FAILURE_LABELS).map((option) => <option key={option.value} value={option.value}
        disabled={fixed && option.value === 'retry_allowed_targets'}>{option.label}{fixed && option.value === 'retry_allowed_targets' ? '（固定模型不可用）' : ''}</option>)}
    </select></label>
    {value.kind !== 'pause' && <RetryFields value={value} maxRetries={maxRetries} onChange={onChange} />}
    <p className="rr-hint">仅在后端确认属于所选拒绝原因时重试。预算、权限拒绝和结果未知不会因此重放，仍需处理相应阻断。</p>
  </section>
}
function RetryFields({ value, maxRetries, onChange }: {
  value: Exclude<RoutingFailurePolicy, { kind: 'pause' }>; maxRetries: number; onChange(value: RoutingFailurePolicy): void
}): React.JSX.Element {
  return <>
    <label>最多额外尝试次数<input data-routing-retry-count type="number" min={1} max={maxRetries} step={1}
      value={Number.isNaN(value.maxAdditionalAttempts) ? '' : value.maxAdditionalAttempts}
      onChange={(event) => onChange({ ...value, maxAdditionalAttempts: event.target.valueAsNumber })} /></label>
    <fieldset><legend>允许重试的明确拒绝原因</legend>{options(RETRY_LABELS).map((option) => <label className="rr-check" key={option.value}>
      <input type="checkbox" data-routing-retry-reason={option.value} checked={value.retryOn.includes(option.value)}
        onChange={(event) => onChange({ ...value, retryOn: toggleValue(value.retryOn, option.value, event.target.checked) })} />{option.label}
    </label>)}</fieldset>
    {!value.retryOn.length && <p className="rr-error">请选择至少一种明确拒绝原因；尚未允许重试。</p>}
  </>
}
