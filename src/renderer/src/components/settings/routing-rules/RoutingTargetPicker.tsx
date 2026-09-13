import { useId } from 'react'
import type { RoutingProviderOption, RoutingTargetPickerProps } from './routing-ui-props'
import { changeTargetProvider } from './routing-form-state'

/** Fully controlled editor: catalog refreshes never replace the caller's target. */
export default function RoutingTargetPicker({ value, providers, label, disabled, onChange }: RoutingTargetPickerProps): React.JSX.Element {
  const id = useId()
  const provider = providers.find((item) => item.id === value.providerId)
  const model = provider?.models.find((item) => item.model === value.model)
  const missingProvider = Boolean(value.providerId && !provider)
  const missingModel = Boolean(value.model && !model)
  return <fieldset className="rr-target" disabled={disabled} data-routing-target-picker>
    <legend>{label}</legend>
    <div className="rr-grid">
      <label htmlFor={`${id}-provider`}>厂商<select id={`${id}-provider`} value={value.providerId}
        data-routing-target-provider onChange={(event) => onChange(changeTargetProvider(value, event.target.value))}>
        <option value="">选择厂商…</option>
        {missingProvider && <option value={value.providerId} disabled>原厂商已不在目录中</option>}
        {providers.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>
          {item.name}{item.available ? '' : '（暂不可用）'}
        </option>)}
      </select></label>
      <label htmlFor={`${id}-model`}>模型<select id={`${id}-model`} value={value.model}
        disabled={!provider?.available} data-routing-target-model onChange={(event) => onChange({ ...value, model: event.target.value })}>
        <option value="">选择模型…</option>
        {missingModel && <option value={value.model} disabled>{value.model}（原模型已不在此厂商目录中）</option>}
        {(provider?.models ?? []).map((item) => <option key={item.model} value={item.model} disabled={!item.available}>
          {item.displayName ?? item.model}{item.available ? '' : '（暂不可用）'}
        </option>)}
      </select></label>
    </div>
    <TargetStatus provider={provider} model={model} missingProvider={missingProvider} missingModel={missingModel} />
  </fieldset>
}
function TargetStatus({ provider, model, missingProvider, missingModel }: {
  provider?: RoutingProviderOption; model?: RoutingProviderOption['models'][number]
  missingProvider: boolean; missingModel: boolean
}): React.JSX.Element {
  return <>
    <p className="rr-hint" data-routing-target-summary>{provider?.name ?? '待选厂商'} · {model?.displayName ?? model?.model ?? '待选模型'}</p>
    {missingProvider && <p className="rr-error" role="alert">原厂商已移除；目标原值已保留，请明确选择替代厂商。</p>}
    {missingModel && <p className="rr-error" role="alert">原模型不可用；请明确选择此厂商的模型，不会自动换用同名模型。</p>}
    {provider && !provider.available && <p className="rr-error" role="alert">此厂商暂不可用，尚未更改原目标。</p>}
    {model && !model.available && <p className="rr-error" role="alert">{model.reason ?? '此模型暂不可用，尚未更改原目标。'}</p>}
  </>
}
