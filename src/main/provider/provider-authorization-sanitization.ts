import type { Provider } from '../../shared/types'
import { normalizedProviderKeys } from './providerKeyRecords'

export function sanitizeUnsupportedProviderAuthorization(provider: Provider): Provider {
  const service = (provider.authorization as { provider?: unknown } | undefined)?.provider
  if (service === undefined || service === 'xai-oauth') return provider
  const hasStoredCredential = Boolean(provider.encryptedToken)
    || normalizedProviderKeys(provider).length > 0
    || Boolean(provider.activeKeyId)
  return {
    ...provider,
    authorization: undefined,
    credentialMigrationRequired: hasStoredCredential || provider.credentialMigrationRequired === true
  }
}
