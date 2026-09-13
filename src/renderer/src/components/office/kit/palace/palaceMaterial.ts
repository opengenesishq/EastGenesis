import { DataTexture, MeshToonMaterial, NearestFilter, RedFormat, type Material, type MeshStandardMaterial } from 'three'
import { applyInkSurface, type InkSurface } from '../ming/inkSurface'
import { PALACE_PALETTE } from './palacePalette'

const surfaces = new Set<InkSurface>(['paper', 'wood', 'tile', 'water', 'cloth', 'stone'])
let gradient: DataTexture | null = null

/** The retained palace owns these materials for the app lifetime. Four analytic
 * tone bands share a single four-byte texture; brush grain needs no mesh UVs. */
export function palaceReviewMaterial(source: Material): Material {
  const surface = source.userData.caogenInkSurface as InkSurface
  if (!source.name.startsWith('PALACE_') || !surfaces.has(surface)) return source
  if (!gradient) {
    gradient = new DataTexture(new Uint8Array([78, 145, 208, 255]), 4, 1, RedFormat)
    gradient.minFilter = NearestFilter
    gradient.magFilter = NearestFilter
    gradient.generateMipmaps = false
    gradient.needsUpdate = true
  }
  const standard = source as MeshStandardMaterial
  const material = new MeshToonMaterial({
    color: PALACE_PALETTE[source.name.slice('PALACE_'.length) as keyof typeof PALACE_PALETTE] ?? standard.color,
    gradientMap: gradient, opacity: source.opacity,
    transparent: source.transparent, side: source.side, depthWrite: source.depthWrite,
    depthTest: source.depthTest, alphaTest: source.alphaTest, toneMapped: source.toneMapped,
    fog: standard.fog
  })
  material.name = source.name
  material.userData = { ...source.userData, paletteSource: 'palace-shared-palette-v2', style: 'caotai-ink-v1' }
  material.onBeforeCompile = (shader) => applyInkSurface(shader, surface)
  material.customProgramCacheKey = () => `caotai-ink-v1:${surface}`
  return material
}
