import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import WorkstationOperatorRig from './WorkstationOperatorRig'
import CompactWorkstationShell from './CompactWorkstationShell'
import Desk from './Desk'
import OfficeChair from './OfficeChair'
import MonitorSetup from './MonitorSetup'
import DeskAccessories from './DeskAccessories'
import DeskLamp from './DeskLamp'
import SpeechBubble from './SpeechBubble'
import ProviderLogoBadge from './ProviderLogoBadge'
import { providerLogoFor } from './ProviderLogos'
import type { ProviderLogoSpec } from './ProviderLogos'
import { officeActivityOf, type OfficeSessionActivity, type OfficeSessionSignal, type OfficeTask, type OfficeTaskStats } from '../model'
import { hasOfficeFailoverSignal } from '../providerModelFailover'
import { stableWatercolorRole, type WatercolorCharacterRole, type WatercolorCharacterState } from '../../../../../shared/watercolor-character'
import type { Group, MeshStandardMaterial } from 'three'
import type { OfficeHairStyle, OfficeOutfitPalette } from '../../../../../shared/types'
import { resolveWorkstationDetail } from './workstationSupport'

export type WorkstationActivity = OfficeSessionActivity
export type WorkstationDetail = 'full' | 'compact'

export interface WorkstationProProps {
  sessionId: string
  position: [number, number, number]
  active: boolean
  /** Selected stations default to full detail; this can keep an inactive station full when needed. */
  detail?: WorkstationDetail
  /** Lets constrained quality tiers lower the selected station without changing inactive-station detail. */
  activeDetail?: WorkstationDetail
  activity: WorkstationActivity
  awaitingText?: string
  title: string
  costUsd: number
  brandName?: string
  providerBaseUrl?: string
  modelName?: string
  vendorKey?: string
  showBadge?: boolean
  liveliness?: number
  loadCharacterAssets?: boolean
  watercolorRole?: WatercolorCharacterRole
  watercolorState?: WatercolorCharacterState
  outfitPalette?: OfficeOutfitPalette
  hairStyle?: OfficeHairStyle
  operatorAway?: boolean
  currentTask?: OfficeTask
  taskStats?: OfficeTaskStats
  sessionSignal?: OfficeSessionSignal
  interactive?: boolean
  onSelect: () => void
  onOpen?: () => void
}

function whenInteractive<T extends object>(interactive: boolean, handlers: T): T | Record<string, never> {
  return interactive ? handlers : {}
}

/** 活动 → 屏幕/强调色(与办公区状态色规范一致,克制) */
const ACTIVITY_COLOR: Record<WorkstationActivity, string> = {
  idle: '#7f95a6',
  working: '#72b8c8',
  awaiting: '#7f9aac',
  completed: '#8ba2b0',
  error: '#7f6662'
}
const OFFICE_SIGNAL_ACCENT = '#59b8c8'
const OFFICE_STRUCTURE_TRIM = '#697680'
const OFFICE_NEUTRAL_LIGHT = '#9aa8b5'
const OPERATOR_INPUT_ARRAY_Z = 0.16

const FAULT_COLOR = '#a94842'

export const activityOf = officeActivityOf

function signalFromText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 997
  return hash
}

