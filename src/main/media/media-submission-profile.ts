import type { MediaOperation, MediaProviderProfile } from '../../shared/media-types'

/** Catalog snapshots are supplied only by the main-process routing boundary. */
export function resolveSubmissionMediaProfile(
  profiles: MediaProviderProfile[],
  id: string | undefined,
  selected?: MediaProviderProfile,
  operation?: MediaOperation
): MediaProviderProfile | undefined {
  if (!id) return undefined
  const profile = selected?.id === id ? selected : profiles.find((item) => item.id === id)
  if (!profile || !profile.enabled) throw new Error('Media Provider is unavailable for this capability')
  if (operation && !profile.operations.includes(operation)) throw new Error('Media Provider is unavailable for this capability')
  return profile
}
