import { AUTO_MODEL, type AppSettings, type ProviderView } from '../../../shared/types'

/** Adding another provider must not overwrite an existing routing choice. */
export function initialProviderRoutingPatch(
  settings: Pick<AppSettings, 'defaultProviderId' | 'defaultModel'>,
  providers: Pick<ProviderView, 'id'>[],
  providerId: string
): Partial<AppSettings> | undefined {
  if (providers.some((provider) => provider.id !== providerId)) return undefined
  if (settings.defaultProviderId || settings.defaultModel) return undefined
  return { defaultProviderId: providerId, defaultModel: AUTO_MODEL, smartModelRoutingEnabled: true }
}
