import InkToonMaterial from '../ming/InkToonMaterial'
import type { Group } from 'three'
import type { RefObject } from 'react'

export const MING_ROBES: Record<string, string> = {
  researcher: '#536b72', planner: '#687b64', writer: '#ad835c', designer: '#9b6662',
  developer: '#4d697b', 'review-test': '#887861', operations: '#75766e'
}

export function MingHead({ skin, variant }: { skin: string; variant: number }): React.JSX.Element {
  return <group>
    <mesh scale={[0.87, 1, 0.87]}><sphereGeometry args={[0.148, 16, 12]} /><meshToonMaterial color={skin} /></mesh>
    <mesh position={[0, 0.045, -0.022]} scale={[0.96, 0.73, 0.99]}><sphereGeometry args={[0.158, 16, 12]} /><meshToonMaterial color="#252b2b" /></mesh>
    <mesh position={[0, 0.19, -0.034]} scale={[1, 0.9, 0.95]}><sphereGeometry args={[0.062, 10, 8]} /><meshToonMaterial color="#252b2b" /></mesh>
    <mesh position={[0, 0.182, -0.033]}><torusGeometry args={[0.047, 0.009, 5, 12]} /><meshToonMaterial color={variant ? '#8d554a' : '#8caa9e'} /></mesh>
    {[-1, 1].map((side) => <group key={side}>
      <mesh position={[side * 0.053, -0.012, 0.119]} scale={[0.67, 1.15, 0.33]}><sphereGeometry args={[0.025, 10, 8]} /><meshBasicMaterial color="#20262b" /></mesh>
      <mesh position={[side * 0.05, -0.006, 0.128]}><sphereGeometry args={[0.007, 6, 6]} /><meshBasicMaterial color="#fff7e8" /></mesh>
      <mesh position={[side * 0.048, 0.066, 0.099]} rotation={[0.1, 0, side * 0.26]} scale={[0.8, 1.2, 0.35]}><sphereGeometry args={[0.065, 10, 8]} /><meshToonMaterial color="#252b2b" /></mesh>
    </group>)}
    <mesh position={[0, -0.04, 0.128]}><sphereGeometry args={[0.018, 8, 6]} /><meshToonMaterial color={skin} /></mesh>
    <mesh position={[0, -0.079, 0.108]}><boxGeometry args={[0.036, 0.007, 0.006]} /><meshBasicMaterial color="#966c60" /></mesh>
  </group>
}

export function MingSleeve({ side, color, skin, arm, elbow }: {
  side: number; color: string; skin: string; arm: RefObject<Group>; elbow: RefObject<Group>
}): React.JSX.Element {
  return <group ref={arm} position={[side * 0.205, 1.27, 0]} rotation={[0, 0, side * -0.12]}>
    <mesh position={[0, -0.13, 0]}><cylinderGeometry args={[0.102, 0.13, 0.27, 10]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
    <group ref={elbow} position={[0, -0.25, 0]}>
      <mesh position={[0, -0.11, 0]}><cylinderGeometry args={[0.13, 0.105, 0.22, 10]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
      <mesh position={[0, -0.22, 0]}><cylinderGeometry args={[0.106, 0.106, 0.027, 10]} /><meshToonMaterial color="#e6dcc6" /></mesh>
      <mesh position={[0, -0.269, 0.012]} scale={[0.8, 1.1, 0.7]}><sphereGeometry args={[0.065, 10, 8]} /><meshToonMaterial color={skin} /></mesh>
    </group>
  </group>
}

export function MingLeg({ side, leg, knee }: { side: number; leg: RefObject<Group>; knee: RefObject<Group> }): React.JSX.Element {
  return <group ref={leg} position={[side * 0.095, 0.69, 0]}>
    <mesh position={[0, -0.155, 0]}><cylinderGeometry args={[0.085, 0.075, 0.31, 8]} /><meshToonMaterial color="#ddd5c1" /></mesh>
    <group ref={knee} position={[0, -0.31, 0]}>
      <mesh position={[0, -0.14, 0]}><cylinderGeometry args={[0.075, 0.053, 0.28, 8]} /><meshToonMaterial color="#ddd5c1" /></mesh>
      <mesh position={[0, -0.31, 0.039]} scale={[0.065, 0.046, 0.115]}><sphereGeometry args={[1, 10, 8]} /><meshToonMaterial color="#303c3c" /></mesh>
    </group>
  </group>
}
