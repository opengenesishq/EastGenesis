import { useCallback, useEffect, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import type { OfficeQualityMode } from '../../../../../shared/types'
import {
  initialOfficeAutoQuality,
  nextOfficeAutoQuality,
  officeResolutionDpr,
  OFFICE_QUALITY_PROFILES,
  summarizeOfficeFrameTimes
} from '../quality'
import type { OfficeAutoQualityState, OfficeQualityProfile, OfficeQualityTier } from '../quality'
import { recordOfficeRenderDuration } from './officeRenderInstrumentation'

const AUTO_SAMPLE_FRAMES = 45
const MAX_MEASURED_FRAME_MS = 250

export interface OfficeRenderQualityRuntime {
  renderActive: boolean
  resolvedTier: OfficeQualityTier
  autoTransitions: number
  profile: OfficeQualityProfile
  recordFrame(frameMs: number): void
}

function isVisibleAndFocused(): boolean {
  return !document.hidden && document.hasFocus()
}

export function useOfficeRenderQuality(requestedMode: OfficeQualityMode, resolutionMode: 'sharp' | 'adaptive' = 'sharp'): OfficeRenderQualityRuntime {
  // Electron may mount the view before native focus/visibility reaches the
  // renderer. Start optimistically and let lifecycle events pause after the
  // first frame, so the initial canvas is not delayed by focus propagation.
  const [renderActive, setRenderActive] = useState(true)
  const [autoTier, setAutoTier] = useState<OfficeQualityTier>('balanced')
  const [autoTransitions, setAutoTransitions] = useState(0)
  const [deviceRatio, setDeviceRatio] = useState(() => window.devicePixelRatio || 1)
  const autoStateRef = useRef<OfficeAutoQualityState>(initialOfficeAutoQuality(performance.now()))
  const frameSamplesRef = useRef<number[]>([])
  const firstFrameRenderedRef = useRef(false)
  useEffect(() => {
    const resized = (): void => setDeviceRatio(window.devicePixelRatio || 1)
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [])

  useEffect(() => {
    // Electron can mount the view before native focus reaches the renderer.
    // Visibility is sufficient for the initial frame; blur/focus events below
    // still pause the loop when the desktop window actually leaves focus.
    const updateVisibility = (): void => {
      // Electron can report a transient unfocused state while the newly
      // navigated page is becoming the foreground view. Do not suppress the
      // first useful canvas frame during that handoff; focus based pausing
      // starts only after a frame has actually rendered.
      if (!firstFrameRenderedRef.current) {
        if (!document.hidden) setRenderActive(true)
        return
      }
      setRenderActive(isVisibleAndFocused())
    }
    const pause = (): void => {
      if (!firstFrameRenderedRef.current) return
      setRenderActive(false)
    }
    const resume = (): void => setRenderActive(firstFrameRenderedRef.current ? isVisibleAndFocused() : true)
    document.addEventListener('visibilitychange', updateVisibility)
    window.addEventListener('blur', pause)
    window.addEventListener('focus', resume)
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility)
      window.removeEventListener('blur', pause)
      window.removeEventListener('focus', resume)
    }
  }, [])

  useEffect(() => {
    frameSamplesRef.current = []
    const initial = initialOfficeAutoQuality(performance.now())
    autoStateRef.current = initial
    setAutoTier(initial.tier)
    setAutoTransitions(0)
  }, [requestedMode])

  const recordFrame = useCallback(
    (frameMs: number): void => {
      if (!firstFrameRenderedRef.current) {
        firstFrameRenderedRef.current = true
        if (document.hidden) {
          setRenderActive(false)
          return
        }
      }
      if (requestedMode !== 'auto' || !renderActive) return
      if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > MAX_MEASURED_FRAME_MS) {
        frameSamplesRef.current = []
        return
      }
      const samples = frameSamplesRef.current
      samples.push(frameMs)
      if (samples.length < AUTO_SAMPLE_FRAMES) return
      frameSamplesRef.current = []
      const previous = autoStateRef.current
      const next = nextOfficeAutoQuality(previous, summarizeOfficeFrameTimes(samples), performance.now())
      autoStateRef.current = next
      if (next.tier !== previous.tier) setAutoTransitions((count) => count + 1)
      setAutoTier((current) => (current === next.tier ? current : next.tier))
    },
    [renderActive, requestedMode]
  )

  const resolvedTier = requestedMode === 'auto' ? autoTier : requestedMode
  const adaptiveProfile = resolutionMode === 'adaptive' && resolvedTier === 'high'
    ? { shadowMapSize: 512, contactShadowResolution: 256 }
    : {}
  return {
    renderActive,
    resolvedTier,
    autoTransitions,
    profile: { ...OFFICE_QUALITY_PROFILES[resolvedTier], ...adaptiveProfile, dpr: officeResolutionDpr(resolvedTier, resolutionMode, deviceRatio) },
    recordFrame
  }
}

export default function OfficeFrameDriver({
  active,
  onFrame
}: {
  active: boolean
  onFrame: (frameMs: number) => void
}): null {
  const advance = useThree((state) => state.advance)
  const gl = useThree((state) => state.gl)
  // Keep the RAF/render loop identity stable while the parent updates its
  // quality instrumentation callback. Recreating the effect on every callback
  // change produces duplicate synchronous `advance` calls after camera
  // controls, which is observable as extra renderer passes on Intel GPUs.
  const onFrameRef = useRef(onFrame)
  const advanceRef = useRef(advance)
  const elapsedRef = useRef(0)

  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])
  useEffect(() => {
    advanceRef.current = advance
  }, [advance])

  useEffect(() => {
    if (!active) return
    let previous = performance.now()
    let frame = 0
    // A lost WebGL context cannot accept useful renderer work. In particular,
    // repeatedly calling R3F's synchronous `advance` while Chromium is
    // recovering the context can keep the renderer thread busy and prevent
    // CDP probes from observing the loss. Keep the RAF heartbeat alive so a
    // restored context can resume on the next tick, but skip all GL work until
    // the browser reports an active context again.
    const context = gl.getContext()
    const contextIsLost = (): boolean => {
      try { return context.isContextLost() }
      catch { return true }
    }
    const renderFrame = (frameMs?: number): void => {
      if (contextIsLost()) return
      const startedAt = performance.now()
      try {
        advanceRef.current(elapsedRef.current, true)
        recordOfficeRenderDuration(gl, performance.now() - startedAt)
        if (frameMs !== undefined) onFrameRef.current(frameMs)
      } catch (error) {
        // Context loss can race the preflight check. Suppress only that
        // recoverable case; surface unrelated renderer errors normally.
        if (!contextIsLost()) throw error
      }
    }
    // A newly mounted Electron canvas can briefly report an unfocused window
    // while requestAnimationFrame is still throttled. Render one useful frame
    // synchronously so the boot scene is visible during that handoff; the
    // normal RAF loop remains the source of subsequent animation and metrics.
    renderFrame()
    const tick = (now: number): void => {
      const delta = Math.min(0.1, Math.max(0, (now - previous) / 1_000))
      previous = now
      elapsedRef.current += delta
      renderFrame(delta * 1_000)
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [active, gl])

  return null
}
