import { useEffect, useMemo, useState } from 'react'
import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import type { OfficeFacilityKey } from './kit/facilityCatalog'
import { officeViewForBusinessLine } from './operationalActors'
import { readOfficeReturnContext, type OfficeBusinessView } from './officeReturnContext'

export function useOfficeBusinessNavigation(lines: BusinessLineDefinition[], defaultLineId: string) {
  const available = useMemo(() => new Set(lines.filter((line) => line.enabled)
    .map((line) => officeViewForBusinessLine(line.id))), [lines])
  const [restored] = useState(readOfficeReturnContext)
  const [businessView, setBusinessView] = useState<OfficeBusinessView>(() => {
    if (restored?.businessView === 'all' || (restored && available.has(restored.businessView))) return restored.businessView
    const preferred = officeViewForBusinessLine(defaultLineId)
    return available.has(preferred) ? preferred : 'all'
  })
  const [selectedFacility, setSelectedFacility] = useState<OfficeFacilityKey | null>(() => {
    if (restored?.selectedFacility && available.has(restored.selectedFacility)) return restored.selectedFacility
    return businessView === 'all' ? null : businessView
  })
  useEffect(() => {
    if (businessView !== 'all' && !available.has(businessView)) setBusinessView('all')
    if (selectedFacility && !available.has(selectedFacility)) setSelectedFacility(null)
    // Registry changes repair navigation without issuing a camera movement request.
  }, [available, businessView, selectedFacility])
  return { businessView, setBusinessView, selectedFacility, setSelectedFacility }
}
