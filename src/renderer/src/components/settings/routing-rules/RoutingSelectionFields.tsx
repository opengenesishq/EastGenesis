import { useId } from 'react'
import type { RoutingSelection, RoutingTargetRef } from '../../../../../shared/routing-policy-types'
import RoutingTargetPicker from './RoutingTargetPicker'
import type { RoutingProviderOption } from './routing-ui-props'
import { emptyTarget, replaceTarget, selectionWithKind } from './routing-form-state'
import { options, SELECTION_LABELS } from './routing-form-options'

interface Props {
  value: RoutingSelection
  providers: readonly RoutingProviderOption[]
  maxTargets: number
  onChange(value: RoutingSelection): void
}
export default function RoutingSelectionFields(props: Props): React.JSX.Element {
  const id = useId()
  return <section className="rr-section">
    <h4>使用</h4>
    <label htmlFor={id}>选择范围<select id={id} data-routing-rule-selection value={props.value.kind}
      onChange={(event) => props.onChange(selectionWithKind(props.value, event.target.value as RoutingSelection['kind']))}>
      {options(SELECTION_LABELS).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
    <SelectionTargets {...props} />
    <p className="rr-hint">仍遵守任务指定的厂商和模型，以及能力、预算与外发权限要求。</p>
  </section>
}
function SelectionTargets({ value, providers, maxTargets, onChange }: Props): React.JSX.Element {
  switch (value.kind) {
    case 'global_auto': return <p>在所有符合任务要求的可用模型中自动选择。</p>
    case 'provider_auto': return <ProviderScope value={value.providerId} providers={providers} onChange={(providerId) => onChange({ ...value, providerId })} />
    case 'fixed': return <RoutingTargetPicker label="固定目标" value={value.target} providers={providers} onChange={(target) => onChange({ ...value, target })} />
    case 'candidate_set': return <TargetList title="候选集合" values={value.targets} max={maxTargets} providers={providers} onChange={(targets) => onChange({ ...value, targets })} required />
    case 'preferred': return <>
      <RoutingTargetPicker label="首选目标" value={value.primary} providers={providers} onChange={(primary) => onChange({ ...value, primary })} />
      <TargetList title="明确备选" values={value.alternatives} max={maxTargets - 1} providers={providers} onChange={(alternatives) => onChange({ ...value, alternatives })} />
    </>
  }
}
function ProviderScope({ value, providers, onChange }: {
  value: string; providers: readonly RoutingProviderOption[]; onChange(id: string): void
}): React.JSX.Element {
  const id = useId(), provider = providers.find((item) => item.id === value)
  return <label htmlFor={id}>限定厂商<select id={id} data-routing-provider-scope value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">选择厂商…</option>
    {value && !provider && <option value={value} disabled>原厂商已不在目录中，请修复</option>}
    {providers.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{item.available ? '' : '（暂不可用）'}</option>)}
  </select>{(!provider || !provider.available) && <span className="rr-error">请选择可用厂商；原范围不会被自动替换。</span>}</label>
}
function TargetList({ title, values, max, providers, required = false, onChange }: {
  title: string; values: readonly RoutingTargetRef[]; max: number; providers: readonly RoutingProviderOption[]
  required?: boolean; onChange(values: RoutingTargetRef[]): void
}): React.JSX.Element {
  return <div className="rr-target-list" data-routing-target-list={required ? 'candidates' : 'alternatives'}>
    <h5>{title}</h5>
    {values.map((target, index) => <div key={index} className="rr-target-row" data-routing-target-index={index}>
      <RoutingTargetPicker label={`${title} ${index + 1}`} value={target} providers={providers} onChange={(next) => onChange(replaceTarget(values, index, next))} />
      <button type="button" data-routing-remove-target aria-label={`移除${title} ${index + 1}`} onClick={() => onChange(values.filter((_, at) => at !== index))}>移除</button>
    </div>)}
    {!values.length && <p className={required ? 'rr-error' : 'rr-hint'}>{required ? '至少明确选择一个候选目标。' : '尚无备选：只考虑首选目标，不会自动添加其它厂商或旧的备用模型。'}</p>}
    <button type="button" data-routing-add-target disabled={values.length >= max} onClick={() => onChange([...values, emptyTarget()])}>添加{title}</button>
  </div>
}
