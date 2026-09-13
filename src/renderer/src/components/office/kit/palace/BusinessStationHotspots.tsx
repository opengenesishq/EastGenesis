import { Html } from '@react-three/drei'
import type { OfficeFacilitySpec } from '../facilityCatalog'
import { businessStationsForRole, type BusinessHallRole, type BusinessStationSpec } from './businessStationCatalog'

function roleForFacility(spec: OfficeFacilitySpec): BusinessHallRole {
  if (spec.variant === 'project') return 'project'
  if (spec.variant === 'video') return 'video'
  if (spec.variant === 'assistant') return 'assistant'
  return 'custom'
}

export default function BusinessStationHotspots({ facility, selected, onSelect }: { facility: OfficeFacilitySpec; selected?: string | null; onSelect: (station: BusinessStationSpec) => void }): React.JSX.Element {
  const role = roleForFacility(facility)
  const center = facility.interior?.center ?? facility.position
  return <>{businessStationsForRole(role).map((station) => <group key={station.id} position={[center[0] + station.offset[0], center[1] + station.offset[1], center[2] + station.offset[2]]} userData={{ businessStation: station.id, businessStationAnchor: station.anchor, businessLineId: facility.businessLineId, functionalWhitebox: true }}>
    <mesh onClick={(event) => { event.stopPropagation(); onSelect(station) }} onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = 'default' }}>
      <boxGeometry args={[2.3, 1.8, 1.1]} />
      <meshBasicMaterial transparent opacity={0.01} depthWrite={false} />
    </mesh>
    <Html position={[0, 2.1, 0]} center>
      <button className="office-domain-marker" aria-label={`${station.label}：${station.purpose}`} title={station.purpose}
        aria-pressed={selected === station.id} data-office-business-station={station.id} data-office-business-station-anchor={station.anchor}
        onClick={() => onSelect(station)}>{station.label}</button>
    </Html>
  </group>)}</>
}
