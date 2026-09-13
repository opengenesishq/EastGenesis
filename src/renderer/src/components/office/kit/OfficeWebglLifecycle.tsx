import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'

/**
 * Keep WebGL loss visible in the same DOM contract used by the performance
 * probes. Browsers can restore a context after a transient GPU reset; the
 * restore handler invalidates the manual frame loop so the scene is drawn
 * again instead of remaining blank with stale diagnostics.
 */
export default function OfficeWebglLifecycle(): null {
  const { gl, invalidate } = useThree()

  useEffect(() => {
    const canvas = gl.domElement
    const wrap = canvas.closest('.office-canvas-wrap')
    if (!wrap) return
    const lost = (event: Event): void => {
      event.preventDefault()
      wrap.setAttribute('data-office-webgl-context', 'lost')
      wrap.setAttribute('data-office-webgl-context-lost-at', String(Date.now()))
    }
    const restored = (): void => {
      wrap.setAttribute('data-office-webgl-context', 'restored')
      wrap.setAttribute('data-office-webgl-context-restored-at', String(Date.now()))
      invalidate()
    }
    canvas.addEventListener('webglcontextlost', lost, { passive: false })
    canvas.addEventListener('webglcontextrestored', restored)
    wrap.setAttribute('data-office-webgl-context', 'active')
    return () => {
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
    }
  }, [gl, invalidate])

  return null
}
