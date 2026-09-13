import { PALACE_WORLD_LAYOUT, type PalacePoint } from './palaceWorldLayout'

export interface PalaceInterior {
  roomId: string
  center: PalacePoint
}

// Physical rooms in the authored GLB; business identities are assigned by the
// registry's four-slot window, never by a builtin/custom identity switch.
const HALLS = ['assistant_hall', 'project_hall', 'video_hall', 'custom_hall']

export function palaceInteriorForSlot(slot: number): PalaceInterior {
  const court = PALACE_WORLD_LAYOUT.courts[slot]
  if (!court) throw new Error('Unknown palace court slot')
  // GLB hall floors: local x [-10,10], z [-12.7,-5.7], top y=0.6.
  return { roomId: HALLS[slot], center: [court[0], 0.6, court[2] - 9.2] }
}

export const PALACE_COMMAND_ROOM = 'HALL_main'
