import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, Matrix4, Quaternion, Vector3 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { PALACE_PALETTE as palette } from '../palace/palacePalette'

export const ACADEMY_COLORS = {
  plaster: palette.plaster, ink: palette.ink, tile: palette.warm_tile, tileEdge: palette.tile_edge,
  wood: palette.wood, darkWood: '#4e342a', stone: palette.limestone, paving: palette.paving,
  water: palette.water, waterLight: '#b8d1c1', leaf: palette.foliage, leafLight: '#81996d',
  paper: palette.paper, cinnabar: palette.vermilion, jade: palette.celadon
} as const
export type AcademyColor = keyof typeof ACADEMY_COLORS
export type AcademyPoint = [number, number, number]
export interface AcademyGeometryPart { color: AcademyColor; geometry: BufferGeometry }

/** One merged mesh per palette color keeps the complete courtyard inexpensive. */
export class AcademyGeometry {
  private readonly buckets = new Map<AcademyColor, BufferGeometry[]>()

  add(color: AcademyColor, geometry: BufferGeometry, position: AcademyPoint, rotationY = 0): void {
    const transform = new Matrix4().compose(new Vector3(...position), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rotationY), new Vector3(1, 1, 1))
    geometry.applyMatrix4(transform)
    const normalized = geometry.index ? geometry.toNonIndexed() : geometry
    normalized.deleteAttribute('uv')
    if (normalized !== geometry) geometry.dispose()
    const bucket = this.buckets.get(color) ?? []
    bucket.push(normalized)
    this.buckets.set(color, bucket)
  }

  box(color: AcademyColor, size: AcademyPoint, position: AcademyPoint, rotationY = 0): void {
    this.add(color, new BoxGeometry(...size), position, rotationY)
  }

  cylinder(color: AcademyColor, radius: number, height: number, position: AcademyPoint, topRadius = radius): void {
    this.add(color, new CylinderGeometry(topRadius, radius, height, 8), position)
  }

  beam(color: AcademyColor, from: AcademyPoint, to: AcademyPoint, radius: number): void {
    const start = new Vector3(...from)
    const end = new Vector3(...to)
    const delta = end.clone().sub(start)
    const geometry = new CylinderGeometry(radius, radius, delta.length(), 6)
    geometry.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), delta.normalize()))
    this.add(color, geometry, start.add(end).multiplyScalar(0.5).toArray() as AcademyPoint)
  }

  rock(color: AcademyColor, size: AcademyPoint, position: AcademyPoint): void {
    const geometry = new IcosahedronGeometry(1, 0)
    geometry.scale(...size)
    this.add(color, geometry, position)
  }

  finish(): AcademyGeometryPart[] {
    const parts = [...this.buckets].map(([color, geometries]) => {
      const geometry = mergeGeometries(geometries)
      geometries.forEach((source) => source.dispose())
      if (!geometry) throw new Error(`Cannot merge academy geometry: ${color}`)
      geometry.computeBoundingSphere()
      return { color, geometry }
    })
    this.buckets.clear()
    return parts
  }
}

/** Original swept gable: shallow curved eaves, no imported mesh or texture. */
export function academyRoof(width: number, depth: number, rise: number): BufferGeometry {
  const vertices: number[] = []
  const steps = 12
  const profile = (index: number): [number, number] => {
    const fraction = Math.abs(index / steps * 2 - 1)
    return [rise * Math.pow(1 - fraction, 1.4) + 0.14 * Math.pow(fraction, 6), (index / steps - 0.5) * depth]
  }
  const triangle = (...points: AcademyPoint[]): void => { points.forEach((point) => vertices.push(...point)) }
  for (let index = 0; index < steps; index += 1) {
    const [y1, z1] = profile(index)
    const [y2, z2] = profile(index + 1)
    triangle([-width / 2, y1, z1], [width / 2, y2, z2], [width / 2, y1, z1])
    triangle([-width / 2, y1, z1], [-width / 2, y2, z2], [width / 2, y2, z2])
    for (const side of [-1, 1]) {
      const x = side * width / 2
      triangle([x, y1, z1], [x, y2, z2], [x, -0.07, z2])
      triangle([x, y1, z1], [x, -0.07, z2], [x, -0.07, z1])
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  geometry.computeVertexNormals()
  return geometry
}
