import type { Provider } from '../../shared/types'
import { inspectProviderBaseUrl, inspectProviderCustomHeaders } from '../providerCredentialBroker'
import { normalizedProviderKeys } from './providerKeyRecords'
import { resolvedProviderCredentialHeaderNames } from './providerCredentialHeaders'

export function persistedProviders(providers: Provider[]): Provider[] {
  return providers.map((provider) => {
    const noAuth = provider.authMode === 'none'
    const apiKeys = noAuth
      ? []
      : normalizedProviderKeys(provider)
        .filter((key) => key.sessionOnly !== true && Boolean(key.encryptedToken))
        .map(({ sessionOnly: _sessionOnly, ...key }) => key)
    const activeKey = apiKeys.find((key) => key.id === provider.activeKeyId && !key.disabled)
      ?? apiKeys.find((key) => !key.disabled)
    const legacyActiveToken = activeKey?.encryptedToken.startsWith('b64:') === true
      ? ''
      : activeKey?.encryptedToken ?? ''
    const safeHeaders = inspectProviderCustomHeaders(provider.customHeaders ?? '').safeValue.trim()
    const safeBaseUrl = inspectProviderBaseUrl(provider.baseUrl).safeValue
    const managedCredentialHeaders = resolvedProviderCredentialHeaderNames(provider)
    return {
      ...provider,
      baseUrl: safeBaseUrl,
      customHeaders: safeHeaders || undefined,
      credentialHeaderNames: managedCredentialHeaders.length > 0 ? managedCredentialHeaders : undefined,
      // 旧 b64 只保留 apiKeys 中的一份，避免持久化时再生成可逆镜像。
      encryptedToken: noAuth ? '' : legacyActiveToken,
      apiKeys,
      activeKeyId: activeKey?.id
    }
  })
}
