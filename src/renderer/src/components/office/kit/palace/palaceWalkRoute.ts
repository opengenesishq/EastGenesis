import { Vector3 } from 'three'

export function buildPalaceWalkRoute(home: Vector3, target: Vector3, waypoints?: Array<[number, number, number]>) {
  const points = [home, ...(waypoints ?? []).map((point) => new Vector3(...point)), target]
  const segments = points.slice(1).map((point, index) => ({
    from: points[index], to: point, length: points[index].distanceTo(point)
  }))
  return { segments, length: segments.reduce((total, segment) => total + segment.length, 0) }
}

/** Arc-length sampling keeps characters inside the authored corridor at every turn. */
export function samplePalaceWalkRoute(route: ReturnType<typeof buildPalaceWalkRoute>, fraction: number, output: Vector3): number {
  let distance = Math.max(0, Math.min(1, fraction)) * route.length
  for (const segment of route.segments) {
    if (distance <= segment.length || segment === route.segments.at(-1)) {
      output.copy(segment.from).lerp(segment.to, segment.length > 0 ? Math.min(1, distance / segment.length) : 1)
      return Math.atan2(segment.to.x - segment.from.x, segment.to.z - segment.from.z)
    }
    distance -= segment.length
  }
  return 0
}
