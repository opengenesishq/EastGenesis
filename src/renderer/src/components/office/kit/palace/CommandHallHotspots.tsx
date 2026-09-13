import { Html } from '@react-three/drei'
import { COMMAND_HALL_STATIONS, type CommandHallStationId } from './commandHallCatalog'

export default function CommandHallHotspots({ selected, onSelect }: { selected?: CommandHallStationId | null; onSelect: (id: CommandHallStationId) => void }): React.JSX.Element {
  return <>{COMMAND_HALL_STATIONS.map((station) => <group key={station.id} position={station.position} userData={{ commandHallStation: station.id, commandHallAnchor: station.anchor, functionalWhitebox: true }}>
    <mesh onClick={(event) => { event.stopPropagation(); onSelect(station.id) }} onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = 'default' }}>
      <cylinderGeometry args={[2.1, 2.1, 2.5, 8]} />
      <meshBasicMaterial transparent opacity={0.01} depthWrite={false} />
    </mesh>
    <Html position={[0, 3.7, 0]} center>
      <button className="office-domain-marker" aria-label={`${station.label}：${station.purpose}`} title={station.purpose}
        aria-pressed={selected === station.id} data-office-command-station={station.id} data-office-command-station-anchor={station.anchor}
        onClick={() => onSelect(station.id)}>{station.label}</button>
    </Html>
  </group>)}</>
}
