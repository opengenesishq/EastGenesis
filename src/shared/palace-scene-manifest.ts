/**
 * Declarative PalaceScene contract.
 *
 * A scene is a projection description only. It contains layout and bindings;
 * execution remains owned by the canonical Command/Policy planes.
 */

export const PALACE_SCENE_SCHEMA_VERSION = 1 as const

export const PALACE_SCENE_COMMAND_IDS = [
  'goal.create', 'goal.update', 'goal.acceptance.set', 'goal.transition', 'goal.archive', 'goal.restore',
  'work_item.create', 'work_item.update', 'work_item.reorder', 'work_item.acceptance.set',
  'work_item.transition', 'work_item.lease.acquire', 'work_item.lease.renew', 'work_item.lease.release'
] as const

export type PalaceSceneCommandId = typeof PALACE_SCENE_COMMAND_IDS[number]
export type PalaceSceneEntityKind = 'goal' | 'workItem' | 'run' | 'artifact' | 'evidence' | 'acceptance'

export interface PalaceSceneEntityRef {
  kind: PalaceSceneEntityKind
  id: string
}

export interface PalaceSceneZone {
  id: string
  title: string
  position?: { x: number; y: number; z: number }
  size?: { width: number; depth: number; height: number }
}

export interface PalaceSceneRoleBinding {
  id: string
  roleId: string
  zoneId: string
  target: PalaceSceneEntityRef
}

export type PalaceSceneViewKind = 'overview' | 'status' | 'timeline' | 'artifact' | 'evidence' | 'acceptance'

export interface PalaceSceneViewBinding {
  id: string
  kind: PalaceSceneViewKind
  zoneId: string
  target: PalaceSceneEntityRef
}

export interface PalaceSceneActionBinding {
  id: string
  label: string
  zoneId: string
  commandId: PalaceSceneCommandId
  policyId: string
  target: PalaceSceneEntityRef
}

export interface PalaceSceneTheme {
  primary?: string
  accent?: string
}

export interface PalaceSceneCamera {
  x: number
  y: number
  z: number
  targetX: number
  targetY: number
  targetZ: number
}

export interface PalaceSceneManifest {
  schemaVersion: typeof PALACE_SCENE_SCHEMA_VERSION
  id: string
  version: number
  /** Optional layout contract revision; legacy manifests default to version. */
  layoutVersion?: number
  title: string
  assetDigest: `sha256:${string}`
  source: { type: 'builtin' | 'local' | 'imported'; ref: string }
  license: { spdx: string; attribution?: string }
  zones: PalaceSceneZone[]
  roleBindings: PalaceSceneRoleBinding[]
  viewBindings: PalaceSceneViewBinding[]
  actionBindings: PalaceSceneActionBinding[]
  theme?: PalaceSceneTheme
  camera?: PalaceSceneCamera
}

const COMMAND_IDS = new Set<string>(PALACE_SCENE_COMMAND_IDS)
const ENTITY_KINDS = new Set<PalaceSceneEntityKind>(['goal', 'workItem', 'run', 'artifact', 'evidence', 'acceptance'])
const VIEW_KINDS = new Set<PalaceSceneViewKind>(['overview', 'status', 'timeline', 'artifact', 'evidence', 'acceptance'])
const HEX_DIGEST = /^sha256:[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const FORBIDDEN_KEYS = /(?:script|javascript|eval|fetch|network|request|webhook|socket|executable|runtime|callback)/iu

function invalid(path: string, message: string): never {
  throw new Error(`Invalid PalaceScene manifest at ${path}: ${message}`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.test(key)) invalid(`${path}.${key}`, 'executable or network fields are forbidden')
    if (!allowed.includes(key)) invalid(`${path}.${key}`, 'unknown field')
  }
}

function text(value: unknown, path: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value) invalid(path, 'expected a bounded non-empty string')
  return value
}

function id(value: unknown, path: string): string {
  const result = text(value, path, 128)
  if (!ID.test(result)) invalid(path, 'invalid identifier')
  return result
}

