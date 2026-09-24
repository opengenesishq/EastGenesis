import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { Group, Vector3 } from 'three'
import AcademyMeshes from '../ming/AcademyMeshes'
import { createAcademyArchitecture } from '../ming/academyArchitecture'
import { getAcademyResource } from '../ming/academyResourceCache'
import MingBusinessStation from '../ming/MingBusinessStation'
import MingCourtFigure, { type MingCourtPose } from '../ming-characters/MingCourtFigure'
import { imperialCityMapPosition, type ImperialCityNode, type ImperialCityZone } from './imperialCityCatalog'
import { imperialCityCourierFrame } from './imperialCityMotion'
import type { SystemRoleSpec } from './systemRoleCatalog'

/** Existing courtyard assets and articulated figures. Only the entered
 * courtyard mounts residents; maps do not spawn agents or duplicate tasks. */
export default function ImperialCityScene({ zone, node, nodes, roles, zh, reducedMotion, onEnter, onRole, onTreasury }: {
  zone: Exclude<ImperialCityZone, 'palace'>; node?: ImperialCityNode; nodes: readonly ImperialCityNode[]
  roles: readonly SystemRoleSpec[]; zh: boolean; reducedMotion: boolean
  onEnter(node: ImperialCityNode): void; onRole(roleId: string): void; onTreasury(): void
}): React.JSX.Element {
  const elapsed = useRef(0)
  const lastReport = useRef(-1)
  const { gl } = useThree()
  useEffect(() => {
    elapsed.current = 0
    lastReport.current = -1
    gl.domElement.closest('.office-canvas-wrap')?.removeAttribute('data-office-palace-loaded')
    gl.shadowMap.needsUpdate = true
    return () => { gl.shadowMap.needsUpdate = true }
  }, [zone, node?.id, gl])
  useFrame((_, delta) => {
    elapsed.current += Math.min(delta, 0.1) * (reducedMotion ? 0.6 : 1)
    if (elapsed.current - lastReport.current < 0.2) return
    lastReport.current = elapsed.current
    const wrap = gl.domElement.closest('.office-canvas-wrap')
    wrap?.setAttribute('data-imperial-animation-time', elapsed.current.toFixed(2))
    wrap?.setAttribute('data-imperial-courier-position', node ? JSON.stringify(imperialCityCourierFrame(elapsed.current, 0)) : '')
  }, -2)
  return <group name={`imperial-city-${zone}`} userData={{ sceneZone: zone, nodeId: node?.id, illustrative: true, era: '1562–1566' }}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.38, 0]} receiveShadow>
      <planeGeometry args={[100, 100]} /><meshStandardMaterial color="#8e9278" roughness={1} />
    </mesh>
    {node ? <OfficeCourtyard key={node.id} node={node} roles={roles.filter(role => node.roleIds.includes(role.id))} elapsed={elapsed}
      zh={zh} reducedMotion={reducedMotion} onRole={onRole} onTreasury={onTreasury} /> : <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.34, 0]}>
        <planeGeometry args={[zone === 'imperial' ? 46 : 78, zone === 'imperial' ? 25 : 55]} /><meshStandardMaterial color="#c6bba5" roughness={1} />
      </mesh>
      {nodes.map((item, index) => <group key={item.id} position={imperialCityMapPosition(index, nodes.length)}
        userData={{ institutionNode: item.id, roleIds: item.roleIds, action: 'enter-existing-workspace' }}>
        <group scale={0.65}><CourtyardArchitecture /></group>
        <mesh position={[0, 0.6, 1]} onClick={event => { event.stopPropagation(); onEnter(item) }}
          onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = 'default' }}>
          <boxGeometry args={[12, 2, 9]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        <Html position={[0, 2.2, 3]} center zIndexRange={[2, 0]}><button type="button" className="imperial-city-marker"
          data-imperial-enter={item.id} onClick={() => onEnter(item)}><strong>{zh ? item.label : item.labelEn}</strong>
          <small>{zh ? '进入院落' : 'Enter courtyard'}</small></button></Html>
      </group>)}
      {zone === 'imperial' && <ImperialBoundary />}
    </>}
  </group>
}

function CourtyardArchitecture(): React.JSX.Element {
  // Working courtyards use restrained grey tiles. Palace roof materials remain
  // on the existing Forbidden City; these nodes are illustrative office spaces.
  const resource = useMemo(() => getAcademyResource('imperial:working-courtyard-v1', () => createAcademyArchitecture({ includePeerHalls: false })), [])
  return <AcademyMeshes parts={resource.parts} resource={resource} colors={{ tile: '#526064', tileEdge: '#748084' }} />
}

function ImperialBoundary(): React.JSX.Element {
  return <group position={[0, 0, -13]} name="illustrative-palace-boundary">
    {[-1, 1].map(side => <group key={side} position={[side * 13, 0, 0]}>
      <mesh position={[0, 2.1, 0]}><boxGeometry args={[17, 4.2, 0.7]} /><meshStandardMaterial color="#954e3c" /></mesh>
      <mesh position={[0, 4.27, 0]}><boxGeometry args={[17.4, 0.18, 1]} /><meshStandardMaterial color="#666354" /></mesh>
    </group>)}
    <mesh position={[0, 4.8, 0]}><boxGeometry args={[10, 1.2, 1.5]} /><meshStandardMaterial color="#624738" /></mesh>
    {[-4.3, 4.3].map(x => <mesh key={x} position={[x, 2.1, 0]}><boxGeometry args={[0.7, 4.2, 1.2]} /><meshStandardMaterial color="#954e3c" /></mesh>)}
  </group>
}

