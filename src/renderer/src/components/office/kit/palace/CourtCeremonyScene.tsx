import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Group, Vector3 } from 'three'
import MingCourtFigure from '../ming-characters/MingCourtFigure'
import { academyRoof } from '../ming/academyGeometry'
import { getCourtFrame } from '../../court-ceremony'

export interface CourtPlayback { elapsed: number; paused: boolean; speed: number }
type FigurePose = { walk: number; bow: number; kneel: number; salute: number; speak: number; sit?: number; paused?: boolean; time?: number }
type Point = [number, number, number]
const OFFICIALS = 12
const smooth = (n: number): number => { const t = Math.max(0, Math.min(1, n)); return t * t * (3 - 2 * t) }
const pulse = (n: number): number => Math.sin(Math.PI * Math.max(0, Math.min(1, n))) ** 2
const ZERO_POSE: FigurePose = { walk: 0, bow: 0, kneel: 0, salute: 0, speak: 0 }

/** Runtime choreography only: no task dispatch, approval or simulated work result. */
export default function CourtCeremonyScene({ playback, participants, reducedMotion, onTick, onSelect }: {
  playback: MutableRefObject<CourtPlayback>; participants: number; reducedMotion: boolean
  onTick(elapsed: number): void; onSelect(index: number): void
}): React.JSX.Element {
  const { gl } = useThree()
  const lastUi = useRef(-1)
  useEffect(() => {
    gl.shadowMap.needsUpdate = true
    return () => { gl.shadowMap.needsUpdate = true }
  }, [gl])
  useFrame((_, delta) => {
    const state = playback.current
    const total = getCourtFrame(state.elapsed, participants).totalDuration
    if (!state.paused) state.elapsed = Math.min(total, state.elapsed + Math.min(0.1, Math.max(0, delta)) * state.speed)
    const frame = getCourtFrame(state.elapsed, participants)
    const wrap = gl.domElement.closest('.office-canvas-wrap')
    wrap?.setAttribute('data-court-stage', frame.stage)
    wrap?.setAttribute('data-court-time', state.elapsed.toFixed(2))
    if (Math.abs(state.elapsed - lastUi.current) >= 0.12 || (state.elapsed === total && lastUi.current !== total)) {
      lastUi.current = state.elapsed; onTick(state.elapsed)
    }
  }, -2)
  return <group position={[0, 0, 8]} name="ming-court-ceremony" userData={{ courtCeremony: true, visualOnly: true }}>
    <CourtGate />
    <CourtEmperor playback={playback} participants={participants} reducedMotion={reducedMotion} />
    {[-1, 1].map(side => <CourtAttendant key={side} side={side} playback={playback} participants={participants} reducedMotion={reducedMotion} />)}
    {Array.from({ length: OFFICIALS }, (_, index) => <CourtOfficial key={index} index={index}
      playback={playback} participants={participants} reducedMotion={reducedMotion} onSelect={onSelect} />)}
  </group>
}

/** A compact, open gate-stage for the ritual; not a claimed surveyed palace reconstruction. */
function CourtGate(): React.JSX.Element {
  const roof = useMemo(() => academyRoof(11.8, 4.8, 1.25), [])
  useEffect(() => () => roof.dispose(), [roof])
  return <group name="court-open-gate" position={[0, 0, -3.4]}>
    {[0, 1, 2].map(step => <mesh key={step} position={[0, 0.09 + step * 0.16, -step * 0.2]}>
      <boxGeometry args={[11.4 - step * 0.45, 0.18, 4.2 - step * 0.4]} /><meshStandardMaterial color="#c5b8a3" roughness={0.9} />
    </mesh>)}
    {[-4.7, -2.5, 2.5, 4.7].map(x => <group key={x} position={[x, 0.5, -0.6]}>
      <mesh position={[0, 1.8, 0]}><cylinderGeometry args={[0.18, 0.21, 3.6, 10]} /><meshStandardMaterial color="#8f3329" roughness={0.8} /></mesh>
      <mesh position={[0, 0.1, 0]}><cylinderGeometry args={[0.31, 0.35, 0.2, 10]} /><meshStandardMaterial color="#c9bcaa" /></mesh>
    </group>)}
    <mesh position={[0, 3.88, -0.6]}><boxGeometry args={[10.7, 0.48, 0.58]} /><meshStandardMaterial color="#714032" /></mesh>
    <mesh position={[0, 4.04, -0.6]} geometry={roof}><meshStandardMaterial color="#b3944f" roughness={0.85} side={2} /></mesh>
    <mesh position={[0, 5.31, -0.6]}><boxGeometry args={[11.9, 0.12, 0.16]} /><meshStandardMaterial color="#c5a55d" /></mesh>
    <mesh position={[0, 0.75, -0.65]}><boxGeometry args={[1.7, 0.3, 1.55]} /><meshStandardMaterial color="#71452e" /></mesh>
    <mesh position={[0, 1.45, -1.26]}><boxGeometry args={[1.55, 1.45, 0.17]} /><meshStandardMaterial color="#9d713f" metalness={0.1} roughness={0.7} /></mesh>
    {[-0.66, 0.66].flatMap(x => [-1.22, -0.08].map(z => <mesh key={`${x}-${z}`} position={[x, 0.58, z]}>
      <boxGeometry args={[0.13, 0.3, 0.13]} /><meshStandardMaterial color="#71452e" /></mesh>))}
    {[-0.85, 0.85].map(x => <mesh key={x} position={[x, 1, -0.55]}><boxGeometry args={[0.15, 0.23, 1.45]} /><meshStandardMaterial color="#855630" /></mesh>)}
  </group>
}

