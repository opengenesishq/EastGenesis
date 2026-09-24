import { useEffect, useMemo } from 'react'
import { DataTexture, EdgesGeometry, NearestFilter, RedFormat } from 'three'
import { ACADEMY_COLORS, type AcademyGeometryPart } from './academyGeometry'
import InkToonMaterial, { type InkSurface } from './InkToonMaterial'
import { retainAcademyResource, type AcademyResource } from './academyResourceCache'

const ignoreDecorativeRaycast = (): void => undefined

export default function AcademyMeshes({ parts, resource, colors }: { parts: AcademyGeometryPart[]; resource?: AcademyResource; colors?: Partial<Record<keyof typeof ACADEMY_COLORS, string>> }): React.JSX.Element {
  const gradient = useMemo(() => {
    const texture = new DataTexture(new Uint8Array([78, 145, 208, 255]), 4, 1, RedFormat)
    texture.minFilter = NearestFilter
    texture.magFilter = NearestFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true
    return texture
  }, [])
  useEffect(() => () => { gradient.dispose() }, [gradient])
  useEffect(() => resource ? retainAcademyResource(resource) : () => { parts.forEach((part) => part.geometry.dispose()) }, [parts, resource])
  const outlines = useMemo(() => resource?.outlines ?? parts.filter((part) => ['tile', 'wood', 'darkWood'].includes(part.color))
    .map((part) => new EdgesGeometry(part.geometry, 36)), [parts, resource])
  useEffect(() => () => { if (!resource) outlines.forEach((geometry) => geometry.dispose()) }, [outlines, resource])
  return <group userData={{ assetOrigin: 'caogen-original-procedural', style: 'ming-academy' }}>
    {parts.map(({ color, geometry }) => <mesh key={color} geometry={geometry} castShadow receiveShadow raycast={ignoreDecorativeRaycast}>
      <InkToonMaterial color={colors?.[color] ?? ACADEMY_COLORS[color]} gradientMap={gradient} surface={inkSurface(color)} />
    </mesh>)}
    {outlines.map((geometry, index) => <lineSegments key={index} geometry={geometry} raycast={ignoreDecorativeRaycast}>
      <lineBasicMaterial color="#34433d" transparent opacity={.18} depthWrite={false} />
    </lineSegments>)}
  </group>
}

function inkSurface(color: string): InkSurface {
  if (color === 'wood' || color === 'darkWood') return 'wood'
  if (color === 'tile' || color === 'tileEdge') return 'tile'
  if (color === 'water' || color === 'waterLight') return 'water'
  return color === 'stone' || color === 'paving' ? 'stone' : 'paper'
}
