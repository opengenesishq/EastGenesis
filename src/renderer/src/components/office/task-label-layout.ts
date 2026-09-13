export interface LabelRect { x: number; y: number; width: number; height: number }
export interface ProjectedTaskLabel extends LabelRect { id: string; priority: number }
export interface TaskLabelPlacement { id: string; x: number; y: number; visible: boolean }

/** Screen-space packing uses measured labels and real viewport/overlay rectangles. */
export function layoutTaskLabels(labels: ProjectedTaskLabel[], viewport: { width: number; height: number }, obstacles: LabelRect[] = []): TaskLabelPlacement[] {
  const occupied = [...obstacles]
  const result: TaskLabelPlacement[] = []
  const sorted = [...labels].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  for (const label of sorted) {
    const rect = candidatesFor(label).find((candidate) => insideViewport(candidate, viewport) && !occupied.some((other) => rectanglesOverlap(candidate, other, 5)))
    if (rect) occupied.push(rect)
    result.push({ id: label.id, x: rect?.x ?? label.x, y: rect?.y ?? label.y, visible: Boolean(rect) })
  }
  return result
}

export function rectanglesOverlap(a: LabelRect, b: LabelRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
}

function candidatesFor(label: ProjectedTaskLabel): LabelRect[] {
  const offsets = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [0, -2], [0, 2], [-1, 1], [1, 1]]
  return offsets.map(([x, y]) => ({ x: label.x - label.width / 2 + x * (label.width + 8), y: label.y - label.height + y * (label.height + 8), width: label.width, height: label.height }))
}

function insideViewport(rect: LabelRect, viewport: { width: number; height: number }): boolean {
  return rect.x >= 8 && rect.y >= 8 && rect.x + rect.width <= viewport.width - 8 && rect.y + rect.height <= viewport.height - 8
}
