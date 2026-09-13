import { useEffect } from 'react'
import { officeWorkerHeadRegions } from '../officeWorkerProjection'
import { academyResourceCacheSnapshot } from './ming/academyResourceCache'
import { palaceResourceSnapshot } from './palace/palaceResourceStats'
import { useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { Camera, Object3D, Scene, WebGLRenderer } from 'three'
import { readOfficeRenderDuration } from './officeRenderInstrumentation'

export const OFFICE_PERFORMANCE_SESSION_KEY = 'caogen.office.performance'

export interface OfficeRenderFrameMetrics {
  frame: number
  calls: number
  triangles: number
  lines: number
  points: number
  /** CPU time spent in the R3F `advance` call for this rendered frame. */
  renderDurationMs: number
}

export interface OfficeRobotLodRoot {
  rootId: string
  sessionId: string
  lod: 'full' | 'low'
  assetLod: string
  modelUrl: string
}

export interface OfficeWorkerMetrics {
  characters: number
  roles: string[]
  states: string[]
}

export interface OfficePerformanceSnapshot {
  resources: ReturnType<typeof academyResourceCacheSnapshot>
  render: OfficeRenderFrameMetrics
  memory: {
    geometries: number
    textures: number
    programs: number
  }
  scene: {
    objects: number
    meshes: number
    lights: number
  }
  workers: OfficeWorkerMetrics
  lod: {
    fullRobots: number
    lowRobots: number
    fullRobotRootIds: string[]
    lowRobotRootIds: string[]
    fullWorkstations: number
    compactWorkstations: number
    fullWorkstationRootIds: string[]
    compactWorkstationRootIds: string[]
    robots: OfficeRobotLodRoot[]
  }
  canvas: {
    width: number
    height: number
    pixelRatio: number
  }
  webgl: {
    renderer: string
    vendor: string
  }
  quality: {
    requested: string
    effective: string
    dprMaximum: number
    shadows: boolean
    contactShadows: string
    contactShadowFrames: number
    contactShadowResolution: number
    autoTransitions: number
    renderActive: boolean
    frameLoop: string
  }
}

export interface OfficePerformanceDiagnostics {
  readWorkerHeads(): ReturnType<typeof officeWorkerHeadRegions>
  readCamera(): { position: number[]; quaternion: number[] }
  readFrame(): OfficeRenderFrameMetrics
  readWorkers(): OfficeWorkerMetrics
  readWorkerMotion(): Array<{ id: string; uuid: string; reduced: boolean; pose: number[][] }>
  readWebglIdentity(): OfficePerformanceSnapshot['webgl']
  readWebglContextState(): 'active' | 'lost'
  snapshot(): OfficePerformanceSnapshot
  projectWorldPoint(point: [number, number, number]): {
    x: number
    y: number
    ndcX: number
    ndcY: number
    visible: boolean
  }
}

type OfficePerformanceWindow = Window & {
  __caogenOfficePerformance?: OfficePerformanceDiagnostics
}

type SceneObject = Object3D & {
  isLight?: boolean
  isMesh?: boolean
}

interface RendererInfoLike {
  frame: number
  calls: number
  triangles: number
  lines: number
  points: number
}

function renderMetrics(render: RendererInfoLike, renderDurationMs = 0): OfficeRenderFrameMetrics {
  return {
    frame: render.frame,
    calls: render.calls,
    triangles: render.triangles,
    lines: render.lines,
    points: render.points,
    renderDurationMs
  }
}

function numberAttribute(element: Element | null, name: string): number {
  const value = Number(element?.getAttribute(name) ?? 0)
  return Number.isFinite(value) ? value : 0
}

function officeResourceSnapshot(): ReturnType<typeof academyResourceCacheSnapshot> {
  const stations = academyResourceCacheSnapshot()
  const palace = palaceResourceSnapshot()
  return { entries: stations.entries + palace.entries, bytes: stations.bytes + palace.bytes,
    retained: stations.retained + palace.retained }
}

function readVisibleWorkers(scene: Object3D): OfficeWorkerMetrics {
  const roles = new Set<string>()
  const states = new Set<string>()
  let characters = 0
  scene.traverseVisible((object) => {
    if (object.userData.officeDigitalWorkerCharacter !== true) return
    characters += 1
    roles.add(String(object.userData.officeDigitalWorkerRole ?? ''))
    states.add(String(object.userData.officeDigitalWorkerState ?? ''))
  })
  return {
    characters,
    roles: [...roles].filter(Boolean).sort(),
    states: [...states].filter(Boolean).sort()
  }
}

function readWebglIdentity(gl: WebGLRenderer): OfficePerformanceSnapshot['webgl'] {
  try {
    const context = gl.getContext()
    if (context.isContextLost()) return { renderer: 'unknown', vendor: 'unknown' }
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
    return {
      renderer: String(context.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER) ?? 'unknown'),
      vendor: String(context.getParameter(debugInfo?.UNMASKED_VENDOR_WEBGL ?? context.VENDOR) ?? 'unknown')
    }
  } catch {
    return { renderer: 'unknown', vendor: 'unknown' }
  }
}