function CourtEmperor({ playback, participants, reducedMotion }: {
  playback: MutableRefObject<CourtPlayback>; participants: number; reducedMotion: boolean
}): React.JSX.Element {
  const pose = useRef<FigurePose>({ ...ZERO_POSE })
  const root = useRef<Group>(null)
  const previous = useRef(new Vector3(6.2, 0, -2.65))
  const position = useMemo(() => new Vector3(), [])
  useFrame(() => {
    pose.current.paused = playback.current.paused
    pose.current.time = playback.current.elapsed
    if (!root.current || playback.current.paused) return
    const frame = getCourtFrame(playback.current.elapsed, participants)
    const entering = frame.stage === 'enter' ? smooth(frame.progress / 0.52) : 1
    const departing = frame.stage === 'complete' ? 1 : frame.stage === 'dismiss' ? smooth((frame.progress - 0.42) / 0.58) : 0
    // Cross in front of the pillars and armrests, then back into the throne.
    // Dismissal follows the same collision-free route in reverse.
    const arrival = entering * (1 - departing)
    const x = 6.2 * (1 - smooth(arrival / 0.82))
    const z = -2.65 - 1.1 * smooth((arrival - 0.82) / 0.18)
    position.set(x, 0.52 * smooth((6.2 - x) / 0.8), z)
    pose.current.walk += position.distanceTo(previous.current)
    previous.current.copy(position)
    root.current.position.copy(position)
    const heading = x > 0.02 ? (departing ? Math.PI / 2 : -Math.PI / 2) : 0
    root.current.rotation.y += Math.atan2(Math.sin(heading - root.current.rotation.y), Math.cos(heading - root.current.rotation.y)) * 0.2
    root.current.visible = frame.stage !== 'complete'
    pose.current.salute = 0.2
    pose.current.sit = (frame.stage === 'enter' ? smooth((frame.progress - 0.55) / 0.2) : 1)
      * (frame.stage === 'dismiss' ? 1 - smooth(frame.progress / 0.22) : 1)
    pose.current.speak = frame.stage === 'report' ? pulse((frame.reportProgress - 0.52) / 0.25) : 0
  }, -1)
  return <group ref={root} position={[6.2, 0, -2.65]} name="court-emperor"><MingCourtFigure kind="emperor" pose={pose} reducedMotion={reducedMotion} /></group>
}

function CourtAttendant({ side, playback, participants, reducedMotion }: {
  side: number; playback: MutableRefObject<CourtPlayback>; participants: number; reducedMotion: boolean
}): React.JSX.Element {
  const pose = useRef<FigurePose>({ ...ZERO_POSE })
  useFrame(() => {
    pose.current.paused = playback.current.paused
    pose.current.time = playback.current.elapsed
    if (playback.current.paused) return
    const frame = getCourtFrame(playback.current.elapsed, participants)
    pose.current.salute = 0.65
    pose.current.speak = frame.stage === 'salute' ? pulse(frame.progress) : 0
    pose.current.bow = frame.stage === 'dismiss' ? 0.2 * pulse(frame.progress * 3) : 0
  }, -1)
  return <group position={[side * 3.5, 0.02, -0.7]} rotation={[0, side * -0.22, 0]} name={side > 0 ? 'court-honglu-herald' : 'court-palace-attendant'}>
    <MingCourtFigure kind={side > 0 ? 'civil' : 'attendant'} pose={pose} reducedMotion={reducedMotion} />
  </group>
}

