import { useState } from 'react'
import type { ProviderModelProfile } from '../../../shared/types'
import type { ProviderMediaPricing } from '../../../shared/media-types'
import { MEDIA_MODEL_PROTOCOLS, declaredMediaOperations, updateDeclaredMediaOperations, type MediaModelProtocol } from '../../../shared/media-model-capabilities'
import { useT } from '../i18n'

interface Props { model: ProviderModelProfile; onChange: (patch: Partial<ProviderModelProfile>) => void }

export default function ProviderMediaModelFields({ model, onChange }: Props): React.JSX.Element {
  const t = useT()
  const [unit, setUnit] = useState<ProviderMediaPricing['unit']>(model.mediaPricing?.unit ?? 'request')
  const selectedUnit = model.mediaPricing?.unit ?? unit
  const updateAmount = (text: string): void => {
    if (!text.trim()) { setUnit(selectedUnit); onChange({ mediaPricing: undefined }); return }
    const amount = Number(text)
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return
    onChange({ mediaPricing: { currency: 'USD', unit: selectedUnit, amount, source: 'user', updatedAt: Date.now() } })
  }
  return <details className="provider-advanced-section" data-provider-media-model={model.model}>
    <summary>{t('mediaModelSettings')}</summary>
    <p className="field-hint">{t('mediaModelSettingsHint')}</p>
    {(Object.keys(MEDIA_MODEL_PROTOCOLS) as MediaModelProtocol[]).map((protocol) => {
      const spec = MEDIA_MODEL_PROTOCOLS[protocol]
      const selected = declaredMediaOperations(model.capabilities, protocol)
      return <fieldset key={protocol} className="provider-advanced-row"><legend>{t(`mediaProtocol_${protocol}`)}</legend>{spec.operations.map((operation) => <label key={operation}><input type="checkbox" data-provider-media-operation={operation} checked={selected.includes(operation)} onChange={(event) => onChange({ capabilities: updateDeclaredMediaOperations(model.capabilities, protocol, event.target.checked ? [...selected, operation] : selected.filter((value) => value !== operation)) })} />{t(`mediaOperation_${operation}`)}</label>)}</fieldset>
    })}
    <div className="provider-advanced-row">
      <label>{t('mediaPriceAmount')}<input className="input" type="number" min="0" max="1000000" step="any" value={model.mediaPricing?.amount ?? ''} onChange={(event) => updateAmount(event.target.value)} placeholder={t('mediaPriceUnknown')} aria-label={t('mediaPriceAmount')} /></label>
      <label>{t('mediaPriceUnit')}<select className="input" value={selectedUnit} onChange={(event) => { const next = event.target.value as ProviderMediaPricing['unit']; setUnit(next); if (model.mediaPricing) onChange({ mediaPricing: { ...model.mediaPricing, unit: next, source: 'user', updatedAt: Date.now() } }) }} aria-label={t('mediaPriceUnit')}>{(['request', 'second', 'million-characters'] as const).map((value) => <option key={value} value={value}>{t(`mediaPriceUnit_${value}`)}</option>)}</select></label>
    </div>
    <p className="field-hint">{t(model.mediaPricing ? 'mediaPriceDeclaredHint' : 'mediaPriceUnknownHint')}</p>
  </details>
}
