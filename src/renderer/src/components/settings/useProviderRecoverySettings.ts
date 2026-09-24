import { useState } from 'react'
import { AUTO_MODEL } from '../../../../shared/types'
import type { ProviderView } from '../../../../shared/types'
import { useStore } from '../../store'
import type { ProviderEditorCloseResult } from '../ProviderEditor'

export type ProviderEditorTarget = ProviderView | 'new' | null

export function useProviderRecoverySettings(providers: ProviderView[]) {
  const context = useStore((state) => state.settingsContext)
  const onboardingContext = context === 'welcome-provider-recovery' || context === 'first-launch-provider-onboarding'
  const setShowSettings = useStore((state) => state.setShowSettings)
  const updateWelcomeDraft = useStore((state) => state.updateWelcomeDraft)
  const [editing, setEditing] = useState<ProviderEditorTarget>(() => {
    if (!onboardingContext) return null
    if (providers.some((provider) => provider.ready && provider.models.length > 0)) return null
    return providers[0] ?? 'new'
  })

  const closeEditor = (result: ProviderEditorCloseResult): void => {
    setEditing(null)
    if (result.reason !== 'saved' || !onboardingContext) return
    if (!result.provider.ready || result.provider.models.length === 0) return
    const routingMode = useStore.getState().welcomeDraft.routingMode
    updateWelcomeDraft({
      computeSelectionSource: 'user',
      providerId: result.provider.id,
      model: routingMode === 'fixed' ? result.provider.models[0] : AUTO_MODEL
    })
    setShowSettings(false)
  }

  return { closeEditor, editing, setEditing }
}
