import { AcademyGeometry, academyRoof, type AcademyGeometryPart, type AcademyPoint } from './academyGeometry'
import { ACADEMY_COURTYARD_SLOTS } from './academyLayout'

export function createAcademyArchitecture({ includePeerHalls = true }: { includePeerHalls?: boolean } = {}): AcademyGeometryPart[] {
  const geometry = new AcademyGeometry()
  courtyardGround(geometry)
  perimeter(geometry)
  hall(geometry, [0, 0, -8.05], 10.2, 2.1, 0)
  for (const [x, , z] of includePeerHalls ? ACADEMY_COURTYARD_SLOTS : []) {
    // A roof behind the task-facing apron preserves the selected subject's view.
    hall(geometry, [x, 0, z - 1.5], 3.6, 1.45, 0, 3.2, z > 0)
    geometry.box('stone', [3.9, 0.075, 3.45], [x, 0.02, z - 0.35])
    geometry.box('paving', [3.65, 0.025, 3.2], [x, 0.07, z - 0.35])
  }
  waterGarden(geometry)
  for (const sign of [-1, 1]) {
    bamboo(geometry, sign * 8.95, 3.6)
    lantern(geometry, sign * 8.7, 4.95)
    scholarPine(geometry, sign * 8.9, -8.65)
  }
  return geometry.finish()
}

function courtyardGround(g: AcademyGeometry): void {
  g.box('stone', [19.4, 0.3, 15.4], [0, -0.18, -1.8])
  g.box('paving', [18.5, 0.035, 14.5], [0, -0.012, -1.8])
  g.box('plaster', [10.0, 0.025, 10.2], [0, 0.013, -1.3])
  for (let index = -4; index <= 4; index += 1) {
    g.box('stone', [0.018, 0.012, 10.2], [index * 1.2, 0.032, -1.3])
    g.box('stone', [10.0, 0.012, 0.018], [0, 0.032, index * 1.2 - 1.3])
  }
  for (const sign of [-1, 1]) {
    g.box('stone', [0.75, 0.07, 12.6], [sign * 8.55, 0.025, -2.6])
    g.box('paving', [0.65, 0.025, 12.4], [sign * 8.55, 0.072, -2.6])
  }
  g.box('stone', [11.2, 0.16, 3.7], [0, 0.055, -7.7])
  g.box('paving', [10.8, 0.03, 3.55], [0, 0.15, -7.7])
}

function perimeter(g: AcademyGeometry): void {
  g.box('plaster', [19.1, 2.6, 0.24], [0, 1.3, -9.3])
  g.box('ink', [19.25, 0.1, 0.4], [0, 2.63, -9.3])
  for (const sign of [-1, 1]) {
    g.box('plaster', [0.24, 2.45, 9], [sign * 9.4, 1.22, -4.65])
    g.box('tile', [0.42, 0.14, 9.15], [sign * 9.4, 2.48, -4.65])
    // Foreground walls are low cutaways: silhouettes never hide task targets.
    g.box('plaster', [0.3, 0.52, 5.4], [sign * 9.4, 0.26, 2.7])
    g.box('tile', [0.44, 0.09, 5.5], [sign * 9.4, 0.57, 2.7])
    for (const z of [-7.2, -3.2]) lattice(g, [sign * 9.23, 1.6, z], Math.PI / 2)
  }
}

function hall(g: AcademyGeometry, origin: AcademyPoint, width: number, depth: number, angle: number, height = 3.2, cutaway = false): void {
  const local = (x: number, y: number, z: number): AcademyPoint => [origin[0] + x * Math.cos(angle) + z * Math.sin(angle), y * height / 3.2, origin[2] - x * Math.sin(angle) + z * Math.cos(angle)]
  if (!cutaway) {
    g.add('tile', academyRoof(width + 0.8, depth + 0.55, 0.95 * height / 3.2), local(0, 3.2, 0), angle)
    g.box('darkWood', [width, 0.2, depth], local(0, 3.07, 0), angle)
    g.box('tileEdge', [width + 0.94, 0.14, 0.15], local(0, 4.18, 0), angle)
  }
  for (const sign of [-1, 1]) {
    g.box('darkWood', [width, 0.1, 0.12], local(0, 3.02, sign * depth * 0.35), angle)
    if (!cutaway) {
      g.box('ink', [width + 0.84, 0.1, 0.12], local(0, 3.32, sign * (depth + 0.55) / 2), angle)
      g.beam('tileEdge', local(sign * (width / 2 - 0.3), 4.19, 0), local(sign * (width / 2 + 0.55), 4.42, 0), 0.095)
    }
  }
  const bays = Math.round(width / 2.4)
  for (let index = 0; index <= bays; index += 1) {
    const x = -width / 2 + index * width / bays
    for (const sign of [-1, 1]) {
      g.cylinder('wood', 0.085, 2.88 * height / 3.2, local(x, 1.67, sign * depth * 0.35))
      g.cylinder('stone', 0.145, 0.22, local(x, 0.23, sign * depth * 0.35), 0.125)
      g.box('wood', [0.5, 0.11, 0.34], local(x, 2.92, sign * depth * 0.35), angle)
    }
  }
  // The slatted eave is batched with the same material, not hundreds of meshes.
  if (cutaway) return
  const ribs = Math.ceil(width / 0.35)
  for (let index = 0; index <= ribs; index += 1) {
    const x = -width / 2 + index * width / ribs
    for (const sign of [-1, 1]) g.beam('tileEdge', local(x, 3.35, sign * depth / 2), local(x, 3.89, sign * 0.33), 0.018)
  }
}

