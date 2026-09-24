import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group, Quaternion, Vector3 } from 'three'
import InkToonMaterial from '../ming/InkToonMaterial'
import { MingHead } from './MingFigureParts'

export interface MingCourtPose {
  paused?: boolean
  /** Director-owned elapsed seconds, so pause/replay also controls small gestures. */
  time?: number
  /** Cumulative distance travelled, in scene units. Hold this value when stopped. */
  walk: number
  bow: number
  kneel: number
  /** Sit on a seat approximately 0.40 scene units above the figure's foot plane. */
  sit?: number
  salute: number
  speak: number
}

export interface MingCourtFigureProps {
  kind: 'civil' | 'military' | 'attendant' | 'emperor'
  pose: MutableRefObject<MingCourtPose>
  robeColor?: string
  reducedMotion?: boolean
}

const THIGH = 0.36
const SHIN = 0.32
const UPPER_ARM = 0.265
const FOREARM = 0.26
const DOWN = new Vector3(0, -1, 0)
const SKIN = '#deb58f'
const COLORS = { civil: '#873e38', military: '#536b70', attendant: '#5a665e', emperor: '#c99a42' }
export const MING_COURT_DIMENSIONS = { standingHip: 0.738, seatedHip: 0.405, seatedWaist: 0.52, height: 1.85 } as const
const clamp = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0

/** A jointed, deliberately stylised Ming court figure, facing +Z, with its soles at y=0.
 * Costume silhouettes distinguish roles; this is not a claim of precise dress reconstruction.
 * The parent owns position/heading. This component never rewrites the forwarded root transform.
 */
