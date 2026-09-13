/** Authored metres. Blender (x, y, z) exports to glTF (x, z, -y). */
export type PalacePoint = [number, number, number]

export const PALACE_WORLD_LAYOUT = {
  groundSize: [124, 156] as [number, number],
  taskCenter: [0, 0, 12] as PalacePoint,
  taskBounds: { min: [-9, 0, 5], max: [9, 3, 19] },
  courts: [[-36, 0, 7], [36, 0, 7], [-36, 0, -32], [36, 0, -32]] as PalacePoint[],
  cornerTowers: {
    southeast: [51.5, 0, -62.5] as PalacePoint,
    southwest: [-51.5, 0, -62.5] as PalacePoint,
    northeast: [51.5, 0, 62.5] as PalacePoint,
    northwest: [-51.5, 0, 62.5] as PalacePoint
  },
  workingCamera: { position: [78, 100, 126] as PalacePoint, target: [0, 0, -4] as PalacePoint, fov: 48 },
  palaceCamera: { position: [78, 100, 126] as PalacePoint, target: [0, 0, -4] as PalacePoint },
  command: [0, 2.4, -14] as PalacePoint,
  plan: [-6, 2.4, -12] as PalacePoint,
  approval: [6, 2.4, -12] as PalacePoint,
  artifact: [-8, 2.4, -14] as PalacePoint,
  recovery: [6, 2.4, -16] as PalacePoint,
  infrastructure: [8, 2.4, -14] as PalacePoint,
  fog: [130, 300] as [number, number],
  cameraFar: 500,
  maximumOrbitDistance: 220
}

/** Stay outside the main terrace and cross the real 4 m side aperture. */
export function palaceCourtWaypoints(home: PalacePoint, target: PalacePoint): PalacePoint[] {
  const side = target[0] < 0 ? -1 : 1
  return [[side * 20.5, 0, home[2]], [side * 20.5, 0, target[2]], [side * 25, 0, target[2]]]
}
