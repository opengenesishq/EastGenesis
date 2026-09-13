import { createHash } from 'node:crypto'
import type { ProviderModelProfile, ProviderView } from '../../shared/types'
import type { MediaOperation, MediaProviderProfile } from '../../shared/media-types'
import { MEDIA_SCHEMA_VERSION } from '../../shared/media-types'
import { MEDIA_MODEL_PROTOCOLS, declaredMediaOperations, type MediaModelProtocol } from '../../shared/media-model-capabilities'

/** Only an explicit media protocol declaration creates a callable catalog entry. */
export function providerMediaCatalog(providers: ProviderView[]): MediaProviderProfile[] {
  return providers.flatMap((provider) => (provider.advancedConfig?.modelProfiles ?? []).flatMap((model) =>
    catalogEntries(provider, model)))
}

function catalogEntries(provider: ProviderView, model: ProviderModelProfile): MediaProviderProfile[] {
  return Object.entries(MEDIA_MODEL_PROTOCOLS).flatMap(([endpointClass, protocol]) => {
    const operations: MediaOperation[] = declaredMediaOperations(model.capabilities, endpointClass as MediaModelProtocol)
    if (!operations.length) return []
    const identity = `${provider.id}\0${model.model}\0${endpointClass}`
    return [{
      schemaVersion: MEDIA_SCHEMA_VERSION,
      id: `media-catalog:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
      displayName: `${provider.name} · ${model.displayName || model.model}`,
      providerId: provider.id,
      model: model.model,
      capabilities: [protocol.capability],
      operations,
      endpointClass: endpointClass as MediaProviderProfile['endpointClass'],
      ...(model.mediaPricing ? { mediaPricing: model.mediaPricing } : {}),
      source: 'provider-catalog',
      enabled: provider.ready,
      createdAt: provider.createdAt,
      updatedAt: model.mediaPricing?.updatedAt ?? provider.createdAt
    }]
  })
}

export function mergeMediaCatalog(manual: MediaProviderProfile[], providers: ProviderView[]): MediaProviderProfile[] {
  return [...providerMediaCatalog(providers), ...manual.filter((profile) => profile.source !== 'provider-catalog')]
}
