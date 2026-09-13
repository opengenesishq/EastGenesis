import { resolveSelectedBusinessLine, type BusinessLineSettings } from '../../../shared/business-line-types'
import { useStore } from '../store'
import { requestBusinessLineTaskNavigation } from '../components/business-lines/businessLineTaskNavigation'
import { requestNewVideoProjectNavigation } from '../components/studio/videoProductionNavigation'

export function businessLineForOfficeCreation(view: string, settings: BusinessLineSettings): string {
  if (view === 'all') return resolveSelectedBusinessLine(settings).id
  return view === 'project' ? 'studio' : view
}

export async function openBusinessLineCreation(businessLineId: string): Promise<void> {
  const state = useStore.getState()
  await state.selectBusinessLine(businessLineId)
  if (businessLineId === 'video') requestNewVideoProjectNavigation(businessLineId)
  else if (businessLineId === 'studio') state.openNewProjectWorkspace()
  else {
    state.setShowNewSession(true)
    requestBusinessLineTaskNavigation(businessLineId)
  }
}