function CourtOfficial({ index, playback, participants, reducedMotion, onSelect }: {
  index: number; playback: MutableRefObject<CourtPlayback>; participants: number; reducedMotion: boolean
  onSelect(index: number): void
}): React.JSX.Element {
  const root = useRef<Group>(null)
  const pose = useRef<FigurePose>({ ...ZERO_POSE })
  const previous = useRef(new Vector3())
  const initialized = useRef(false)
  const side = index % 2 === 0 ? 1 : -1 // 文东、武西; north is -Z.
  const place = Math.floor(index / 2)
  const row = Math.floor(place / 2), column = place % 2
  const home = useMemo<Point>(() => [side * (3.3 + column * 1.85), 0.02, 3.2 + row * 2.5], [side, column, row])
  const entry = useMemo<Point>(() => [side * (8.5 + column * 1.5), 0.02, 11 + row * 0.9], [side, column, row])
  const position = useMemo(() => new Vector3(), [])
  const look = useMemo(() => new Vector3(), [])
  useFrame(() => {
    pose.current.paused = playback.current.paused
    pose.current.time = playback.current.elapsed
    if (!root.current || playback.current.paused) return
    const frame = getCourtFrame(playback.current.elapsed, participants)
    const state = pose.current
    state.bow = 0; state.kneel = 0; state.salute = 0.82; state.speak = 0
    position.fromArray(home)
    let heading = Math.PI
    if (frame.stage === 'enter') {
      const p = smooth((frame.progress - place * 0.035) / (1 - place * 0.035))
      // First merge into the correct side's own lane, then advance toward its row.
      position.set(entry[0] + (home[0] - entry[0]) * smooth(p / 0.36), 0.02,
        entry[2] + (home[2] - entry[2]) * smooth((p - 0.18) / 0.82))
    } else if (frame.stage === 'salute') {
      state.bow = 0.8 * pulse(frame.progress)
      state.kneel = 0.95 * pulse(frame.progress)
    } else if (frame.stage === 'report' && frame.reportIndex === index) {
      const p = frame.reportProgress
      // The elected representative exits the front of their lane before entering the centre.
      const out = smooth(p / 0.27), back = smooth((p - 0.77) / 0.23)
      const amount = out * (1 - back)
      // Step ahead into the row gap, then use the inner aisle; do not walk through other officials.
      const stops: Point[] = [home, [home[0], 0.02, home[2] - 0.8], [side * 1.8, 0.02, home[2] - 0.8],
        [side * 1.8, 0.02, 0.35], [0, 0.02, 0.35]]
      const segment = Math.min(3, Math.floor(amount * 4))
      const progress = smooth(amount * 4 - segment)
      position.fromArray(stops[segment]).lerp(look.fromArray(stops[segment + 1]), progress)
      state.kneel = smooth((p - 0.29) / 0.08) * (1 - smooth((p - 0.64) / 0.1))
      state.bow = 0.22 * state.kneel
      state.speak = pulse((p - 0.35) / 0.3)
    } else if (frame.stage === 'dismiss' || frame.stage === 'complete') {
      const p = frame.stage === 'complete' ? 1 : smooth((frame.progress - place * 0.025) / (1 - place * 0.025))
      position.set(home[0] + (entry[0] - home[0]) * smooth((p - 0.4) / 0.6), 0.02,
        home[2] + (entry[2] - home[2]) * smooth(p / 0.8))
      heading = 0
      root.current.visible = p < 0.99
    }
    if (frame.stage !== 'dismiss' && frame.stage !== 'complete') root.current.visible = true
    if (initialized.current) {
      look.copy(position).sub(previous.current)
      const distance = look.length()
      if (distance > 0.00001) { state.walk += distance; heading = Math.atan2(look.x, look.z) }
    }
    initialized.current = true
    previous.current.copy(position)
    root.current.position.copy(position)
    const difference = Math.atan2(Math.sin(heading - root.current.rotation.y), Math.cos(heading - root.current.rotation.y))
    root.current.rotation.y += difference * 0.25
    root.current.userData.courtPosition = position.toArray()
    root.current.userData.courtBow = state.bow
    root.current.userData.courtKneel = state.kneel
  }, -1)
  return <group ref={root} name={`court-official-${index}`} rotation={[0, Math.PI, 0]}
    userData={{ courtOfficial: index, taskRepresentative: index < participants }}
    onClick={event => { event.stopPropagation(); if (index < participants) onSelect(index) }}>
    <MingCourtFigure kind={side > 0 ? 'civil' : 'military'} pose={pose} reducedMotion={reducedMotion}
      robeColor={side > 0 ? ['#813c35', '#7e473d', '#99594b'][row] : ['#355262', '#3e5b67', '#426c72'][row]} />
  </group>
}
