import { useMemo, useState } from 'react'
import { PROVIDER_PRESETS, type ProviderPreset } from '../store'
import type { EngineKind } from '../../../shared/types'
import { useT } from '../i18n'
import './provider-quick-setup.css'

type CatalogFilter = 'all' | NonNullable<ProviderPreset['category']>

interface Props {
  onSelect: (preset: ProviderPreset) => void
  compact?: boolean
  presets?: ProviderPreset[]
  selectedKey?: string
  disabled?: boolean
}

export default function ProviderPresetCatalog({ onSelect, compact = false, presets: sourcePresets = PROVIDER_PRESETS, selectedKey, disabled = false }: Props): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CatalogFilter>('all')
  const presets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sourcePresets.filter((preset) => {
      const meta = presetMeta(preset)
      if (filter !== 'all' && meta.category !== filter) return false
      if (!needle) return true
      return [preset.label, preset.vendor, preset.baseUrl, preset.hint, ...(preset.models ?? []), ...(preset.searchTerms ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [filter, query, sourcePresets])

  return (
    <section className={`provider-preset-catalog${compact ? ' provider-preset-catalog-compact' : ''}`} data-provider-preset-catalog>
      <div className="provider-preset-catalog-toolbar">
        <input
          className="input input-block provider-preset-search"
          value={query}
          placeholder={t('providerCatalogSearch')}
          aria-label={t('providerCatalogSearch')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="provider-preset-filters" role="group" aria-label={t('providerQuickTemplateLabel')}>
          {(['all', 'official', 'aggregator', 'gateway', 'local'] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={`btn btn-ghost btn-sm${filter === value ? ' is-active' : ''}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(value === 'all' ? 'providerCatalogFilterAll' : `providerCatalogFilter${capitalize(value)}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="provider-preset-catalog-count">{t('providerCatalogResults', { n: presets.length })}</div>
      {presets.length === 0 ? (
        <div className="notice notice-info">{t('providerCatalogEmpty')}</div>
      ) : (
        <div className="provider-preset-grid">
          {presets.map((preset) => {
            const meta = presetMeta(preset)
            if (compact) return <button key={preset.key} type="button"
              className={`provider-preset-choice${selectedKey === preset.key ? ' is-selected' : ''}`}
              data-provider-preset={preset.key} aria-pressed={selectedKey === preset.key}
              disabled={disabled} onClick={() => onSelect(preset)}>
              <span className="provider-preset-monogram" aria-hidden="true">{meta.vendor.slice(0, 1)}</span>
              <span><strong>{preset.label}</strong><small>{t(preset.key === 'custom' ? 'providerSimpleCustom' : regionKey(meta.region))}</small></span>
            </button>
            return (
              <article className="provider-preset-card" key={preset.key}>
                <div className="provider-preset-card-heading">
                  <strong>{preset.label}</strong>
                  <span className="provider-preset-vendor">{meta.vendor}</span>
                </div>
                <div className="provider-preset-badges">
                  <span>{engineLabel(t, preset.engine, preset.openaiProtocol)}</span>
                  <span>{t(billingKey(meta.billing))}</span>
                  <span>{t(regionKey(meta.region))}</span>
                </div>
                <p>{preset.hint}</p>
                <div className="provider-preset-card-footer">
                  <code>{preset.baseUrl || t('officialEndpoint')}</code>
                  <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={() => onSelect(preset)}>
                    {t('providerCatalogApply')}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function billingKey(value: NonNullable<ProviderPreset['billing']>): string {
  if (value === 'free-tier') return 'providerCatalogFreeTier'
  if (value === 'subscription') return 'providerCatalogSubscription'
  if (value === 'local') return 'providerCatalogLocalBilling'
  return 'providerCatalogMetered'
}

function regionKey(value: NonNullable<ProviderPreset['region']>): string {
  if (value === 'china') return 'providerCatalogChina'
  if (value === 'local') return 'providerCatalogLocalRegion'
  return 'providerCatalogGlobal'
}

function engineLabel(
  t: ReturnType<typeof useT>,
  engine: EngineKind,
  protocol: ProviderPreset['openaiProtocol']
): string {
  if (engine === 'anthropic') return t('providerCatalogProtocolAnthropic')
  if (engine === 'gemini') return t('providerCatalogProtocolGemini')
  return protocol === 'chat' ? t('providerCatalogProtocolChat') : t('providerCatalogProtocolResponses')
}

function presetMeta(preset: ProviderPreset): Required<Pick<ProviderPreset, 'vendor' | 'category' | 'region' | 'billing' | 'auth'>> {
  const key = preset.key
  return {
    vendor: preset.vendor ?? preset.label.split(/[(/]/)[0].trim(),
    category: preset.category ?? (key === 'custom' ? 'gateway' : key === 'local-openai' ? 'local' : key === 'oneapi' || key === 'litellm' || key === 'caogen-relay' ? 'gateway' : 'official'),
    region: preset.region ?? (key === 'local-openai' ? 'local' : ['qwen', 'glm', 'kimi', 'baichuan', 'doubao', 'siliconflow'].includes(key) ? 'china' : 'global'),
    billing: preset.billing ?? (key === 'local-openai' ? 'local' : 'metered'),
    auth: preset.auth ?? (key === 'local-openai' ? 'none' : 'api-key')
  }
}
