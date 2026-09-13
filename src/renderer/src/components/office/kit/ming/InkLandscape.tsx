import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Shape, ShapeGeometry } from 'three'
import { inkClock } from './InkToonMaterial'
import { useOfficeReducedMotion } from '../../useOfficeReducedMotion'

function mountainGeometry(layer: number): ShapeGeometry {
  const shape = new Shape()
  shape.moveTo(-34, -6)
  shape.lineTo(-34, 1)
  for (let index = 0; index < 12; index++) {
    const x = -34 + index * 5.8
    const peak = 3.3 + Math.sin(index * 1.73 + layer) * 2.1 + (index % 3) * .75
    shape.bezierCurveTo(x + 1.1, peak - .8, x + 1.9, peak + .7, x + 2.9, peak)
    shape.bezierCurveTo(x + 4.1, peak - 1, x + 4.8, peak - 1.7, x + 5.8, 1.1 + Math.sin(index + layer))
  }
  shape.lineTo(36, -6); shape.closePath()
  return new ShapeGeometry(shape, 12)
}

/** Original distant silhouettes stay behind the academy and never intercept controls. */
export default function InkLandscape(): React.JSX.Element {
  const reducedMotion = useOfficeReducedMotion()
  const mountains = useMemo(() => [0, 1, 2].map(mountainGeometry), [])
  useEffect(() => () => mountains.forEach((geometry) => geometry.dispose()), [mountains])
  useFrame((_state, delta) => { if (!reducedMotion) inkClock.value += Math.min(delta, .1) })
  return <group name="caotai-original-ink-landscape" userData={{ assetOrigin: 'caogen-original-procedural' }}>
    {mountains.map((geometry, index) => <mesh key={index} geometry={geometry}
      position={[index * 2 - 2, 2.3 + index * .7, -20 - index * 4]} renderOrder={-10 - index} raycast={() => undefined}>
      <meshBasicMaterial color={['#879c93', '#a5b2a6', '#bec6b7'][index]} transparent opacity={.24 - index * .035} depthWrite={false} fog={false} />
    </mesh>)}
  </group>
}
