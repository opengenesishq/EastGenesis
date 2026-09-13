import { ACADEMY_COURTYARD_SLOTS } from './ming/academyLayout'
import { PALACE_WORLD_LAYOUT } from './palace/palaceWorldLayout'

export type ControlRoomVector = [number, number, number]

export interface ControlRoomZoneLayout {
  station: ControlRoomVector
  approach: ControlRoomVector
  lookAt: ControlRoomVector
  hit: ControlRoomVector
  cameraPosition: ControlRoomVector
  cameraTarget: ControlRoomVector
}

export function courtyardZoneLayout(station: ControlRoomVector): ControlRoomZoneLayout {
  const [x, , z] = station
  return { station, approach: [x + (x < 0 ? 1.8 : -1.8), 0, z],
    lookAt: [x, 1.0, z], hit: [x, 1.4, z],
    cameraPosition: [x + (x < 0 ? 8 : -8), 10, z + 13], cameraTarget: [x, 1.3, z - 3] }
}

export const CONTROL_ROOM_LAYOUT = {
  overview: PALACE_WORLD_LAYOUT.workingCamera,
  zoneOverview: PALACE_WORLD_LAYOUT.palaceCamera,
  assistant: courtyardZoneLayout(ACADEMY_COURTYARD_SLOTS[0]),
  project: courtyardZoneLayout(ACADEMY_COURTYARD_SLOTS[1]),
  video: courtyardZoneLayout(ACADEMY_COURTYARD_SLOTS[2]),
  command: PALACE_WORLD_LAYOUT.command,
  plan: PALACE_WORLD_LAYOUT.plan,
  approval: PALACE_WORLD_LAYOUT.approval,
  approvalApproach: [13, 0, 7.4] as ControlRoomVector,
  artifact: PALACE_WORLD_LAYOUT.artifact,
  recovery: PALACE_WORLD_LAYOUT.recovery,
  infrastructure: PALACE_WORLD_LAYOUT.infrastructure
}