function entity(value: unknown, path: string): PalaceSceneEntityRef {
  const row = object(value, path); keys(row, ['kind', 'id'], path)
  const kind = text(row.kind, `${path}.kind`, 32) as PalaceSceneEntityKind
  if (!ENTITY_KINDS.has(kind)) invalid(`${path}.kind`, 'must reference a canonical Work OS entity')
  return { kind, id: id(row.id, `${path}.id`) }
}

function vec3(value: unknown, path: string): { x: number; y: number; z: number } {
  const row = object(value, path); keys(row, ['x', 'y', 'z'], path)
  for (const axis of ['x', 'y', 'z']) if (typeof row[axis] !== 'number' || !Number.isFinite(row[axis])) invalid(`${path}.${axis}`, 'expected a finite number')
  return { x: row.x as number, y: row.y as number, z: row.z as number }
}

function zone(value: unknown, path: string): PalaceSceneZone {
  const row = object(value, path); keys(row, ['id', 'title', 'position', 'size'], path)
  const result: PalaceSceneZone = { id: id(row.id, `${path}.id`), title: text(row.title, `${path}.title`) }
  if (row.position !== undefined) result.position = vec3(row.position, `${path}.position`)
  if (row.size !== undefined) {
    const size = object(row.size, `${path}.size`); keys(size, ['width', 'depth', 'height'], `${path}.size`)
    for (const axis of ['width', 'depth', 'height']) if (typeof size[axis] !== 'number' || !Number.isFinite(size[axis]) || (size[axis] as number) <= 0) invalid(`${path}.size.${axis}`, 'expected a positive finite number')
    result.size = { width: size.width as number, depth: size.depth as number, height: size.height as number }
  }
  return result
}

function bindingBase(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  const row = object(value, path); keys(row, allowed, path)
  return row
}

export function assertPalaceSceneManifest(value: unknown): asserts value is PalaceSceneManifest {
  const row = object(value, '$')
  keys(row, ['schemaVersion', 'id', 'version', 'layoutVersion', 'title', 'assetDigest', 'source', 'license', 'zones', 'roleBindings', 'viewBindings', 'actionBindings', 'theme', 'camera'], '$')
  if (row.schemaVersion !== PALACE_SCENE_SCHEMA_VERSION) invalid('$.schemaVersion', `must be ${PALACE_SCENE_SCHEMA_VERSION}`)
  id(row.id, '$.id'); text(row.title, '$.title')
  if (typeof row.version !== 'number' || !Number.isInteger(row.version) || row.version < 1) invalid('$.version', 'must be a positive integer')
  if (row.layoutVersion !== undefined && (typeof row.layoutVersion !== 'number' || !Number.isSafeInteger(row.layoutVersion) || row.layoutVersion < 1)) invalid('$.layoutVersion', 'must be a positive safe integer')
  if (typeof row.assetDigest !== 'string' || !HEX_DIGEST.test(row.assetDigest)) invalid('$.assetDigest', 'must be sha256 followed by 64 lowercase hex characters')
  const source = bindingBase(row.source, '$.source', ['type', 'ref'])
  if (!['builtin', 'local', 'imported'].includes(String(source.type))) invalid('$.source.type', 'unsupported source type')
  text(source.ref, '$.source.ref', 1024)
  const license = bindingBase(row.license, '$.license', ['spdx', 'attribution'])
  text(license.spdx, '$.license.spdx', 128)
  if (license.attribution !== undefined) text(license.attribution, '$.license.attribution', 2048)
  const zones = row.zones
  if (!Array.isArray(zones) || zones.length < 1 || zones.length > 128) invalid('$.zones', 'must contain 1-128 zones')
  const parsedZones = zones.map((item, index) => zone(item, `$.zones[${index}]`))
  const zoneIds = new Set(parsedZones.map((item) => item.id)); if (zoneIds.size !== parsedZones.length) invalid('$.zones', 'zone ids must be unique')
  for (const [field, parser] of [['roleBindings', parseRole] as const, ['viewBindings', parseView] as const, ['actionBindings', parseAction] as const]) {
    const rows = row[field]; if (!Array.isArray(rows) || rows.length > 512) invalid(`$.${field}`, 'must be an array with at most 512 entries')
    const ids = new Set<string>(); for (let index = 0; index < rows.length; index += 1) { const parsed = parser(rows[index], `$.${field}[${index}]`); if (ids.has(parsed.id)) invalid(`$.${field}[${index}].id`, 'binding ids must be unique within a collection'); ids.add(parsed.id); if (!zoneIds.has(parsed.zoneId)) invalid(`$.${field}[${index}].zoneId`, 'must reference an existing zone') }
  }
  if (row.theme !== undefined) { const theme = bindingBase(row.theme, '$.theme', ['primary', 'accent']); for (const key of ['primary', 'accent']) if (theme[key] !== undefined) text(theme[key], `$.theme.${key}`, 64) }
  if (row.camera !== undefined) { const camera = object(row.camera, '$.camera'); keys(camera, ['x', 'y', 'z', 'targetX', 'targetY', 'targetZ'], '$.camera'); for (const key of Object.keys(camera)) if (typeof camera[key] !== 'number' || !Number.isFinite(camera[key])) invalid(`$.camera.${key}`, 'expected a finite number') }
}

