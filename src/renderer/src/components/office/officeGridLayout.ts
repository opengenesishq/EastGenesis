import { PALACE_WORLD_LAYOUT } from './kit/palace/palaceWorldLayout'
import type { OfficeFacilitySpec } from './kit/facilityCatalog'

/** Fits the full 12-worker render budget inside one authored hall, with a
 * central aisle and no seats in the rear archive or courtyard. */
export function businessInteriorPositions(
  lineIds: string[], facilities: OfficeFacilitySpec[]
): Array<[number, number, number]> {
  const counts = new Map<string, number>()
  const columns = [-7.6, -5.1, -2.6, 2.6, 5.1, 7.6]
  return lineIds.map((lineId) => {
    const room = facilities.find((facility) => facility.businessLineId === lineId)?.interior
    if (!room) throw new Error(`Business line has no visible palace interior:${lineId}`)
    const index = counts.get(lineId) ?? 0
    if (index >= 12) throw new Error('Palace room render capacity exceeded')
    counts.set(lineId, index + 1)
    const [x, y, z] = room.center
    return [x + columns[index % columns.length], y, z - 0.8 + Math.floor(index / columns.length) * 2.4]
  })
}

/** Historical geometry diagnostics; the live Office uses businessInteriorPositions. */
export function gridPositions(count: number, teamPhoto = false): Array<[number, number, number]> {
  if (count === 0) return []
  if (teamPhoto) {
    const columns = Math.min(5, count)
    return Array.from({ length: count }, (_, index) => {
      const row = Math.floor(index / columns)
      const itemsInRow = Math.min(columns, count - row * columns)
      return [(index % columns - (itemsInRow - 1) / 2) * 2.3, 0, PALACE_WORLD_LAYOUT.taskCenter[2] - 2 + row * 2.3]
    })
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.ceil(count / columns)
  const gapX = columns > 1 ? Math.min(3.05, 8 / (columns - 1)) : 0
  const gapZ = rows > 1 ? Math.min(3, 6 / (rows - 1)) : 0
  return Array.from({ length: count }, (_, index) => [
    (index % columns - (columns - 1) / 2) * gapX, 0,
    (Math.floor(index / columns) - (rows - 1) / 2) * gapZ + PALACE_WORLD_LAYOUT.taskCenter[2]
  ])
}
