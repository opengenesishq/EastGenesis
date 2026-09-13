import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { RoundedBox } from '@react-three/drei'
import type { Group } from 'three'
import type { AvatarRefs } from './AvatarRig'
import ProviderLogoBadge from './ProviderLogoBadge'
import type { ProviderLogoSpec } from './ProviderLogos'
import type { WatercolorCharacterRole } from '../../../../../shared/watercolor-character'

interface LowPolyDigitalWorkerRigProps {
  sessionId: string
  role: WatercolorCharacterRole
  accentColor: string
  providerLogo?: ProviderLogoSpec
  detailLevel?: 'full' | 'low'
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

type Side = -1 | 1

const SKIN_TONES = ['#f0c7a7', '#d9a27b', '#b97855', '#8f5a42'] as const
const HAIR_TONES = ['#17191d', '#34261f', '#503b2d', '#202932'] as const
const JACKET_TONES = ['#52616a', '#465760', '#555b68', '#4e6260'] as const
const TROUSER_TONES = ['#28333b', '#303741', '#2b3039', '#293837'] as const

const ROLE_LABEL_KEYS: Record<WatercolorCharacterRole, string> = {
  researcher: 'officeRoleResearcher',
  planner: 'officeRolePlanner',
  writer: 'officeRoleWriter',
  designer: 'officeRoleDesigner',
  developer: 'officeRoleDeveloper',
  'review-test': 'officeRoleReviewTest',
  operations: 'officeRoleOperations'
}

function stableVariant(sessionId: string): number {
  let hash = 2166136261
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function WorkerHead({ skin, hair, variant, detailed }: { skin: string; hair: string; variant: number; detailed: boolean }): React.JSX.Element {
  const sidePart = variant % 2 === 0 ? -1 : 1
  return (
    <group>
      <mesh position={[0, 0.145, 0.008]} scale={[0.88, 1.05, 0.92]} castShadow={detailed}>
        <sphereGeometry args={[0.15, detailed ? 18 : 10, detailed ? 14 : 8]} />
        <meshStandardMaterial color={skin} roughness={0.72} metalness={0.02} />
      </mesh>
      <mesh position={[sidePart * 0.018, 0.247, -0.012]} scale={[0.98, 0.54, 1.02]} castShadow={detailed}>
        <sphereGeometry args={[0.154, detailed ? 16 : 9, detailed ? 10 : 7]} />
        <meshStandardMaterial color={hair} roughness={0.82} metalness={0.01} />
      </mesh>
      <RoundedBox args={[0.255, 0.08, 0.08]} radius={0.025} smoothness={3} position={[sidePart * 0.025, 0.211, -0.112]} castShadow={detailed}>
        <meshStandardMaterial color={hair} roughness={0.82} metalness={0.01} />
      </RoundedBox>
      {detailed && (
        <>
          {([-1, 1] as Side[]).map((side) => (
            <mesh key={`eye-${side}`} position={[side * 0.052, 0.166, 0.136]}>
              <sphereGeometry args={[0.012, 10, 8]} />
              <meshStandardMaterial color="#24292e" roughness={0.55} />
            </mesh>
          ))}
          <mesh position={[0, 0.128, 0.148]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.018, 0.045, 8]} />
            <meshStandardMaterial color={skin} roughness={0.74} />
          </mesh>
          <mesh position={[0, 0.083, 0.145]} scale={[1, 0.34, 0.35]}>
            <torusGeometry args={[0.035, 0.007, 6, 16, Math.PI]} />
            <meshStandardMaterial color="#75483e" roughness={0.75} />
          </mesh>
        </>
      )}
    </group>
  )
}

function WorkerArm({
  jacket,
  skin,
  castShadow,
  elbowRef,
  wristRef,
  handRef
}: {
  jacket: string
  skin: string
  castShadow: boolean
  elbowRef: React.Ref<Group>
  wristRef: React.Ref<Group>
  handRef: React.Ref<Group>
}): React.JSX.Element {
  return (
    <group>
      <mesh position={[0, -0.135, 0]} castShadow={castShadow}>
        <capsuleGeometry args={[0.062, 0.19, 6, 10]} />
        <meshStandardMaterial color={jacket} roughness={0.7} metalness={0.04} />
      </mesh>
      <group ref={elbowRef} position={[0, -0.27, 0]}>
        <mesh castShadow={castShadow}>
          <sphereGeometry args={[0.06, 10, 8]} />
          <meshStandardMaterial color={jacket} roughness={0.72} metalness={0.03} />
        </mesh>
        <mesh position={[0, -0.12, 0]} castShadow={castShadow}>
          <capsuleGeometry args={[0.052, 0.16, 6, 10]} />
          <meshStandardMaterial color={jacket} roughness={0.72} metalness={0.03} />
        </mesh>
        <group ref={wristRef} position={[0, -0.235, 0]}>
          <mesh castShadow={castShadow}>
            <cylinderGeometry args={[0.045, 0.05, 0.07, 10]} />
            <meshStandardMaterial color={skin} roughness={0.76} metalness={0.01} />
          </mesh>
          <group ref={handRef} position={[0, -0.045, 0.018]}>
            <mesh position={[0, -0.028, 0.018]} scale={[0.82, 1.05, 0.68]} castShadow={castShadow}>
              <sphereGeometry args={[0.065, 10, 8]} />
              <meshStandardMaterial color={skin} roughness={0.76} metalness={0.01} />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  )
}

function WorkerLeg({
  trouser,
  castShadow,
  kneeRef,
  anklePitchRef,
  ankleRollRef,
  footRef
}: {
  trouser: string
  castShadow: boolean
  kneeRef: React.Ref<Group>
  anklePitchRef: React.Ref<Group>
  ankleRollRef: React.Ref<Group>
  footRef: React.Ref<Group>
}): React.JSX.Element {
  return (
    <group>
      <mesh position={[0, -0.155, 0]} castShadow={castShadow}>
        <capsuleGeometry args={[0.075, 0.2, 6, 10]} />
        <meshStandardMaterial color={trouser} roughness={0.76} metalness={0.03} />
      </mesh>
      <group ref={kneeRef} position={[0, -0.31, 0]}>
        <mesh castShadow={castShadow}>
          <sphereGeometry args={[0.069, 10, 8]} />
          <meshStandardMaterial color={trouser} roughness={0.76} metalness={0.03} />
        </mesh>
        <mesh position={[0, -0.14, 0]} castShadow={castShadow}>
          <capsuleGeometry args={[0.064, 0.18, 6, 10]} />
          <meshStandardMaterial color={trouser} roughness={0.77} metalness={0.03} />
        </mesh>
        <group ref={anklePitchRef} position={[0, -0.28, 0]}>
          <group ref={ankleRollRef}>
            <RoundedBox args={[0.14, 0.095, 0.25]} radius={0.035} smoothness={3} position={[0, -0.015, 0.075]} castShadow={castShadow}>
              <meshStandardMaterial color="#171c21" roughness={0.64} metalness={0.08} />
            </RoundedBox>
            <mesh position={[0, -0.062, 0.08]} castShadow={castShadow}>
              <boxGeometry args={[0.145, 0.018, 0.255]} />
              <meshStandardMaterial color="#090c0f" roughness={0.72} metalness={0.04} />
            </mesh>
            <group ref={footRef} position={[0, -0.07, 0.07]} />
          </group>
        </group>
      </group>
    </group>
  )
}

function WorkerRoleMarker({ role, accentColor }: { role: WatercolorCharacterRole; accentColor: string }): React.JSX.Element {
  return (
    <group
      name="office-role-accent-marker"
      userData={{
        officeRoleMarker: true,
        officeRoleMarkerRole: role,
        officeRoleMarkerLabelKey: ROLE_LABEL_KEYS[role],
        officeRoleMarkerTooltipKey: 'officeRoleAccentTitle',
        officeRoleMarkerDescriptionKey: 'officeRoleAccentTitle'
      }}
    >
      <mesh
        name="office-role-accent-marker-swatch"
        position={[0, 0.995, 0.128]}
        rotation={[0, 0, Math.PI]}
        userData={{ officeRoleMarkerPart: true, officeRole: role }}
      >
        <coneGeometry args={[0.042, 0.18, 4]} />
        <meshStandardMaterial color={accentColor} roughness={0.58} metalness={0.06} />
      </mesh>
    </group>
  )
}

const LowPolyDigitalWorkerRig = forwardRef<AvatarRefs, LowPolyDigitalWorkerRigProps>(
  function LowPolyDigitalWorkerRig(
    { sessionId, role, accentColor, providerLogo, detailLevel = 'full', position, rotation, scale = 1 },
    ref
  ): React.JSX.Element {
    const rootRef = useRef<Group>(null)
    const headRef = useRef<Group>(null)
    const waistYawRef = useRef<Group>(null)
    const waistRollRef = useRef<Group>(null)
    const armLRef = useRef<Group>(null); const armRRef = useRef<Group>(null)
    const elbowLRef = useRef<Group>(null); const elbowRRef = useRef<Group>(null)
    const wristLRef = useRef<Group>(null); const wristRRef = useRef<Group>(null)
    const handLRef = useRef<Group>(null); const handRRef = useRef<Group>(null)
    const legLRef = useRef<Group>(null); const legRRef = useRef<Group>(null)
    const kneeLRef = useRef<Group>(null); const kneeRRef = useRef<Group>(null)
    const anklePitchLRef = useRef<Group>(null); const anklePitchRRef = useRef<Group>(null)
    const ankleRollLRef = useRef<Group>(null); const ankleRollRRef = useRef<Group>(null)
    const footLRef = useRef<Group>(null); const footRRef = useRef<Group>(null)
    const variant = useMemo(() => stableVariant(sessionId), [sessionId])
    const skin = SKIN_TONES[variant % SKIN_TONES.length]
    const hair = HAIR_TONES[(variant >>> 3) % HAIR_TONES.length]
    const jacket = JACKET_TONES[(variant >>> 5) % JACKET_TONES.length]
    const trouser = TROUSER_TONES[(variant >>> 7) % TROUSER_TONES.length]
    const detailed = detailLevel === 'full'

    useImperativeHandle(ref, () => ({
      root: rootRef.current,
      head: headRef.current,
      armL: armLRef.current,
      armR: armRRef.current,
      elbowL: elbowLRef.current,
      elbowR: elbowRRef.current,
      wristL: wristLRef.current,
      wristR: wristRRef.current,
      handL: handLRef.current,
      handR: handRRef.current,
      waistYaw: waistYawRef.current,
      waistRoll: waistRollRef.current,
      legL: legLRef.current,
      legR: legRRef.current,
      kneeL: kneeLRef.current,
      kneeR: kneeRRef.current,
      anklePitchL: anklePitchLRef.current,
      anklePitchR: anklePitchRRef.current,
      ankleRollL: ankleRollLRef.current,
      ankleRollR: ankleRollRRef.current,
      footL: footLRef.current,
      footR: footRRef.current
    }), [])

    return (
      <group
        ref={rootRef}
        name="low-poly-digital-worker"
        position={position}
        rotation={rotation}
        scale={scale}
        userData={{
          officeDigitalWorkerCharacter: true,
          officeDigitalWorkerRole: role,
          officeWorkerVisualFamily: 'low-poly-human-v1',
          officeWorkerDetail: detailLevel,
          officeWorkerSessionId: sessionId
        }}
      >
        <group ref={waistYawRef} position={[0, 0.66, 0]}>
          <group ref={waistRollRef} position={[0, -0.66, 0]}>
            <RoundedBox args={[0.38, 0.47, 0.2]} radius={0.075} smoothness={4} position={[0, 0.91, 0]} castShadow={detailed}>
              <meshStandardMaterial color={jacket} roughness={0.68} metalness={0.05} />
            </RoundedBox>
            <RoundedBox args={[0.16, 0.34, 0.025]} radius={0.02} smoothness={3} position={[0, 0.94, 0.108]} castShadow={detailed}>
              <meshStandardMaterial color="#d9dde0" roughness={0.78} metalness={0.01} />
            </RoundedBox>
            <WorkerRoleMarker role={role} accentColor={accentColor} />
            <RoundedBox args={[0.31, 0.13, 0.18]} radius={0.045} smoothness={3} position={[0, 0.69, 0]} castShadow={detailed}>
              <meshStandardMaterial color={trouser} roughness={0.75} metalness={0.03} />
            </RoundedBox>
            <mesh position={[0, 1.16, 0]} castShadow={detailed}>
              <cylinderGeometry args={[0.058, 0.07, 0.12, 10]} />
              <meshStandardMaterial color={skin} roughness={0.74} metalness={0.01} />
            </mesh>
            <group ref={headRef} position={[0, 1.18, 0]}>
              <WorkerHead skin={skin} hair={hair} variant={variant} detailed={detailed} />
            </group>
            <group ref={armLRef} position={[-0.22, 1.06, 0]}>
              <WorkerArm jacket={jacket} skin={skin} castShadow={detailed} elbowRef={elbowLRef} wristRef={wristLRef} handRef={handLRef} />
            </group>
            <group ref={armRRef} position={[0.22, 1.06, 0]}>
              <WorkerArm jacket={jacket} skin={skin} castShadow={detailed} elbowRef={elbowRRef} wristRef={wristRRef} handRef={handRRef} />
            </group>
            {providerLogo && detailed && (
              <ProviderLogoBadge logo={providerLogo} position={[0.1, 0.98, 0.13]} scale={0.36} width={0.3} height={0.15} compact />
            )}
          </group>
        </group>
        <group ref={legLRef} position={[-0.095, 0.66, 0]}>
          <WorkerLeg trouser={trouser} castShadow={detailed} kneeRef={kneeLRef} anklePitchRef={anklePitchLRef} ankleRollRef={ankleRollLRef} footRef={footLRef} />
        </group>
        <group ref={legRRef} position={[0.095, 0.66, 0]}>
          <WorkerLeg trouser={trouser} castShadow={detailed} kneeRef={kneeRRef} anklePitchRef={anklePitchRRef} ankleRollRef={ankleRollRRef} footRef={footRRef} />
        </group>
      </group>
    )
  }
)

export default LowPolyDigitalWorkerRig