const MingCourtFigure = forwardRef<Group, MingCourtFigureProps>(function MingCourtFigure({
  kind, pose, robeColor, reducedMotion = false
}, forwardedRef): React.JSX.Element {
  const root = useRef<Group>(null)
  const hips = useRef<Group>(null)
  const waist = useRef<Group>(null)
  const skirt = useRef<Group>(null)
  const lap = useRef<Group>(null)
  const head = useRef<Group>(null)
  const armL = useRef<Group>(null), armR = useRef<Group>(null)
  const elbowL = useRef<Group>(null), elbowR = useRef<Group>(null)
  const legL = useRef<Group>(null), legR = useRef<Group>(null)
  const kneeL = useRef<Group>(null), kneeR = useRef<Group>(null)
  const footL = useRef<Group>(null), footR = useRef<Group>(null)
  const tablet = useRef<Group>(null)
  const animated = useRef({ bow: 0, kneel: 0, sit: 0, salute: 0, speak: 0, walking: 0, lastWalk: pose.current.walk })
  const armMath = useMemo(() => ({
    direction: new Vector3(), bend: new Vector3(), elbow: new Vector3(), lower: new Vector3(),
    upperRotation: new Quaternion(), lowerRotation: new Quaternion()
  }), [])
  useImperativeHandle(forwardedRef, () => root.current!, [])
  const color = robeColor || COLORS[kind]
  const hasTablet = kind === 'civil' || kind === 'military'

  useFrame(({ clock }, frameDelta) => {
    const delta = Math.min(frameDelta, 0.1)
    const current = animated.current
    const requested = pose.current
    if (requested.paused) return
    const motionTime = requested.time ?? clock.elapsedTime
    const blend = 1 - Math.exp(-delta * 11)
    for (const key of ['bow', 'kneel', 'sit', 'salute', 'speak'] as const) {
      current[key] += (clamp(requested[key] ?? 0) - current[key]) * blend
    }
    const distance = Number.isFinite(requested.walk) ? requested.walk : current.lastWalk
    const speed = Math.abs(distance - current.lastWalk) / Math.max(delta, 0.001)
    current.lastWalk = distance
    current.walking += (Math.min(1, speed / 0.65) - current.walking) * blend
    const sitting = current.sit * (1 - current.kneel)
    const walking = current.walking * (1 - Math.max(current.kneel, sitting)) * (reducedMotion ? 0.55 : 1)
    const phase = distance * 8.6
    const gait = Math.sin(phase)
    // Kneeling lowers the hips and folds the shin behind the knee. It does not
    // sink an unarticulated standing model through the floor.
    const hipHeight = 0.738 - current.kneel * 0.368 - sitting * 0.333 - walking * 0.022
    if (hips.current) {
      hips.current.position.y = hipHeight
      hips.current.rotation.y = gait * walking * 0.025
    }
    if (waist.current) {
      waist.current.rotation.x = current.bow * 0.94 + current.kneel * 0.07 + sitting * 0.035
      waist.current.rotation.z = reducedMotion ? 0 : gait * walking * 0.018
    }
    if (skirt.current) {
      // Gather the hem above the feet as the wearer kneels.
      skirt.current.scale.y = (hipHeight - 0.085) / 0.653
      skirt.current.rotation.x = current.kneel * -0.12
    }
    if (lap.current) {
      lap.current.visible = sitting > 0.01
      lap.current.scale.z = sitting
      lap.current.scale.y = sitting
    }
    const cadence = reducedMotion ? 0 : Math.sin(motionTime * 4.2) * current.speak
    if (head.current) {
      head.current.rotation.x = current.bow * 0.14 + current.kneel * 0.025 + cadence * 0.038
      head.current.rotation.y = reducedMotion ? 0 : Math.sin(motionTime * 1.7) * current.speak * 0.03
    }

    const moveLeg = (leg: Group | null, knee: Group | null, foot: Group | null, offset: number): void => {
      if (!leg || !knee || !foot) return
      const legPhase = phase + offset
      const forward = Math.sin(legPhase) * 0.16 * walking - current.kneel * 0.15 + sitting * 0.35
      const lift = Math.max(0, Math.cos(legPhase)) * 0.095 * walking
      const ankleHeight = 0.06 + lift
      const down = hipHeight - ankleHeight
      const reachSquared = down * down + forward * forward
      const cosine = Math.max(-0.999, Math.min(0.999, (reachSquared - THIGH * THIGH - SHIN * SHIN) / (2 * THIGH * SHIN)))
      const kneeAngle = Math.acos(cosine)
      const thighAngle = Math.atan2(-forward, down) - Math.atan2(SHIN * Math.sin(kneeAngle), THIGH + SHIN * Math.cos(kneeAngle))
      leg.rotation.x = thighAngle
      knee.rotation.x = kneeAngle
      foot.rotation.x = -(thighAngle + kneeAngle)
      // Kneeling feet point back; both soles retain their own ground clearance.
      foot.rotation.y = current.kneel * Math.PI
    }
    moveLeg(legL.current, kneeL.current, footL.current, 0)
    moveLeg(legR.current, kneeR.current, footR.current, Math.PI)

    const salute = Math.max(hasTablet ? 0.5 : sitting * 0.25, current.salute, current.speak * 0.92, current.bow * 0.85, current.kneel * 0.88)
    const setArm = (upper: Group | null, lower: Group | null, side: number): void => {
      if (!upper || !lower) return
      // Solve shoulder/elbow positions for actual hand targets so both hands
      // meet the tablet instead of passing through it as the sleeves rotate.
      const swing = gait * -side * walking
      const handX = side * (hasTablet ? 0.047 : 0.275 * (1 - salute) + 0.047 * salute)
      const handY = -0.075 * (1 - salute) + (0.215 + cadence * 0.009) * salute
      const handZ = (0.025 + (hasTablet ? 0 : swing * 0.095)) * (1 - salute) + 0.355 * salute
      armMath.direction.set(handX - side * 0.235, handY - 0.405, handZ)
      const reach = Math.min(UPPER_ARM + FOREARM - 0.001, armMath.direction.length())
      armMath.direction.normalize()
      armMath.bend.set(side * 0.8, -0.35, -0.15)
      armMath.bend.addScaledVector(armMath.direction, -armMath.bend.dot(armMath.direction)).normalize()
      const along = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + reach * reach) / (2 * reach)
      const radius = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - along * along))
      armMath.elbow.copy(armMath.direction).multiplyScalar(along).addScaledVector(armMath.bend, radius)
      armMath.upperRotation.setFromUnitVectors(DOWN, armMath.lower.copy(armMath.elbow).normalize())
      upper.quaternion.copy(armMath.upperRotation)
      armMath.lower.copy(armMath.direction).multiplyScalar(reach).sub(armMath.elbow).normalize()
      armMath.lowerRotation.setFromUnitVectors(DOWN, armMath.lower)
      lower.quaternion.copy(armMath.upperRotation).invert().multiply(armMath.lowerRotation)
    }
    setArm(armL.current, elbowL.current, -1)
    setArm(armR.current, elbowR.current, 1)
    if (tablet.current) {
      // Carry at the waist while standing, raise for salutation and reporting.
      tablet.current.position.set(0, 0.05 + salute * 0.29 + cadence * 0.009 * salute, 0.03 + salute * 0.33)
      tablet.current.rotation.x = -0.3 * (1 - salute)
      tablet.current.visible = true
    }
  })

  return <group ref={root} name={`ming-court-${kind}`} userData={{ mingCourtFigure: true, historicalRepresentation: 'stylised-ming-silhouette' }}>
    <mesh name="court-foot-contact-shadow" position={[0, 0.009, 0.035]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.29, 0.2, 1]}>
      <circleGeometry args={[1, 24]} /><meshBasicMaterial color="#27332f" transparent opacity={0.1} depthWrite={false} />
    </mesh>
    <group ref={hips} position={[0, 0.738, 0]}>
      <CourtLeg side={-1} color={color} leg={legL} knee={kneeL} foot={footL} />
      <CourtLeg side={1} color={color} leg={legR} knee={kneeR} foot={footR} />
      <group ref={skirt} position={[0, 0.075, 0]} name="court-gathered-robe">
        <mesh position={[0, -0.285, -0.025]} scale={[1, 1, 0.66]}>
          <cylinderGeometry args={[0.21, 0.285, 0.57, 14]} /><InkToonMaterial surface="cloth" color={color} />
        </mesh>
        {[-1, 1].map((side) => <mesh key={side} position={[side * 0.115, -0.29, 0.141]} rotation={[0, 0, side * -0.09]}>
          <boxGeometry args={[0.013, 0.49, 0.008]} /><meshToonMaterial color={kind === 'emperor' ? '#a77a31' : '#343b36'} />
        </mesh>)}
      </group>
      <group ref={lap} visible={false} position={[0, 0.022, 0.012]} name="court-seated-robe">
        <mesh position={[0, 0, 0.175]}><boxGeometry args={[0.40, 0.055, 0.35]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
        <mesh position={[0, -0.11, 0.34]}><boxGeometry args={[0.40, 0.22, 0.026]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
      </group>
      <group ref={waist} position={[0, 0.115, 0]} name="court-waist-pivot">
        <mesh position={[0, 0.23, 0]} scale={[1, 1, 0.71]}>
          <cylinderGeometry args={[0.193, 0.218, 0.47, 14]} /><InkToonMaterial surface="cloth" color={color} />
        </mesh>
        <mesh scale={[1, 1, 0.75]} position={[0, 0.012, 0]}>
          <cylinderGeometry args={[0.223, 0.223, 0.053, 14]} /><meshToonMaterial color={kind === 'emperor' ? '#836029' : '#433d32'} />
        </mesh>
        <mesh position={[0, 0.015, 0.169]}>
          <boxGeometry args={[0.06, 0.034, 0.016]} /><meshToonMaterial color={kind === 'emperor' ? '#e0bd6d' : '#a2926c'} />
        </mesh>
        {/* Round collar: no Qing beads, braid, or invented animal-rank badge. */}
        <mesh position={[0, 0.445, 0.038]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.092, 0.018, 6, 18, Math.PI]} /><meshToonMaterial color="#e5d8bc" />
        </mesh>
        <group ref={head} position={[0, 0.648, 0]} name="court-head">
          <MingHead skin={SKIN} variant={kind === 'attendant' ? 1 : 0} />
          <CourtCap kind={kind} />
        </group>
        <CourtArm side={-1} color={color} upper={armL} lower={elbowL} />
        <CourtArm side={1} color={color} upper={armR} lower={elbowR} />
        {hasTablet && <group ref={tablet} name="court-hu-tablet" visible={false} position={[0, 0.34, 0.36]}>
          <mesh><boxGeometry args={[0.085, 0.295, 0.014]} /><meshToonMaterial color="#e2d6b6" /></mesh>
          <mesh position={[0, 0.151, 0]} scale={[1, 0.35, 0.18]}><sphereGeometry args={[0.043, 10, 6]} /><meshToonMaterial color="#e2d6b6" /></mesh>
        </group>}
      </group>
    </group>
  </group>
})

