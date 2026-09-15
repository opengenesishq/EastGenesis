import { routeObservationKey, type RouteObservationIdentity } from './route-observation-signal'

export interface AcceptanceQualitySignal {
  providerId: string
  model: string
  passed: number
  failed: number
  samples: number
  /** Final Acceptance pass ratio shrunk toward 0.5 while evidence is sparse. */
  score: number
  lastAcceptanceAt?: number
}

let snapshot = new Map<string, AcceptanceQualitySignal>()

/** Request-path reads are synchronous and never touch Electron or the database. */
export function getAcceptanceQualitySignal(
  providerId: string,
  model: string,
  identity?: RouteObservationIdentity
): AcceptanceQualitySignal | undefined {
  return snapshot.get(identity ? routeObservationKey(identity) : acceptanceQualitySignalKey(providerId, model))
}

export function publishAcceptanceQualitySnapshot(
  next: ReadonlyMap<string, AcceptanceQualitySignal>
): void {
  snapshot = new Map(next)
}

export function acceptanceQualitySignalKey(providerId: string, model: string): string {
  return `${providerId}\u0000${model}`
}
