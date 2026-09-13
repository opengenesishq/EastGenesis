import { Html } from '@react-three/drei'
import { CORNER_TOWERS, type CornerTowerId } from './cornerTowerCatalog'

export default function CornerTowerHotspots({ selected, onSelect }: { selected?: CornerTowerId | null; onSelect: (id: CornerTowerId) => void }): React.JSX.Element {
  return <>{CORNER_TOWERS.map((tower) => <group key={tower.id} position={tower.position} userData={{ cornerTower: tower.id, cornerTowerAnchor: tower.anchor, cornerTowerRole: tower.role, functionalWhitebox: true }}>
    <mesh onClick={(event) => { event.stopPropagation(); onSelect(tower.id) }} onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = 'default' }}>
      <cylinderGeometry args={[3.4, 3.4, 5, 8]} />
      <meshBasicMaterial transparent opacity={0.01} depthWrite={false} />
    </mesh>
    <Html position={[0, 5.8, 0]} center>
      <button className="office-domain-marker" aria-label={`${tower.label}：${tower.purpose}`} title={tower.purpose}
        aria-pressed={selected === tower.id} data-office-corner-tower={tower.id} data-office-corner-tower-anchor={tower.anchor} data-office-corner-tower-role={tower.role}
        onClick={() => onSelect(tower.id)}>{tower.label}</button>
    </Html>
  </group>)}</>
}
