import { Vector3, type Camera, type Object3D } from 'three'
import type { LabelRect } from './task-label-layout'

/** Project actual animated head transforms so labels leave faces and their click targets clear. */
export function officeWorkerHeadRegions(scene: Object3D, camera: Camera, size: { width: number; height: number }): Array<LabelRect & { id: string; world: [number, number, number] }> {
  const regions: ReturnType<typeof officeWorkerHeadRegions> = []
  const point = new Vector3()
  scene.traverseVisible((head) => {
    if (head.name !== 'office-worker-head') return
    head.updateWorldMatrix(true, false)
    const world = head.getWorldPosition(point).toArray() as [number, number, number]
    const center = point.clone().project(camera)
    if (Math.abs(center.z) > 1) return
    const corners: Array<{ x: number; y: number }> = []
    for (const x of [-0.23, 0.23]) for (const y of [-0.22, 0.25]) for (const z of [-0.18, 0.18]) {
      point.set(x, y, z).applyMatrix4(head.matrixWorld).project(camera)
      corners.push({ x: (point.x + 1) * size.width / 2, y: (1 - point.y) * size.height / 2 })
    }
    const x = Math.floor(Math.min(...corners.map((item) => item.x)))
    const y = Math.floor(Math.min(...corners.map((item) => item.y)))
    regions.push({ id: String(head.userData.officeCharacterSessionId), world, x, y,
      width: Math.ceil(Math.max(...corners.map((item) => item.x))) - x,
      height: Math.ceil(Math.max(...corners.map((item) => item.y))) - y })
  })
  return regions
}