function OperatorWorkSurface({
  accent,
  screenColor,
  activity,
  progress
}: {
  accent: string
  screenColor: string
  activity: WorkstationActivity
  progress: number
}): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const railRef = useRef<MeshStandardMaterial>(null)
  const active = activity === 'working' || activity === 'awaiting'

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = (active ? 0.3 : 0.1) + Math.sin(t * 3.1) * (active ? 0.08 : 0.025)
    }
    if (railRef.current) {
      railRef.current.emissiveIntensity = (active ? 0.36 : 0.13) + Math.sin(t * 4.2 + 0.8) * (active ? 0.09 : 0.03)
    }
  })

  return (
    <group position={[0, 0.768, 0.16]}>
      <RoundedBox args={[0.66, 0.026, 0.32]} radius={0.025} smoothness={3} position={[0, 0, 0.02]} castShadow receiveShadow>
        <meshStandardMaterial color="#14202a" metalness={0.3} roughness={0.5} transparent opacity={0.9} />
      </RoundedBox>
      <RoundedBox args={[0.5, 0.012, 0.18]} radius={0.018} smoothness={3} position={[0, 0.021, 0.02]}>
        <meshStandardMaterial
          ref={pulseRef}
          color={screenColor}
          emissive={screenColor}
          emissiveIntensity={active ? 0.3 : 0.1}
          transparent
          opacity={active ? 0.24 : 0.14}
          roughness={0.24}
          metalness={0.18}
          toneMapped={false}
        />
      </RoundedBox>
      <mesh position={[-0.18, 0.034, 0.07]}>
        <boxGeometry args={[0.16, 0.012, 0.022]} />
        <meshStandardMaterial ref={railRef} color={accent} emissive={accent} emissiveIntensity={0.36} toneMapped={false} />
      </mesh>
      <mesh position={[0.18, 0.034, 0.07]}>
        <boxGeometry args={[0.16, 0.012, 0.022]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.28} toneMapped={false} />
      </mesh>
      <RoundedBox args={[0.13, 0.032, 0.07]} radius={0.018} smoothness={3} position={[-0.18, 0.072, 0.19]} castShadow>
        <meshStandardMaterial color={OFFICE_NEUTRAL_LIGHT} emissive="#6f8794" emissiveIntensity={0.08} roughness={0.24} metalness={0.4} />
      </RoundedBox>
      <RoundedBox args={[0.13, 0.032, 0.07]} radius={0.018} smoothness={3} position={[0.18, 0.072, 0.19]} castShadow>
        <meshStandardMaterial color={OFFICE_NEUTRAL_LIGHT} emissive="#6f8794" emissiveIntensity={0.08} roughness={0.24} metalness={0.4} />
      </RoundedBox>
      <mesh position={[-0.18, 0.093, 0.19]}>
        <boxGeometry args={[0.088, 0.012, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.34 : 0.14} toneMapped={false} />
      </mesh>
      <mesh position={[0.18, 0.093, 0.19]}>
        <boxGeometry args={[0.088, 0.012, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.34 : 0.14} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.036, -0.08]}>
        <boxGeometry args={[0.42, 0.01, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.28 : 0.11} toneMapped={false} />
      </mesh>
      <mesh position={[-0.11, 0.039, -0.005]} rotation={[0, 0.34, 0]}>
        <boxGeometry args={[0.018, 0.01, 0.18]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.24 : 0.1} toneMapped={false} />
      </mesh>
      <mesh position={[0.11, 0.039, -0.005]} rotation={[0, -0.34, 0]}>
        <boxGeometry args={[0.018, 0.01, 0.18]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.24 : 0.1} toneMapped={false} />
      </mesh>
      <mesh position={[-(0.46 * (1 - progress)) / 2, 0.043, 0.15]}>
        <boxGeometry args={[0.46 * progress, 0.01, 0.018]} />
        <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={active ? 0.34 : 0.14} toneMapped={false} />
      </mesh>
    </group>
  )
}

function OperatorInputArray({
  accent,
  screenColor,
  activity
}: {
  accent: string
  screenColor: string
  activity: WorkstationActivity
}): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const active = activity === 'working' || activity === 'awaiting'

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = (active ? 0.4 : 0.16) + Math.sin(t * 5.4) * (active ? 0.1 : 0.04)
      pulseRef.current.opacity = (active ? 0.64 : 0.38) + Math.sin(t * 3.6) * 0.05
    }
  })

  return (
    <group position={[0, 0.858, OPERATOR_INPUT_ARRAY_Z]} rotation={[-0.08, 0, 0]}>
      <RoundedBox args={[0.78, 0.032, 0.28]} radius={0.024} smoothness={3} castShadow receiveShadow>
        <meshStandardMaterial color="#131f29" metalness={0.34} roughness={0.5} transparent opacity={0.92} />
      </RoundedBox>
      {[-0.21, 0.21].map((x) => (
        <group key={x} position={[x, 0.027, 0.01]}>
          <RoundedBox args={[0.27, 0.018, 0.16]} radius={0.018} smoothness={3}>
            <meshStandardMaterial
              color={screenColor}
              emissive={screenColor}
              emissiveIntensity={active ? 0.28 : 0.13}
              transparent
              opacity={active ? 0.28 : 0.17}
              roughness={0.28}
              metalness={0.18}
              toneMapped={false}
            />
          </RoundedBox>
          {Array.from({ length: 5 }).map((_, i) => (
            <mesh key={`${x}-key-${i}`} position={[-0.09 + i * 0.045, 0.02, 0.012 + (i % 2) * 0.038]}>
              <boxGeometry args={[0.026, 0.012, 0.026]} />
              <meshStandardMaterial
                color={i % 2 === 0 ? accent : OFFICE_NEUTRAL_LIGHT}
                emissive={i % 2 === 0 ? accent : screenColor}
                emissiveIntensity={active ? 0.38 : 0.16}
                transparent
                opacity={0.9}
                toneMapped={false}
              />
            </mesh>
          ))}
        </group>
      ))}
      <mesh position={[0, 0.046, -0.092]}>
        <boxGeometry args={[0.62, 0.014, 0.024]} />
        <meshStandardMaterial
          ref={pulseRef}
          color={accent}
          emissive={accent}
          emissiveIntensity={active ? 0.4 : 0.16}
          transparent
          opacity={active ? 0.64 : 0.38}
          toneMapped={false}
        />
      </mesh>
      {[-0.18, 0.18].map((x) => (
        <mesh key={`finger-target-${x}`} position={[x, 0.065, 0.12]} castShadow>
          <boxGeometry args={[0.12, 0.018, 0.038]} />
          <meshStandardMaterial color={OFFICE_NEUTRAL_LIGHT} emissive="#6f8794" emissiveIntensity={0.08} roughness={0.28} metalness={0.4} />
        </mesh>
      ))}
    </group>
  )
}

