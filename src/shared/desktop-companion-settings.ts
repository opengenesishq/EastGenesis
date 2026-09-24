import type { DesktopCompanionSettings, DesktopCompanionSize } from './desktop-companion-types'
export type { DesktopCompanionSettings, DesktopCompanionSize } from './desktop-companion-types'

export function normalizeDesktopCompanionSettings(value: unknown): DesktopCompanionSettings {
  const raw = value && typeof value === 'object' ? value as Partial<DesktopCompanionSettings> : {}
  const position = raw.position && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y)
    ? { x: Math.round(raw.position.x), y: Math.round(raw.position.y) } : undefined
  return { enabled: raw.enabled !== false, size: raw.size === 'small' || raw.size === 'large' ? raw.size : 'medium',
    mode: raw.mode === 'mini' ? 'mini' : 'figure',
    ...(typeof raw.imageId === 'string' && /^[a-f0-9]{64}$/.test(raw.imageId) ? { imageId: raw.imageId } : {}),
    ...(typeof raw.displayId === 'string' && /^-?\d+$/.test(raw.displayId) ? { displayId: raw.displayId } : {}), ...(position ? { position } : {}) }
}

export function desktopCompanionSize(size: DesktopCompanionSize, expanded: boolean, mode: 'figure' | 'mini' = 'figure'): { width: number; height: number } {
  if (expanded) return size === 'small' ? { width: 310, height: 500 } : size === 'large' ? { width: 380, height: 600 } : { width: 340, height: 550 }
  if (mode === 'mini') return size === 'small' ? { width: 280, height: 96 } : size === 'large' ? { width: 380, height: 110 } : { width: 330, height: 100 }
  return size === 'small' ? { width: 140, height: 170 } : size === 'large' ? { width: 220, height: 260 } : { width: 180, height: 220 }
}

export function clampCompanionBounds(bounds: { x: number; y: number; width: number; height: number }, area: { x: number; y: number; width: number; height: number }) {
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height)
  return { width, height, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))) }
}
