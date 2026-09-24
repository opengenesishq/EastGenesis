import { useSyncExternalStore } from 'react'

const KEY = 'caogen.companion.visible.v1'
const EVENT = 'caogen:companion-visibility'
let enabled = true
try { enabled = window.localStorage.getItem(KEY) !== 'false' } catch { /* Keep the in-memory preference. */ }

export function setCompanionEnabled(value: boolean): void {
  enabled = value
  try { window.localStorage.setItem(KEY, String(value)) } catch { /* Still usable without storage. */ }
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== KEY && event.key !== null) return
    enabled = event.newValue !== 'false'
    listener()
  }
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', onStorage) }
}

export function useCompanionEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled)
}
