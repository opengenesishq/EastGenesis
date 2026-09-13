import type { AppSettings } from '../../shared/types'
import type { RoutingRulePreviewResult, RoutingRuleReadResult, RoutingRuleSaveResult } from '../../shared/routing-policy-types'
import { parseSettingsDomainCommand } from './settings-domain-commands'

export interface SettingsDomainServices {
  getSettings(): AppSettings
  updateSettings(patch: Partial<AppSettings>): AppSettings
  revokeAllGuiAutomationGrants(): void
  configureProviderCircuitBreaker(settings: AppSettings['providerCircuitBreaker']): void
  readRules(): RoutingRuleReadResult | Promise<RoutingRuleReadResult>
  previewRules(input: unknown): Promise<RoutingRulePreviewResult>
  saveRules(input: unknown): Promise<RoutingRuleSaveResult>
}

/** Register behind the existing trusted-sender gate and exactly-one-argument check.
 * This dispatcher has no generic method lookup and preserves the two existing
 * ordinary-settings update effects only after a successful atomic settings write. */
export async function dispatchSettingsDomain(raw: unknown, services: SettingsDomainServices) {
  const command = parseSettingsDomainCommand(raw)
  switch (command.kind) {
    case 'get': return services.getSettings()
    case 'update': return updateOrdinarySettings(command.patch, services)
    case 'route-read': return services.readRules()
    case 'route-preview': return services.previewRules(command.input)
    case 'route-save': return services.saveRules(command.input)
  }
}

function updateOrdinarySettings(patch: Partial<AppSettings>, services: SettingsDomainServices): AppSettings {
  const next = services.updateSettings(patch)
  if (!next.guiAutomationEnabled) services.revokeAllGuiAutomationGrants()
  services.configureProviderCircuitBreaker(next.providerCircuitBreaker)
  return next
}