function parseRole(value: unknown, path: string): PalaceSceneRoleBinding {
  const row = bindingBase(value, path, ['id', 'roleId', 'zoneId', 'target'])
  return { id: id(row.id, `${path}.id`), roleId: id(row.roleId, `${path}.roleId`), zoneId: id(row.zoneId, `${path}.zoneId`), target: entity(row.target, `${path}.target`) }
}

function parseView(value: unknown, path: string): PalaceSceneViewBinding {
  const row = bindingBase(value, path, ['id', 'kind', 'zoneId', 'target']); const kind = text(row.kind, `${path}.kind`, 32) as PalaceSceneViewKind
  if (!VIEW_KINDS.has(kind)) invalid(`${path}.kind`, 'unsupported view kind')
  return { id: id(row.id, `${path}.id`), kind, zoneId: id(row.zoneId, `${path}.zoneId`), target: entity(row.target, `${path}.target`) }
}

function parseAction(value: unknown, path: string): PalaceSceneActionBinding {
  const row = bindingBase(value, path, ['id', 'label', 'zoneId', 'commandId', 'policyId', 'target']); const commandId = text(row.commandId, `${path}.commandId`, 128) as PalaceSceneCommandId
  if (!COMMAND_IDS.has(commandId)) invalid(`${path}.commandId`, 'must reference an existing canonical CommandId')
  return { id: id(row.id, `${path}.id`), label: text(row.label, `${path}.label`), zoneId: id(row.zoneId, `${path}.zoneId`), commandId, policyId: id(row.policyId, `${path}.policyId`), target: entity(row.target, `${path}.target`) }
}

export function parsePalaceSceneManifest(value: unknown): PalaceSceneManifest {
  assertPalaceSceneManifest(value)
  return structuredClone(value)
}

/**
 * Renderer-neutral runtime projection.  A manifest never contains executable
 * scene code; this projection only resolves bindings into deterministic data
 * that a 3D renderer or the bounded 2D fallback can consume.
 */
export type PalaceSceneRuntimeMode = '3d' | '2d-fallback'
export type PalaceSceneRuntimeFreshness = 'fresh' | 'stale'
export type PalaceSceneStaleReason = 'offline' | 'event-delay' | 'unknown'

export interface PalaceSceneRuntimeZone {
  id: string
  title: string
  x: number
  y: number
  z: number
  width: number
  depth: number
  height: number
}

export interface PalaceSceneRuntimeNode {
  id: string
  zoneId: string
  target: PalaceSceneEntityRef
  x: number
  y: number
  z: number
  kind: 'role' | PalaceSceneViewKind | 'action'
  roleId?: string
  label?: string
  commandId?: PalaceSceneCommandId
  policyId?: string
}

export interface PalaceSceneRuntimeProjection {
  schemaVersion: typeof PALACE_SCENE_SCHEMA_VERSION
  sceneId: string
  version: number
  /** Provenance is carried into runtime output for packaged auditability. */
  assetDigest: `sha256:${string}`
  source: PalaceSceneManifest['source']
  license: PalaceSceneManifest['license']
  mode: PalaceSceneRuntimeMode
  /** Every renderer can surface when this projection is behind the ledger. */
  freshness: PalaceSceneRuntimeFreshness
  stale: boolean
  staleReason?: PalaceSceneStaleReason
  zones: PalaceSceneRuntimeZone[]
  nodes: PalaceSceneRuntimeNode[]
}

