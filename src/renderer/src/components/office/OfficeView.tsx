import { memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import { useStore } from '../../store'
import { getBusinessLines, resolveBusinessLineId, resolveSelectedBusinessLine } from '../../../../shared/business-line-types'
import { requestBusinessLineTaskNavigation } from '../business-lines/businessLineTaskNavigation'
import { requestBusinessLineSurfaceNavigation } from '../business-lines/businessLineTaskNavigation'
import { requestTaskPlanNavigation } from '../experience/task-plan-navigation'
import { buildBusinessFacilities } from './businessFacilities'
import { businessInteriorPositions } from './officeGridLayout'
import { officeWalkers } from './officeWalkers'
import { officeFacilitySignals } from './officeFacilitySignals'
import OfficeBusinessSwitcher from './OfficeBusinessSwitcher'
import { useOfficeBusinessNavigation } from './useOfficeBusinessNavigation'
import OfficeOperationalStations from './OfficeOperationalStations'
import OfficeOperationalPanel from './OfficeOperationalPanel'
import { officeSessionSelection, officeSelectionPosition } from './officeSelection'
import { buildOperationalActors, operationalActorMatchesView, visibleOperationalActors, type OfficeOperationalActor } from './operationalActors'
import { requestVideoProductionNavigation } from '../studio/videoProductionNavigation'
import { requestProjectWorkspaceNavigation } from '../studio/projectWorkspaceNavigation'
import { businessLineForOfficeCreation, openBusinessLineCreation } from '../../lib/businessLineCreation'
import { OfficeTaskLabelLayer, OfficeTaskPicker } from './OfficeTaskLabelLayer'
import OfficeTaskLabelProjector from './OfficeTaskLabelProjector'
import { officeTaskLabels, type OfficeTaskLabel } from './task-label-model'
import { useOfficeReducedMotion } from './useOfficeReducedMotion'
import './operational-actors.css'
import { useT } from '../../i18n'
import AgentWalkers from './kit/AgentWalkers'
import type { AgentWalkerSpec } from './kit/AgentWalkers'
import CameraRig from './kit/CameraRig'
import FacilityHotspots from './kit/FacilityHotspots'
import type { OfficeFacilityKey } from './kit/FacilityHotspots'
import { CONTROL_ROOM_LAYOUT } from './kit/controlRoomLayout'
import { PALACE_WORLD_LAYOUT } from './kit/palace/palaceWorldLayout'
import { PALACE_COMMAND_ROOM } from './kit/palace/palaceInteriorLayout'
import CornerTowerHotspots from './kit/palace/CornerTowerHotspots'
import { CORNER_TOWERS, type CornerTowerId } from './kit/palace/cornerTowerCatalog'
import CommandHallHotspots from './kit/palace/CommandHallHotspots'
import { COMMAND_HALL_STATIONS, commandHallStationById, type CommandHallStationId } from './kit/palace/commandHallCatalog'
import BusinessStationHotspots from './kit/palace/BusinessStationHotspots'
import { BUSINESS_STATIONS, type BusinessStationSpec } from './kit/palace/businessStationCatalog'
import SystemRoleHotspots from './kit/palace/SystemRoleHotspots'
import { SYSTEM_ROLES, systemRoleById, type SystemRoleActionId, type SystemRoleId } from './kit/palace/systemRoleCatalog'
import OfficeScene from './kit/MingAcademyScene'
import OfficePerformanceProbe from './kit/OfficePerformanceProbe'
import OfficeWebglLifecycle from './kit/OfficeWebglLifecycle'
import OfficeFrameDriver, { useOfficeRenderQuality } from './kit/OfficeRenderQuality'
import WorkstationPro from './kit/ming-characters/MingWorkstation'
import OfficeBootScene from './OfficeBootScene'
import { summarizeMedia, summarizeProjects } from './operationalSummary'
import { summarizeOfficeBusiness, summarizeOfficeCosts, summarizeOfficeExecutionActivity } from './businessOperationalSummary'
import { useOfficeOperations } from './useOfficeOperations'
import OfficeCommandStrip from './OfficeCommandStrip'
import OfficeCommandPanel from './OfficeCommandPanel'
import OfficeArchivePanel from './OfficeArchivePanel'
import OfficeRoleWorkItems from './OfficeRoleWorkItems'
import { openOfficeWorkItem } from './officeWorkItemNavigation'
import OfficeOperationNotice from './OfficeOperationNotice'
import { vendorKeyFor } from './kit/VendorSkins'
import { buildOfficeModel, officeActivityForSessionId } from './model'
import type { OfficeSessionActivity } from './model'
import OfficeAgentSelectionPanel from './OfficeAgentSelectionPanel'
import { useOfficeBootStages } from './useOfficeBootStages'
import type { OfficeContactShadowMode } from './quality'
import type { GitStatus } from '../../../../shared/types'
import type { WorkflowEvidenceRecord, WorkflowLedgerRendererSelection } from '../../../../shared/types'
import {
  resolveWatercolorRole,
  stableWatercolorRole,
  type WatercolorCharacterRole
} from '../../../../shared/watercolor-character'
import { OFFICE_RENDER_SESSION_LIMIT, projectOfficeSessionIds, shouldProjectOfficeWorker } from './sessionProjection'
import {
  saveOfficeReturnContext,
  type OfficeBusinessView
} from './officeReturnContext'
import { recordOfficeShellMounted } from './officePrewarm'
import { businessSessionIds, sceneForTheme, watercolorRoleForSession } from './officeViewSupport'
import { PALACE_LIGHTING_MANIFEST } from './kit/palace/palaceLighting'

const OFFICE_CAMERA_POSITION = CONTROL_ROOM_LAYOUT.overview.position
const OFFICE_CAMERA_TARGET = CONTROL_ROOM_LAYOUT.overview.target
const OFFICE_CAMERA_FOV = CONTROL_ROOM_LAYOUT.overview.fov
const WALKER_VISUAL_SCALE = 1.18
const DEFAULT_OFFICE_SETTINGS = {
  qualityMode: 'auto' as const, showBadges: true, liveliness: 1, catEars: false,
  spaceTheme: 'control-room' as const, outfitPalette: 'role-default' as const,
  hairStyle: 'role-default' as const, teamLayout: 'grid' as const
}
type CameraPreset = 'overview' | 'agent' | 'facilities' | 'incidents'
const CAMERA_PRESETS: CameraPreset[] = ['overview', 'agent', 'facilities', 'incidents']


const OfficeContactShadows = memo(function OfficeContactShadows({
  position,
  lightMode,
  mode,
  frames,
  resolution
}: {
  position: [number, number, number]
  lightMode: boolean
  mode: OfficeContactShadowMode
  frames: number
  resolution: number
}): React.JSX.Element {
  return (
    <ContactShadows
      position={position}
      opacity={lightMode ? 0.24 : 0.34}
      scale={28}
      blur={1.4}
      far={3.5}
      frames={frames}
      resolution={resolution}
      smooth={mode === 'dynamic'}
    />
  )
})

/** Balanced keeps the static-shadow contract without scheduling a multi-pass
 * ContactShadows render whenever the user changes camera presets. */
const OfficeStaticContactShadow = memo(function OfficeStaticContactShadow({ position }: {
  position: [number, number, number]
}): React.JSX.Element {
  return <mesh position={position} rotation={[-Math.PI / 2, 0, 0]} userData={{ officeStaticContactShadow: true }}>
    <circleGeometry args={[5.5, 48]} />
    <meshBasicMaterial color="#182329" transparent opacity={0.11} depthWrite={false} />
  </mesh>
})

function walkerLocalPoint(point: [number, number, number]): [number, number, number] {
  return [
    point[0] / WALKER_VISUAL_SCALE,
    point[1] / WALKER_VISUAL_SCALE,
    point[2] / WALKER_VISUAL_SCALE
  ]
}

function gitStatusError(id: string, err: unknown): GitStatus {
  return {
    ok: false,
    cwd: '',
    branch: '',
    files: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    error: `office git status failed for ${id}: ${err instanceof Error ? err.message : String(err)}`
  }
}

export default function OfficeView(): React.JSX.Element {
  const t = useT()
  const hydrated = useStore((s) => s.hydrated)
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const providers = useStore((s) => s.providers)
  const office = useStore((s) => s.settings?.office ?? DEFAULT_OFFICE_SETTINGS)
  const reducedMotion = useOfficeReducedMotion()
  const themePref = useStore((s) => s.settings?.theme ?? 'dark')
  const activeId = useStore((s) => s.activeId)
  const selectSession = useStore((s) => s.selectSession)
  const setView = useStore((s) => s.setView)
  const experienceMode = useStore((s) => s.experienceMode)
  const settings = useStore((s) => s.settings)
  const businessLines = useMemo(() => getBusinessLines(settings), [settings.businessLines])
  const [selectedOperationalId, setSelectedOperationalId] = useState<string | null>(null)
  const [operationalNavigationError, setOperationalNavigationError] = useState('')
  const { businessView, setBusinessView, selectedFacility, setSelectedFacility } =
    useOfficeBusinessNavigation(businessLines, resolveSelectedBusinessLine(settings).id)
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>(() => businessView === 'all' ? 'overview' : 'facilities')
  const [cameraRequestId, setCameraRequestId] = useState(0)
  const [palaceCutaway, setPalaceCutaway] = useState(false)
  const [selectedTower, setSelectedTower] = useState<CornerTowerId | null>(null)
  const [selectedCommandStation, setSelectedCommandStation] = useState<CommandHallStationId | null>(null)
  const [selectedBusinessStation, setSelectedBusinessStation] = useState<BusinessStationSpec | null>(null)
  const [selectedSystemRole, setSelectedSystemRole] = useState<SystemRoleId | null>(null)
  // Ephemeral governance projection state; it never creates a canonical task.
  const [councilSummoned, setCouncilSummoned] = useState(false)
  const [authoredRoleFigureCount, setAuthoredRoleFigureCount] = useState(0)
  const [councilReceipt, setCouncilReceipt] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveLedger, setArchiveLedger] = useState<WorkflowLedgerRendererSelection | null>(null)
  const [archiveEvidence, setArchiveEvidence] = useState<WorkflowEvidenceRecord[]>([])
  const [archiveLedgerError, setArchiveLedgerError] = useState('')
  // Keep the HTML command shell paintable before R3F synchronously creates a
  // WebGL context.  Canvas creation can block the renderer for >100ms on a
  // cold Intel GPU; mounting it on the next frame preserves the shell's first
  // useful paint while leaving the scene and all canonical semantics intact.
  const [canvasMounted, setCanvasMounted] = useState(false)
  const officeHitRef = useRef({ seq: 0, kind: '', id: '' })
  const [officeGitStatusBySession, setOfficeGitStatusBySession] = useState<Record<string, GitStatus | undefined>>({})
  const [watercolorRoleByWorkerId, setWatercolorRoleByWorkerId] = useState<Record<string, WatercolorCharacterRole>>({})
  const { mediaSnapshot, projectSnapshot, operationalDataReady, operationStatus, onJobChanged } = useOfficeOperations()
  useEffect(() => {
    if (!archiveOpen) return
    let active = true
    setArchiveLedgerError('')
    void Promise.all([
      window.agentDesk.listWorkflowLedger({ limit: 200 }),
      window.agentDesk.queryWorkflowEvidence({ limit: 200 })
    ]).then(([ledger, evidence]) => {
      if (!active) return
      setArchiveLedger(ledger)
      setArchiveEvidence(evidence.items)
    }).catch((cause: unknown) => {
      if (!active) return
      setArchiveLedgerError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [archiveOpen])
  // Auto quality must be able to trade a small amount of pixel density for
  // stable interaction on integrated GPUs. Explicit user-selected quality
  // keeps the sharp default unless adaptive resolution was requested.
  const resolutionMode = office.resolutionMode ?? (office.qualityMode === 'auto' ? 'adaptive' : 'sharp')
  const renderQuality = useOfficeRenderQuality(office.qualityMode, resolutionMode)
  const qualityDprMaximum = Array.isArray(renderQuality.profile.dpr) ? renderQuality.profile.dpr[1] : renderQuality.profile.dpr
  const { bootCharactersEnabled, sceneDetailEnabled, sceneAssetsEnabled, handleOfficeFrame } =
    useOfficeBootStages(renderQuality.recordFrame)

  useLayoutEffect(() => {
    recordOfficeShellMounted()
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setCanvasMounted(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  // 办公区场景色随主题切换
  const isLight = themePref === 'light' || (themePref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
  const scene = sceneForTheme(office.spaceTheme, isLight)
  const ids = order.filter((id) => sessions[id])
  const businessIds = businessSessionIds(businessView, ids, sessions)
  const operationalActors = useMemo(() => buildOperationalActors({ media: mediaSnapshot, ...projectSnapshot, sessions }), [mediaSnapshot, projectSnapshot, sessions])
  const businessActors = operationalActors.filter((actor) => operationalActorMatchesView(actor, businessView))
  const focusedLineId = cameraPreset === 'agent'
    ? businessActors.find((actor) => actor.id === selectedOperationalId)?.businessLineId
      ?? (activeId && sessions[activeId] ? resolveBusinessLineId(sessions[activeId].meta) : undefined)
    : undefined
  const facilitySpecs = useMemo(() => buildBusinessFacilities(businessLines, selectedFacility ?? focusedLineId), [businessLines, selectedFacility, focusedLineId])
  const visibleLines = new Set(facilitySpecs.map((facility) => facility.businessLineId))
  const activeBusinessIds = businessIds.filter((id) => shouldProjectOfficeWorker(sessions[id]) && visibleLines.has(resolveBusinessLineId(sessions[id].meta)))
  const scopedOperations = summarizeOfficeBusiness({ media: mediaSnapshot, ...projectSnapshot, sessions }, businessView)
  const scopedCosts = summarizeOfficeCosts(businessIds.map((id) => sessions[id].meta), businessActors)
  const visibleActors = visibleOperationalActors(businessActors.filter((actor) => visibleLines.has(actor.businessLineId)), selectedOperationalId, activeBusinessIds.length ? 3 : OFFICE_RENDER_SESSION_LIMIT)
  const selectedActor = businessActors.find((actor) => actor.id === selectedOperationalId)
  const visibleIds = useMemo(
    () => projectOfficeSessionIds(activeBusinessIds, sessions, activeId, OFFICE_RENDER_SESSION_LIMIT - visibleActors.length),
    [activeBusinessIds.join('\0'), activeId, sessions, visibleActors.length]
  )
  const hiddenSessionCount = Math.max(0, businessIds.length - visibleIds.length)
  const visibleIdsKey = visibleIds.join('\0')
  const assignedWorkerIdsKey = visibleIds
    .map((id) => sessions[id]?.meta.digitalWorkerBinding)
    .filter((binding) => binding?.kind === 'assigned')
    .map((binding) => binding.workerId)
    .sort()
    .join('\0')
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined' || !assignedWorkerIdsKey) {
      setWatercolorRoleByWorkerId({})
      return
    }
    let cancelled = false
    void Promise.all([
      window.agentDesk.listDigitalWorkers({ includeRetired: true }),
      window.agentDesk.listDigitalWorkerRoleTemplates()
    ]).then(([workers, roles]) => {
      if (cancelled) return
      const roleById = new Map(roles.map((role) => [role.id, role]))
      const next: Record<string, WatercolorCharacterRole> = {}
      for (const worker of workers) {
        next[worker.id] = resolveWatercolorRole(worker, roleById.get(worker.roleTemplateId)).role
      }
      setWatercolorRoleByWorkerId(next)
    }).catch((error) => {
      if (!cancelled) console.error('[agent-desk] Failed to load watercolor DigitalWorker identities', error)
    })
    return () => { cancelled = true }
  }, [assignedWorkerIdsKey])
  const positions = businessInteriorPositions([
    ...visibleIds.map((id) => resolveBusinessLineId(sessions[id].meta)),
    ...visibleActors.map((actor) => actor.businessLineId)
  ], facilitySpecs)
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      if (visibleIds.length === 0) {
        if (!cancelled) setOfficeGitStatusBySession({})
        return
      }
      const entries = await Promise.all(
        visibleIds.map(async (id) => {
          try {
            return [id, await window.agentDesk.gitStatus(id)] as const
          } catch (err) {
            return [id, gitStatusError(id, err)] as const
          }
        })
      )
      if (cancelled) return
      const next: Record<string, GitStatus | undefined> = {}
      for (const [id, status] of entries) next[id] = status
      setOfficeGitStatusBySession(next)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [visibleIdsKey])
  const officeModel = useMemo(
    () => buildOfficeModel(visibleIds, sessions, officeGitStatusBySession),
    [visibleIds, sessions, officeGitStatusBySession]
  )
  const realtime = officeModel.realtime
  const subagentPacketCount = officeModel.packets.filter((packet) => packet.toolName === 'Subagent').length
  const officeSignalPanelCount = visibleIds.filter((id) => {
    const signal = officeModel.sessions[id]?.signal
    return Boolean(
      signal?.routing ||
      signal?.failover ||
      signal?.keyFailover ||
      signal?.modelFailover ||
      signal?.workspace.gitOk !== undefined ||
      signal?.workspace.isolated ||
      signal?.workspace.changedFiles ||
      signal?.budget.budgetUsd ||
      signal?.budget.costUsd
    )
  }).length
  const activitySummary = useMemo(
    () =>
      businessIds.reduce(
        (acc, id) => {
          acc.total += 1
          acc[officeActivityForSessionId(id, sessions)] += 1
          return acc
        },
        { total: 0, idle: 0, working: 0, awaiting: 0, completed: 0, error: 0 }
      ),
    [businessIds.join('\0'), sessions]
  )
  const executionActivitySummary = useMemo(
    () => summarizeOfficeExecutionActivity(activitySummary, businessActors),
    [activitySummary, businessActors]
  )
  const mediaSummary = useMemo(() => summarizeMedia(mediaSnapshot), [mediaSnapshot])
  const projectSummary = useMemo(
    () => summarizeProjects(projectSnapshot.projects, projectSnapshot.workItems),
    [projectSnapshot]
  )
  const assistantSessionCount = businessIds.filter((id) => resolveBusinessLineId(sessions[id].meta) === 'assistant').length
  const projectSessionCount = businessIds.filter((id) => resolveBusinessLineId(sessions[id].meta) === 'studio').length
  // Facility counters are a cross-courtyard overview; selected-courtyard filtering applies to telemetry and operations below.
  const facilitySignals = useMemo(() => officeFacilitySignals(sessions, operationalActors), [sessions, operationalActors])
  const totalIncidentCount = activitySummary.error + businessActors.filter((actor) => actor.activity === 'error' || actor.status === 'blocked' || actor.status === 'waiting_reconciliation').length
  // Empty state and telemetry must describe the selected courtyard; the 3D scene itself still renders all peer facilities.
  const hasAnyOperations = businessIds.length > 0 || scopedOperations.projects.projects > 0 || scopedOperations.projects.workItems > 0 || scopedOperations.media.productions > 0 || scopedOperations.media.jobs > 0

  const providerNameOf = (providerId: string): string => {
    return providerId ? (providers.find((p) => p.id === providerId)?.name ?? '') : ''
  }
  const providerBaseUrlOf = (providerId: string): string => {
    return providerId ? (providers.find((p) => p.id === providerId)?.baseUrl ?? '') : ''
  }

  // Provider identity is retained for task metadata; the original figures do not use vendor skins.
  const vendorKeyOf = (providerId: string, modelName?: string): string => {
    return vendorKeyFor([providerNameOf(providerId), modelName, providerBaseUrlOf(providerId)].filter(Boolean).join(' '))
  }
  const semanticWalkers = useMemo(() => officeWalkers({ ids: visibleIds, positions, sessions, providers,
    roles: watercolorRoleByWorkerId, facilities: facilitySpecs, reducedMotion }),
  [visibleIds, positions, sessions, providers, watercolorRoleByWorkerId, facilitySpecs, reducedMotion])
  const walkerRenderSpecs = useMemo<AgentWalkerSpec[]>(
    () =>
      semanticWalkers.map((spec) => ({
        ...spec,
        home: walkerLocalPoint(spec.home),
        homeLookAt: walkerLocalPoint(spec.homeLookAt),
        target: walkerLocalPoint(spec.target),
        waypoints: spec.waypoints?.map(walkerLocalPoint),
        targetLookAt: walkerLocalPoint(spec.targetLookAt)
      })),
    [semanticWalkers]
  )
  const [awaySessionIds, setAwaySessionIds] = useState<Set<string>>(() => new Set())
  const handleWalkerAwayChange = useCallback((sessionId: string, away: boolean): void => {
    setAwaySessionIds((current) => {
      if (current.has(sessionId) === away) return current
      const next = new Set(current)
      if (away) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])
  const assistantWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'assistant').length
  const approvalWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'approval').length
  const projectWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'project').length
  const videoWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'video').length
  const facilityWalkerCount = semanticWalkers.filter((spec) => spec.reason !== 'approval').length
  const deskRobotCount = Math.max(0, visibleIds.length - awaySessionIds.size)
  const { activeOfficeId, activeOfficeIndex, activeOfficeSession, activeOfficeActivity, activeOfficeModel, activeOfficeSignal, activeOfficeRole } =
    officeSessionSelection(activeId, visibleIds, Boolean(selectedActor), sessions, officeModel, watercolorRoleByWorkerId, businessIds, officeGitStatusBySession)
  const presentedWalkerSpecs = useMemo(
    () =>
      cameraPreset === 'agent' && activeOfficeId
        ? walkerRenderSpecs.filter((spec) => spec.sessionId !== activeOfficeId)
        : walkerRenderSpecs,
    [activeOfficeId, cameraPreset, walkerRenderSpecs]
  )
  const faultHitTargets = visibleIds
    .map((id, i) => ({
      id,
      activity: officeActivityForSessionId(id, sessions),
      x: positions[i]?.[0] ?? 0,
      y: (positions[i]?.[1] ?? 0) + 0.9,
      z: (positions[i]?.[2] ?? 0) + 0.54
    }))
    .filter((target) => target.activity === 'error')
  const primaryFaultTarget = faultHitTargets[0]
  const incidentCamera = primaryFaultTarget
    ? {
        position: [primaryFaultTarget.x + 2.18, primaryFaultTarget.y + 1.82, primaryFaultTarget.z + 3.36] as [number, number, number],
        target: [primaryFaultTarget.x - 0.12, primaryFaultTarget.y + 0.02, primaryFaultTarget.z + 0.08] as [number, number, number]
      }
    : {
        position: OFFICE_CAMERA_POSITION,
        target: OFFICE_CAMERA_TARGET
      }
  const selectedFacilitySpec = selectedFacility ? facilitySpecs.find((spec) => spec.key === selectedFacility) : undefined
  const activeOfficePosition = officeSelectionPosition(positions, activeOfficeIndex, visibleIds.length, visibleActors.map((actor) => actor.id), selectedActor?.id)
  const cameraPose = useMemo(() => {
    if (cameraPreset === 'facilities') {
      const tower = selectedTower ? CORNER_TOWERS.find((item) => item.id === selectedTower) : undefined
      if (tower) return { position: tower.cameraPosition, target: tower.cameraTarget }
      const role = selectedSystemRole ? systemRoleById(selectedSystemRole) : undefined
      if (role) return { position: role.cameraPosition, target: role.cameraTarget }
      if (selectedFacilitySpec) {
        return {
          position: selectedFacilitySpec.cameraPosition,
          target: selectedFacilitySpec.cameraTarget
        }
      }
      return {
        position: [0, 15, 2] as [number, number, number],
        target: [0, 3.2, -14] as [number, number, number]
      }
    }
    if (cameraPreset === 'agent' && activeOfficePosition) {
      const focusY = activeOfficePosition[1]
      const focusX = activeOfficePosition[0]
      const focusZ = activeOfficePosition[2] + 0.34
      return {
        position: [focusX + 1.58, focusY + 2.34, focusZ + 3.48] as [number, number, number],
        target: [focusX - 0.18, focusY + 0.86, focusZ - 0.06] as [number, number, number]
      }
    }
    if (cameraPreset === 'incidents') return incidentCamera
    return { position: OFFICE_CAMERA_POSITION, target: OFFICE_CAMERA_TARGET }
  }, [activeOfficePosition, cameraPreset, incidentCamera, selectedFacilitySpec, selectedSystemRole, selectedTower])
  const initialCanvasCamera = useRef({ position: cameraPose.position, fov: OFFICE_CAMERA_FOV, near: 0.1, far: PALACE_WORLD_LAYOUT.cameraFar })
  const initialCanvasTarget = useRef(cameraPose.target)
  const cameraMinDistance = 1
  const workstationHitTargets = visibleIds.map((id, i) => ({
    id,
    x: positions[i]?.[0] ?? 0,
    y: (positions[i]?.[1] ?? 0) + 0.78,
    z: (positions[i]?.[2] ?? 0) + 0.08
  }))
  const walkerHitTargets = semanticWalkers.map((spec) => ({
    id: spec.sessionId,
    reason: spec.reason,
    x: spec.target[0],
    y: 1.27,
    z: spec.target[2]
  }))
  const facilityHitTargets = facilitySpecs.map((spec) => ({
    id: spec.key,
    x: spec.hit[0],
    y: spec.hit[1],
    z: spec.hit[2]
  }))
  const officeProjectionConsistent =
    (visibleIds.length > 0 || hasAnyOperations) &&
    deskRobotCount + awaySessionIds.size === visibleIds.length &&
    facilitySpecs.length > 0 && facilitySpecs.length <= 4 &&
    CAMERA_PRESETS.length === 4 &&
    semanticWalkers.length === approvalWalkerCount + facilityWalkerCount &&
    facilityHitTargets.length === facilitySpecs.length &&
    activitySummary.error === faultHitTargets.length

  const selectOfficeSession = (id: string, kind: 'workstation' | 'walker' = 'workstation'): void => {
    setCameraRequestId((value) => value + 1)
    officeHitRef.current = { seq: officeHitRef.current.seq + 1, kind, id }
    setSelectedOperationalId(null)
    setSelectedFacility(null)
    setSelectedTower(null)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(null)
    selectSession(id)
    setCameraPreset('agent')
  }
  const selectCameraPreset = (preset: CameraPreset): void => {
    setCameraRequestId((value) => value + 1)
    if (preset !== 'facilities') { setSelectedFacility(null); setSelectedTower(null); setSelectedCommandStation(null); setSelectedBusinessStation(null); setSelectedSystemRole(null) }
    else setSelectedOperationalId(null)
    if (preset === 'incidents' && primaryFaultTarget) selectSession(primaryFaultTarget.id)
    setCameraPreset(preset)
  }
  const selectFacility = (key: OfficeFacilityKey): void => {
    setCameraRequestId((value) => value + 1)
    officeHitRef.current = { seq: officeHitRef.current.seq + 1, kind: 'facility', id: key }
    setSelectedOperationalId(null)
    setSelectedTower(null)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(null)
    setSelectedFacility(key)
    setCameraPreset('facilities')
  }
  const selectBusinessView = (nextView: OfficeBusinessView): void => {
    setCameraRequestId((value) => value + 1)
    setSelectedOperationalId(null)
    setSelectedTower(null)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(null)
    setBusinessView(nextView)
    if (nextView === 'all') {
      setSelectedFacility(null)
      setCameraPreset('overview')
      return
    }
    setSelectedFacility(nextView)
    setCameraPreset('facilities')
  }
  const selectCommandHall = (): void => {
    setCameraRequestId((value) => value + 1)
    setSelectedOperationalId(null)
    setSelectedFacility(null)
    setSelectedTower(null)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(null)
    setBusinessView('all')
    setCameraPreset('facilities')
  }
  const summonCouncil = (): void => {
    selectCommandHall()
    setCouncilSummoned(true)
    setSelectedCommandStation('command_desk')
    setCouncilReceipt(settings.language === 'zh' ? '已打开职责概览。选择角色查看现有任务；此操作不会发起智能体议事。' : 'Responsibility overview opened. Select a role to inspect existing tasks; this does not start an agent discussion.')
  }
  const dismissCouncil = (): void => {
    setCouncilSummoned(false)
    setCouncilReceipt(settings.language === 'zh' ? '已关闭职责概览。' : 'Responsibility overview closed.')
  }
  const focus = (id: string): void => {
    saveOfficeReturnContext({ businessView, selectedFacility })
    requestBusinessLineTaskNavigation(resolveBusinessLineId(sessions[id]?.meta ?? {}))
    selectSession(id)
    setView('list')
  }
  const returnToWorkspace = (): void => { saveOfficeReturnContext({ businessView, selectedFacility }); setView('list') }
  const selectOperationalActor = (id: string): void => {
    setCameraRequestId((value) => value + 1)
    setSelectedOperationalId(id)
    setSelectedFacility(null)
    setSelectedTower(null)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(null)
    setCameraPreset('agent')
  }
  const selectCornerTower = (id: CornerTowerId): void => {
    setCameraRequestId((value) => value + 1)
    setSelectedOperationalId(null)
    setSelectedFacility(null)
    setSelectedTower(id)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(null)
    setCameraPreset('facilities')
  }
  const selectCommandHallStation = (id: CommandHallStationId): void => {
    if (!commandHallStationById(id)) return
    setCameraRequestId((value) => value + 1)
    setSelectedOperationalId(null)
    setSelectedFacility(null)
    setSelectedTower(null)
    setSelectedCommandStation(id)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(null)
    setBusinessView('all')
    setCameraPreset('facilities')
  }
  /** Focus the existing command desk textarea; the 3D desk remains a projection. */
  const focusOfficeCommandInput = (): void => {
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('[data-office-command-text]')
      input?.focus()
    })
  }
  /** Open the real session surface that owns TaskPlanWorkbench. */
  const openTaskPlanWorkbench = (): void => {
    const targetId = activeId && sessions[activeId] ? activeId : businessIds.find((id) => Boolean(sessions[id]))
    if (targetId) {
      saveOfficeReturnContext({ businessView, selectedFacility })
      requestTaskPlanNavigation(targetId)
      selectSession(targetId)
      setView('list')
      return
    }
    // With no canonical session there is no plan to inspect yet; preserve the
    // command flow by starting a real task in the selected business line.
    void createInCurrentBusinessLine()
  }
  /** Results are session-scoped; never open an unbound result panel. */
  const openBoundResult = (lineId?: string): void => {
    if (lineId?.startsWith('business-line:')) {
      saveOfficeReturnContext({ businessView, selectedFacility })
      void useStore.getState().selectBusinessLine(lineId).then(() => { requestBusinessLineSurfaceNavigation(lineId, 'results'); setView('list') }).catch((cause) =>
        setOperationalNavigationError(cause instanceof Error ? cause.message : String(cause)))
      return
    }
    const targetId = lineId
      ? ids.find((id) => resolveBusinessLineId(sessions[id].meta) === lineId)
      : (activeId && sessions[activeId] ? activeId : ids[0])
    if (targetId) {
      // Bind the result panel without dispatching a business-line creation
      // event; archive access should be a deterministic read-only handoff.
      saveOfficeReturnContext({ businessView, selectedFacility })
      selectSession(targetId)
      setView('list')
      useStore.getState().openPanel('result')
      return
    }
    if (lineId) {
      saveOfficeReturnContext({ businessView, selectedFacility })
      void useStore.getState().selectBusinessLine(lineId).then(() => { requestBusinessLineSurfaceNavigation(lineId, 'results'); setView('list') }).catch((cause) =>
        setOperationalNavigationError(cause instanceof Error ? cause.message : String(cause)))
    } else {
      // Leave the read-only projection even when the fixture/account has no
      // session yet. The canonical workspace can then show its own empty
      // archive state; the office must not remain trapped on an unbound panel.
      setArchiveOpen(true)
      setOperationalNavigationError('已打开全局档案索引：当前没有可绑定的 Session，记录按 Project、WorkItem 与 MediaJob 展示。')
    }
  }
  const openRecoverySurface = (approval = false): void => {
    const permissionSession = approval ? ids.find((id) => sessions[id].pendingPermissions.length > 0) : undefined
    if (permissionSession) selectSession(permissionSession)
    saveOfficeReturnContext({ businessView, selectedFacility })
    setView('list')
    useStore.getState().setShowTaskRecovery(true)
  }
  const selectSystemRole = (id: SystemRoleId): void => {
    const role = systemRoleById(id)
    if (!role) return
    setCameraRequestId((value) => value + 1)
    setSelectedOperationalId(null)
    setSelectedFacility(null)
    setSelectedTower(null)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(null)
    setSelectedSystemRole(id)
    setCameraPreset('facilities')
  }
  const activateSystemRole = (id: SystemRoleId, actionId: SystemRoleActionId): void => {
    const role = systemRoleById(id)
    const action = role?.actions.find((item) => item.id === actionId)
    if (!action) return
    if (action.target === 'new_task') { void createInCurrentBusinessLine(); return }
    if (action.target === 'summon_council') { summonCouncil(); return }
    if (action.target === 'incident_watch') { selectCameraPreset('incidents'); return }
    if (action.target === 'results') {
      openBoundResult()
      return
    }
    if (action.target === 'recovery') {
      openRecoverySurface()
      return
    }
    selectCommandHall()
  }
  const activateCornerTower = (id: CornerTowerId): void => {
    const tower = CORNER_TOWERS.find((item) => item.id === id)
    if (!tower) return
    if (tower.role === 'ingress') {
      void createInCurrentBusinessLine()
      return
    }
    if (tower.role === 'archive') {
      openBoundResult()
      return
    }
    if (tower.role === 'watch') {
      // Keep the patrol tower inside the projection: the incident camera
      // binds the visible fault target and the routing desk in HALL_main
      // remains the canonical configuration surface.
      selectCameraPreset('incidents')
      return
    }
    openRecoverySurface()
  }
  const activateCornerTowerTool = (id: CornerTowerId, tool: 'resume' | 'providers' | 'routing' | 'data'): void => {
    const tower = CORNER_TOWERS.find((item) => item.id === id)
    if (!tower) return
    if (tool === 'resume') { openRecoverySurface(); return }
    if (tool === 'providers' || tool === 'routing') {
      saveOfficeReturnContext({ businessView, selectedFacility })
      setView('list')
      useStore.getState().setShowSettings(true, tool)
      return
    }
    if (tool === 'data') {
      saveOfficeReturnContext({ businessView, selectedFacility })
      setView('list')
      useStore.getState().setShowSettings(true, 'data')
    }
  }
  const activateCommandHallStation = (id: CommandHallStationId): void => {
    const station = commandHallStationById(id)
    if (!station) return
    if (station.action === 'command') { selectCommandHall(); focusOfficeCommandInput(); return }
    if (station.action === 'new_task') { openTaskPlanWorkbench(); return }
    if (station.action === 'results') {
      openBoundResult()
      return
    }
    if (station.action === 'recovery' || station.action === 'approval') {
      openRecoverySurface(station.action === 'approval')
      return
    }
    saveOfficeReturnContext({ businessView, selectedFacility })
    setView('list')
    useStore.getState().setShowSettings(true, 'routing')
  }
  const selectBusinessStation = (station: BusinessStationSpec): void => {
    setCameraRequestId((value) => value + 1)
    setSelectedOperationalId(null)
    setSelectedTower(null)
    setSelectedCommandStation(null)
    setSelectedBusinessStation(station)
    setSelectedSystemRole(null)
    setCameraPreset('facilities')
  }
  const activateBusinessStation = (station: BusinessStationSpec): void => {
    const lineId = selectedFacilitySpec?.businessLineId
    if (!lineId) return
    if (station.action === 'new_task') {
      void openBusinessLineCreation(lineId).catch((cause) => setOperationalNavigationError(cause instanceof Error ? cause.message : String(cause)))
      return
    }
    const matchingSessionId = ids.find((id) => resolveBusinessLineId(sessions[id].meta) === lineId)
    if (station.action === 'results') {
      openBoundResult(lineId)
      return
    }
    if (station.action === 'surface') {
      const actor = operationalActors.find((item) => item.businessLineId === lineId && item.projectId)
      if ((station.role === 'project' || station.role === 'custom') && actor?.projectId) {
        saveOfficeReturnContext({ businessView, selectedFacility })
        if (matchingSessionId) {
          selectSession(matchingSessionId)
          setView('list')
          if (station.id.includes('code_workbench')) useStore.getState().openPanel('files')
          else if (station.id.includes('diff_review')) useStore.getState().openPanel('diff')
        } else {
          useStore.getState().openProjectWorkspace(actor.projectId)
          if (station.id.includes('code_workbench')) requestProjectWorkspaceNavigation(actor.projectId, 'code')
          else if (station.id.includes('diff_review')) requestProjectWorkspaceNavigation(actor.projectId, 'diff')
          setView('list')
        }
        return
      }
      if (station.role === 'video' && actor?.kind === 'media') {
        saveOfficeReturnContext({ businessView, selectedFacility })
        void useStore.getState().selectBusinessLine(lineId).then(() => {
          requestVideoProductionNavigation({ projectId: actor.projectId, productionId: actor.productionId ?? '', businessLineId: lineId })
          setView('list')
        }).catch((cause) => setOperationalNavigationError(cause instanceof Error ? cause.message : String(cause)))
        return
      }
      if (matchingSessionId) { focus(matchingSessionId); return }
    }
    saveOfficeReturnContext({ businessView, selectedFacility })
    void useStore.getState().selectBusinessLine(lineId).then(() => setView('list')).catch((cause) => setOperationalNavigationError(cause instanceof Error ? cause.message : String(cause)))
  }
  const openOperationalActor = async (actor: OfficeOperationalActor): Promise<void> => {
    saveOfficeReturnContext({ businessView, selectedFacility })
    try {
      if (actor.kind === 'media') {
        await useStore.getState().selectBusinessLine(actor.businessLineId)
        requestVideoProductionNavigation({ projectId: actor.projectId, productionId: actor.productionId ?? '', businessLineId: actor.businessLineId })
      } else {
        useStore.getState().openProjectWorkspace(actor.projectId)
        if (actor.workItemId) requestProjectWorkspaceNavigation(actor.projectId, 'work-item', actor.workItemId)
      }
      setView('list')
    } catch (cause) { setOperationalNavigationError(`${cause instanceof Error ? cause.message : String(cause)}；请在业务线管理中检查该业务线，历史归属已保留。`) }
  }
  const createInCurrentBusinessLine = async (): Promise<void> => {
    try { await openBusinessLineCreation(businessLineForOfficeCreation(businessView, settings)) }
    catch (cause) { setOperationalNavigationError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const focusLine = cameraPreset === 'agent'
    ? selectedActor?.businessLineId ?? (activeOfficeSession ? resolveBusinessLineId(activeOfficeSession.meta) : undefined)
    : cameraPreset === 'incidents' && primaryFaultTarget ? resolveBusinessLineId(sessions[primaryFaultTarget.id].meta) : undefined
  const openedRoom = cameraPreset === 'facilities' ? selectedFacilitySpec?.interior?.roomId ?? PALACE_COMMAND_ROOM
    : facilitySpecs.find((spec) => spec.businessLineId === focusLine)?.interior?.roomId
  const visiblePlacements = [...visibleIds.map((id, index) => ({ id, lineId: resolveBusinessLineId(sessions[id].meta), position: positions[index] })),
    ...visibleActors.map((actor, index) => ({ id: actor.id, lineId: actor.businessLineId, position: positions[visibleIds.length + index] }))]
    .map((item) => ({ ...item, roomId: facilitySpecs.find((spec) => spec.businessLineId === item.lineId)?.interior?.roomId }))
  // Overview has no openedRoom: it is the global projection and must keep all
  // visible canonical tasks selectable. Room filtering only applies after a
  // facility/agent camera has established a concrete room focus.
  const placementIsVisible = (item: (typeof visiblePlacements)[number]): boolean => palaceCutaway || !openedRoom || item.roomId === openedRoom
  const interactiveIds = visiblePlacements.filter(placementIsVisible).map((item) => item.id)
  const openedCenter = facilitySpecs.find((spec) => spec.interior?.roomId === openedRoom)?.interior?.center
    ?? PALACE_WORLD_LAYOUT.command
  const interiorShadowPosition: [number, number, number] = [openedCenter[0], openedCenter[1] + 0.002, openedCenter[2]]
  // Balanced uses a static contact-shadow budget. Keep its receiver anchored
  // to the command hall so camera presets do not invalidate and rebuild the
  // shadow target on every focus change; High may follow the opened room.
  const contactShadowPosition: [number, number, number] = renderQuality.profile.contactShadows === 'static' && renderQuality.resolvedTier !== 'high'
    ? [PALACE_WORLD_LAYOUT.command[0], PALACE_WORLD_LAYOUT.command[1] + 0.002, PALACE_WORLD_LAYOUT.command[2]]
    : interiorShadowPosition
  const taskLabelLayer = useRef<HTMLDivElement>(null)
  const taskLabels = officeTaskLabels({ sessionIds: businessIds, sessions, actors: businessActors, selectedSessionId: activeOfficeId,
    selectedActorId: selectedOperationalId, positionedIds: visiblePlacements.filter(placementIsVisible).map((item) => item.id),
    positions: visiblePlacements.filter(placementIsVisible).map((item) => item.position) })
  const selectTaskLabel = (label: OfficeTaskLabel): void => {
    if (label.kind === 'session') selectOfficeSession(label.id, 'workstation')
    else selectOperationalActor(label.id)
  }

  return (
    <div className="office">
      {operationalNavigationError && <p role="alert" data-office-navigation-error>{operationalNavigationError}</p>}
      <OfficeOperationNotice statuses={operationStatus} zh={settings.language === 'zh'} />
      {archiveOpen && <OfficeArchivePanel
        sessions={ids.map((id) => ({
          id,
          title: sessions[id].meta.title,
          status: sessions[id].meta.status,
          businessLineId: resolveBusinessLineId(sessions[id].meta)
        }))}
        workItems={projectSnapshot.workItems}
        projects={projectSnapshot.projects}
        jobs={mediaSnapshot.jobs}
        ledger={archiveLedger}
        evidence={archiveEvidence}
        ledgerError={archiveLedgerError}
        onClose={() => { setArchiveOpen(false); setOperationalNavigationError('') }}
      />}
      <div className="office-topbar drag-region">
        <div className="office-title no-drag">{t('officeTitle')}</div>
        <div className="office-actions no-drag">
          <span className="office-hint">{t('officeHint')}</span>
          <OfficeTaskPicker labels={taskLabels} zh={settings.language === 'zh'} onSelect={selectTaskLabel} />
          <button className="btn btn-ghost" data-office-new-work onClick={() => void createInCurrentBusinessLine()}>
            {t('newShort')}
          </button>
          <button className="btn btn-primary" onClick={returnToWorkspace}>
            {t('officeReturnWorkspace')}
          </button>
        </div>
      </div>

        <div
          className="office-canvas-wrap"
          data-office-business-view={businessView} data-office-data-ready={hydrated && operationalDataReady ? 'true' : 'false'}
          data-office-interior-placements={JSON.stringify(visiblePlacements)}
          data-office-opened-room={openedRoom ?? ''}
          data-office-art-direction="ming-original-palace-v1" data-office-architecture-reference="forbidden-city-reference-palace-v2" data-office-shared-command-hall="true" data-office-courtyard-template="peer-court-v1"
          data-office-art-finish="authored-whitebox-v2" data-office-space-brand="CaoTaiHub"
          data-office-palace-cutaway={palaceCutaway ? '1' : '0'}
          data-office-palace-quality-tier={renderQuality.resolvedTier}
          data-office-palace-lighting-source={PALACE_LIGHTING_MANIFEST.source}
          data-office-palace-lighting-schema={PALACE_LIGHTING_MANIFEST.schema}
          data-office-palace-lighting-fixture-count={PALACE_LIGHTING_MANIFEST.fixtures.length}
          data-office-reduced-motion={reducedMotion ? 'true' : 'false'}
          data-office-ming-characters={visibleIds.length + visibleActors.length}
          data-office-operational-actors={JSON.stringify(visibleActors.map((actor) => ({ id: actor.id, kind: actor.kind, sourceId: actor.sourceId, status: actor.status, businessLineId: actor.businessLineId })))}
          data-office-operational-actor-count={visibleActors.length}
          data-office-business-line-count={businessLines.filter((line) => line.enabled).length}
          data-office-total-execution-actors={visibleIds.length + visibleActors.length}
          data-office-return-mode={experienceMode}
          data-office-sessions={visibleIds.length}
          data-office-session-count={businessIds.length}
          data-office-active-session-count={activeBusinessIds.length}
          data-office-hidden-sessions={hiddenSessionCount}
          data-office-render-session-limit={OFFICE_RENDER_SESSION_LIMIT}
          data-office-assistant-sessions={assistantSessionCount}
          data-office-project-sessions={projectSessionCount}
          data-office-projects={scopedOperations.projects.projects}
          data-office-work-items={scopedOperations.projects.workItems}
          data-office-running-work-items={scopedOperations.projects.running}
          data-office-project-approvals={scopedOperations.projects.approvals}
          data-office-blocked-work-items={scopedOperations.projects.blocked}
          data-office-failed-work-items={scopedOperations.projects.failed}
          data-office-video-productions={scopedOperations.media.productions}
          data-office-media-jobs={scopedOperations.media.jobs}
          data-office-running-media-jobs={scopedOperations.media.running}
          data-office-failed-media-jobs={scopedOperations.media.failed}
          data-office-reconciliation-media-jobs={scopedOperations.media.waitingReconciliation}
          data-office-succeeded-media-jobs={scopedOperations.media.succeeded}
          data-office-media-estimated-cost-usd={scopedOperations.media.estimatedUsd.toFixed(6)}
          data-office-media-actual-cost-usd={scopedOperations.media.actualUsd.toFixed(6)}
          data-office-media-unknown-cost-count={scopedOperations.media.unknownActualCostCount}
          data-office-total-incidents={totalIncidentCount}
          data-office-idle-sessions={activitySummary.idle}
          data-office-running-sessions={activitySummary.working}
          data-office-waiting-approval-sessions={activitySummary.awaiting}
          data-office-completed-sessions={activitySummary.completed}
          data-office-failed-sessions={activitySummary.error}
          data-office-execution-total={executionActivitySummary.total}
          data-office-execution-idle={executionActivitySummary.idle}
          data-office-execution-running={executionActivitySummary.working}
          data-office-execution-awaiting={executionActivitySummary.awaiting}
          data-office-execution-completed={executionActivitySummary.completed}
          data-office-execution-failed={executionActivitySummary.error}
          data-office-packets={officeModel.packets.length}
          data-office-subagent-packets={subagentPacketCount}
          data-office-routed-sessions={realtime.routedSessions}
          data-office-failover-sessions={realtime.failoverSessions}
          data-office-budgeted-sessions={realtime.budgetedSessions}
          data-office-over-budget-sessions={realtime.overBudgetSessions}
          data-office-total-cost-usd={realtime.totalCostUsd.toFixed(6)}
          data-office-total-budget-usd={realtime.totalBudgetUsd.toFixed(6)}
          data-office-total-duration-ms={Math.round(realtime.totalDurationMs)}
          data-office-cross-validation-validators={realtime.crossValidationValidators}
          data-office-routing-budget-panels={officeSignalPanelCount}
          data-office-isolated-sessions={realtime.isolatedSessions}
          data-office-removed-worktrees={realtime.removedWorktrees}
          data-office-workspace-changed-files={realtime.workspaceChangedFiles}
          data-office-workspace-insertions={realtime.workspaceInsertions}
          data-office-workspace-deletions={realtime.workspaceDeletions}
          data-office-git-tracked-sessions={realtime.gitTrackedSessions}
          data-office-git-dirty-sessions={realtime.gitDirtySessions}
          data-office-git-errored-sessions={realtime.gitErroredSessions}
          data-office-git-files={realtime.gitFiles}
          data-office-git-staged={realtime.gitStaged}
          data-office-git-unstaged={realtime.gitUnstaged}
          data-office-git-untracked={realtime.gitUntracked}
          data-office-walkers={semanticWalkers.length}
          data-office-away-sessions={awaySessionIds.size}
          data-office-desk-workers={deskRobotCount} data-office-visible-digital-workers={deskRobotCount + awaySessionIds.size}
          data-office-one-digital-worker-per-agent={visibleIds.length > 0 && deskRobotCount + awaySessionIds.size === visibleIds.length ? 1 : 0}
          data-office-desk-robots={0} data-office-visible-robots={0} data-office-one-robot-per-agent={0}
          data-office-watercolor-characters={0} data-office-one-watercolor-character-per-agent={0}
          data-office-articulated-characters={visibleIds.length} data-office-grounded-character-rigs={visibleIds.length}
          data-office-low-poly-digital-workers={visibleIds.length}
          data-office-role-accented-workers={visibleIds.length} data-office-camera-facing-character-sprites={0}
          data-office-assistant-walkers={assistantWalkerCount}
          data-office-approval-walkers={approvalWalkerCount}
          data-office-project-walkers={projectWalkerCount}
          data-office-video-walkers={videoWalkerCount}
          data-office-visible-session-ids={JSON.stringify(visibleIds)}
          data-office-facility-walkers={facilityWalkerCount}
          data-office-approval-stations={1}
          data-office-assistant-stations={facilitySpecs.filter((spec) => spec.businessLineId === 'assistant').length}
          data-office-project-stations={facilitySpecs.filter((spec) => spec.businessLineId === 'studio').length}
          data-office-video-stations={facilitySpecs.filter((spec) => spec.businessLineId === 'video').length}
          data-office-command-stations={COMMAND_HALL_STATIONS.length}
          data-office-command-hall-station-count={COMMAND_HALL_STATIONS.length}
          data-office-command-hall-station-catalog={JSON.stringify(COMMAND_HALL_STATIONS.map((station) => ({
            id: station.id, anchor: station.anchor, label: station.label, purpose: station.purpose,
            position: station.position, capabilities: station.capabilities, action: station.action
          })))}
          data-office-selected-command-hall-station={selectedCommandStation ?? ''}
          data-office-business-station-count={BUSINESS_STATIONS.length}
          data-office-business-station-catalog={JSON.stringify(BUSINESS_STATIONS.map((station) => ({ id: station.id, role: station.role, anchor: station.anchor, action: station.action })))}
          data-office-selected-business-station={selectedBusinessStation?.id ?? ''}
          data-office-artifact-vaults={1}
          data-office-render-racks={1}
          data-office-corner-towers={4}
          data-office-corner-tower-catalog={JSON.stringify(CORNER_TOWERS.map((tower) => ({
            id: tower.id, anchor: tower.anchor, role: tower.role, label: tower.label, purpose: tower.purpose,
            position: tower.position, capabilities: tower.capabilities
          })))}
          data-office-selected-corner-tower={selectedTower ?? ''}
          data-office-system-role-count={SYSTEM_ROLES.length}
          data-office-system-role-figure-count={councilSummoned ? authoredRoleFigureCount : 0}
          data-office-council-summoned={councilSummoned ? '1' : '0'}
          data-office-system-role-catalog={JSON.stringify(SYSTEM_ROLES.map((role) => ({
            id: role.id, anchor: role.anchor, label: role.label, group: role.group,
            duty: role.duty, canonicalSource: role.canonicalSource, projectionOnly: role.projectionOnly,
            position: role.position, actions: role.actions.map((action) => ({ id: action.id, target: action.target }))
          })))}
          data-office-selected-system-role={selectedSystemRole ?? ''}
          data-office-facility-fixtures={facilitySpecs.length}
          data-office-service-wayfinding={0}
          data-office-amenity-portals={0}
          data-office-facility-signals={facilitySpecs.length}
          data-office-clickable-facilities={facilitySpecs.length}
          data-office-selected-facility={selectedFacility ?? ''}
          data-office-facility-hit-targets={JSON.stringify(facilityHitTargets)}
          data-office-desk-status-plaques={deskRobotCount}
          data-office-work-inputs={deskRobotCount}
          data-office-service-foreground-occluders={0}
          data-office-walker-routes={semanticWalkers.length}
          data-office-cutaway-walls={1}
          data-office-industrial-robots={0} data-office-humanoid-robot-silhouettes={0}
          data-office-humanoid-face-visors={0}
          data-office-humanoid-shell-panels={0}
          data-office-humanoid-back-shells={0}
          data-office-humanoid-neutral-shells={0}
          data-office-reference-robot-silhouettes={0}
          data-office-reference-robot-helmet-visors={0}
          data-office-reference-robot-shell-panels={0}
          data-office-reference-robot-articulated-joints={0}
          data-office-reference-robot-back-shells={0}
          data-office-reference-robot-neutral-shells={0}
          data-office-fault-hit-targets={JSON.stringify(faultHitTargets)}
          data-office-incident-camera={JSON.stringify(incidentCamera)}
          data-office-incident-camera-available={primaryFaultTarget ? 1 : 0}
          data-office-clickable-workstations={visibleIds.length}
          data-office-clickable-walkers={semanticWalkers.length}
          data-office-selected-session={activeOfficeId ?? ''}
          data-office-selected-workstations={activeOfficeIndex >= 0 ? 1 : 0}
          data-office-camera-presets={CAMERA_PRESETS.length}
          data-office-active-camera-preset={cameraPreset}
          data-office-last-hit-seq={officeHitRef.current.seq}
          data-office-last-hit-kind={officeHitRef.current.kind}
          data-office-last-hit-id={officeHitRef.current.id}
          data-office-workstation-hit-targets={JSON.stringify(workstationHitTargets)}
          data-office-walker-hit-targets={JSON.stringify(walkerHitTargets)}
          data-office-subject-framing={1}
          data-office-projection-consistent={officeProjectionConsistent ? 1 : 0}
          data-office-quality-requested={office.qualityMode}
          data-office-resolution-mode={resolutionMode}
          data-office-space-theme={office.spaceTheme}
          data-office-outfit-palette={office.outfitPalette}
          data-office-hair-style={office.hairStyle}
          data-office-team-layout={office.teamLayout}
          data-office-quality-effective={renderQuality.resolvedTier}
          data-office-quality-dpr-maximum={qualityDprMaximum}
          data-office-quality-shadows={renderQuality.profile.shadows ? 1 : 0}
          data-office-quality-contact-shadows={renderQuality.profile.contactShadows}
          data-office-quality-contact-shadow-frames={
            Number.isFinite(renderQuality.profile.contactShadowFrames)
              ? renderQuality.profile.contactShadowFrames
              : -1
          }
          data-office-quality-contact-shadow-resolution={renderQuality.profile.contactShadowResolution}
          data-office-quality-auto-transitions={renderQuality.autoTransitions}
          data-office-render-active={renderQuality.renderActive ? 1 : 0}
          data-office-render-paused={renderQuality.renderActive ? 0 : 1}
          data-office-frame-loop={renderQuality.renderActive ? 'manual' : 'paused'}
          data-office-boot-characters-ready={bootCharactersEnabled ? 1 : 0}
          data-office-scene-detail-ready={sceneDetailEnabled ? 1 : 0}
          data-office-scene-assets-ready={sceneAssetsEnabled ? 1 : 0}
        >
          <OfficeBusinessSwitcher value={businessView} lines={businessLines} onChange={selectBusinessView} />
          <OfficeCommandStrip
            businessView={businessView}
            activity={executionActivitySummary}
            packetCount={officeModel.packets.length}
            realtime={realtime}
            projects={scopedOperations.projects}
            media={scopedOperations.media} cost={scopedCosts}
          />
          <OfficeCommandPanel lines={businessLines} settings={settings} businessView={businessView} facilityLineId={selectedFacilitySpec?.businessLineId}
            agentSelected={cameraPreset === 'agent'} session={activeOfficeSession} actor={selectedActor}
            onOpenSession={focus} onOpenActor={openOperationalActor} />
          <div className="office-camera-strip no-drag" data-office-camera-preset-controls={CAMERA_PRESETS.length}>
            {CAMERA_PRESETS.map((preset) => (
              <button
                key={preset}
                className={`office-camera-button ${cameraPreset === preset ? 'active' : ''}`}
                data-office-camera-preset={preset}
                aria-label={t(`officePreset${preset[0].toUpperCase()}${preset.slice(1)}`)}
                aria-pressed={cameraPreset === preset}
                title={t(`officePreset${preset[0].toUpperCase()}${preset.slice(1)}`)}
                onClick={() => selectCameraPreset(preset)}
              >
                {t(`officePreset${preset[0].toUpperCase()}${preset.slice(1)}`)}
              </button>
            ))}
            <button className="office-camera-button" data-office-command-hall onClick={selectCommandHall}>
              {settings.language === 'zh' ? '议政殿' : 'Council hall'}
            </button>
            <button className="office-camera-button" data-office-role-coordination
              aria-pressed={selectedSystemRole === 'taizi'} onClick={() => selectSystemRole('taizi')}>
              {settings.language === 'zh' ? '协调事项' : 'Coordination'}
            </button>
            <button className={`office-camera-button ${palaceCutaway ? 'active' : ''}`}
              data-office-palace-roof-toggle aria-pressed={palaceCutaway}
              onClick={() => setPalaceCutaway((value) => !value)}>
              {settings.language === 'zh' ? (palaceCutaway ? '恢复屋顶' : '查看剖面') : (palaceCutaway ? 'Show roofs' : 'Cutaway')}
            </button>
          </div>
          {cameraPreset !== 'facilities' && activeOfficeSession && activeOfficeId && activeOfficeActivity && (
            <OfficeAgentSelectionPanel activity={activeOfficeActivity} model={activeOfficeModel} session={activeOfficeSession} signal={activeOfficeSignal}
              onOpenResults={() => { focus(activeOfficeId); useStore.getState().openPanel('result') }}
              role={activeOfficeRole}
              providerName={providerNameOf(activeOfficeSession.meta.providerId) || activeOfficeSignal?.routing?.providerName}
              openButton={<button className="btn btn-primary btn-sm" aria-label={t('officeOpenSession')} title={t('officeOpenSession')} data-office-open-session={activeOfficeId} onClick={() => focus(activeOfficeId)}>{t('officeOpenSession')}</button>} />
          )}
          {cameraPreset === 'facilities' && selectedFacilitySpec && !selectedBusinessStation && (
            <div className="office-facility-panel no-drag" data-office-facility-panel={selectedFacilitySpec.key}>
              <div className="office-selection-kicker">{t('officeSelectedFacility')}</div>
              <div className="office-selection-title">{selectedFacilitySpec.displayName || t(selectedFacilitySpec.labelKey)}</div>
              <div className="office-selection-meta">
                <span>{t(selectedFacilitySpec.statusKey)}</span>
              </div>
            </div>
          )}
          {cameraPreset === 'facilities' && selectedBusinessStation && (() => {
            const actionLabel = settings.language === 'zh'
              ? selectedBusinessStation.action === 'new_task' ? '新建业务任务' : selectedBusinessStation.action === 'results' ? '打开成果档案' : '进入业务工作面'
              : selectedBusinessStation.action === 'new_task' ? 'New business task' : selectedBusinessStation.action === 'results' ? 'Open results' : 'Open business workspace'
            return <div className="office-facility-panel no-drag" data-office-business-station-panel={selectedBusinessStation.id}>
              <div className="office-selection-kicker">{settings.language === 'zh' ? '业务院落工位' : 'Business hall station'}</div>
              <div className="office-selection-title" data-office-business-station-id={selectedBusinessStation.id}>{selectedBusinessStation.label}</div>
              <div className="office-selection-meta"><span>{selectedBusinessStation.purpose}</span><span data-office-business-station-anchor={selectedBusinessStation.anchor}>{selectedBusinessStation.anchor}</span></div>
              <div className="office-signal-list">{selectedBusinessStation.capabilities.map((capability) => <div key={capability}><span>{settings.language === 'zh' ? '能力' : 'Capability'}</span><strong>{capability}</strong></div>)}</div>
              <button className="btn btn-primary btn-sm" type="button" data-office-business-station-action={selectedBusinessStation.action} onClick={() => activateBusinessStation(selectedBusinessStation)}>{actionLabel}</button>
            </div>
          })()}
          {cameraPreset === 'facilities' && selectedTower && (() => {
            const tower = CORNER_TOWERS.find((item) => item.id === selectedTower)
            return tower ? <div className="office-facility-panel no-drag" data-office-corner-tower-panel={tower.id}>
              <div className="office-selection-kicker">{settings.language === 'zh' ? '系统角楼' : 'System tower'}</div>
              <div className="office-selection-title" data-office-corner-tower-role={tower.role}>{tower.label}</div>
              <div className="office-selection-meta"><span>{tower.purpose}</span><span data-office-corner-tower-anchor={tower.anchor}>{tower.position.join(',')}</span></div>
              <div className="office-signal-list">{tower.capabilities.map((capability) => <div key={capability}><span>{settings.language === 'zh' ? '能力' : 'Capability'}</span><strong>{capability}</strong></div>)}</div>
              <button className="btn btn-primary btn-sm" type="button" data-office-corner-tower-action={tower.role} onClick={() => activateCornerTower(tower.id)}>
                {settings.language === 'zh'
                  ? tower.role === 'ingress' ? '新建任务' : tower.role === 'archive' ? '打开成果档案' : tower.role === 'watch' ? '进入异常巡核' : '打开恢复中心'
                  : tower.role === 'ingress' ? 'New task' : tower.role === 'archive' ? 'Open results' : tower.role === 'watch' ? 'Open incident watch' : 'Open recovery'}
              </button>
              {tower.role === 'ingress' && <button className="btn btn-ghost btn-sm" type="button" data-office-tower-tool="resume" onClick={() => activateCornerTowerTool(tower.id, 'resume')}>{settings.language === 'zh' ? '打开任务恢复与来源' : 'Open recovery and source context'}</button>}
              {tower.role === 'watch' && <>
                <button className="btn btn-ghost btn-sm" type="button" data-office-tower-tool="providers" onClick={() => activateCornerTowerTool(tower.id, 'providers')}>{settings.language === 'zh' ? '打开 Provider 设置' : 'Open provider settings'}</button>
                <button className="btn btn-ghost btn-sm" type="button" data-office-tower-tool="routing" onClick={() => activateCornerTowerTool(tower.id, 'routing')}>{settings.language === 'zh' ? '打开路由设置' : 'Open routing settings'}</button>
              </>}
              {tower.role === 'recovery' && <button className="btn btn-ghost btn-sm" type="button" data-office-tower-tool="data" onClick={() => activateCornerTowerTool(tower.id, 'data')}>{settings.language === 'zh' ? '打开备份与数据设置' : 'Open backup/data settings'}</button>}
            </div> : null
          })()}
          {cameraPreset === 'facilities' && selectedCommandStation && (() => {
            const station = commandHallStationById(selectedCommandStation)
            if (!station) return null
            const actionLabel = settings.language === 'zh'
              ? station.action === 'command' ? '回到总控案' : station.action === 'new_task' ? '提交新任务' : station.action === 'approval' ? '打开审批/恢复中心' : station.action === 'results' ? '打开成果档案' : station.action === 'recovery' ? '打开恢复中心' : '进入异常巡核'
              : station.action === 'command' ? 'Focus command desk' : station.action === 'new_task' ? 'Submit new task' : station.action === 'approval' ? 'Open approval/recovery' : station.action === 'results' ? 'Open results' : station.action === 'recovery' ? 'Open recovery' : 'Open incident watch'
            return <div className="office-facility-panel no-drag" data-office-command-station-panel={station.id}>
              <div className="office-selection-kicker">{settings.language === 'zh' ? '中央议政殿工位' : 'Council station'}</div>
              <div className="office-selection-title" data-office-command-station-id={station.id}>{station.label}</div>
              <div className="office-selection-meta"><span>{station.purpose}</span><span data-office-command-station-anchor={station.anchor}>{station.anchor}</span></div>
              <div className="office-signal-list">{station.capabilities.map((capability) => <div key={capability}><span>{settings.language === 'zh' ? '能力' : 'Capability'}</span><strong>{capability}</strong></div>)}</div>
              <button className="btn btn-primary btn-sm" type="button" data-office-command-station-action={station.action} onClick={() => activateCommandHallStation(station.id)}>{actionLabel}</button>
              {station.id === 'command_desk' && <>
                <button className="btn btn-primary btn-sm" type="button" data-office-summon-council onClick={summonCouncil}>{settings.language === 'zh' ? '查看职责' : 'View responsibilities'}</button>
                {councilSummoned && <button className="btn btn-ghost btn-sm" type="button" data-office-dismiss-council onClick={dismissCouncil}>{settings.language === 'zh' ? '关闭概览' : 'Close overview'}</button>}
                {councilReceipt && <p role="status" data-office-council-receipt>{councilReceipt}</p>}
                {councilSummoned && <ul data-office-council-participants>{SYSTEM_ROLES.map((role) => <li key={role.id}><button className="btn btn-ghost btn-sm" data-office-council-participant={role.id} onClick={() => selectSystemRole(role.id)}>{settings.language === 'zh' ? role.label : role.labelEn}</button></li>)}</ul>}
              </>}
            </div>
          })()}
          {cameraPreset === 'facilities' && selectedSystemRole && (() => {
            const role = systemRoleById(selectedSystemRole)
            return role ? <div className="office-facility-panel no-drag" data-office-system-role-panel={role.id}
              data-office-system-role-projection="true">
              <div className="office-selection-kicker">{settings.language === 'zh' ? '议政殿角色' : 'Council role'}</div>
              <div className="office-selection-title" data-office-system-role-id={role.id}>{settings.language === 'zh' ? role.label : role.labelEn}</div>
              <div className="office-selection-meta"><span>{settings.language === 'zh' ? role.duty : role.dutyEn}</span><span data-office-system-role-anchor={role.anchor}>{role.anchor}</span></div>
              <OfficeRoleWorkItems roleId={role.id} workItems={projectSnapshot.workItems} projects={projectSnapshot.projects}
                status={operationStatus.workItems} zh={settings.language === 'zh'} onSelectRole={selectSystemRole} onOpen={(item) => {
                  saveOfficeReturnContext({ businessView, selectedFacility })
                  try { openOfficeWorkItem(item, useStore.getState()) }
                  catch (cause) { setOperationalNavigationError(cause instanceof Error ? cause.message : String(cause)) }
                }} />
              {role.actions.map((action) => <button key={action.id} className="btn btn-primary btn-sm" type="button"
                data-office-system-role-action={action.id} data-office-system-role-target={action.target}
                onClick={() => activateSystemRole(role.id, action.id)}>{settings.language === 'zh' ? action.label : action.labelEn}</button>)}
            </div> : null
          })()}
          {selectedActor && <OfficeOperationalPanel key={selectedActor.id} actor={selectedActor} onOpen={openOperationalActor}
            onClose={() => setSelectedOperationalId(null)} onJobChanged={onJobChanged} />}
          {hydrated && operationalDataReady && !hasAnyOperations && (
            <div className="office-idle-notice no-drag" data-office-empty="true">{t('officeEmpty')}</div>
          )}
          <OfficeTaskLabelLayer ref={taskLabelLayer} labels={sceneDetailEnabled ? taskLabels : []} zh={settings.language === 'zh'} onSelect={selectTaskLabel} />
          {canvasMounted && <Canvas
            className="office-render-surface"
            shadows={renderQuality.profile.shadows}
            camera={initialCanvasCamera.current}
            dpr={renderQuality.profile.dpr}
            // Avoid forcing a discrete GPU wake-up for the first WebGL2
            // context. The cold context path is measured separately from
            // scene loading; the default browser choice preserves rendering
            // quality while avoiding the observed ~1s activation stall.
            gl={{ powerPreference: 'default', antialias: true, alpha: true }}
            frameloop="never"
            resize={{ offsetSize: true }}
            onCreated={({ camera, gl }) => {
              camera.lookAt(...initialCanvasTarget.current)
              camera.updateProjectionMatrix()
              if (renderQuality.profile.shadows) {
                // Static Office lighting needs one shadow-map build; keeping
                // it cached removes a full shadow pass from every manual frame.
                gl.shadowMap.autoUpdate = false
                gl.shadowMap.needsUpdate = true
              }
            }}
          >
          <color attach="background" args={[scene.bg]} />
          <OfficePerformanceProbe />
          <OfficeWebglLifecycle />
          <OfficeTaskLabelProjector labels={sceneDetailEnabled ? taskLabels : []} layer={taskLabelLayer} />
          <OfficeFrameDriver active={renderQuality.renderActive} onFrame={handleOfficeFrame} />
          <fog attach="fog" args={[scene.bg, ...PALACE_WORLD_LAYOUT.fog]} />
          <ambientLight intensity={isLight ? 0.98 : 1.16} />
          <directionalLight
            position={PALACE_LIGHTING_MANIFEST.fixtures[0].location}
            intensity={isLight ? 1.45 : 1.72}
            color={isLight ? '#ffffff' : '#fff7ed'}
            castShadow={renderQuality.profile.shadows}
            shadow-camera-left={-30} shadow-camera-right={30}
            shadow-camera-top={30} shadow-camera-bottom={-30} shadow-camera-far={150}
            // The light and scene are static between explicit camera/scene
            // changes. Keep the authored shadow map after its first render;
            // rebuilding it every manual frame dominates High on Intel GPUs.
            shadow-autoUpdate={false}
            shadow-mapSize={[
              Math.max(256, renderQuality.profile.shadowMapSize),
              Math.max(256, renderQuality.profile.shadowMapSize)
            ]}
          />
          <directionalLight
            position={[-6, 5.5, 7]}
            intensity={isLight ? 0.5 : renderQuality.profile.shadows ? 0.92 : 1.05}
            color={!isLight && !renderQuality.profile.shadows ? '#c9e5ff' : '#d9ecff'}
          />
          <hemisphereLight args={[isLight ? '#f3f5f6' : '#aebfd0', '#303843', isLight ? 0.48 : 0.7]} />
          {/* 补光随当前打开的殿堂移动，与实际工位及地面高度一致。 */}
          <pointLight position={[openedCenter[0], openedCenter[1] + 3.8, openedCenter[2]]}
            intensity={openedRoom ? (isLight ? 0.46 : 1.1) : 0} distance={20} color="#f5e8cb" />

          {/* 共享业务控制室:建筑外壳、中央总控、三类业务设备、审批、资产与算力设施。 */}
          {!sceneDetailEnabled && (
            <OfficeBootScene
              ids={visibleIds}
              positions={positions}
              activeId={activeOfficeId}
              lightMode={isLight}
              showCharacters={bootCharactersEnabled}
                interactive={Boolean(openedRoom) || palaceCutaway}
              onSelect={selectOfficeSession}
              onOpen={focus}
            />
          )}
          {sceneAssetsEnabled && (
            <Suspense fallback={null}>
              <OfficeScene
                cutaway={palaceCutaway} openedRoom={openedRoom}
                qualityTier={renderQuality.resolvedTier}
                lightMode={isLight} facilities={facilitySpecs} counts={facilitySignals.counts}
                onSelectCommand={selectCommandHall}
                labels={settings.language === 'zh' ? { academy: 'CaoTaiHub', command: '议政殿', assistant: '书斋', project: '营造工坊', video: '绘事院' } : { academy: 'CaoTaiHub', command: 'Council hall', assistant: 'Study', project: 'Workshop', video: 'Atelier' }}
                signals={{
                  assistant: assistantSessionCount,
                  project: projectSummary.workItems + projectSessionCount,
                  video: mediaSummary.jobs || mediaSummary.productions,
                  incidents: facilitySignals.incidents
                }}
              />
            </Suspense>
          )}
          {sceneDetailEnabled && (
            <>
              <OfficeOperationalStations actors={visibleActors} positions={positions.slice(visibleIds.length)}
                selectedId={selectedOperationalId} onSelect={selectOperationalActor} onOpen={openOperationalActor} reducedMotion={reducedMotion} interactiveIds={interactiveIds} />
              {visibleIds.map((id, i) => (
                <Suspense key={id} fallback={null}>
                  <WorkstationPro
                    sessionId={id}
                    position={positions[i]}
                    active={id === activeOfficeId}
                    reducedMotion={reducedMotion}
                    activeDetail={renderQuality.resolvedTier === 'low' ? 'compact' : 'full'}
                    activity={officeActivityForSessionId(id, sessions)}
                    title={sessions[id].meta.title}
                    costUsd={sessions[id].meta.costUsd}
                    brandName={
                      sessions[id].meta.providerId
                        ? providerNameOf(sessions[id].meta.providerId)
                        : undefined
                    }
                    providerBaseUrl={providerBaseUrlOf(sessions[id].meta.providerId)}
                    modelName={officeModel.sessions[id]?.signal.routing?.model || sessions[id].effectiveModel || sessions[id].meta.model}
                    vendorKey={vendorKeyOf(sessions[id].meta.providerId, sessions[id].meta.model)}
                    showBadge={office.showBadges}
                    liveliness={office.liveliness}
                    watercolorRole={watercolorRoleForSession(sessions[id], id, watercolorRoleByWorkerId)}
                    watercolorState={officeModel.sessions[id]?.characterState}
                    outfitPalette={office.outfitPalette}
                    hairStyle={office.hairStyle}
                    operatorAway={awaySessionIds.has(id)}
                    currentTask={officeModel.sessions[id]?.currentTask}
                    taskStats={officeModel.sessions[id]?.taskStats}
                    sessionSignal={officeModel.sessions[id]?.signal}
                    interactive={interactiveIds.includes(id)}
                    onSelect={() => selectOfficeSession(id, 'workstation')}
                    onOpen={() => focus(id)}
                  />
                </Suspense>
              ))}
              <Suspense fallback={null}>
                <group scale={WALKER_VISUAL_SCALE}>
                  <AgentWalkers
                    specs={presentedWalkerSpecs}
                    activeSessionId={activeOfficeId}
                    onAwayChange={handleWalkerAwayChange}
                    onSelect={(id) => selectOfficeSession(id, 'walker')}
                    onOpen={focus}
                  />
                </group>
              </Suspense>
              {sceneAssetsEnabled && (
                <FacilityHotspots
                  specs={facilitySpecs}
                  activeKey={selectedFacility}
                  onSelect={selectFacility}
                />
              )}
              {sceneAssetsEnabled && <CornerTowerHotspots selected={selectedTower} onSelect={selectCornerTower} />}
              {sceneAssetsEnabled && openedRoom === PALACE_COMMAND_ROOM && <CommandHallHotspots selected={selectedCommandStation} onSelect={selectCommandHallStation} />}
              {sceneAssetsEnabled && openedRoom !== PALACE_COMMAND_ROOM && selectedFacilitySpec?.interior && <BusinessStationHotspots facility={selectedFacilitySpec} selected={selectedBusinessStation?.id} onSelect={selectBusinessStation} />}
              {sceneAssetsEnabled && <SystemRoleHotspots selected={selectedSystemRole} summoned={councilSummoned} onSelect={selectSystemRole} onFigureCountChange={setAuthoredRoleFigureCount} />}
              {sceneAssetsEnabled && renderQuality.profile.contactShadows === 'static' && renderQuality.resolvedTier !== 'high' && (
                <OfficeStaticContactShadow position={[PALACE_WORLD_LAYOUT.command[0], PALACE_WORLD_LAYOUT.command[1] + 0.004, PALACE_WORLD_LAYOUT.command[2]]} />
              )}
              {sceneAssetsEnabled && openedRoom && renderQuality.profile.contactShadows !== 'off' && (renderQuality.resolvedTier === 'high' || renderQuality.profile.contactShadows === 'dynamic') && (
                <OfficeContactShadows
                  position={contactShadowPosition}
                  lightMode={isLight}
                  mode={renderQuality.profile.contactShadows}
                  frames={renderQuality.profile.contactShadowFrames}
                  resolution={renderQuality.profile.contactShadowResolution}
                />
              )}
            </>
          )}
          <CameraRig
            requestId={cameraRequestId}
            position={cameraPose.position}
            target={cameraPose.target}
            // Low/Balanced prioritize a single settled render after a preset
            // click; High retains the authored eased camera move.
            auto={false} reducedMotion={reducedMotion || renderQuality.resolvedTier !== 'high'}
            minDistance={cameraMinDistance} maxDistance={PALACE_WORLD_LAYOUT.maximumOrbitDistance}
            onSettledChange={(settled) => document.querySelector('.office-canvas-wrap')?.setAttribute('data-office-camera-settled', settled ? '1' : '0')}
          />

          </Canvas>}
        </div>
    </div>
  )
}
