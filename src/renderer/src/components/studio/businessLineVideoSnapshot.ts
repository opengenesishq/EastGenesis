import type { MediaStudioSnapshot } from '../../../../shared/media-types'

/** Shared connections stay visible; productions and jobs follow their durable business owner. */
export function businessLineVideoSnapshot(snapshot: MediaStudioSnapshot, businessLineId = 'video'): MediaStudioSnapshot {
  const productions = snapshot.productions.filter((item) => (item.businessLineId ?? 'video') === businessLineId)
  const productionIds = new Set(productions.map((item) => item.id))
  const jobs = snapshot.jobs.filter((item) => (item.businessLineId ?? snapshot.productions.find((production) => production.id === item.productionId)?.businessLineId ?? 'video') === businessLineId && productionIds.has(item.productionId))
  return { ...snapshot, productions, jobs }
}
