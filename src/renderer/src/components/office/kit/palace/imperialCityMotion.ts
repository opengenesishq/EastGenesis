/** Local scene animation only; no inference of real workers or running tasks. */
export function imperialCityCourierFrame(elapsed: number, index: number): { x: number; z: number; heading: number; walking: boolean } {
  const phase = ((Math.max(0, elapsed) + index * 12) % 24)
  const lane = index % 2 ? -6.2 : 6.2
  if (phase < 8) return { x: lane, z: 4.5 - phase * 1.125, heading: Math.PI, walking: true }
  if (phase < 12) return { x: lane, z: -4.5, heading: lane > 0 ? -Math.PI / 2 : Math.PI / 2, walking: false }
  if (phase < 20) return { x: lane, z: -4.5 + (phase - 12) * 1.125, heading: 0, walking: true }
  return { x: lane, z: 4.5, heading: lane > 0 ? -Math.PI / 2 : Math.PI / 2, walking: false }
}
