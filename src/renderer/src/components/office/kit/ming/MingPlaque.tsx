import { useEffect, useMemo, useState } from 'react'
import { CanvasTexture, SRGBColorSpace } from 'three'
import type { AcademyPoint } from './academyGeometry'
import { CAOTAI_BRAND_FONT, loadAcademyBrandFont } from './academyBrandFont'

/** Brand lettering uses bundled OFL Noto Serif; Chinese labels use system fallbacks. */
export default function MingPlaque({ label, position, width = 2.6, brand = false }: { label: string; position: AcademyPoint; width?: number; brand?: boolean }): React.JSX.Element {
  const [fontReady, setFontReady] = useState(false)
  useEffect(() => {
    if (!brand) return
    let cancelled = false
    void loadAcademyBrandFont().then((loaded) => { if (!cancelled) setFontReady(loaded) })
    return () => { cancelled = true }
  }, [brand])
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 768
    canvas.height = 160
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = '#3f4540'
      context.fillRect(0, 0, 768, 160)
      context.strokeStyle = '#b6a480'
      context.lineWidth = 6
      context.strokeRect(12, 12, 744, 136)
      context.fillStyle = '#f5ead0'
      context.font = brand && fontReady ? `600 84px "${CAOTAI_BRAND_FONT}"` : '600 76px "Songti SC", "Noto Serif SC", serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, 384, 82, 688)
    }
    const next = new CanvasTexture(canvas)
    next.colorSpace = SRGBColorSpace
    return next
  }, [label, brand, fontReady])
  useEffect(() => () => texture.dispose(), [texture])
  return <mesh position={position} raycast={() => undefined} userData={{ mingPlaque: label, brandFontLoaded: fontReady }}>
    <planeGeometry args={[width, width * 160 / 768]} />
    <meshBasicMaterial map={texture} toneMapped={false} />
  </mesh>
}
