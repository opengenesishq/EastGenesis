import { PALACE_WORLD_LAYOUT } from '../palace/palaceWorldLayout'

/** Every registered business line uses the same authored court and paging rules. */
export const ACADEMY_COURTYARD_SLOTS = PALACE_WORLD_LAYOUT.courts

// Retained export for geometry diagnostics; these are shared slots, not a custom tier.
export const ACADEMY_CUSTOM_SLOTS = ACADEMY_COURTYARD_SLOTS
export const ACADEMY_WORKSPACE_CLEARANCE = PALACE_WORLD_LAYOUT.taskBounds

export function academyCourtyardWindow<T extends { id: string }>(lines: T[], selectedId?: string | null): T[] {
  const selected = Math.max(0, lines.findIndex((line) => line.id === selectedId))
  const start = Math.floor(selected / ACADEMY_COURTYARD_SLOTS.length) * ACADEMY_COURTYARD_SLOTS.length
  return lines.slice(start, start + ACADEMY_COURTYARD_SLOTS.length)
}
