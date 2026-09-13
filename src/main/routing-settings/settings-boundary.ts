import { compareAndWriteSettingsFile, SettingsFileWriteError, readSettingsFileSnapshot } from '../settings-file-storage'
import { RoutingSettingsWriteError, type RoutingSettingsBoundary } from './routing-settings-types'

/** Compose with the existing settings path and cache; never open a second rules store. */
export function createSettingsRoutingBoundary(input: { file: () => string; invalidateCache: () => void }): RoutingSettingsBoundary {
  return {
    read: () => readSettingsFileSnapshot(input.file()),
    commit: (transaction) => {
      try {
        const receipt = compareAndWriteSettingsFile(input.file(), transaction)
        if (receipt.status === 'committed') input.invalidateCache()
        return receipt
      } catch (error) {
        input.invalidateCache()
        if (error instanceof SettingsFileWriteError) throw new RoutingSettingsWriteError(error.commitState, error.message)
        throw error
      }
    }
  }
}
