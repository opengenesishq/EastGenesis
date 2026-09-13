import type { WebGLRenderer } from 'three'

// Keep the render-work sample on the renderer instance so the performance
// probe can read the exact `advance` span without coupling the frame driver to
// the probe component. This is CPU submission time for one frame; the regular
// requestAnimationFrame interval remains a separate interaction metric.
const renderDurations = new WeakMap<WebGLRenderer, number>()

export function recordOfficeRenderDuration(renderer: WebGLRenderer, durationMs: number): void {
  renderDurations.set(renderer, Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0)
}

export function readOfficeRenderDuration(renderer: WebGLRenderer): number {
  const value = renderDurations.get(renderer)
  return Number.isFinite(value) && (value ?? 0) >= 0 ? value ?? 0 : 0
}