function lattice(g: AcademyGeometry, center: AcademyPoint, angle: number): void {
  g.box('darkWood', [1.15, 1.25, 0.04], center, angle)
  const point = (x: number, y: number): AcademyPoint => [center[0] + x * Math.cos(angle), center[1] + y, center[2] - x * Math.sin(angle)]
  g.box('paper', [1.02, 1.12, 0.055], center, angle)
  for (const offset of [-0.36, 0, 0.36]) {
    g.box('wood', [0.035, 1.12, 0.09], point(offset, 0), angle)
    g.box('wood', [1.02, 0.035, 0.09], point(0, offset), angle)
  }
}

function waterGarden(g: AcademyGeometry): void {
  for (const sign of [-1, 1]) {
    const x = sign * 8.65
    g.box('ink', [0.85, 0.12, 3.5], [x, -0.005, 2.1])
    g.box('water', [0.68, 0.04, 3.26], [x, 0.043, 2.1])
    for (const edge of [-0.46, 0.46]) g.box('stone', [0.1, 0.12, 3.68], [x + edge, 0.09, 2.1])
    for (const z of [0.32, 3.88]) g.box('stone', [1.0, 0.12, 0.12], [x, 0.09, z])
    for (let index = 0; index < 6; index++) g.box('waterLight', [0.25, 0.009, 0.028], [x + (index % 2 ? 0.1 : -0.1), 0.069, 0.75 + index * 0.48])
    g.cylinder('leaf', 0.15, 0.025, [x, 0.082, 2.9])
    g.rock('paper', [0.06, 0.065, 0.06], [x + 0.04, 0.13, 2.9])
  }
}

function bamboo(g: AcademyGeometry, x: number, z: number): void {
  g.box('stone', [0.92, 0.3, 0.78], [x, 0.18, z])
  for (let index = 0; index < 5; index += 1) {
    const dx = x + (index - 2) * 0.14
    const height = 2.1 + index % 3 * 0.23
    g.cylinder('leaf', 0.026, height, [dx, height / 2 + 0.25, z + index % 2 * 0.16])
    for (const y of [0.8, 1.3, 1.8, 2.2]) {
      g.cylinder('leafLight', 0.033, 0.032, [dx, y, z + index % 2 * 0.16])
      g.rock('leaf', [0.33, 0.05, 0.09], [dx + (index % 2 ? 0.17 : -0.17), y + 0.18, z])
    }
  }
}

function lantern(g: AcademyGeometry, x: number, z: number): void {
  g.box('stone', [0.6, 0.14, 0.6], [x, 0.12, z])
  g.cylinder('stone', 0.11, 0.75, [x, 0.55, z])
  g.box('wood', [0.5, 0.56, 0.5], [x, 1.12, z])
  g.box('paper', [0.42, 0.43, 0.52], [x, 1.12, z])
  g.add('tile', academyRoof(0.72, 0.65, 0.24), [x, 1.43, z])
}

function scholarPine(g: AcademyGeometry, x: number, z: number): void {
  g.rock('stone', [0.9, 0.25, 0.8], [x, 0.18, z])
  g.beam('darkWood', [x, 0.2, z], [x - 0.25, 3.2, z - 0.1], 0.12)
  for (let index = 0; index < 3; index += 1) {
    const y = 2.1 + index * 0.63
    const dx = x + (index % 2 ? -0.55 : 0.42)
    g.beam('darkWood', [x - 0.15, y - 0.25, z], [dx, y, z], 0.06)
    g.rock(index % 2 ? 'leaf' : 'leafLight', [0.94 - index * 0.15, 0.4, 0.72], [dx, y + 0.25, z])
  }
}