function readWorkerMotion(scene: Object3D): ReturnType<OfficePerformanceDiagnostics['readWorkerMotion']> {
  const workers: ReturnType<OfficePerformanceDiagnostics['readWorkerMotion']> = []
  scene.traverseVisible((object) => {
    if (object.userData.officeDigitalWorkerCharacter !== true) return
    const pose: number[][] = []
    object.traverse((part) => { if (part.type === 'Group') pose.push([...part.position.toArray(), part.rotation.x, part.rotation.y, part.rotation.z]) })
    workers.push({ id: String(object.userData.officeCharacterSessionId), uuid: object.uuid, reduced: object.userData.officeReducedMotion === true, pose })
  })
  return workers.sort((a, b) => a.id.localeCompare(b.id))
}

function readOfficePerformanceSnapshot(
  gl: WebGLRenderer,
  scene: Scene,
  webglIdentity: () => OfficePerformanceSnapshot['webgl']
): OfficePerformanceSnapshot {
  let objects = 0
  let meshes = 0
  let lights = 0
  const fullRobotRootIds = new Set<string>()
  const lowRobotRootIds = new Set<string>()
  const fullWorkstationRootIds = new Set<string>()
  const compactWorkstationRootIds = new Set<string>()
  const robots: OfficeRobotLodRoot[] = []
  const workers = readVisibleWorkers(scene)
  scene.traverse((object) => {
    const item = object as SceneObject
    objects += 1
    if (item.isMesh) meshes += 1
    if (item.isLight) lights += 1
  })
  scene.traverseVisible((object) => {
    const item = object as SceneObject
    const robotLod = item.userData.officeRobotLod
    if (robotLod === 'full' || robotLod === 'low') {
      if (robotLod === 'full') fullRobotRootIds.add(item.uuid)
      else lowRobotRootIds.add(item.uuid)
      robots.push({
        rootId: item.uuid,
        sessionId: String(item.userData.officeRobotSessionId ?? ''),
        lod: robotLod,
        assetLod: String(item.userData.officeRobotAssetLod ?? ''),
        modelUrl: String(item.userData.officeRobotModelUrl ?? '')
      })
    }
    if (item.userData.officeWorkstationDetail === 'full') fullWorkstationRootIds.add(item.uuid)
    if (item.userData.officeWorkstationDetail === 'compact') compactWorkstationRootIds.add(item.uuid)
  })

  const office = document.querySelector('.office-canvas-wrap')
  return {
    resources: officeResourceSnapshot(),
    render: renderMetrics(gl.info.render),
    memory: {
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      programs: gl.info.programs?.length ?? 0
    },
    scene: { objects, meshes, lights },
    workers,
    lod: {
      fullRobots: fullRobotRootIds.size,
      lowRobots: lowRobotRootIds.size,
      fullRobotRootIds: [...fullRobotRootIds].sort(),
      lowRobotRootIds: [...lowRobotRootIds].sort(),
      fullWorkstations: fullWorkstationRootIds.size,
      compactWorkstations: compactWorkstationRootIds.size,
      fullWorkstationRootIds: [...fullWorkstationRootIds].sort(),
      compactWorkstationRootIds: [...compactWorkstationRootIds].sort(),
      robots: robots.sort(
        (left, right) => left.sessionId.localeCompare(right.sessionId) || left.rootId.localeCompare(right.rootId)
      )
    },
    canvas: {
      width: gl.domElement.width,
      height: gl.domElement.height,
      pixelRatio: gl.getPixelRatio()
    },
    webgl: webglIdentity(),
    quality: {
      requested: office?.getAttribute('data-office-quality-requested') ?? '',
      effective: office?.getAttribute('data-office-quality-effective') ?? '',
      dprMaximum: numberAttribute(office, 'data-office-quality-dpr-maximum'),
      shadows: numberAttribute(office, 'data-office-quality-shadows') === 1,
      contactShadows: office?.getAttribute('data-office-quality-contact-shadows') ?? '',
      contactShadowFrames: numberAttribute(office, 'data-office-quality-contact-shadow-frames'),
      contactShadowResolution: numberAttribute(office, 'data-office-quality-contact-shadow-resolution'),
      autoTransitions: numberAttribute(office, 'data-office-quality-auto-transitions'),
      renderActive: numberAttribute(office, 'data-office-render-active') === 1,
      frameLoop: office?.getAttribute('data-office-frame-loop') ?? ''
    }
  }
}