function OperatorContactLinks({
  accent,
  activity
}: {
  accent: string
  activity: WorkstationActivity
}): React.JSX.Element {
  const active = activity === 'working' || activity === 'awaiting'
  return (
    <group position={[0, 0, 0]}>
      {[-0.18, 0.18].map((x) => (
        <group key={x} position={[x, 0.865, 0.43]} rotation={[-0.22, 0, 0]}>
          <mesh>
            <boxGeometry args={[0.026, 0.014, 0.42]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={active ? 0.24 : 0.1}
              transparent
              opacity={active ? 0.34 : 0.18}
              roughness={0.3}
              metalness={0.16}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0.018, -0.21]}>
            <boxGeometry args={[0.11, 0.012, 0.035]} />
            <meshStandardMaterial color={OFFICE_NEUTRAL_LIGHT} roughness={0.28} metalness={0.34} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function OperatorFocusLinks({
  accent,
  activity
}: {
  accent: string
  activity: WorkstationActivity
}): React.JSX.Element {
  const active = activity === 'working' || activity === 'awaiting'
  const opacity = active ? 0.1 : 0.04
  return (
    <group position={[0, 0, 0]}>
      {[-1, 1].map((dir) => (
        <group key={dir} position={[dir * 0.28, 1.31, 0.02]} rotation={[0, -dir * 0.52, 0]}>
          <mesh>
            <boxGeometry args={[0.018, 0.01, 1.08]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={active ? 0.16 : 0.06}
              transparent
              opacity={opacity}
              roughness={0.26}
              metalness={0.08}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0, -0.52]}>
            <boxGeometry args={[0.11, 0.014, 0.014]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={active ? 0.2 : 0.08}
              transparent
              opacity={active ? 0.18 : 0.08}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function FailureBeacon(): React.JSX.Element {
  const coreRef = useRef<MeshStandardMaterial>(null)
  const railRef = useRef<MeshStandardMaterial>(null)

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    const pulse = 0.65 + Math.sin(t * 5.2) * 0.22
    if (coreRef.current) {
      coreRef.current.emissiveIntensity = 0.24 + pulse * 0.12
      coreRef.current.opacity = 0.42 + Math.sin(t * 4.4) * 0.03
    }
    if (railRef.current) {
      railRef.current.emissiveIntensity = 0.2 + pulse * 0.1
    }
  })

  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.09, -0.78]} castShadow>
        <boxGeometry args={[0.62, 0.018, 0.036]} />
        <meshStandardMaterial
          ref={railRef}
          color={FAULT_COLOR}
          emissive={FAULT_COLOR}
          emissiveIntensity={0.24}
          toneMapped={false}
        />
      </mesh>
      <group position={[0.58, 0.94, -0.36]}>
        <mesh position={[0, -0.09, 0]} castShadow>
          <cylinderGeometry args={[0.035, 0.045, 0.12, 12]} />
          <meshStandardMaterial color="#303845" roughness={0.36} metalness={0.62} />
        </mesh>
        <mesh castShadow>
          <boxGeometry args={[0.14, 0.05, 0.055]} />
          <meshStandardMaterial
            ref={coreRef}
            color={FAULT_COLOR}
            emissive={FAULT_COLOR}
            emissiveIntensity={0.28}
            transparent
            opacity={0.42}
            roughness={0.38}
            metalness={0.5}
            toneMapped={false}
          />
        </mesh>
      </group>
      <mesh position={[0, 0.098, 0.94]} castShadow>
        <boxGeometry args={[0.18, 0.018, 0.034]} />
        <meshStandardMaterial color={FAULT_COLOR} emissive={FAULT_COLOR} emissiveIntensity={0.2} toneMapped={false} />
      </mesh>
    </group>
  )
}

function FaultDiagnosticRig(): React.JSX.Element {
  const scannerRef = useRef<Group>(null)
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const beamRef = useRef<MeshStandardMaterial>(null)

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (scannerRef.current) {
      scannerRef.current.rotation.y = Math.sin(t * 2.2) * 0.28
      scannerRef.current.position.y = 0.42 + Math.sin(t * 3.1) * 0.018
    }
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = 0.34 + Math.sin(t * 4.8) * 0.12
      pulseRef.current.opacity = 0.38 + Math.sin(t * 3.6) * 0.05
    }
    if (beamRef.current) {
      beamRef.current.emissiveIntensity = 0.22 + Math.sin(t * 6.4) * 0.08
      beamRef.current.opacity = 0.1 + Math.sin(t * 5.7) * 0.025
    }
  })

  return (
    <group position={[-0.72, 0, 0.74]} rotation={[0, -0.22, 0]}>
      <RoundedBox args={[0.5, 0.018, 0.4]} radius={0.035} smoothness={3} position={[0, 0.035, 0]} receiveShadow>
        <meshStandardMaterial
          color="#20262e"
          emissive={FAULT_COLOR}
          emissiveIntensity={0.08}
          transparent
          opacity={0.72}
          toneMapped={false}
        />
      </RoundedBox>
      <RoundedBox args={[0.44, 0.18, 0.36]} radius={0.045} smoothness={4} position={[0, 0.13, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#151a22" roughness={0.52} metalness={0.38} />
      </RoundedBox>
      <RoundedBox args={[0.34, 0.055, 0.28]} radius={0.024} smoothness={3} position={[0, 0.245, -0.01]} castShadow>
        <meshStandardMaterial color={OFFICE_NEUTRAL_LIGHT} roughness={0.34} metalness={0.34} />
      </RoundedBox>
      {[-0.17, 0.17].map((x) => (
        <mesh key={`fault-wheel-${x}`} position={[x, 0.065, 0.18]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.055, 0.055, 0.035, 18]} />
          <meshStandardMaterial color="#0b1118" roughness={0.42} metalness={0.44} />
        </mesh>
      ))}
      <mesh position={[0, 0.276, 0.03]}>
        <boxGeometry args={[0.25, 0.018, 0.024]} />
        <meshStandardMaterial ref={pulseRef} color={FAULT_COLOR} emissive={FAULT_COLOR} emissiveIntensity={0.28} transparent opacity={0.38} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.304, -0.12]}>
        <boxGeometry args={[0.3, 0.014, 0.02]} />
        <meshStandardMaterial color={OFFICE_STRUCTURE_TRIM} emissive={OFFICE_STRUCTURE_TRIM} emissiveIntensity={0.24} transparent opacity={0.64} toneMapped={false} />
      </mesh>
      {[-0.18, 0.18].map((x) => (
        <mesh key={`fault-trim-rail-${x}`} position={[x, 0.19, -0.005]} rotation={[0, 0.16 * Math.sign(x), 0]}>
          <boxGeometry args={[0.018, 0.016, 0.25]} />
          <meshStandardMaterial color={OFFICE_STRUCTURE_TRIM} emissive={OFFICE_STRUCTURE_TRIM} emissiveIntensity={0.2} transparent opacity={0.56} toneMapped={false} />
        </mesh>
      ))}
      <group ref={scannerRef} position={[0, 0.42, -0.04]}>
        <mesh position={[0, 0.1, 0]} castShadow>
          <cylinderGeometry args={[0.025, 0.035, 0.2, 16]} />
          <meshStandardMaterial color="#303845" roughness={0.32} metalness={0.72} />
        </mesh>
        <mesh position={[0, 0.22, -0.06]} rotation={[0.42, 0, 0]} castShadow>
          <boxGeometry args={[0.22, 0.035, 0.08]} />
          <meshStandardMaterial color={OFFICE_NEUTRAL_LIGHT} roughness={0.28} metalness={0.44} />
        </mesh>
        <mesh position={[0, 0.22, -0.112]}>
          <boxGeometry args={[0.14, 0.018, 0.012]} />
          <meshStandardMaterial color={FAULT_COLOR} emissive={FAULT_COLOR} emissiveIntensity={0.62} toneMapped={false} />
        </mesh>
      </group>
      {[-0.07, 0.07].map((x) => (
        <mesh key={`fault-beam-${x}`} position={[0.38 + x, 0.54, -0.44]} rotation={[0.54, -0.38, 0.02]}>
          <boxGeometry args={[0.018, 0.012, 0.82]} />
          <meshStandardMaterial
            ref={x < 0 ? beamRef : undefined}
            color={FAULT_COLOR}
            emissive={FAULT_COLOR}
            emissiveIntensity={0.22}
            transparent
            opacity={0.1}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh position={[0.34, 0.07, -0.42]} rotation={[0, -0.38, 0]}>
        <boxGeometry args={[0.08, 0.014, 0.68]} />
        <meshStandardMaterial color={OFFICE_STRUCTURE_TRIM} emissive={OFFICE_STRUCTURE_TRIM} emissiveIntensity={0.12} transparent opacity={0.2} toneMapped={false} />
      </mesh>
      <mesh position={[0.24, 0.2, -0.2]} rotation={[0, 0, 0.7]} castShadow>
        <boxGeometry args={[0.22, 0.025, 0.025]} />
        <meshStandardMaterial color={FAULT_COLOR} emissive={FAULT_COLOR} emissiveIntensity={0.14} toneMapped={false} />
      </mesh>
      <mesh position={[0.24, 0.2, -0.2]} rotation={[0, 0, -0.7]} castShadow>
        <boxGeometry args={[0.22, 0.025, 0.025]} />
        <meshStandardMaterial color={FAULT_COLOR} emissive={FAULT_COLOR} emissiveIntensity={0.14} toneMapped={false} />
      </mesh>
    </group>
  )
}

function DeskStatusPlaque({
  title,
  costUsd,
  accent,
  screenColor,
  activity,
  active,
  progress,
  currentTask,
  taskStats,
  providerLogo
}: {
  title: string
  costUsd: number
  accent: string
  screenColor: string
  activity: WorkstationActivity
  active: boolean
  progress: number
  currentTask?: OfficeTask
  taskStats?: OfficeTaskStats
  providerLogo: ProviderLogoSpec
}): React.JSX.Element {
  const signal = useMemo(() => signalFromText(title), [title])
  const costSignal = Math.max(0, Math.min(4, Math.ceil(Math.log10(Math.max(1, costUsd * 10000 + 1)))))
  const taskSignal =
    currentTask?.status === 'awaiting'
      ? '#7f9aac'
      : currentTask?.status === 'error'
        ? FAULT_COLOR
        : currentTask?.status === 'running'
          ? OFFICE_SIGNAL_ACCENT
          : screenColor
  const toolTicks = Math.min(4, Math.max(1, taskStats?.tools ?? 1))
  const glow = activity === 'idle' ? 0.16 : active ? 0.5 : 0.32

  return (
    <group position={[-0.78, 0.096, 0.98]} rotation={[0, 0.08, 0]}>
      <RoundedBox args={[0.58, 0.035, 0.2]} radius={0.018} smoothness={3} receiveShadow castShadow>
        <meshStandardMaterial color="#121821" metalness={0.32} roughness={0.6} transparent opacity={0.86} />
      </RoundedBox>
      <mesh position={[0, 0.024, -0.074]}>
        <boxGeometry args={[0.46, 0.012, 0.018]} />
        <meshStandardMaterial
          color={screenColor}
          emissive={screenColor}
          emissiveIntensity={glow}
          transparent
          opacity={0.78}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[-(0.44 * (1 - progress)) / 2, 0.034, -0.073]}>
        <boxGeometry args={[0.44 * progress, 0.014, 0.022]} />
        <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={glow + 0.12} toneMapped={false} />
      </mesh>
      <mesh position={[-0.23, 0.032, 0.045]}>
        <cylinderGeometry args={[0.03, 0.03, 0.012, 16]} />
        <meshStandardMaterial color={taskSignal} emissive={taskSignal} emissiveIntensity={0.5} toneMapped={false} />
      </mesh>
      {Array.from({ length: 4 }).map((_, i) => {
        const enabled = i < toolTicks
        return (
          <mesh key={`tool-${i}`} position={[-0.11 + i * 0.055, 0.032, 0.045]}>
            <boxGeometry args={[0.026, 0.011, 0.026]} />
            <meshStandardMaterial
              color={enabled ? accent : '#2b3440'}
              emissive={enabled ? accent : '#000000'}
              emissiveIntensity={enabled ? 0.34 : 0}
              transparent
              opacity={enabled ? 0.82 : 0.58}
              toneMapped={false}
            />
          </mesh>
        )
      })}
      {Array.from({ length: 3 }).map((_, i) => {
        const phase = (signal + i * 7) % 3
        const enabled = i <= costSignal % 3
        return (
          <mesh key={`sig-${i}`} position={[0.16 + i * 0.045, 0.032, 0.044 + (phase - 1) * 0.006]}>
            <boxGeometry args={[0.026, 0.01, 0.018]} />
            <meshStandardMaterial
              color={enabled ? OFFICE_NEUTRAL_LIGHT : '#2b3440'}
              emissive={enabled ? accent : '#000000'}
              emissiveIntensity={enabled ? 0.2 : 0}
              transparent
              opacity={enabled ? 0.78 : 0.52}
              toneMapped={false}
            />
          </mesh>
        )
      })}
      <ProviderLogoBadge
        logo={providerLogo}
        position={[0.13, 0.052, -0.03]}
        rotation={[-Math.PI / 2, 0, 0]}
        width={0.32}
        height={0.072}
        depth={0.012}
      />
    </group>
  )
}

function RoutingBudgetStack({
  signal,
  accent,
  screenColor
}: {
  signal?: OfficeSessionSignal
  accent: string
  screenColor: string
}): React.JSX.Element | null {
  if (!signal) return null
  const failoverActive = hasOfficeFailoverSignal(signal)
  if (
    !signal.routing &&
    !failoverActive &&
    !signal.workspace.isolated &&
    signal.workspace.changedFiles === 0 &&
    signal.budget.costUsd === 0 &&
    !signal.budget.budgetUsd
  ) return null
  const budgetProgress = signal.budget.ratio ?? Math.min(1, Math.log10(signal.budget.costUsd * 1000 + 1) / 4)
  const routingActive = Boolean(signal.routing)
  const workspaceActive = Boolean(signal.workspace.isolated || signal.workspace.changedFiles)
  const budgetColor = signal.budget.overBudget ? FAULT_COLOR : screenColor

  return (
    <group position={[0.76, 0.11, 0.96]} rotation={[0, -0.12, 0]}>
      <RoundedBox args={[0.5, 0.032, 0.22]} radius={0.018} smoothness={3} castShadow receiveShadow>
        <meshStandardMaterial color="#111923" roughness={0.62} metalness={0.26} transparent opacity={0.88} />
      </RoundedBox>
      <mesh position={[-0.16, 0.026, -0.058]}>
        <boxGeometry args={[routingActive ? 0.16 : 0.06, 0.012, 0.018]} />
        <meshStandardMaterial
          color={routingActive ? accent : '#2b3440'}
          emissive={routingActive ? accent : '#000000'}
          emissiveIntensity={routingActive ? 0.5 : 0}
          transparent
          opacity={routingActive ? 0.82 : 0.52}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0.05, 0.026, -0.058]}>
        <boxGeometry args={[failoverActive ? 0.16 : 0.06, 0.012, 0.018]} />
        <meshStandardMaterial
          color={failoverActive ? FAULT_COLOR : '#2b3440'}
          emissive={failoverActive ? FAULT_COLOR : '#000000'}
          emissiveIntensity={failoverActive ? 0.52 : 0}
          transparent
          opacity={failoverActive ? 0.82 : 0.52}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0.2, 0.026, -0.058]}>
        <boxGeometry args={[workspaceActive ? 0.11 : 0.045, 0.012, 0.018]} />
        <meshStandardMaterial
          color={workspaceActive ? OFFICE_NEUTRAL_LIGHT : '#2b3440'}
          emissive={workspaceActive ? accent : '#000000'}
          emissiveIntensity={workspaceActive ? 0.28 : 0}
          transparent
          opacity={workspaceActive ? 0.82 : 0.52}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[-(0.36 * (1 - budgetProgress)) / 2, 0.031, 0.052]}>
        <boxGeometry args={[0.36 * Math.max(0.06, budgetProgress), 0.012, 0.018]} />
        <meshStandardMaterial
          color={budgetColor}
          emissive={budgetColor}
          emissiveIntensity={signal?.budget.budgetUsd ? 0.48 : 0.24}
          transparent
          opacity={0.78}
          toneMapped={false}
        />
      </mesh>
      {signal.routing?.crossValidationEnabled && (
        <mesh position={[0.2, 0.034, 0.052]}>
          <boxGeometry args={[0.046, 0.012, 0.046]} />
          <meshStandardMaterial color={OFFICE_NEUTRAL_LIGHT} emissive={accent} emissiveIntensity={0.34} toneMapped={false} />
        </mesh>
      )}
    </group>
  )
}

