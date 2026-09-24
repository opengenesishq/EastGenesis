import type { AppSettings, Provider } from '../../shared/types'
import { EMPTY_AUTHORIZATION_POOL_DIGEST } from '../provider/providerAuthorizationPoolIdentity'
import { assignProviderConnectionIdentity } from '../provider/providerConnectionIdentity'

/** Only connection material is copied. No sessions, directories, OAuth pools, prompts or private files. */
export function temporaryProviders(providers: readonly Provider[]): Provider[] {
  return providers.filter(provider => !provider.authorization ||
    (['api-key', 'none'].includes(provider.authorization.method) && provider.authorization.status === 'authorized')).map(provider => {
    const keys = (provider.apiKeys ?? []).filter(key => !key.sessionOnly && key.encryptedToken.startsWith('enc:'))
      .map(({ id, label, encryptedToken, createdAt, disabled, policy }) => ({ id, label, encryptedToken, createdAt, disabled, policy }))
    const active = keys.find(key => key.id === provider.activeKeyId) ?? keys.find(key => !key.disabled)
    return assignProviderConnectionIdentity(undefined, {
      id: provider.id, name: provider.name, baseUrl: provider.baseUrl, models: [...provider.models],
      engine: provider.engine, openaiProtocol: provider.openaiProtocol, authMode: provider.authMode,
      encryptedToken: active?.encryptedToken ?? '', apiKeys: keys, activeKeyId: active?.id,
      credentialRoutingMode: provider.credentialRoutingMode, customHeaders: provider.customHeaders,
      credentialHeaderNames: provider.credentialHeaderNames, budgetUsd: provider.budgetUsd, createdAt: provider.createdAt,
      ...(provider.advancedConfig?.modelProfiles?.length ? { advancedConfig: { schemaVersion: 1 as const,
        modelProfiles: provider.advancedConfig.modelProfiles.map(({ model, displayName, aliases, capabilities, contextWindow, pricing, mediaPricing }) =>
          structuredClone({ model, displayName, aliases, capabilities, contextWindow, pricing, mediaPricing }))
      } } : {})
    }, { authorizationPoolDigest: EMPTY_AUTHORIZATION_POOL_DIGEST })
  })
}
export function temporarySettings(settings: AppSettings): Partial<AppSettings> {
  return {
    language: settings.language, theme: settings.theme, desktopFonts: settings.desktopFonts,
    layout: settings.layout, driveMode: settings.driveMode,
    defaultModel: settings.defaultModel, defaultProviderId: settings.defaultProviderId,
    defaultTaskStrategy: settings.defaultTaskStrategy, experienceMode: settings.experienceMode,
    budgetUsdPerSession: settings.budgetUsdPerSession, budgetUsdPerMonth: settings.budgetUsdPerMonth,
    schedulerStrategy: settings.schedulerStrategy, modelRoutingRules: settings.modelRoutingRules,
    smartModelRoutingEnabled: settings.smartModelRoutingEnabled, routingExpertPolicy: settings.routingExpertPolicy,
    failoverEnabled: settings.failoverEnabled, providerCircuitBreaker: settings.providerCircuitBreaker,
    fallbackProviderId: settings.fallbackProviderId, fallbackModel: settings.fallbackModel,
    autoSkillLearningEnabled: false, guiAutomationEnabled: false, notificationsEnabled: false,
    sandboxMode: 'restrictedLocal', permissionRules: [], permissionAllowlist: '', permissionDenylist: '',
    permissionTemporaryAllowlist: '', persona: ''
  }
}