function OfficeCourtyard({ node, roles, elapsed, zh, reducedMotion, onRole, onTreasury }: {
  node: ImperialCityNode; roles: readonly SystemRoleSpec[]; elapsed: MutableRefObject<number>; zh: boolean; reducedMotion: boolean
  onRole(id: string): void; onTreasury(): void
}): React.JSX.Element {
  return <group name={`entered-courtyard-${node.id}`}>
    <CourtyardArchitecture />
    {roles.map((role, index) => {
      const x = roles.length === 1 ? 0 : index % 2 ? 3 : -3
      const z = Math.floor(index / 2) * 4 - 3
      return <group key={role.id} position={[x, 0.05, z]} userData={{ institutionId: role.id, canonicalSource: role.canonicalSource }}>
        <MingBusinessStation variant="command" />
        <mesh position={[0, 0.36, -0.88]}><boxGeometry args={[0.85, 0.12, 0.56]} /><meshStandardMaterial color="#704d37" /></mesh>
        {[-0.3, 0.3].map(side => <mesh key={side} position={[side, 0.16, -0.88]}><boxGeometry args={[0.09, 0.32, 0.42]} /><meshStandardMaterial color="#704d37" /></mesh>)}
        <OfficeResident roleId={role.id} index={index} elapsed={elapsed} reducedMotion={reducedMotion} onSelect={() => onRole(role.id)} />
        <mesh position={[0, 0.7, 0]} onClick={event => { event.stopPropagation(); onRole(role.id) }}>
          <boxGeometry args={[2.1, 1.4, 1.4]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        <Html position={[0, 2.8, -0.35]} center zIndexRange={[2, 0]}><div className="imperial-city-role-actions">
          <button type="button" data-imperial-role={role.id} onClick={() => onRole(role.id)}>{zh ? role.label : role.labelEn}</button>
          {role.actions.some(action => action.target === 'treasury') && <button type="button" data-imperial-treasury onClick={onTreasury}>{zh ? '国库账目' : 'Treasury'}</button>}
        </div></Html>
      </group>
    })}
    <MingBusinessStation position={[-7.6, 0.03, -6.5]} variant={node.kind === 'military' ? 'infrastructure' : 'archive'} />
    <MingBusinessStation position={[7.6, 0.03, -6.5]} variant={node.id === 'works' ? 'project' : 'archive'} />
    {[0, 1].map(index => <OfficeCourier key={index} index={index} elapsed={elapsed} kind={node.kind === 'service' ? 'attendant' : node.kind}
      reducedMotion={reducedMotion} onSelect={() => { if (roles.length) onRole(roles[index % roles.length].id) }} />)}
  </group>
}

function OfficeResident({ roleId, index, elapsed, reducedMotion, onSelect }: {
  roleId: string; index: number; elapsed: MutableRefObject<number>; reducedMotion: boolean; onSelect(): void
}): React.JSX.Element {
  const pose = useRef<MingCourtPose>({ walk: 0, bow: 0.08, kneel: 0, sit: 1, salute: 0.35, speak: 0 })
  useFrame(() => {
    pose.current.time = elapsed.current
    pose.current.bow = 0.08 + Math.sin(elapsed.current * 0.8 + index) * 0.03
    pose.current.salute = 0.35 + Math.sin(elapsed.current * 1.4 + index) * 0.08
  }, -1)
  const kind = roleId === 'silijian' ? 'attendant' : ['wujun_dudufu', 'tongbing_jiangling', 'jinyiwei'].includes(roleId) ? 'military' : 'civil'
  return <group position={[0, 0, -0.88]} name={`office-resident-${roleId}`} onClick={event => { event.stopPropagation(); onSelect() }}
    userData={{ roleId, visualOnly: true, activity: 'reading-at-desk' }}>
    <MingCourtFigure kind={kind} pose={pose} reducedMotion={reducedMotion} />
  </group>
}

function OfficeCourier({ index, elapsed, kind, reducedMotion, onSelect }: {
  index: number; elapsed: MutableRefObject<number>; kind: 'civil' | 'military' | 'attendant'; reducedMotion: boolean; onSelect(): void
}): React.JSX.Element {
  const root = useRef<Group>(null)
  const pose = useRef<MingCourtPose>({ walk: 0, bow: 0, kneel: 0, salute: 0.4, speak: 0 })
  const previous = useRef<Vector3 | null>(null)
  useFrame(() => {
    if (!root.current) return
    const frame = imperialCityCourierFrame(elapsed.current, index)
    root.current.position.set(frame.x, 0.05, frame.z)
    if (previous.current) pose.current.walk += root.current.position.distanceTo(previous.current)
    else previous.current = new Vector3()
    previous.current.copy(root.current.position)
    root.current.rotation.y = frame.heading
    pose.current.time = elapsed.current
    pose.current.bow = frame.walking ? 0 : 0.06
    pose.current.salute = frame.walking ? 0.25 : 0.65
  }, -1)
  return <group ref={root} name={`office-courier-${index}`} onClick={event => { event.stopPropagation(); onSelect() }}
    userData={{ visualOnly: true, activity: 'walking-and-delivering-records' }}>
    <MingCourtFigure kind={kind} pose={pose} reducedMotion={reducedMotion} />
  </group>
}
