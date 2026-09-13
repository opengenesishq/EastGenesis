import { AcademyGeometry, type AcademyGeometryPart, type AcademyPoint } from './academyGeometry'

export type MingStationVariant = 'assistant' | 'project' | 'video' | 'custom' | 'command' | 'approval' | 'archive' | 'infrastructure' | 'entrance'

export function createAcademyStation(variant: MingStationVariant, count: number): AcademyGeometryPart[] {
  const g = new AcademyGeometry()
  if (variant === 'entrance') {
    g.box('stone', [0.9, 0.12, 0.5], [0, 0.06, 0])
    g.box('darkWood', [0.12, 0.95, 0.12], [0, 0.58, 0])
    g.box('wood', [0.9, 0.48, 0.1], [0, 1.16, 0])
    g.box('paper', [0.76, 0.32, 0.025], [0, 1.16, 0.065])
    for (let i = 0; i < 6; i++) g.box(i < count ? 'jade' : 'stone', [0.055, 0.055, 0.015], [-0.275 + i * 0.11, 1.16, 0.09])
    return g.finish()
  }
  if (variant === 'archive' || variant === 'infrastructure') archive(g, variant === 'infrastructure')
  else if (variant === 'project') drawingBoard(g)
  else if (variant === 'video') paintingDesk(g)
  else if (variant === 'command') commandTable(g)
  else writingDesk(g, variant === 'approval' ? 1.45 : 2.65)
  if (variant !== 'archive' && variant !== 'infrastructure') countingTokens(g, count, variant)
  return g.finish()
}

function desk(g: AcademyGeometry, width: number, depth = 0.88): void {
  g.box('stone', [width + 0.55, 0.035, depth + 0.6], [0, 0.033, 0.05])
  g.box('darkWood', [width, 0.09, depth], [0, 0.74, 0])
  g.box('wood', [width + 0.055, 0.045, depth + 0.035], [0, 0.799, 0])
  for (const x of [-width / 2 + 0.16, width / 2 - 0.16]) {
    for (const z of [-depth / 2 + 0.13, depth / 2 - 0.13]) g.box('wood', [0.085, 0.69, 0.085], [x, 0.39, z])
    g.box('darkWood', [0.065, 0.065, depth - 0.16], [x, 0.26, 0])
  }
  g.box('wood', [width - 0.2, 0.09, 0.04], [0, 0.64, depth / 2 - 0.04])
}

function scroll(g: AcademyGeometry, center: AcademyPoint, width: number, height: number): void {
  g.box('paper', [width, height, 0.04], center)
  for (const sign of [-1, 1]) {
    const y = center[1] + sign * height / 2
    g.beam('wood', [center[0] - width / 2 - 0.065, y, center[2]], [center[0] + width / 2 + 0.065, y, center[2]], 0.037)
  }
}

function writingDesk(g: AcademyGeometry, width: number): void {
  desk(g, width)
  g.box('paper', [width * 0.45, 0.024, 0.46], [-width * 0.15, 0.842, 0.05])
  g.box('ink', [0.19, 0.035, 0.12], [width * 0.27, 0.85, 0.16])
  g.cylinder('darkWood', 0.08, 0.18, [width * 0.33, 0.91, -0.24])
  g.beam('wood', [width * 0.33, 0.96, -0.24], [width * 0.34 + 0.05, 1.19, -0.25], 0.015)
  g.beam('ink', [width * 0.34 + 0.05, 1.19, -0.25], [width * 0.34 + 0.06, 1.24, -0.25], 0.011)
  scroll(g, [-width * 0.15, 1.33, -0.3], width * 0.57, 0.69)
  for (const x of [-width * 0.38, width * 0.08]) g.box('darkWood', [0.05, 0.5, 0.05], [x, 1.05, -0.32])
}

function drawingBoard(g: AcademyGeometry): void {
  g.box('stone', [4.1, 0.055, 1.65], [0, 0.045, 0])
  g.box('darkWood', [3.6, 1.67, 0.12], [0, 1.63, -0.08])
  scroll(g, [0, 1.65, 0], 3.3, 1.38)
  for (const x of [-1.56, 1.56]) g.box('wood', [0.115, 2.1, 0.13], [x, 1.12, -0.1])
  // A blank architectural drawing, not a fabricated work-item graph.
  g.box('stone', [2.4, 0.027, 0.015], [0, 1.13, 0.035])
  for (const x of [-0.95, -0.33, 0.33, 0.95]) g.box('wood', [0.016, 0.6, 0.015], [x, 1.5, 0.035])
  g.beam('ink', [-1.15, 1.78, 0.04], [0, 2.13, 0.04], 0.019)
  g.beam('ink', [0, 2.13, 0.04], [1.15, 1.78, 0.04], 0.019)
  g.box('wood', [2.1, 0.075, 0.54], [0, 0.64, 0.51])
}

function paintingDesk(g: AcademyGeometry): void {
  desk(g, 2.9, 1.04)
  for (const x of [-0.91, 0, 0.91]) {
    scroll(g, [x, 1.48, -0.32], 0.71, 0.97)
    g.box('darkWood', [0.055, 1.16, 0.07], [x, 1.17, -0.38])
    g.rock('leafLight', [0.18, 0.18, 0.012], [x - 0.08, 1.34, -0.29])
    g.rock('tile', [0.15, 0.23, 0.01], [x + 0.12, 1.46, -0.28])
  }
  for (let index = 0; index < 4; index += 1) g.cylinder(index % 2 ? 'cinnabar' : 'jade', 0.056, 0.024, [-0.36 + index * 0.22, 0.846, 0.33])
}

function commandTable(g: AcademyGeometry): void {
  desk(g, 1.8, 1.15)
  g.box('paper', [1.47, 0.025, 0.84], [0, 0.843, 0])
  g.box('wood', [0.94, 0.04, 0.035], [0, 0.87, 0.17])
  for (const x of [-0.35, 0, 0.35]) g.box('ink', [0.07, 0.045, 0.07], [x, 0.89, 0.17])
  g.box('cinnabar', [0.2, 0.13, 0.2], [0.59, 0.92, -0.26])
}

function archive(g: AcademyGeometry, infrastructure: boolean): void {
  g.box('stone', [1.7, 0.12, 0.9], [0, 0.12, 0])
  g.box('darkWood', [1.6, 2.2, 0.68], [0, 1.24, -0.09])
  for (let row = 0; row < 4; row += 1) {
    const y = 0.47 + row * 0.49
    g.box('wood', [1.55, 0.05, 0.82], [0, y - 0.15, 0.02])
    for (let column = 0; column < 4; column += 1) {
      const x = -0.55 + column * 0.36
      g.box(infrastructure ? 'jade' : 'paper', [0.26, 0.31, 0.42], [x, y + 0.03, 0.2])
      g.box('darkWood', [0.29, 0.018, 0.02], [x, y + 0.035, 0.42])
    }
  }
  g.box('wood', [1.72, 0.09, 0.88], [0, 2.39, -0.02])
}

function countingTokens(g: AcademyGeometry, count: number, variant: MingStationVariant): void {
  const active = Math.min(6, Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0))
  const y = variant === 'project' ? 0.704 : 0.852
  const z = variant === 'project' ? 0.61 : 0.33
  for (let index = 0; index < 6; index += 1) {
    const color = index < active ? variant === 'command' || variant === 'approval' ? 'cinnabar' : 'jade' : 'stone'
    g.cylinder(color, 0.037, 0.023, [-0.275 + index * 0.11, y, z])
  }
}
