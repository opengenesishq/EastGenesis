import { useState } from 'react'
import { CircleMinus, Plus } from 'lucide-react'
import type { ProviderView } from '../../../../shared/types'
import type { MediaOperation, MediaProviderProfile, MediaRoutingPreference } from '../../../../shared/media-types'
import { MEDIA_AUTO_PROVIDER_ID } from '../../../../shared/media-routing-types'
import { useT } from '../../i18n'

interface Props {
  operation: MediaOperation
  selectedId: string
  preference: MediaRoutingPreference
  profiles: MediaProviderProfile[]
  providers: ProviderView[]
  busy: boolean
  onOperation: (operation: MediaOperation) => void
  onSelect: (id: string) => void
  onPreference: (preference: MediaRoutingPreference) => void
  run: (operation: () => Promise<unknown>) => Promise<void>
}

export const mediaOperationOptions: Array<[MediaOperation, string]> = [
  ['image.generate', '文本生图'], ['image.edit', '图片编辑'], ['video.text-to-video', '文生视频'],
  ['video.image-to-video', '图生视频'], ['video.reference-to-video', '参考图视频'],
  ['speech.synthesize', '文本转语音'], ['speech.voice-clone', '声音克隆']
]

export default function VideoMediaRoutingControls(props: Props): React.JSX.Element {
  const t = useT()
  const compatible = props.profiles.filter((profile) => profile.enabled && profile.operations.includes(props.operation))
  const selected = compatible.find((profile) => profile.id === props.selectedId)
  return <>
    <div className="video-studio-provider-toolbar" data-media-routing-controls>
      <label><span>{t('mediaRoutingOperation')}</span><select className="input" value={props.operation} onChange={(event) => props.onOperation(event.target.value as MediaOperation)} aria-label={t('mediaRoutingOperationAria')}>{mediaOperationOptions.map(([value]) => <option key={value} value={value}>{t(`mediaOperation_${value}`)}</option>)}</select></label>
      <label><span>{t('mediaRoutingConnection')}</span><select className="input" value={props.selectedId} onChange={(event) => props.onSelect(event.target.value)} aria-label={t('mediaRoutingProviderAria')}>
        <option value={MEDIA_AUTO_PROVIDER_ID}>{t('mediaRoutingAuto')}</option>
        {!selected && props.selectedId !== MEDIA_AUTO_PROVIDER_ID && <option value={props.selectedId} disabled>{t('mediaRoutingUnavailable')}</option>}
        {compatible.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}{profile.source === 'provider-catalog' ? t('mediaRoutingCatalogSuffix') : ''}</option>)}
      </select></label>
      <label><span>{t('mediaRoutingPreference')}</span><select className="input" value={props.preference} onChange={(event) => props.onPreference(event.target.value as MediaRoutingPreference)} aria-label={t('mediaRoutingPreferenceAria')}><option value="balanced">{t('mediaRoutingBalanced')}</option><option value="cost">{t('mediaRoutingCost')}</option><option value="speed">{t('mediaRoutingSpeed')}</option><option value="quality">{t('mediaRoutingQuality')}</option></select></label>
      <span>{selected?.endpointClass === 'mock' ? t('mediaRoutingLocal') : selected ? `${selected.source === 'provider-catalog' ? t('mediaRoutingReuse') : t('mediaRoutingManual')} · ${priceLabel(selected, t)}` : t('mediaRoutingAutoHint')}</span>
      {selected && selected.source !== 'provider-catalog' && selected.endpointClass !== 'mock' && <button type="button" className="btn btn-ghost btn-icon-sm" disabled={props.busy} onClick={() => void props.run(async () => { await window.agentDesk.deleteMediaProvider({ id: selected.id }); props.onSelect(MEDIA_AUTO_PROVIDER_ID) })} aria-label={t('mediaRoutingDelete')} title={t('mediaRoutingDelete')}><CircleMinus size={13} /></button>}
    </div>
    <p className="field-hint">{t('mediaRoutingHint')}</p>
    <ManualMediaAdapter {...props} />
  </>
}

