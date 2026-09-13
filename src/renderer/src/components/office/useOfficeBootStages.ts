import { useCallback, useRef, useState } from 'react'

/** Reveal useful geometry on rendered frames; no fixed wall-clock loading delay. */
export function useOfficeBootStages(recordFrame: (frameMs: number) => void): {
  bootCharactersEnabled: boolean
  sceneDetailEnabled: boolean
  sceneAssetsEnabled: boolean
  handleOfficeFrame: (frameMs: number) => void
} {
  // The CPU geometry cache survives navigation, but Canvas creates a new WebGL
  // context each time. Keep the first frame small even on a warm remount: GPU
  // shader compilation and uploading all workers would otherwise block it.
  const [bootCharactersEnabled, setBootCharactersEnabled] = useState(false)
  const [sceneDetailEnabled, setSceneDetailEnabled] = useState(false)
  const [sceneAssetsEnabled, setSceneAssetsEnabled] = useState(false)
  const stage = useRef(0)
  const deferredFrames = useRef(0)
  const handleOfficeFrame = useCallback((frameMs: number): void => {
    recordFrame(frameMs)
    if (stage.current === 2) return
    if (stage.current === 0) {
      stage.current = 1; setBootCharactersEnabled(true); return
    }
    // Give a busy first frame room to settle, with a bounded frame count to prevent starvation.
    if (frameMs > 30 && ++deferredFrames.current < 3) return
    stage.current = 2
    setSceneDetailEnabled(true)
    setSceneAssetsEnabled(true)
  }, [recordFrame])
  return { bootCharactersEnabled, sceneDetailEnabled, sceneAssetsEnabled, handleOfficeFrame }
}
