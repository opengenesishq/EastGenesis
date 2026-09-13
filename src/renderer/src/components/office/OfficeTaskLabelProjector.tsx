import { useEffect, useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { officeWorkerHeadRegions } from './officeWorkerProjection'
import { layoutTaskLabels, type LabelRect, type ProjectedTaskLabel } from './task-label-layout'
import { taskLabelPriority, type OfficeTaskLabel } from './task-label-model'

interface Props { labels: OfficeTaskLabel[]; layer: RefObject<HTMLDivElement | null> }
interface LabelMeasurement { element: HTMLButtonElement; width: number; height: number }
const OVERLAYS = '.office-selection-panel, .office-command-strip, .office-camera-strip, .office-business-strip, .office-command-input, .office-facility-panel'

/** One camera observer updates the shared DOM layer; task components never set React state per frame. */
export default function OfficeTaskLabelProjector({ labels, layer }: Props): null {
  const { camera, size, gl, scene } = useThree()
  const cache = useRef({ signature: undefined as string | undefined, frameKey: '', measurements: new Map<string, LabelMeasurement>(), revision: 0 })
  const point = useRef(new Vector3())
  const signature = labels.map((label) => `${label.id}:${label.title}:${label.status}:${label.selected}:${label.position?.join(',')}`).join('|')
  useEffect(() => { cache.current.signature = undefined }, [signature, size.width, size.height])
  useEffect(() => {
    let active = true
    void document.fonts.ready.then(() => { if (active) cache.current.signature = undefined })
    return () => { active = false }
  }, [])
  useFrame(() => {
    const root = layer.current
    if (!root) return
    camera.updateMatrixWorld()
    const canvasRect = gl.domElement.getBoundingClientRect()
    const heads = officeWorkerHeadRegions(scene, camera, size)
    const obstacles = [...overlayRectangles(root.parentElement, canvasRect), ...heads.map(({ x, y, width, height }) => ({ x, y, width, height }))]
    const frameKey = `${camera.matrixWorld.elements.join(',')}|${camera.projectionMatrix.elements.join(',')}|${JSON.stringify(obstacles)}|${size.width}:${size.height}`
    if (cache.current.signature === signature && cache.current.frameKey === frameKey) return
    if (cache.current.signature !== signature) cache.current.measurements = measureLabels(root, size.width)
    const projected: ProjectedTaskLabel[] = []
    for (const label of labels) {
      const measured = cache.current.measurements.get(label.id)
      if (!measured || !label.position) continue
      point.current.set(label.position[0], label.position[1] + 2.08, label.position[2] - 0.48).project(camera)
      if (Math.abs(point.current.x) > 1 || Math.abs(point.current.y) > 1 || Math.abs(point.current.z) > 1) continue
      projected.push({ id: label.id, x: (point.current.x + 1) * size.width / 2, y: (1 - point.current.y) * size.height / 2, width: measured.width, height: measured.height, priority: taskLabelPriority(label) })
    }
    applyLayout(root, cache.current.measurements, layoutTaskLabels(projected, size, obstacles))
    cache.current.frameKey = frameKey; cache.current.signature = signature
    root.dataset.headRegions = JSON.stringify(heads)
    root.dataset.layoutRevision = String(++cache.current.revision)
  })
  return null
}

function measureLabels(root: HTMLDivElement, width: number): Map<string, LabelMeasurement> {
  const measurements = new Map<string, LabelMeasurement>()
  for (const element of root.querySelectorAll<HTMLButtonElement>('[data-office-task-label]')) {
    element.style.maxWidth = `${Math.max(48, Math.min(200, width - 16))}px`
    const rect = element.getBoundingClientRect()
    measurements.set(element.dataset.officeTaskLabel!, { element, width: rect.width, height: rect.height })
  }
  return measurements
}

function overlayRectangles(host: HTMLElement | null, canvas: DOMRect): LabelRect[] {
  if (!host) return []
  return [...host.querySelectorAll<HTMLElement>(OVERLAYS)].map((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x - canvas.x, y: rect.y - canvas.y, width: rect.width, height: rect.height }
  }).filter((rect) => rect.width > 0 && rect.height > 0)
}

function applyLayout(root: HTMLDivElement, measured: Map<string, LabelMeasurement>, placements: ReturnType<typeof layoutTaskLabels>): void {
  const byId = new Map(placements.map((placement) => [placement.id, placement]))
  let visible = 0
  for (const [id, { element }] of measured) {
    const placement = byId.get(id)
    const shown = Boolean(placement?.visible)
    element.style.visibility = shown ? 'visible' : 'hidden'
    element.tabIndex = shown ? 0 : -1
    element.setAttribute('aria-hidden', shown ? 'false' : 'true')
    if (shown && placement) { element.style.transform = `translate3d(${placement.x}px, ${placement.y}px, 0)`; visible++ }
  }
  root.dataset.visibleLabels = String(visible)
  root.dataset.hiddenLabels = String(measured.size - visible)
}