function ManualMediaAdapter(props: Props): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState({ displayName: '', providerId: '', model: '', estimatedCostUsd: '', endpointClass: 'generic-async' as MediaProviderProfile['endpointClass'], submitPath: '/v1/media/jobs', statusPathTemplate: '/v1/media/jobs/{id}', downloadPathTemplate: '/v1/media/jobs/{id}/content', cancelPathTemplate: '/v1/media/jobs/{id}' })
  const update = (key: keyof typeof draft, value: string): void => setDraft((current) => ({ ...current, [key]: value }))
  const save = (): void => void props.run(async () => {
    const operations = operationsForEndpoint(draft.endpointClass)
    const saved = await window.agentDesk.upsertMediaProvider({
      displayName: draft.displayName, providerId: draft.providerId, model: draft.model,
      capabilities: [...new Set(operations.map(operationCapability))], operations, endpointClass: draft.endpointClass,
      ...(draft.estimatedCostUsd.trim() ? { estimatedCostUsd: Number(draft.estimatedCostUsd) } : {}),
      ...(draft.endpointClass === 'generic-async' ? { submitPath: draft.submitPath, statusPathTemplate: draft.statusPathTemplate,
        downloadPathTemplate: draft.downloadPathTemplate, cancelPathTemplate: draft.cancelPathTemplate } : {}),
      requestTimeoutMs: 120_000, enabled: true
    })
    props.onSelect(saved.id)
    setDraft((current) => ({ ...current, displayName: '', model: '', estimatedCostUsd: '' }))
  })
  return <details className="video-studio-provider-editor"><summary>{t('mediaAdapterTitle')}</summary><div>
    <input className="input" value={draft.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder={t('mediaAdapterName')} aria-label={t('mediaAdapterNameAria')} />
    <select className="input" value={draft.providerId} onChange={(event) => update('providerId', event.target.value)} aria-label={t('mediaAdapterBinding')}><option value="">{t('mediaAdapterChooseProvider')}</option>{props.providers.filter((provider) => provider.ready).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>
    <input className="input" value={draft.model} onChange={(event) => update('model', event.target.value)} placeholder={t('mediaAdapterModel')} aria-label={t('mediaAdapterModel')} />
    <input className="input" type="number" min={0} step={0.01} value={draft.estimatedCostUsd} onChange={(event) => update('estimatedCostUsd', event.target.value)} placeholder={t('mediaAdapterEstimate')} aria-label={t('mediaAdapterEstimateAria')} />
    <select className="input" value={draft.endpointClass} onChange={(event) => update('endpointClass', event.target.value)} aria-label={t('mediaAdapterProtocol')}><option value="generic-async">{t('mediaAdapterGeneric')}</option><option value="openai-video">{t('mediaProtocol_openai-video')}</option><option value="openai-image">{t('mediaProtocol_openai-image')}</option><option value="openai-speech">OpenAI TTS</option></select>
    {draft.endpointClass === 'generic-async' && (['submitPath', 'statusPathTemplate', 'downloadPathTemplate', 'cancelPathTemplate'] as const).map((key) => <input key={key} className="input" value={draft[key]} onChange={(event) => update(key, event.target.value)} aria-label={key} />)}
    <button type="button" className="btn btn-secondary btn-sm" onClick={save} disabled={props.busy || !draft.providerId || !draft.model.trim() || !draft.displayName.trim()}><Plus size={13} />{t('mediaAdapterAdd')}</button>
  </div></details>
}

export function operationCapability(operation: MediaOperation): 'image' | 'video' | 'tts' | 'synthesis' {
  if (operation.startsWith('image.')) return 'image'
  if (operation.startsWith('video.')) return 'video'
  return operation.startsWith('speech.') ? 'tts' : 'synthesis'
}

function operationsForEndpoint(endpoint: MediaProviderProfile['endpointClass']): MediaOperation[] {
  if (endpoint === 'openai-image') return ['image.generate', 'image.edit']
  if (endpoint === 'openai-speech') return ['speech.synthesize']
  if (endpoint === 'openai-video') return ['video.text-to-video', 'video.image-to-video', 'video.reference-to-video']
  return mediaOperationOptions.map(([operation]) => operation)
}

function priceLabel(profile: MediaProviderProfile, t: ReturnType<typeof useT>): string {
  if (profile.mediaPricing) return `$${profile.mediaPricing.amount} / ${t(`mediaPriceUnit_${profile.mediaPricing.unit}`)}`
  return profile.estimatedCostUsd === undefined ? t('mediaPriceUnknown') : t('mediaPricePerRequest', { amount: profile.estimatedCostUsd })
}
