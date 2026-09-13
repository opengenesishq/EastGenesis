import { ACADEMY_COURTYARD_SLOTS, academyCourtyardWindow } from './kit/ming/academyLayout'
import { courtyardZoneLayout } from './kit/controlRoomLayout'
import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import { OFFICE_FACILITY_SPECS, type OfficeFacilitySpec } from './kit/facilityCatalog'
import { palaceInteriorForSlot } from './kit/palace/palaceInteriorLayout'

/** All business lines share the same four physical courts; navigation keeps every identity available. */
export function buildBusinessFacilities(lines: BusinessLineDefinition[], selectedId?: string | null): OfficeFacilitySpec[] {
  const selectedLineId = selectedId === 'project' ? 'studio' : selectedId
  return academyCourtyardWindow(lines.filter((line) => line.enabled), selectedLineId).map((line, index) => {
    const key = line.id === 'studio' ? 'project' : line.id as OfficeFacilitySpec['key']
    const builtin = OFFICE_FACILITY_SPECS.find((spec) => spec.key === key)
    const zone = courtyardZoneLayout(ACADEMY_COURTYARD_SLOTS[index])
    const interior = palaceInteriorForSlot(index)
    const [x, y, z] = interior.center
    return { key, businessLineId: line.id, displayName: line.name, interior,
      labelKey: builtin?.labelKey ?? '', statusKey: 'officeZoneLive',
      variant: line.origin === 'builtin' ? key as 'assistant' | 'project' | 'video' : 'custom',
      accent: builtin?.accent ?? '#92aaa6', position: zone.station, hit: zone.hit,
      cameraPosition: [x + 5, y + 10, z + 13], cameraTarget: [x, y + 0.8, z] }
  })
}
