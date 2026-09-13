import type { ProviderView } from '../../../../../shared/types'
import type { RoutingProviderOption } from './routing-ui-props'

/**
 * Build the editor catalog from the same persisted model evidence used by the
 * main-process router.  Unknown declarations stay selectable (the router can
 * still validate them at preview time); an explicitly failed probe is shown
 * as unavailable so a user cannot pin a known-bad model by accident.
 */
export function routingProviderOptions(providers: readonly ProviderView[]): RoutingProviderOption[] {
  return providers.map((provider) => {
    const modelProfiles = provider.advancedConfig?.modelProfiles ?? []
    const models = provider.models.map((model) => {
      const profile = modelProfiles.find((candidate) => candidate.model.toLowerCase() === model.toLowerCase()
        || candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()))
      const failed = profile?.verification?.generation === 'failed'
      return {
        model,
        displayName: profile?.displayName,
        available: !failed,
        ...(failed ? { reason: '最近一次生成探测失败；请重新检查连接后再固定此模型。' } : {})
      }
    })
    return {
      id: provider.id,
      name: provider.name,
      available: Boolean(provider.ready),
      models
    }
  })
}
