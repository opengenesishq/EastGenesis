import { useMemo } from 'react'
import type { OfficeProp } from '../Floor'
import AcademyMeshes from './AcademyMeshes'
import { createAcademyStation, type MingStationVariant } from './academyStations'
import { getAcademyResource } from './academyResourceCache'

/** Visual only: FacilityHotspots retains canonical IDs and all hit actions. */
export default function MingBusinessStation({ position = [0, 0, 0], rotation = [0, 0, 0], scale = 1, variant = 'custom', count = 0 }: OfficeProp & {
  variant?: MingStationVariant
  count?: number
}): React.JSX.Element {
  const actualCount = Math.min(6, Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0))
  const resource = useMemo(() => getAcademyResource(`station:${variant}:${actualCount}`, () => createAcademyStation(variant, actualCount)), [variant, actualCount])
  return <group position={position} rotation={rotation} scale={scale} userData={{ mingStation: variant, liveCount: count }}>
    <AcademyMeshes parts={resource.parts} resource={resource} />
  </group>
}
