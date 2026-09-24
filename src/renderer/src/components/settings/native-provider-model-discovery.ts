import type { ProviderManagementApi, ProviderModelFetchInput, ProviderView } from '../../../../shared/types'

type DiscoveryApi = Pick<ProviderManagementApi, 'listProviders' | 'fetchProviderModels' | 'updateProvider'>
export type ImportedModelsFailure = 'missing' | 'changed' | 'unavailable'
export class ImportedModelsError extends Error {
  constructor(readonly reason: ImportedModelsFailure, message?: string) { super(message ?? reason) }
}

/** Credentials are resolved from providerId in the main process; they never return to this UI flow. */
export async function discoverImportedProviderModels(providerId: string, api: DiscoveryApi): Promise<ProviderView> {
  const original = (await api.listProviders()).find((provider) => provider.id === providerId)
  if (!original) throw new ImportedModelsError('missing')
  const request = savedConnection(original)
  const discovery = await api.fetchProviderModels(request)
  const models = [...new Set(discovery.models.map((model) => model.trim()).filter(Boolean))]
  if (!discovery.ok || discovery.stale || models.length === 0) {
    throw new ImportedModelsError('unavailable', discovery.error?.message)
  }
  const latest = (await api.listProviders()).find((provider) => provider.id === providerId)
  if (!latest) throw new ImportedModelsError('missing')
  if (connectionIdentity(original) !== connectionIdentity(latest)) throw new ImportedModelsError('changed')
  // Preserve any models another window added while the request was running.
  return api.updateProvider(providerId, { models: [...new Set([...latest.models, ...models])] })
}

function savedConnection(provider: ProviderView): ProviderModelFetchInput {
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    engine: provider.engine,
    openaiProtocol: provider.openaiProtocol,
    authMode: provider.authMode,
    customHeaders: provider.customHeaders,
    credentialHeaderNames: provider.credentialHeaderNames
  }
}
function connectionIdentity(provider: ProviderView): string {
  return JSON.stringify({ ...savedConnection(provider), activeKeyId: provider.activeKeyId, authorization: provider.authorization })
}
