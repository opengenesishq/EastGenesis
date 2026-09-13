import InkToonMaterial from '../ming/InkToonMaterial'
import { forwardRef, useImperativeHandle, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import type { AvatarRefs } from '../AvatarRig'
import type { WatercolorCharacterRole } from '../../../../../../shared/watercolor-character'
import { MingHead, MingSleeve, MingLeg, MING_ROBES } from './MingFigureParts'

interface Props {
  sessionId: string
  role: WatercolorCharacterRole
  seated?: boolean
  working?: boolean
  reducedMotion?: boolean
  state?: string
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
  providerName?: string
  providerBaseUrl?: string
  modelName?: string
  loadModel?: boolean
  detailLevel?: 'full' | 'low'
}

/** Original procedural figure: cross-collar robe, fabric belt, tied hair, cloth shoes. */
const MingCharacterRig = forwardRef<AvatarRefs, Props>(function MingCharacterRig({
  sessionId, role, seated = false, working = false, state, position, rotation, scale = 1, reducedMotion = false
}, ref): React.JSX.Element {
  const root = useRef<Group>(null)
  const head = useRef<Group>(null)
  const armL = useRef<Group>(null), armR = useRef<Group>(null)
  const elbowL = useRef<Group>(null), elbowR = useRef<Group>(null)
  const legL = useRef<Group>(null), legR = useRef<Group>(null)
  const kneeL = useRef<Group>(null), kneeR = useRef<Group>(null)
  // Seated figures keep a stable pose for most office states. The manual
  // frame driver still ticks while the room is active, so avoid rewriting the
  // same joint transforms for every idle figure on every frame. The animated
  // arm/head pair remains frame-driven only while a worker is actually
  // working and reduced motion is not requested.
  const poseModeRef = useRef('')
  useImperativeHandle(ref, () => ({ root: root.current, head: head.current,
    armL: armL.current, armR: armR.current, elbowL: elbowL.current, elbowR: elbowR.current,
    legL: legL.current, legR: legR.current, kneeL: kneeL.current, kneeR: kneeR.current }), [])
  const variant = [...sessionId].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 2
  const color = MING_ROBES[role] || '#62796d'
  const skin = variant ? '#d7ac88' : '#e6bc97'
  useFrame(({ clock }) => {
    if (!seated) {
      poseModeRef.current = ''
      return
    }
    const animated = working && !reducedMotion
    const poseMode = animated ? 'animated' : 'static'
    if (poseModeRef.current !== poseMode) {
      poseModeRef.current = poseMode
      if (armL.current) armL.current.rotation.x = -0.55
      if (armR.current && !animated) armR.current.rotation.x = -0.65
      if (elbowL.current) elbowL.current.rotation.x = -0.7
      if (elbowR.current) elbowR.current.rotation.x = -0.6
      if (head.current) head.current.rotation.x = animated ? 0.14 : 0.04
      for (const leg of [legL.current, legR.current]) if (leg) leg.rotation.x = -Math.PI / 2
      for (const knee of [kneeL.current, kneeR.current]) if (knee) knee.rotation.x = Math.PI / 2
    }
    if (!animated) {
      return
    }
    const motion = Math.sin(clock.elapsedTime * 2.2) * 0.045
    if (armR.current) armR.current.rotation.x = -0.65 + motion
    if (head.current) head.current.rotation.x = 0.14 + motion * 0.15
  })
  return <group name="ming-original-character" position={position} rotation={rotation} scale={scale}
    userData={{ officeCharacterSessionId: sessionId, officeCharacterRole: role, mingOriginalGeometry: true, mingHeadRatio: 5.5, officeReducedMotion: reducedMotion,
      officeDigitalWorkerCharacter: true, officeDigitalWorkerRole: role, officeDigitalWorkerState: state || (working ? 'working' : 'idle') }}>
    <group ref={root} position={[0, seated ? -0.19 : 0, 0]}>
      <mesh position={[0, 1.07, 0]} scale={[1, 1, 0.68]}><cylinderGeometry args={[0.195, 0.23, 0.49, 12]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
      <mesh position={[0, seated ? 0.75 : 0.62, seated ? 0.1 : 0]} scale={[1, 1, seated ? 1.1 : 0.66]} rotation={[seated ? -0.3 : 0, 0, 0]}><cylinderGeometry args={[0.22, 0.29, seated ? 0.34 : 0.48, 12]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
      <mesh position={[0, 0.86, 0]} scale={[1, 1, 0.72]}><cylinderGeometry args={[0.231, 0.232, 0.055, 12]} /><meshToonMaterial color="#594c3f" /></mesh>
      <mesh position={[-0.053, 1.23, 0.135]} rotation={[0, 0, 0.56]}><boxGeometry args={[0.043, 0.25, 0.024]} /><meshToonMaterial color="#e7deca" /></mesh>
      <mesh position={[0.041, 1.23, 0.143]} rotation={[0, 0, -0.48]}><boxGeometry args={[0.043, 0.25, 0.025]} /><meshToonMaterial color="#e7deca" /></mesh>
      <group name="office-worker-head" userData={{ officeCharacterSessionId: sessionId }} ref={head} position={[0, 1.48, 0]}><MingHead skin={skin} variant={variant} /></group>
      <MingSleeve side={-1} color={color} skin={skin} arm={armL} elbow={elbowL} />
      <MingSleeve side={1} color={color} skin={skin} arm={armR} elbow={elbowR} />
      <MingLeg side={-1} leg={legL} knee={kneeL} /><MingLeg side={1} leg={legR} knee={kneeR} />
    </group>
  </group>
})

export default MingCharacterRig
