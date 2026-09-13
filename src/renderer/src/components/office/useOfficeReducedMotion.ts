import { useSyncExternalStore } from 'react'
import { useStore } from '../../store'

let query: MediaQueryList | undefined
function motionQuery(): MediaQueryList { return query ??= window.matchMedia('(prefers-reduced-motion: reduce)') }
function subscribe(listener: () => void): () => void {
  const media = motionQuery()
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

/** Reuses the OS preference and the existing minimum-liveliness setting (0.2). */
export function useOfficeReducedMotion(): boolean {
  const systemReduced = useSyncExternalStore(subscribe, () => motionQuery().matches, () => false)
  const liveliness = useStore((state) => state.settings.office.liveliness)
  return systemReduced || liveliness <= 0.2
}
