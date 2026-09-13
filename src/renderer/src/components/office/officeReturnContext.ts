import type { ExperienceMode } from '../../store/experience-mode'
import type { OfficeFacilityKey } from './kit/facilityCatalog'

export type OfficeBusinessView = 'all' | OfficeFacilityKey

export const OFFICE_BUSINESS_VIEWS: OfficeBusinessView[] = ['all', 'assistant', 'project', 'video']
const FACILITY_KEYS = new Set<OfficeFacilityKey>(['assistant', 'project', 'video'])
const STORAGE_KEY = 'caogen.office.return-context'

export interface OfficeReturnContext {
  businessView: OfficeBusinessView
  selectedFacility: OfficeFacilityKey | null
}

export function defaultOfficeBusinessView(mode: ExperienceMode): Exclude<OfficeBusinessView, 'all'> {
  return mode === 'studio' ? 'project' : mode === 'video' ? 'video' : 'assistant'
}

/** Reading during render is repeatable; explicit navigation writes the next return context. */
export function readOfficeReturnContext(): OfficeReturnContext | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<OfficeReturnContext>
    if (!isOfficeBusinessView(value.businessView)) return null
    return {
      businessView: value.businessView as OfficeBusinessView,
      selectedFacility: isOfficeFacilityKey(value.selectedFacility)
        ? value.selectedFacility
        : null
    }
  } catch {
    return null
  }
}

function isOfficeBusinessView(value: unknown): value is OfficeBusinessView {
  return value === 'all' || isOfficeFacilityKey(value)
}

function isOfficeFacilityKey(value: unknown): value is OfficeFacilityKey {
  return typeof value === 'string' && (FACILITY_KEYS.has(value as OfficeFacilityKey) || /^business-line:[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value))
}

export function saveOfficeReturnContext(context: OfficeReturnContext): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
  } catch {
    // Opening the session remains available when renderer storage is restricted.
  }
}
