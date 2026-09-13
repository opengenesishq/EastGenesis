import { Box3, BufferGeometry, Group, Mesh, type Material, type Object3D } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { palaceReviewMaterial } from './palaceMaterial'

interface Batch {
  /** Material batches share static architecture; only room roofs and cutaway
   * walls retain room identity so opening one hall does not open every hall. */
  key: string
  semantic: Object3D
  roof: boolean
  cutawayRoom?: string
  cutawayWall: boolean
  authoredCharacter: boolean
  material: Material
  geometries: BufferGeometry[]
  names: string[]
}

export interface PalaceGeometry {
  scene: Group
  /** Authored central-hall figures, kept outside the batched architecture so
   * role hotspots can place the real source figures without making them part
   * of the room's static/cutaway batches. */
  authoredCharacters: Group
  sourceMeshes: number
  batches: number
  architectureBatches: number
  authoredCharacterBatches: number
  removedScaleReferences: number
  removedSampleFurniture: number
  roofBatches: number
  authoredCharacterGroups: string[]
}

function extractAuthoredCharacter(root: Object3D): Group {
  root.updateMatrixWorld(true)
  const roleId = String(root.userData.role_id ?? root.name.replace(/^CHAR_/, ''))
  const figure = new Group()
  figure.name = root.name
  figure.userData = {
    ...root.userData,
    roleId,
    palaceAuthoredCharacter: true,
    palaceSemanticGroup: root.name,
    stateSource: 'unbound_review_asset',
    projectionOnly: true,
    sourceRootMatrix: root.matrixWorld.toArray()
  }
  const meshes: Mesh[] = []
  root.traverse((node) => { if (node instanceof Mesh) meshes.push(node) })
  const relativeRoot = root.matrixWorld.clone().invert()
  const bounds = new Box3()
  for (const sourceMesh of meshes) {
    // Sockets are empty Object3D nodes; every mesh here is an authored
    // surface/tool and must retain its authored material separation.
    const relativeMatrix = relativeRoot.clone().multiply(sourceMesh.matrixWorld)
    let geometry = sourceMesh.geometry.clone().applyMatrix4(relativeMatrix)
    for (const name of Object.keys(geometry.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name)
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals()
    if (geometry.index) {
      const indexed = geometry
      geometry = indexed.toNonIndexed()
      indexed.dispose()
    }
    geometry.computeBoundingBox()
    if (geometry.boundingBox) bounds.union(geometry.boundingBox)
    const material = Array.isArray(sourceMesh.material) ? sourceMesh.material[0] : sourceMesh.material
    const mesh = new Mesh(geometry, palaceReviewMaterial(material))
    mesh.name = sourceMesh.name
    mesh.userData = {
      ...sourceMesh.userData,
      palaceAuthoredCharacter: true,
      roleId,
      stateSource: 'unbound_review_asset',
      projectionOnly: true
    }
    mesh.castShadow = true
    mesh.receiveShadow = true
    // Interaction belongs to the role hotspot's explicit target, so the
    // authored surface cannot steal pointer events from that target.
    mesh.raycast = () => undefined
    figure.add(mesh)
  }
  // Source roots carry their placement in the palace GLB. Normalize to a
  // grounded local figure without centering an asymmetric hand-held tool.
  // The authored root is already the feet's x/z origin. SystemRoleHotspots
  // supplies the catalog position and owns the projection placement.
  if (!bounds.isEmpty()) {
    figure.children.forEach((child) => { child.position.y -= bounds.min.y })
    figure.userData.footNormalizationY = -bounds.min.y
  }
  figure.updateMatrixWorld(true)
  return figure
}

export function setPalaceRoomVisibility(scene: Group, cutaway: boolean, openedRoom?: string): void {
  scene.traverse((node) => {
    if (node.userData.palaceRoof === true || node.userData.palaceCutawayWall === true) {
      node.visible = !(cutaway || (openedRoom !== undefined && node.userData.palaceCutawayRoom === openedRoom))
    }
  })
}

function lineage(object: Object3D): Object3D[] {
  const result: Object3D[] = []
  for (let parent: Object3D | null = object; parent; parent = parent.parent) result.push(parent)
  return result
}

function semanticOwner(ancestors: Object3D[]): Object3D {
  return ancestors.find((node) => isAuthoredCharacterRoot(node)) ??
    ancestors.find((node) => /^(PAVILION_|HERO_|TOWER_|INNER_GATE|ARRIVAL_)/.test(node.name) && !('isMesh' in node)) ??
    ancestors.find((node) => node.userData.role) ?? ancestors.at(-1)!
}

function isAuthoredCharacterRoot(node: Object3D): boolean {
  return node.name.startsWith('CHAR_') && node.userData.category === 'character' &&
    (node.userData.original_geometry === true || node.userData.character_schema === 'caogen.palace-character.v1')
}

/** Only central-hall governance figures are durable room art. Business-line
 * sample figures in the same review GLB remain excluded; live workers are
 * projected separately from canonical sessions by OfficeView. */
const GOVERNANCE_ROLE_IDS = new Set([
  'taizi', 'neige', 'dongchang', 'xichang', 'libu', 'hubu', 'libu_ritual', 'bingbu', 'xingbu', 'gongbu'
])

function isGovernanceCharacterRoot(node: Object3D): boolean {
  return isAuthoredCharacterRoot(node) && GOVERNANCE_ROLE_IDS.has(String(node.userData.role_id ?? node.name.replace(/^CHAR_/, '')))
}

/** GLTFLoader commonly gives each source mesh its own Material instance even
 * when all instances have identical authored parameters. UUID based batching
 * would therefore preserve hundreds of redundant material switches. Keep the
 * visual parameters that affect the standard/toon material in the key so
 * equivalent instances share one GPU batch without mutating source assets. */
function materialBatchKey(material: Material): string {
  const candidate = material as Material & {
    color?: { getHexString?: () => string }
    roughness?: number
    metalness?: number
    opacity?: number
    transparent?: boolean
    side?: number
  }
  return [
    material.type,
    candidate.color?.getHexString?.() ?? '',
    candidate.roughness ?? '',
    candidate.metalness ?? '',
    candidate.opacity ?? '',
    candidate.transparent ? 1 : 0,
    candidate.side ?? '',
    material.userData.caogenInkSurface ?? ''
  ].join('|')
}

/** Merge static surfaces, retaining building identity and roof layers for selection/cutaway.
 * Authored CHAR_* role figures are a separate semantic batch family. Their
 * `unbound_review_asset` source is deliberately distinct from live
 * `officeSessionId` workers projected by OfficeView. */
export async function batchPalaceGeometry(source: Group): Promise<PalaceGeometry> {
  source.updateMatrixWorld(true)
  const meshes: Mesh[] = []
  source.traverse((node) => { if (node instanceof Mesh) meshes.push(node) })
  const authoredRoots: Object3D[] = []
  source.traverse((node) => { if (isGovernanceCharacterRoot(node)) authoredRoots.push(node) })
  const batches = new Map<string, Batch>()
  let removedScaleReferences = 0
  let removedSampleFurniture = 0
  const authoredCharacterNames = new Set<string>()
  for (let index = 0; index < meshes.length; index++) {
    const mesh = meshes[index]
    const ancestors = lineage(mesh)
    if (ancestors.some((node) => node.name.startsWith('SCALE_') || node.userData.role === 'scale_reference')) {
      removedScaleReferences++; continue
    }
    const semantic = semanticOwner(ancestors)
    const interior = ancestors.find((node) => /^(assistant_hall|project_hall|video_hall|custom_hall|HALL_main)$/.test(node.name))
    // Authored sample desks cannot overlap the canonical live workstations.
    // Retain wall archives and courtyard benches as architectural furniture.
    if (interior && mesh.userData.category === 'furniture' && !mesh.name.includes('archive')) {
      removedSampleFurniture++; continue
    }
    const authoredCharacter = isAuthoredCharacterRoot(semantic)
    if (authoredCharacter && isGovernanceCharacterRoot(semantic)) authoredCharacterNames.add(semantic.name)
    const roof = ancestors.some((node) => ['roof', 'ceiling_beam'].includes(String(node.userData.category)))
    const cutawayWall = Boolean(interior && /_(front|side-?1)$/.test(mesh.name))
    const cutawayRoom = (roof || cutawayWall) ? interior?.name : undefined
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    // Architecture has no pointer interaction (raycast is disabled below), so
    // preserving every source semantic as a separate GPU batch only adds
    // state changes. Room cutaways are the narrow exception to global
    // material batching. Live tasks keep their independent canonical identity.
    const key = `${authoredCharacter ? semantic.uuid : cutawayRoom ?? 'architecture'}:${authoredCharacter ? 'character' : 'architecture'}:${roof ? 'roof' : cutawayWall ? 'wall' : 'body'}:${materialBatchKey(material)}`
    let batch = batches.get(key)
    if (!batch) { batch = { key, semantic, roof, cutawayRoom, cutawayWall, authoredCharacter, material, geometries: [], names: [] }; batches.set(key, batch) }
    let geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal'].includes(name)) geometry.deleteAttribute(name)
    if (!geometry.attributes.normal) geometry.computeVertexNormals()
    if (geometry.index) { const indexed = geometry; geometry = indexed.toNonIndexed(); indexed.dispose() }
    batch.geometries.push(geometry); batch.names.push(mesh.name)
    // Yield between chunks so input and initial useful frames remain responsive.
    if (index % 128 === 127) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const scene = new Group()
  scene.name = 'palace-authored-architecture'
  scene.userData = { importedModels: 1, authoredScaleMetres: 1, stateSource: 'architecture-only' }
  const groups = new Map<string, Group>()
  for (const batch of batches.values()) {
    // Authored figures are extracted below as role projections rather than
    // merged into architecture. Do not add their transformed geometry to the
    // architecture scene or duplicate them as proxies.
    if (batch.authoredCharacter) {
      batch.geometries.forEach((part) => part.dispose())
      continue
    }
    let group = groups.get(batch.key)
    if (!group) {
      group = new Group()
      group.name = batch.authoredCharacter
        ? batch.semantic.name
        : `ARCHITECTURE_${batch.roof ? 'roof' : 'body'}_${batch.material.name || 'material'}`
      group.userData = { ...batch.semantic.userData, palaceSemanticGroup: true,
        palaceAuthoredCharacter: batch.authoredCharacter, stateSource: batch.authoredCharacter ? 'unbound_review_asset' : 'architecture-only' }
      groups.set(batch.key, group); scene.add(group)
    }
    const geometry = mergeGeometries(batch.geometries, false)
    batch.geometries.forEach((part) => part.dispose())
    if (!geometry) throw new Error(`Palace geometry batch failed: ${group.name}`)
    geometry.computeBoundingBox(); geometry.computeBoundingSphere()
    const mesh = new Mesh(geometry, palaceReviewMaterial(batch.material))
    mesh.name = `${group.name}:${batch.roof ? 'roof' : 'body'}:${batch.material.name}`
    mesh.userData = { palaceRoof: batch.roof, palaceCutawayRoom: batch.cutawayRoom, palaceCutawayWall: batch.cutawayWall, palaceAuthoredCharacter: batch.authoredCharacter,
      sourceObjects: batch.names, palaceSemanticGroup: group.name, stateSource: batch.authoredCharacter ? 'unbound_review_asset' : 'architecture-only' }
    mesh.receiveShadow = true; mesh.castShadow = false
    // Task figures and courtyard hotspots own pointer events; architecture cannot steal them.
    mesh.raycast = () => undefined
    group.add(mesh)
  }
  const authoredCharacters = new Group()
  authoredCharacters.name = 'palace-authored-governance-figures'
  authoredCharacters.userData = {
    stateSource: 'unbound_review_asset', projectionOnly: true,
    canonicalSource: 'HALL_main', authoredCharacterCount: authoredRoots.length
  }
  for (const root of authoredRoots) authoredCharacters.add(extractAuthoredCharacter(root))
  const sourceGeometries = new Set(meshes.map((mesh) => mesh.geometry))
  sourceGeometries.forEach((geometry) => geometry.dispose())
  const authoredCharacterBatches = [...batches.values()].filter((batch) => batch.authoredCharacter).length
  return { scene, authoredCharacters, sourceMeshes: meshes.length, batches: batches.size,
    architectureBatches: batches.size - authoredCharacterBatches, authoredCharacterBatches, removedScaleReferences, removedSampleFurniture,
    roofBatches: [...batches.values()].filter((batch) => batch.roof && !batch.authoredCharacter).length,
    authoredCharacterGroups: [...authoredCharacterNames].sort() }
}