export interface PalaceSceneRuntimeOptions {
  /** 3D is selected only when the caller explicitly advertises support. */
  supports3D?: boolean
  /** Offline/event-delayed views remain usable but must be visibly stale. */
  freshness?: PalaceSceneRuntimeFreshness
  staleReason?: PalaceSceneStaleReason
}

/**
 * Resolve a validated manifest to data-only runtime coordinates.  Explicit
 * zone positions are preserved; missing positions use a stable grid.  The
 * same projection is therefore suitable for an offline 2D fallback without
 * loading assets, executing scripts, or invoking CommandIds.
 */
export function resolvePalaceSceneRuntime(
  value: unknown,
  options: PalaceSceneRuntimeOptions = {}
): PalaceSceneRuntimeProjection {
  if (options.freshness === 'fresh' && options.staleReason !== undefined) {
    throw new Error('PalaceScene runtime freshness cannot be fresh with a stale reason')
  }
  if (options.freshness === 'stale' && options.staleReason === undefined) {
    throw new Error('PalaceScene stale runtime requires a stale reason')
  }
  const manifest = parsePalaceSceneManifest(value)
  const freshness = options.freshness ?? (options.staleReason === undefined ? 'fresh' : 'stale')
  const stale = freshness === 'stale'
  const zones = manifest.zones.map((zone, index) => {
    const position = zone.position ?? { x: (index % 4) * 12, y: 0, z: Math.floor(index / 4) * 10 }
    const size = zone.size ?? { width: 10, depth: 8, height: 4 }
    return { id: zone.id, title: zone.title, x: position.x, y: position.y, z: position.z, ...size }
  })
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]))
  const nodeAt = (zoneId: string, index: number): { x: number; y: number; z: number } => {
    const zone = zoneById.get(zoneId)
    if (!zone) throw new Error(`PalaceScene runtime zone resolution failed: ${zoneId}`)
    // Keep nodes inside their zone and deterministic across renderers.
    const column = index % 4
    const row = Math.floor(index / 4) % 4
    const marginX = Math.min(1, zone.width / 2)
    const marginZ = Math.min(1, zone.depth / 2)
    const innerWidth = Math.max(0, zone.width - marginX * 2)
    const innerDepth = Math.max(0, zone.depth - marginZ * 2)
    const x = innerWidth === 0 ? zone.x : zone.x - zone.width / 2 + marginX + (column + 0.5) * innerWidth / 4
    const z = innerDepth === 0 ? zone.z : zone.z - zone.depth / 2 + marginZ + (row + 0.5) * innerDepth / 4
    return { x, y: zone.y + Math.min(1, zone.height / 2), z }
  }
  const nodes: PalaceSceneRuntimeNode[] = []
  manifest.roleBindings.forEach((binding, index) => nodes.push({ id: binding.id, zoneId: binding.zoneId, target: binding.target, ...nodeAt(binding.zoneId, index), kind: 'role', roleId: binding.roleId }))
  manifest.viewBindings.forEach((binding, index) => nodes.push({ id: binding.id, zoneId: binding.zoneId, target: binding.target, ...nodeAt(binding.zoneId, index), kind: binding.kind }))
  manifest.actionBindings.forEach((binding, index) => nodes.push({ id: binding.id, zoneId: binding.zoneId, target: binding.target, ...nodeAt(binding.zoneId, index), kind: 'action', label: binding.label, commandId: binding.commandId, policyId: binding.policyId }))
  return {
    schemaVersion: manifest.schemaVersion,
    sceneId: manifest.id,
    version: manifest.version,
    assetDigest: manifest.assetDigest,
    source: manifest.source,
    license: manifest.license,
    mode: options.supports3D === true ? '3d' : '2d-fallback',
    freshness,
    stale,
    ...(stale ? { staleReason: options.staleReason ?? 'unknown' } : {}),
    zones,
    nodes
  }
}

/** Explicit entry point for callers that always need the renderer-independent fallback. */
export function projectPalaceScene2DFallback(value: unknown): PalaceSceneRuntimeProjection {
  return resolvePalaceSceneRuntime(value, { supports3D: false })
}