function createOfficePerformanceDiagnostics(
  camera: Camera,
  gl: WebGLRenderer,
  scene: Scene
): OfficePerformanceDiagnostics {
  let cachedWebglIdentity: OfficePerformanceSnapshot['webgl'] | undefined
  const webglIdentity = (): OfficePerformanceSnapshot['webgl'] => {
    cachedWebglIdentity ??= readWebglIdentity(gl)
    return cachedWebglIdentity
  }
  return {
    readWorkerHeads: () => officeWorkerHeadRegions(scene, camera, { width: gl.domElement.clientWidth, height: gl.domElement.clientHeight }),
    readCamera: () => ({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }),
    readFrame: () => renderMetrics(gl.info.render, readOfficeRenderDuration(gl)),
    readWorkers: () => readVisibleWorkers(scene),
    readWorkerMotion: () => readWorkerMotion(scene),
    readWebglIdentity: webglIdentity,
    readWebglContextState: () => {
      try { return gl.getContext().isContextLost() ? 'lost' : 'active' }
      catch { return 'lost' }
    },
    projectWorldPoint: (point) => {
      const projected = new Vector3(...point).project(camera)
      const rect = gl.domElement.getBoundingClientRect()
      return {
        x: rect.left + ((projected.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - projected.y) / 2) * rect.height,
        ndcX: projected.x,
        ndcY: projected.y,
        visible: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1
      }
    },
    snapshot: () => readOfficePerformanceSnapshot(gl, scene, webglIdentity)
  }
}

export default function OfficePerformanceProbe(): null {
  const { camera, gl, scene } = useThree()

  useEffect(() => {
    if (window.sessionStorage.getItem(OFFICE_PERFORMANCE_SESSION_KEY) !== '1') return

    const target = window as OfficePerformanceWindow
    const diagnostics = createOfficePerformanceDiagnostics(camera, gl, scene)

    target.__caogenOfficePerformance = diagnostics
    return () => {
      if (target.__caogenOfficePerformance === diagnostics) {
        delete target.__caogenOfficePerformance
      }
    }
  }, [camera, gl, scene])

  return null
}
