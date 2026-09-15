export type WorkOsNavigationTarget = 'inbox' | 'projects' | 'runs' | 'review' | 'library' | 'settings'
export type StudioSectionTarget = 'inbox' | 'work' | 'team' | 'runs' | 'review'

export const WORK_OS_NAVIGATION_EVENT = 'caogen:work-os-navigation'
export const STUDIO_SECTION_NAVIGATION_EVENT = 'caogen:studio-section-navigation'

let pendingStudioSection: StudioSectionTarget | null = null

/** Route the product-level Work OS navigation without coupling Sidebar to Studio internals. */
export function requestWorkOsNavigation(target: WorkOsNavigationTarget): void {
  window.dispatchEvent(new CustomEvent<WorkOsNavigationTarget>(WORK_OS_NAVIGATION_EVENT, { detail: target }))
}

/** Queue the Studio projection that should be shown when the lazy Studio surface mounts. */
export function requestStudioSectionNavigation(section: StudioSectionTarget): void {
  pendingStudioSection = section
  window.dispatchEvent(new CustomEvent<StudioSectionTarget>(STUDIO_SECTION_NAVIGATION_EVENT, { detail: section }))
}

export function takeStudioSectionNavigation(): StudioSectionTarget | null {
  const next = pendingStudioSection
  pendingStudioSection = null
  return next
}

