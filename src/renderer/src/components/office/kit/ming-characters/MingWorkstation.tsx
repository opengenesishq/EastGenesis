import InkToonMaterial from '../ming/InkToonMaterial'
import type { WorkstationProProps } from '../WorkstationPro'
import MingCharacterRig from './MingCharacterRig'
import { PALACE_PALETTE } from '../palace/palacePalette'

const STATUS_COLORS = { idle: '#aaa48e', working: '#678d78', awaiting: '#b09154', completed: '#768f72', error: '#a86255' }

/** Original wood desk and manuscript props. Every station is bound to a real actor. */
export default function MingWorkstation({
  sessionId, position, active, activity,
  watercolorRole = 'researcher', operatorAway = false, interactive = true,
  onSelect, onOpen, reducedMotion = false
}: WorkstationProProps & { costKnown?: boolean; reducedMotion?: boolean }): React.JSX.Element {
  const color = STATUS_COLORS[activity]
  const handlers = interactive ? {
    onClick: (event: { stopPropagation(): void }): void => { event.stopPropagation(); onSelect() },
    onDoubleClick: (event: { stopPropagation(): void }): void => { event.stopPropagation(); onOpen?.() },
    onPointerOver: (): void => { document.body.style.cursor = 'pointer' },
    onPointerOut: (): void => { document.body.style.cursor = 'default' }
  } : {}
  return <group position={position} name="ming-execution-workstation" {...handlers}
    userData={{ officeSessionId: sessionId, mingOriginalGeometry: true, activity }}>
    <mesh position={[0, 0.018, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.04, active ? 1.1 : 1.065, 40]} /><meshBasicMaterial color={active ? '#a85f4d' : '#b5ae99'} />
    </mesh>
    <MingDesk color={color} />
    {!operatorAway && <MingCharacterRig sessionId={sessionId} role={watercolorRole} seated working={activity === 'working'} state={activity} position={[0, 0, -0.66]} reducedMotion={reducedMotion} />}
    <mesh position={[0, 0.72, 0.08]}>
      <boxGeometry args={[2.05, 1.45, 1.65]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  </group>
}

function MingDesk({ color }: { color: string }): React.JSX.Element {
  return <group>
    <mesh position={[0, 0.8, 0.04]} castShadow receiveShadow><boxGeometry args={[1.8, 0.095, 0.74]} /><InkToonMaterial surface="wood" color={PALACE_PALETTE.wood} /></mesh>
    <mesh position={[0, 0.685, 0.28]}><boxGeometry args={[1.55, 0.15, 0.055]} /><InkToonMaterial surface="wood" color="#604734" /></mesh>
    {[-1, 1].flatMap((x) => [-1, 1].map((z) => <mesh key={`${x}:${z}`} position={[x * 0.73, 0.38, z * 0.24]} castShadow>
      <boxGeometry args={[0.09, 0.76, 0.09]} /><InkToonMaterial surface="wood" color="#604734" />
    </mesh>))}
    <mesh position={[0, 0.856, -0.02]} rotation={[-Math.PI / 2, 0, -0.08]}><planeGeometry args={[0.69, 0.43]} /><meshToonMaterial color={PALACE_PALETTE.paper} /></mesh>
    {[-0.34, 0.34].map((x) => <mesh key={x} position={[x, 0.875, -0.02]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.024, 0.024, 0.46, 8]} /><meshToonMaterial color="#c8b790" />
    </mesh>)}
    {[-0.1, 0, 0.1].map((x) => <mesh key={x} position={[x, 0.858, -0.03]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[0.009, 0.24]} /><meshBasicMaterial color="#9b9985" />
    </mesh>)}
    <mesh position={[0.58, 0.868, 0.02]}><boxGeometry args={[0.15, 0.035, 0.13]} /><meshToonMaterial color="#384342" /></mesh>
    <mesh position={[0.54, 0.9, -0.17]} rotation={[0, 0, 0.83]}><cylinderGeometry args={[0.011, 0.014, 0.32, 6]} /><meshToonMaterial color="#b39c6b" /></mesh>
    <mesh position={[-0.64, 0.89, -0.07]}><boxGeometry args={[0.23, 0.085, 0.28]} /><meshToonMaterial color={color} /></mesh>
    <mesh position={[0, 0.45, -0.69]}><boxGeometry args={[0.5, 0.07, 0.45]} /><InkToonMaterial surface="wood" color="#624b3c" /></mesh>
    {[-0.19, 0.19].map((x) => <mesh key={x} position={[x, 0.22, -0.69]}><boxGeometry args={[0.07, 0.44, 0.3]} /><InkToonMaterial surface="wood" color="#624b3c" /></mesh>)}
  </group>
}
