import { Html } from '@react-three/drei'
import { useEffect, useMemo, useState } from 'react'
import { SYSTEM_ROLES, type SystemRoleId, type SystemRoleSpec } from './systemRoleCatalog'
import { getLatestPalaceResource, subscribePalaceResource } from './palaceResource'
import type { Group, Mesh } from 'three'

function GovernanceRoleFigure({ role, authoredCharacters, summoned }: { role: SystemRoleSpec; authoredCharacters: Group | null; summoned: boolean }): React.JSX.Element | null {
  const figure = useMemo(() => {
    const source = authoredCharacters?.getObjectByName(`CHAR_${role.id}`)
    if (!source) return null
    const copy = source.clone(true)
    copy.traverse((node) => {
      if ((node as Mesh).isMesh) (node as Mesh).raycast = () => undefined
    })
    copy.userData = { ...copy.userData, systemRoleFigure: role.id, projectionOnly: true, canonicalSource: role.canonicalSource }
    return copy
  }, [authoredCharacters, role.canonicalSource, role.id])
  return figure && summoned ? <primitive object={figure} dispose={null} /> : null
}

/** Clickable governance projections in HALL_main. No role state is created here. */
export default function SystemRoleHotspots({ selected, summoned = false, onSelect, onFigureCountChange }: {
  selected?: SystemRoleId | null
  summoned?: boolean
  onSelect: (id: SystemRoleId) => void
  onFigureCountChange?: (count: number) => void
}): React.JSX.Element {
  const [authoredCharacters, setAuthoredCharacters] = useState<Group | null>(() => getLatestPalaceResource()?.authoredCharacters ?? null)
  useEffect(() => subscribePalaceResource(() => setAuthoredCharacters(getLatestPalaceResource()?.authoredCharacters ?? null)), [])
  useEffect(() => {
    onFigureCountChange?.(SYSTEM_ROLES.filter((role) => authoredCharacters?.getObjectByName(`CHAR_${role.id}`)).length)
  }, [authoredCharacters, onFigureCountChange])
  return <>{SYSTEM_ROLES.map((role) => <group key={role.id} position={role.position}
    userData={{ systemRole: role.id, systemRoleAnchor: role.anchor, systemRoleGroup: role.group, canonicalSource: role.canonicalSource, projectionOnly: true }}>
    <GovernanceRoleFigure role={role} authoredCharacters={authoredCharacters} summoned={summoned} />
    <mesh onClick={(event) => { event.stopPropagation(); onSelect(role.id) }}
      onPointerOver={() => { document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { document.body.style.cursor = 'default' }}>
      <cylinderGeometry args={[0.48, 0.48, 2.2, 8]} />
      <meshBasicMaterial transparent opacity={0.01} depthWrite={false} />
    </mesh>
    <Html position={[0, 2, 0]} center>
      <button className="office-domain-marker" aria-label={`${role.label}：${role.duty}`} title={role.duty}
        aria-pressed={selected === role.id} data-office-system-role={role.id}
        data-office-system-role-anchor={role.anchor} data-office-system-role-group={role.group}
        data-office-system-role-projection="true" onClick={() => onSelect(role.id)}>
        {role.label}
      </button>
    </Html>
  </group>)}</>
}
