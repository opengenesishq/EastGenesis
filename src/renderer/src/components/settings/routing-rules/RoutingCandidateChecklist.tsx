import type { RoutingTargetRef } from '../../../../../shared/routing-policy-types'
import type { RoutingProviderOption } from './routing-ui-props'

interface Props {
  values: readonly RoutingTargetRef[]
  providers: readonly RoutingProviderOption[]
  max: number
  primary?: RoutingTargetRef
  onChange(values: RoutingTargetRef[]): void
}

/** Edits the existing explicit target list. Unchecked models never become fallback candidates. */
export default function RoutingCandidateChecklist({ values, providers, max, primary, onChange }: Props): React.JSX.Element {
  const isSame = (left: RoutingTargetRef, right: RoutingTargetRef): boolean => left.providerId === right.providerId && left.model === right.model
  return <details className="rr-candidate-checklist" open data-routing-candidate-checklist>
    <summary>勾选{primary ? '备选' : '候选'}模型 · 已选 {values.length}/{max}</summary>
    <p className="rr-hint">{primary ? '勾选的模型作为备选，首选仍在上方单独指定。取消勾选会将该模型排除出备选。'
      : '勾选的模型才参与本规则；取消勾选即排除。'}新增厂商或模型也需在这里明确加入。</p>
    {!providers.some((provider) => provider.models.length) && <p className="rr-hint">请先在设置的厂商页面添加连接和模型。</p>}
    {providers.map((provider) => <fieldset key={provider.id}>
      <legend>{provider.name}{provider.available ? '' : '（连接暂不可用）'}</legend>
      {provider.models.map((model) => {
        const target = { providerId: provider.id, model: model.model }
        const selected = values.some((value) => isSame(value, target))
        const isPrimary = primary ? isSame(primary, target) : false
        const unavailable = !provider.available || !model.available
        return <label key={model.model} className="rr-check" title={model.reason}>
          <input type="checkbox" checked={selected} data-routing-candidate-provider={provider.id} data-routing-candidate-model={model.model}
            disabled={!selected && (unavailable || isPrimary || values.length >= max)}
            onChange={(event) => {
              if (!event.target.checked) onChange(values.filter((value) => !isSame(value, target)))
              else if (!selected && !unavailable && !isPrimary && values.length < max) onChange([...values, target])
            }} />
          <span>{model.displayName ?? model.model}{model.displayName && model.displayName !== model.model && <small> {model.model}</small>}
            {isPrimary ? '（已是首选）' : unavailable ? '（暂不可用）' : ''}</span>
        </label>
      })}
      {!provider.models.length && <p className="rr-hint">尚未配置模型。</p>}
    </fieldset>)}
  </details>
}
