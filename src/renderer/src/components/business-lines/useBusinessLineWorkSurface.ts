import { useEffect, useState } from 'react'
import { getBusinessLineWorkSurfaces, type BusinessLineDefinition, type BusinessLineWorkSurface } from '../../../../shared/business-line-types'
import { peekVideoProductionNavigation, type VideoProductionNavigation } from '../studio/videoProductionNavigation'
import { BUSINESS_LINE_NEW_TASK_EVENT, BUSINESS_LINE_SURFACE_EVENT, hasBusinessLineTaskNavigation, takeBusinessLineTaskNavigation, takeBusinessLineSurfaceNavigation } from './businessLineTaskNavigation'

export function useBusinessLineWorkSurface(line: BusinessLineDefinition) {
  const [current, setSurface] = useState<BusinessLineWorkSurface>(() => initialSurface(line))
  useEffect(() => {
    const open = (event: Event): void => {
      if ((event as CustomEvent<VideoProductionNavigation>).detail?.businessLineId === line.id) setSurface('video')
    }
    window.addEventListener('caogen:video-select-production', open)
    const newTask = (): void => { if (takeBusinessLineTaskNavigation(line.id)) setSurface('tasks') }
    const surface = (): void => { const target = takeBusinessLineSurfaceNavigation(line.id); if (target) setSurface(target) }
    window.addEventListener(BUSINESS_LINE_NEW_TASK_EVENT, newTask)
    window.addEventListener(BUSINESS_LINE_SURFACE_EVENT, surface)
    newTask()
    surface()
    return () => { window.removeEventListener('caogen:video-select-production', open); window.removeEventListener(BUSINESS_LINE_NEW_TASK_EVENT, newTask); window.removeEventListener(BUSINESS_LINE_SURFACE_EVENT, surface) }
  }, [line.id])
  // Explicit existing-media and new-task routes remain reachable on any surface combination.
  return [current, setSurface] as const
}

function initialSurface(line: BusinessLineDefinition): BusinessLineWorkSurface {
  if (hasBusinessLineTaskNavigation(line.id)) return 'tasks'
  return peekVideoProductionNavigation()?.businessLineId === line.id ? 'video' : getBusinessLineWorkSurfaces(line)[0]
}
