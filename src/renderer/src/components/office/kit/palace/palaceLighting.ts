/** Runtime projection of the authored palace lighting manifest.
 *
 * The source-of-truth is 3d/palace-whitebox-v2/lighting.json.  These values
 * are deliberately copied into a typed renderer contract so the application
 * can expose which authored fixtures it consumes without loading filesystem
 * JSON at runtime. Blender uses (x,y,z); glTF/R3F uses (x,z,-y).
 */
export interface PalaceLightingFixture {
  id: string
  type: 'AREA'
  location: [number, number, number]
  target: [number, number, number]
  energyWatts: number
  sizeMetres: number
  purpose: string
}

const fixture = (
  id: string,
  location: [number, number, number],
  target: [number, number, number],
  energyWatts: number,
  sizeMetres: number,
  purpose: string
): PalaceLightingFixture => ({ id, type: 'AREA', location, target, energyWatts, sizeMetres, purpose })

export const PALACE_LIGHTING_MANIFEST = {
  source: '3d/palace-whitebox-v2/lighting.json',
  sourceSha256: '0ef24013fb1a424a28c3f28fafd8afecd5209c3ea35fdc4213eca5f2801ad871',
  schema: 'caogen.palace-lighting.v2',
  worldStrength: 0.3,
  sun: { rotationDegrees: [27, -23, -28] as [number, number, number], energy: 2.2, angleDegrees: 12 },
  fixtures: [
    fixture('LIGHT_key', [10, 80, 40], [0, 0, -8], 50000, 65, 'exterior presentation'),
    fixture('LIGHT_hall_down_-9', [-9, 6.8, -14], [-9, 2.4, -14], 620, 4.5, 'interior diffuse ceiling fill'),
    fixture('LIGHT_hall_up_-9', [-9, 3, -14], [-9, 7.28, -14], 450, 3.8, 'coffer and structural underside review'),
    fixture('LIGHT_hall_down_0', [0, 6.8, -14], [0, 2.4, -14], 620, 4.5, 'interior diffuse ceiling fill'),
    fixture('LIGHT_hall_up_0', [0, 3, -14], [0, 7.28, -14], 450, 3.8, 'coffer and structural underside review'),
    fixture('LIGHT_hall_down_9', [9, 6.8, -14], [9, 2.4, -14], 620, 4.5, 'interior diffuse ceiling fill'),
    fixture('LIGHT_hall_up_9', [9, 3, -14], [9, 7.28, -14], 450, 3.8, 'coffer and structural underside review'),
    fixture('LIGHT_hall_entry', [0, 5.7, -8.1], [0, 4.2, -18.5], 700, 7, 'front opening bounce'),
    ...(['assistant', 'project', 'video', 'custom'] as const).flatMap((label) => [-5.8, 0, 5.8].map((offset) =>
      fixture(`LIGHT_${label}_${offset}`, [
        (label === 'assistant' || label === 'video' ? -36 : 36) + offset,
        3.5,
        (label === 'assistant' || label === 'project' ? 7 : -32) - 9.2
      ], [
        (label === 'assistant' || label === 'video' ? -36 : 36) + offset,
        0.6,
        (label === 'assistant' || label === 'project' ? 7 : -32) - 9.2
      ], 380, 3.2, 'business work surface fill')
    ))
  ] as PalaceLightingFixture[]
} as const

export const palaceLightingFixtureIds = PALACE_LIGHTING_MANIFEST.fixtures.map(({ id }) => id)
