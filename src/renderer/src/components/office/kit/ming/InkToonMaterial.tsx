import { useCallback } from 'react'
import type { MeshToonMaterialParameters, WebGLProgramParametersWithUniforms } from 'three'
import { applyInkSurface, type InkSurface } from './inkSurface'

export { inkClock, type InkSurface } from './inkSurface'

/** Original analytic brush grain: no bitmap, external shader, or per-frame allocation. */
export default function InkToonMaterial({ surface = 'paper', ...props }: MeshToonMaterialParameters & { surface?: InkSurface }): React.JSX.Element {
  const compile = useCallback((shader: WebGLProgramParametersWithUniforms): void => {
    applyInkSurface(shader, surface)
  }, [surface])
  return <meshToonMaterial {...props} onBeforeCompile={compile} customProgramCacheKey={() => `caotai-ink-v1:${surface}`} />
}
