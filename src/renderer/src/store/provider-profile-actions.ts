import {
  type AppSettings,
  type LocalComputeActivationOptions,
  type LocalComputeActivationResult,
  type ProviderInput,
  type ProviderProfileApplyResult,
  type ProviderProfileImportDecision,
  type ProviderProfileRollbackResult,
  type ProviderView
} from '../../../shared/types'
import { initialProviderRoutingPatch } from './provider-onboarding-policy'

export interface ProviderProfileStoreActions {
  refreshProviders(): Promise<void>
  activateLocalCompute(options?: LocalComputeActivationOptions): Promise<LocalComputeActivationResult>
  createProvider(input: ProviderInput): Promise<ProviderView>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderView>
  deleteProvider(id: string): Promise<void>
  applyProviderProfileImport(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileApplyResult>
  rollbackProviderProfileBackup(backupId: string): Promise<ProviderProfileRollbackResult>
}

interface ProviderProfileStoreState extends ProviderProfileStoreActions {
  providers: ProviderView[]
  settings: AppSettings
  updateSettings(patch: Partial<AppSettings>): Promise<void>
}

type SetProviders = (partial: { providers: ProviderView[]; providersHydrated?: boolean }) => void

export function createProviderProfileStoreActions(
  set: SetProviders,
  get: () => ProviderProfileStoreState
): ProviderProfileStoreActions {
  return {
    async refreshProviders() {
      set({ providers: await window.agentDesk.listProviders(), providersHydrated: true })
    },
    async activateLocalCompute(options) {
      const result = await window.agentDesk.activateLocalCompute(options)
      if (result.provider) {
        const patch = initialProviderRoutingPatch(get().settings, get().providers, result.provider.id)
        if (patch) await get().updateSettings(patch)
      }
      await get().refreshProviders()
      return result
    },
    async createProvider(input) {
      const provider = await window.agentDesk.createProvider(input)
      await get().refreshProviders()
      return provider
    },
    async updateProvider(id, patch) {
      const provider = await window.agentDesk.updateProvider(id, patch)
      await get().refreshProviders()
      return provider
    },
    async deleteProvider(id) {
      await window.agentDesk.deleteProvider(id)
      await get().refreshProviders()
      if (get().settings.defaultProviderId === id) {
        await get().updateSettings({ defaultProviderId: '' })
      }
    },
    async applyProviderProfileImport(previewId, decisions) {
      const result = await window.agentDesk.applyProviderProfileImport(previewId, decisions)
      set({ providers: result.providers })
      return result
    },
    async rollbackProviderProfileBackup(backupId) {
      const result = await window.agentDesk.rollbackProviderProfileBackup(backupId)
      set({ providers: result.providers })
      const defaultProviderId = get().settings.defaultProviderId
      if (defaultProviderId && !result.providers.some((provider) => provider.id === defaultProviderId)) {
        await get().updateSettings({ defaultProviderId: '' })
      }
      return result
    }
  }
}