/**
 * 完整写实工位:办公桌 + 转椅 + 双显示器 + 桌面小物 + 台灯 + Agent 小人。
 * 屏幕色与小人动作随 activity 驱动:working→打字,idle/completed→值守,
 * awaiting→说话并弹出气泡,error→思考托腮。
 * 低位 3D 状态铭牌表达标题/任务/成本的摘要信号;整组可点击选中。
 *
 * 坐标:自身原点在地面(y=0),桌面 y=0.74,朝 -Z 面向桌子。占地约 2m×2m。
 */
export default function WorkstationPro({
  sessionId,
  position,
  active,
  detail,
  activeDetail,
  activity, awaitingText = '等待处理',
  title,
  costUsd,
  brandName,
  providerBaseUrl,
  modelName,
  showBadge = true,
  liveliness = 1,
  loadCharacterAssets = true,
  watercolorRole,
  operatorAway = false,
  currentTask,
  taskStats,
  sessionSignal,
  interactive = true,
  onSelect,
  onOpen
}: WorkstationProProps): React.JSX.Element {
  const providerLogo = useMemo(
    () => providerLogoFor([brandName, modelName, providerBaseUrl]),
    [brandName, modelName, providerBaseUrl]
  )
  const screenColor = ACTIVITY_COLOR[activity]
  const progressColor = activity === 'error' ? OFFICE_STRUCTURE_TRIM : screenColor
  const stationAccent = OFFICE_STRUCTURE_TRIM
  const showFaultStrip = activity === 'error'
  const totalTasks = taskStats?.total ?? 0
  const progress =
    totalTasks > 0
      ? Math.max(0.08, Math.min(1, ((taskStats?.done ?? 0) + (taskStats?.error ?? 0)) / totalTasks))
      : activity === 'working'
        ? 0.36
        : activity === 'awaiting'
          ? 0.62
          : activity === 'error' || activity === 'completed'
            ? 1
            : 0.08
  const showOperator = !operatorAway
  const characterRole = watercolorRole ?? stableWatercolorRole(sessionId)
  const resolvedDetail = resolveWorkstationDetail(active, activeDetail, detail)
  const phase = useMemo(
    () => (position[0] * 1.7 + position[2] * 0.9) % (Math.PI * 2),
    [position]
  )

  const cursorOver = (e: { stopPropagation: () => void }): void => { e.stopPropagation(); document.body.style.cursor = 'pointer' }
  const cursorOut = (): void => {
    document.body.style.cursor = 'default'
  }
  const clickSelect = (e: { stopPropagation: () => void }): void => { e.stopPropagation(); onSelect() }
  const doubleClickOpen = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onOpen?.()
  }
  const interactionProps = whenInteractive(interactive, { onClick: clickSelect, onDoubleClick: doubleClickOpen, onPointerOver: cursorOver, onPointerOut: cursorOut })

  if (resolvedDetail === 'compact') {
    return (
      <group
        name="office-workstation-compact"
        userData={{ officeWorkstationDetail: 'compact' }}
        position={position}
        {...interactionProps}
      >
        <mesh name="compact-workstation-hit-target" position={[0, 0.9, 0.08]}>
          <boxGeometry args={[2.1, 1.8, 1.72]} />
          <meshBasicMaterial visible={false} />
        </mesh>
        <CompactWorkstationShell
          activity={activity}
          screenColor={screenColor}
          progress={progress}
          showOperator={showOperator}
          showBadge={showBadge}
          providerLogo={providerLogo}
        />

        {showOperator && (
          <WorkstationOperatorRig
            sessionId={sessionId} role={characterRole} activity={activity} liveliness={liveliness}
            providerName={brandName} providerBaseUrl={providerBaseUrl} modelName={modelName}
            loadModel={loadCharacterAssets} detailLevel="low"
            position={[0, 0, 0.52]} rotation={[0, Math.PI, 0]} scale={1.2} phase={phase}
          />
        )}

        {activity === 'awaiting' && !operatorAway && (
          <SpeechBubble position={[0, 1.98, 0.56]} kind="speak" text={awaitingText} />
        )}
      </group>
    )
  }

  return (
    <group
      name="office-workstation-full"
      userData={{ officeWorkstationDetail: 'full' }}
      position={position}
      {...interactionProps}
    >
      {/* 控制台基座:矩形信息区取代玩具感发光圆圈。 */}
      <RoundedBox args={[2.1, 0.045, 1.72]} radius={0.055} smoothness={3} position={[0, 0.024, 0.08]} receiveShadow>
        <meshStandardMaterial
          color={active ? '#20252d' : '#14181f'}
          metalness={0.28}
          roughness={0.78}
        />
      </RoundedBox>
      {[
        { key: 'front', position: [0, 0.074, 0.92] as [number, number, number], size: [2.02, 0.032, 0.11] as [number, number, number] },
        { key: 'back', position: [0, 0.074, -0.78] as [number, number, number], size: [2.02, 0.032, 0.11] as [number, number, number] },
        { key: 'left', position: [-0.98, 0.073, 0.08] as [number, number, number], size: [0.095, 0.026, 1.64] as [number, number, number] },
        { key: 'right', position: [0.98, 0.073, 0.08] as [number, number, number], size: [0.095, 0.026, 1.64] as [number, number, number] }
      ].map((rail) => (
        <mesh key={`work-zone-edge-${rail.key}`} position={rail.position} castShadow>
          <boxGeometry args={rail.size} />
          <meshStandardMaterial
            color={stationAccent}
            emissive={stationAccent}
            emissiveIntensity={active ? 0.32 : 0.14}
            transparent
            opacity={active ? 0.72 : 0.44}
            toneMapped={false}
          />
        </mesh>
      ))}
      {showFaultStrip &&
        [-0.44, 0.44].map((x) => (
          <mesh key={`fault-edge-${x}`} position={[x, 0.092, 0.92]} castShadow>
            <boxGeometry args={[0.24, 0.018, 0.046]} />
            <meshStandardMaterial color={FAULT_COLOR} emissive={FAULT_COLOR} emissiveIntensity={0.2} toneMapped={false} />
          </mesh>
        ))}
      <mesh position={[0, 0.052, 0.92]} castShadow>
        <boxGeometry args={[1.72, 0.018, 0.052]} />
        <meshStandardMaterial color="#252b34" roughness={0.72} metalness={0.18} />
      </mesh>
      <mesh position={[-(1.72 * (1 - progress)) / 2, 0.068, 0.92]} castShadow>
        <boxGeometry args={[1.72 * progress, 0.026, 0.064]} />
        <meshStandardMaterial
          color={progressColor}
          emissive={progressColor}
          emissiveIntensity={activity === 'idle' ? 0.16 : 0.36}
          toneMapped={false}
        />
      </mesh>
      {active && (
        <mesh position={[0, 0.071, -0.78]} castShadow>
          <boxGeometry args={[1.76, 0.022, 0.055]} />
          <meshStandardMaterial
            color={stationAccent}
            emissive={stationAccent}
            emissiveIntensity={0.14}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* 办公桌:桌面 y≈0.74,面向 +Z 的使用者 */}
      <Desk position={[0, 0, -0.32]} />

      {/* 双显示器:置于桌面靠后 */}
      <MonitorSetup
        position={[0, 0.72, -0.54]}
        scale={0.84}
        screenColor={screenColor}
        glow={activity === 'working' ? 1.35 : activity === 'awaiting' ? 1.18 : 1}
      />

      {/* 桌面小物:键盘/鼠标/马克杯/笔记本 */}
      <DeskAccessories position={[0, 0.74, -0.16]} />

      {/* 台灯:桌面右后角,working 时点亮更积极 */}
      <DeskLamp position={[0.52, 0.74, -0.42]} on={activity !== 'idle'} />

      {showBadge && (
        <ProviderLogoBadge
          logo={providerLogo}
          position={[0.36, 0.82, -0.09]}
          rotation={[0, -0.35, 0]}
          width={0.42}
          height={0.12}
          depth={0.018}
        />
      )}

      {showOperator && (
        <>
          {[-0.24, 0.24].map((x) => (
            <mesh key={`operator-position-slat-${x}`} position={[x, 0.061, 0.62]} receiveShadow>
              <boxGeometry args={[0.24, 0.012, 0.038]} />
              <meshStandardMaterial
                color={stationAccent}
                emissive={stationAccent}
                emissiveIntensity={activity === 'idle' ? 0.08 : 0.18}
                transparent
                opacity={activity === 'idle' ? 0.16 : 0.28}
                toneMapped={false}
              />
            </mesh>
          ))}
          <mesh position={[0, 0.078, 0.98]} castShadow>
            <boxGeometry args={[0.46, 0.022, 0.042]} />
            <meshStandardMaterial
              color={stationAccent}
              emissive={stationAccent}
              emissiveIntensity={activity === 'idle' ? 0.12 : 0.22}
              roughness={0.32}
              metalness={0.24}
              toneMapped={false}
            />
          </mesh>

          {/* 转椅与髋部对齐,座面承托桌面状态下的机器人坐姿。 */}
          <OfficeChair position={[0, 0, 0.65]} scale={0.88} />

          <OperatorWorkSurface
            accent={stationAccent}
            screenColor={screenColor}
            activity={activity}
            progress={progress}
          />
          <OperatorInputArray
            accent={stationAccent}
            screenColor={screenColor}
            activity={activity}
          />

          <WorkstationOperatorRig
            sessionId={sessionId} role={characterRole} activity={activity} liveliness={liveliness}
            providerName={brandName} providerBaseUrl={providerBaseUrl} modelName={modelName}
            loadModel={loadCharacterAssets} detailLevel="full"
            position={[0, 0, 0.52]} rotation={[0, Math.PI, 0]} scale={1.2} phase={phase}
          />
          <OperatorContactLinks accent={stationAccent} activity={activity} />
          <OperatorFocusLinks accent={stationAccent} activity={activity} />
        </>
      )}

      {/* 待授权:头顶说话气泡 */}
      {activity === 'awaiting' && !operatorAway && (
        <SpeechBubble position={[0, 1.98, 0.56]} kind="speak" text={awaitingText} />
      )}
      {activity === 'error' && !operatorAway && (
        <>
          <FailureBeacon />
          <FaultDiagnosticRig />
        </>
      )}

      {/* 低位 3D 状态铭牌:保留状态可读性,避开 HTML 覆盖层。 */}
      {!operatorAway && (
        <DeskStatusPlaque
          title={title}
          costUsd={costUsd}
          accent={OFFICE_SIGNAL_ACCENT}
          screenColor={screenColor}
          activity={activity}
          active={active}
          progress={progress}
          currentTask={currentTask}
          taskStats={taskStats}
          providerLogo={providerLogo}
        />
      )}
      {!operatorAway && <RoutingBudgetStack signal={sessionSignal} accent={OFFICE_SIGNAL_ACCENT} screenColor={screenColor} />}
    </group>
  )
}