function CourtLeg({ side, color, leg, knee, foot }: {
  side: number; color: string; leg: RefObject<Group>; knee: RefObject<Group>; foot: RefObject<Group>
}): React.JSX.Element {
  return <group ref={leg} position={[side * 0.105, 0, 0]} name={`court-hip-${side}`}>
    <mesh position={[0, -THIGH / 2, 0]}><cylinderGeometry args={[0.087, 0.078, THIGH, 10]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
    <group ref={knee} position={[0, -THIGH, 0]} name={`court-knee-${side}`}>
      <mesh><sphereGeometry args={[0.079, 10, 8]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
      <mesh position={[0, -SHIN / 2, 0]}><cylinderGeometry args={[0.072, 0.048, SHIN, 10]} /><meshToonMaterial color="#d8cdb6" /></mesh>
      <mesh position={[0, -SHIN + 0.065, 0]}><cylinderGeometry args={[0.058, 0.057, 0.13, 10]} /><meshToonMaterial color="#282e2b" /></mesh>
      <group ref={foot} position={[0, -SHIN, 0]} name={`court-ankle-${side}`}>
        <mesh position={[0, 0, 0.044]} scale={[0.069, 0.052, 0.116]}><sphereGeometry args={[1, 12, 8]} /><meshToonMaterial color="#242b29" /></mesh>
        <mesh position={[0, -0.044, 0.047]}><boxGeometry args={[0.13, 0.016, 0.19]} /><meshToonMaterial color="#7b7967" /></mesh>
      </group>
    </group>
  </group>
}

function CourtArm({ side, color, upper, lower }: {
  side: number; color: string; upper: RefObject<Group>; lower: RefObject<Group>
}): React.JSX.Element {
  return <group ref={upper} position={[side * 0.235, 0.405, 0]} name={`court-shoulder-${side}`}>
    <mesh position={[0, -UPPER_ARM / 2, 0]}><cylinderGeometry args={[0.107, 0.121, UPPER_ARM, 10]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
    <group ref={lower} position={[0, -UPPER_ARM, 0]} name={`court-elbow-${side}`}>
      <mesh position={[0, -0.106, 0]}><cylinderGeometry args={[0.121, 0.089, 0.218, 10]} /><InkToonMaterial surface="cloth" color={color} /></mesh>
      <mesh position={[0, -0.212, 0]}><cylinderGeometry args={[0.09, 0.09, 0.025, 10]} /><meshToonMaterial color="#e8dcc4" /></mesh>
      <mesh position={[0, -FOREARM, 0]} scale={[0.72, 1, 0.68]}><sphereGeometry args={[0.061, 10, 8]} /><meshToonMaterial color={SKIN} /></mesh>
    </group>
  </group>
}

function CourtCap({ kind }: Pick<MingCourtFigureProps, 'kind'>): React.JSX.Element {
  const official = kind === 'civil' || kind === 'military'
  const black = kind === 'attendant' ? '#343b38' : '#222b2b'
  return <group name={`court-cap-${kind}`}>
    <mesh position={[0, 0.155, -0.026]} scale={[1, 0.82, 0.86]}>
      <sphereGeometry args={[0.177, 14, 10]} /><meshToonMaterial color={black} />
    </mesh>
    <mesh position={[0, 0.063, 0.029]}><boxGeometry args={[0.28, 0.04, 0.2]} /><meshToonMaterial color={black} /></mesh>
    {official && [-1, 1].map((side) => <mesh key={side} position={[side * 0.255, 0.101, -0.051]}
      rotation={[0, side * 0.12, side * (kind === 'military' ? 0.12 : 0.025)]}>
      <boxGeometry args={[0.27, 0.053, 0.026]} /><meshToonMaterial color={black} />
    </mesh>)}
    {kind === 'emperor' && [-1, 1].map((side) => <mesh key={side} position={[side * 0.064, 0.236, -0.112]}
      rotation={[-0.12, 0, side * -0.22]}>
      <boxGeometry args={[0.051, 0.22, 0.033]} /><meshToonMaterial color={black} />
    </mesh>)}
    {kind === 'attendant' && <mesh position={[0, 0.11, -0.159]}><boxGeometry args={[0.16, 0.24, 0.028]} /><meshToonMaterial color={black} /></mesh>}
  </group>
}

export default MingCourtFigure
