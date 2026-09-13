import type { AppSettings } from './types'
import type { RoutingRuleApi, RoutingRulePreviewInput, RoutingRulePreviewResult, RoutingRuleReadResult, RoutingRuleSaveInput, RoutingRuleSaveResult } from './routing-policy-types'

/** Internal transport only. The renderer receives named methods, never an invoke/command method. */
export type SettingsDomainCommand =
  | { kind: 'get' }
  | { kind: 'update'; patch: Partial<AppSettings> }
  | { kind: 'route-read' }
  | { kind: 'route-preview'; input: RoutingRulePreviewInput }
  | { kind: 'route-save'; input: RoutingRuleSaveInput }

export type SettingsDomainResult<C extends SettingsDomainCommand> =
  C extends { kind: 'get' | 'update' } ? AppSettings :
  C extends { kind: 'route-read' } ? RoutingRuleReadResult :
  C extends { kind: 'route-preview' } ? RoutingRulePreviewResult : RoutingRuleSaveResult

export interface SettingsDomainApi extends RoutingRuleApi {
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
}
