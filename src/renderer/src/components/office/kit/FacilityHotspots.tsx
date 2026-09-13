import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { MeshStandardMaterial } from 'three'
import { useOfficeReducedMotion } from '../useOfficeReducedMotion'

export { OFFICE_FACILITY_OVERVIEW_CAMERA, OFFICE_FACILITY_SPECS } from './facilityCatalog'
export type { OfficeFacilityKey, OfficeFacilitySpec } from './facilityCatalog'
import type { OfficeFacilityKey, OfficeFacilitySpec } from './facilityCatalog'

interface FacilityHotspotsProps {
  specs: OfficeFacilitySpec[]
  activeKey?: OfficeFacilityKey | null
  interactive?: boolean
  onSelect: (key: OfficeFacilityKey) => void
}

function FacilityHotspot({
  spec,
  active,
  interactive,
  onSelect
}: {
  spec: OfficeFacilitySpec
  active: boolean
  interactive: boolean
  onSelect: (key: OfficeFacilityKey) => void
}): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const ringRef = useRef<MeshStandardMaterial>(null)
  const reducedMotion = useOfficeReducedMotion()

  useFrame((state) => {
    const t = reducedMotion ? 0 : state.clock.getElapsedTime()
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = (active ? 0.24 : 0.08) + Math.sin(t * 2.4) * (active ? 0.05 : 0.02)
      pulseRef.current.opacity = (active ? 0.36 : 0.12) + Math.sin(t * 2.1) * 0.025
    }
    if (ringRef.current) {
      ringRef.current.emissiveIntensity = (active ? 0.32 : 0.1) + Math.sin(t * 3.2) * (active ? 0.06 : 0.025)
    }
  })

  const cursorOver = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    document.body.style.cursor = 'pointer'
  }
  const cursorOut = (): void => {
    document.body.style.cursor = 'default'
  }
  const clickSelect = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onSelect(spec.key)
  }
  const interactionProps = interactive
    ? { onClick: clickSelect, onDoubleClick: clickSelect, onPointerOver: cursorOver, onPointerOut: cursorOut }
    : {}

  return (
    <group position={spec.position} {...interactionProps}>
      {spec.displayName && <Html position={[0, 2.02, -0.35]} center>
        <button className="office-domain-marker" aria-pressed={active} disabled={!interactive}
          data-office-business-facility={spec.key}
          data-office-courtyard-template="peer-court-v1" title={spec.displayName}
          onClick={() => onSelect(spec.key)}>{spec.displayName}</button>
      </Html>}
      <mesh position={[0, 0.024, 0]} receiveShadow>
        <boxGeometry args={[0.82, 0.012, 0.48]} />
        <meshStandardMaterial
          ref={pulseRef}
          color={spec.accent}
          emissive={spec.accent}
          emissiveIntensity={active ? 0.24 : 0.08}
          transparent
          opacity={active ? 0.36 : 0.12}
          toneMapped={false}
        />
      </mesh>
      {[-0.2, 0.2].map((x) => (
        <mesh key={`facility-active-slat-${x}`} position={[x, 0.042, 0.14]}>
          <boxGeometry args={[active ? 0.28 : 0.16, 0.012, 0.022]} />
          <meshStandardMaterial
            ref={x < 0 ? ringRef : undefined}
            color={active ? '#b7c4ce' : spec.accent}
            emissive={spec.accent}
            emissiveIntensity={active ? 0.32 : 0.1}
            transparent
            opacity={active ? 0.62 : 0.24}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh
        position={[
          spec.hit[0] - spec.position[0],
          spec.hit[1] - spec.position[1],
          spec.hit[2] - spec.position[2]
        ]}
        visible
      >
        <boxGeometry args={[1.4, 0.36, 0.52]} />
        <meshBasicMaterial transparent opacity={0.01} depthWrite={false} />
      </mesh>
    </group>
  )
}

export default function FacilityHotspots({ specs, activeKey, interactive = true, onSelect }: FacilityHotspotsProps): React.JSX.Element {
  return (
    <>
      {specs.map((spec) => (
        <FacilityHotspot
          key={spec.key}
          spec={spec}
          active={spec.key === activeKey}
          interactive={interactive}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}
