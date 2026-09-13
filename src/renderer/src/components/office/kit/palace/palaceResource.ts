import palaceModelUrl from '../../../../assets/palace/palace-material-review.glb?url'
import palaceVLowModelUrl from '../../../../assets/palace/palace-material-review-vlow.glb?url'
import { batchPalaceGeometry, type PalaceGeometry } from './palaceGeometry'
import { recordPalaceGeometryBytes } from './palaceResourceStats'

export type PalaceGeometryTier = 'high' | 'balanced' | 'low'

const resources: Partial<Record<PalaceGeometryTier, Promise<PalaceGeometry>>> = {}
const resourceListeners = new Set<() => void>()
let latestResource: PalaceGeometry | null = null

/** URLs are immutable local exports from the same material-review source blend. */
export const palaceModelUrls: Record<PalaceGeometryTier, string> = {
  high: palaceModelUrl,
  balanced: palaceModelUrl,
  low: palaceVLowModelUrl
}

/** One bounded local asset; defer parsing until the useful first frames have rendered. */
export function loadPalaceResource(tier: PalaceGeometryTier = 'high'): Promise<PalaceGeometry> {
  const existing = resources[tier]
  if (existing) return existing
  const pending = import('three/examples/jsm/loaders/GLTFLoader.js')
    .then(({ GLTFLoader }) => new GLTFLoader().loadAsync(palaceModelUrls[tier]))
    .then(({ scene }) => batchPalaceGeometry(scene))
    .then((loaded) => {
      // The vLow architecture export intentionally omits review characters.
      // Keep the already-loaded authored governance figures available to the
      // overlay when a user changes quality tier; never replace real figures
      // with placeholders or an empty low-tier projection.
      if (loaded.authoredCharacters.children.length > 0 || !latestResource) {
        latestResource = loaded
        resourceListeners.forEach((listener) => listener())
      }
      let bytes = 0
      const retained = [loaded.scene, loaded.authoredCharacters]
      retained.forEach((root) => root.traverse((node) => {
        if (!('geometry' in node)) return
        const geometry = (node as import('three').Mesh).geometry
        bytes += Object.values(geometry.attributes).reduce((total, attribute) => total + attribute.array.byteLength, 0)
      }))
      recordPalaceGeometryBytes(bytes)
      return loaded
    })
    .catch((error: unknown) => {
      delete resources[tier]
      throw error
    })
  resources[tier] = pending
  return pending
}

/** Read-only bridge for scene overlays that are siblings of PalaceArchitecture
 * in the R3F tree. It observes the same cached promise and never starts a
 * second GLB load. */
export function getLatestPalaceResource(): PalaceGeometry | null { return latestResource }
export function subscribePalaceResource(listener: () => void): () => void {
  resourceListeners.add(listener)
  return () => resourceListeners.delete(listener)
}

export { palaceModelUrl }
