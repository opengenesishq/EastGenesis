import { CONTROL_ROOM_LAYOUT } from './controlRoomLayout'
import type { PalaceInterior } from './palace/palaceInteriorLayout'

export type OfficeFacilityKey = 'assistant' | 'project' | 'video' | `business-line:${string}`

export interface OfficeFacilitySpec {
  key: OfficeFacilityKey
  labelKey: string
  statusKey: string
  displayName?: string
  businessLineId?: string
  interior?: PalaceInterior
  variant?: 'assistant' | 'project' | 'video' | 'custom'
  accent: string
  position: [number, number, number]
  hit: [number, number, number]
  cameraPosition: [number, number, number]
  cameraTarget: [number, number, number]
}

export const OFFICE_FACILITY_OVERVIEW_CAMERA = {
  position: CONTROL_ROOM_LAYOUT.zoneOverview.position as [number, number, number],
  target: CONTROL_ROOM_LAYOUT.zoneOverview.target as [number, number, number]
}

export const OFFICE_FACILITY_SPECS: OfficeFacilitySpec[] = [
  {
    key: 'assistant',
    labelKey: 'officeZoneAssistant',
    statusKey: 'officeZoneLive',
    accent: '#8fb8c6',
    position: CONTROL_ROOM_LAYOUT.assistant.station,
    hit: CONTROL_ROOM_LAYOUT.assistant.hit,
    cameraPosition: CONTROL_ROOM_LAYOUT.assistant.cameraPosition,
    cameraTarget: CONTROL_ROOM_LAYOUT.assistant.cameraTarget
  },
  {
    key: 'project',
    labelKey: 'officeZoneProject',
    statusKey: 'officeZoneLive',
    accent: '#8ba88f',
    position: CONTROL_ROOM_LAYOUT.project.station,
    hit: CONTROL_ROOM_LAYOUT.project.hit,
    cameraPosition: CONTROL_ROOM_LAYOUT.project.cameraPosition,
    cameraTarget: CONTROL_ROOM_LAYOUT.project.cameraTarget
  },
  {
    key: 'video',
    labelKey: 'officeZoneVideo',
    statusKey: 'officeZoneLive',
    accent: '#c39b73',
    position: CONTROL_ROOM_LAYOUT.video.station,
    hit: CONTROL_ROOM_LAYOUT.video.hit,
    cameraPosition: CONTROL_ROOM_LAYOUT.video.cameraPosition,
    cameraTarget: CONTROL_ROOM_LAYOUT.video.cameraTarget
  }
]
