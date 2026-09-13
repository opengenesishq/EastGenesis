import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { loadPalaceResource, type PalaceGeometryTier } from './palaceResource'
import { retainPalaceResourceStats } from './palaceResourceStats'
import { setPalaceRoomVisibility, type PalaceGeometry } from './palaceGeometry'

export default function PalaceArchitecture({ cutaway, openedRoom, qualityTier = 'high', onReady }: {
  cutaway: boolean
  openedRoom?: string
  qualityTier?: PalaceGeometryTier
  onReady?: (ready: boolean) => void
}): React.JSX.Element | null {
  const [resource, setResource] = useState<PalaceGeometry | null>(null)
  const renderedFrames = useRef(0)
  const { gl, invalidate } = useThree()
  useEffect(() => {
    let cancelled = false
    const wrap = gl.domElement.closest('.office-canvas-wrap')
    renderedFrames.current = 0
    wrap?.setAttribute('data-office-palace-loaded', '0')
    wrap?.setAttribute('data-office-palace-geometry-tier', qualityTier)
    // Parsing the authored GLB is CPU heavy. Let the shell, task labels, and
    // live worker projection render first, then promote the selected tier.
    const timer = window.setTimeout(() => { void loadPalaceResource(qualityTier).then((loaded) => {
      if (cancelled) return
      setResource(loaded)
      wrap?.setAttribute('data-office-palace-source-meshes', String(loaded.sourceMeshes))
      wrap?.setAttribute('data-office-palace-batches', String(loaded.batches))
      wrap?.setAttribute('data-office-palace-architecture-batches', String(loaded.architectureBatches))
      wrap?.setAttribute('data-office-palace-authored-character-batches', String(loaded.authoredCharacterBatches))
      wrap?.setAttribute('data-office-palace-removed-scale-meshes', String(loaded.removedScaleReferences))
      wrap?.setAttribute('data-office-palace-removed-sample-furniture', String(loaded.removedSampleFurniture))
      wrap?.setAttribute('data-office-palace-authored-character-groups', JSON.stringify(loaded.authoredCharacterGroups))
      wrap?.setAttribute('data-office-palace-authored-character-count', String(loaded.authoredCharacterGroups.length))
      invalidate()
    }).catch(() => {
      if (!cancelled) { wrap?.setAttribute('data-office-palace-loaded', 'error'); onReady?.(false) }
    }) }, 1300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [gl, invalidate, onReady, qualityTier])
  const scene = resource?.scene
  useEffect(() => resource ? retainPalaceResourceStats() : undefined, [resource])
  useFrame(() => {
    if (!scene || renderedFrames.current >= 2) return
    if (++renderedFrames.current === 2) {
      gl.domElement.closest('.office-canvas-wrap')?.setAttribute('data-office-palace-loaded', '1')
      onReady?.(true)
    }
  })
  useEffect(() => {
    if (scene) setPalaceRoomVisibility(scene, cutaway, openedRoom)
    invalidate()
  }, [scene, cutaway, openedRoom, invalidate])
  return scene ? <primitive object={scene} dispose={null} /> : null
}
