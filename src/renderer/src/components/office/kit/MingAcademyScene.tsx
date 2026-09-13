import { useState } from 'react'
import type { OfficeProp } from './Floor'
import type { CommandCenterSignals } from './CommandCenterStations'
import type { OfficeFacilitySpec } from './facilityCatalog'
import { CONTROL_ROOM_LAYOUT } from './controlRoomLayout'
import MingBusinessStation from './ming/MingBusinessStation'
import MingPlaque from './ming/MingPlaque'
import PalaceArchitecture from './palace/PalaceArchitecture'
import { PALACE_WORLD_LAYOUT } from './palace/palaceWorldLayout'
import { PALACE_PALETTE } from './palace/palacePalette'
import type { PalaceGeometryTier } from './palace/palaceResource'
import { businessRoleForVariant, businessStationsForRole } from './palace/businessStationCatalog'

/** Authored palace at 1 m scale; all live task state remains owned by OfficeView. */
export default function MingAcademyScene({
  position = [0, 0, 0], rotation = [0, 0, 0], scale = 1,
  signals = { assistant: 0, project: 0, video: 0, incidents: 0 },
  qualityTier = 'high',
  facilities = [], counts = {}, labels, onSelectCommand, cutaway = false, openedRoom, lightMode = false
}: OfficeProp & {
  lightMode?: boolean
  qualityTier?: PalaceGeometryTier
  cutaway?: boolean
  openedRoom?: string
  signals?: CommandCenterSignals
  facilities?: OfficeFacilitySpec[]
  counts?: Record<string, number>
  labels?: Partial<Record<'academy' | 'assistant' | 'project' | 'video' | 'command', string>>
  onSelectCommand?: () => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  return <group position={position} rotation={rotation} scale={scale}
    userData={{ architecture: 'forbidden-city-reference-palace-v2', importedModels: loaded ? 1 : 0, sharedCommandHall: true }}>
    {!loaded && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.025, 0]}>
      <planeGeometry args={PALACE_WORLD_LAYOUT.groundSize} />
      <meshBasicMaterial color={lightMode ? PALACE_PALETTE.paving : '#8b816e'} />
    </mesh>}
    <PalaceArchitecture qualityTier={qualityTier} cutaway={cutaway} openedRoom={openedRoom} onReady={setLoaded} />
    {facilities.map((facility) => <group key={facility.key} position={facility.position}
      userData={{ businessLineId: facility.businessLineId, courtyardTemplate: 'peer-court-v1' }}>
      <MingBusinessStation variant="entrance" count={counts[facility.businessLineId ?? ''] ?? 0} />
      {facility.interior && <group position={[facility.interior.center[0] - facility.position[0], facility.interior.center[1] - facility.position[1], facility.interior.center[2] - facility.position[2]]}
        userData={{ businessLineId: facility.businessLineId, functionalWhitebox: true, roomId: facility.interior.roomId }}>
        {businessStationsForRole(businessRoleForVariant(facility.variant)).map((station) => <MingBusinessStation key={station.id}
          position={[station.offset[0], 0, station.offset[2]]} variant={facility.variant ?? 'custom'} count={counts[facility.businessLineId ?? ''] ?? 0} />)}
      </group>}
    </group>)}
    <group onClick={(event) => { event.stopPropagation(); onSelectCommand?.() }}
      userData={{ officeCommandHall: true }}>
      <MingBusinessStation position={CONTROL_ROOM_LAYOUT.command} variant="command" scale={1.15} count={signals.incidents} />
      <MingPlaque label={labels?.command ?? '议政殿'} position={[0, 5.1, -15.5]} width={2.3} brand />
    </group>
    <MingBusinessStation position={CONTROL_ROOM_LAYOUT.plan} variant="command" />
    <MingBusinessStation position={CONTROL_ROOM_LAYOUT.approval} variant="approval" count={signals.incidents} />
    <MingBusinessStation position={CONTROL_ROOM_LAYOUT.artifact} variant="archive" />
    <MingBusinessStation position={CONTROL_ROOM_LAYOUT.recovery} variant="approval" />
    <MingBusinessStation position={CONTROL_ROOM_LAYOUT.infrastructure} variant="infrastructure" />
    {Object.entries(PALACE_WORLD_LAYOUT.cornerTowers).map(([role, towerPosition]) => <group key={role} position={towerPosition}
      userData={{ cornerTower: role, functionalWhitebox: true }}>
      <MingBusinessStation variant="infrastructure" />
    </group>)}
  </group>
}
