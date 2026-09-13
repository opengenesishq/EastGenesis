import { EdgesGeometry } from 'three'
import type { AcademyGeometryPart } from './academyGeometry'

export interface AcademyResource {
  key: string
  parts: AcademyGeometryPart[]
  outlines: EdgesGeometry[]
  users: number
  lastUsed: number
  bytes: number
  expiry?: ReturnType<typeof setTimeout>
}

const resources = new Map<string, AcademyResource>()
const TTL_MS = 60_000
const MAX_ENTRIES = 32
const MAX_BYTES = 16 * 1024 * 1024
export const ACADEMY_ARCHITECTURE_CACHE_KEY = 'academy:peer-courts-v2'

/** CPU geometry cache only; each real renderer owns and releases its own GPU resources. */
export function getAcademyResource(key: string, create: () => AcademyGeometryPart[]): AcademyResource {
  const cached = resources.get(key)
  if (cached) { cached.lastUsed = Date.now(); if (!cached.users) scheduleExpiry(cached); return cached }
  const parts = create()
  const outlines = parts.filter((part) => ['tile', 'wood', 'darkWood'].includes(part.color))
    .map((part) => new EdgesGeometry(part.geometry, 36))
  const bytes = [...parts.map((part) => part.geometry), ...outlines].reduce((sum, geometry) =>
    sum + (geometry.index?.array.byteLength ?? 0) + Object.values(geometry.attributes).reduce((total, attribute) => total + attribute.array.byteLength, 0), 0)
  const resource = { key, parts, outlines, bytes, users: 0, lastUsed: Date.now() }
  resources.set(key, resource)
  scheduleExpiry(resource)
  trimCache(key)
  return resource
}

export function retainAcademyResource(resource: AcademyResource): () => void {
  if (resource.expiry) clearTimeout(resource.expiry)
  resource.expiry = undefined
  resource.users++
  let released = false
  return () => {
    if (released) return
    released = true
    resource.users = Math.max(0, resource.users - 1)
    resource.lastUsed = Date.now()
    if (!resource.users) scheduleExpiry(resource)
    trimCache()
  }
}

export function hasCachedAcademyArchitecture(): boolean {
  return resources.has(ACADEMY_ARCHITECTURE_CACHE_KEY)
}

export function academyResourceCacheSnapshot(): { entries: number; bytes: number; retained: number } {
  const values = [...resources.values()]
  return { entries: values.length, bytes: values.reduce((sum, item) => sum + item.bytes, 0),
    retained: values.filter((item) => item.users > 0).length }
}

function scheduleExpiry(resource: AcademyResource): void {
  if (resource.expiry) clearTimeout(resource.expiry)
  resource.expiry = setTimeout(() => { if (!resource.users) evict(resource) }, TTL_MS)
  ;(resource.expiry as unknown as { unref?: () => void }).unref?.()
}

function evict(resource: AcademyResource): void {
  if (resources.get(resource.key) !== resource || resource.users) return
  if (resource.expiry) clearTimeout(resource.expiry)
  resources.delete(resource.key)
  resource.parts.forEach((part) => part.geometry.dispose())
  resource.outlines.forEach((geometry) => geometry.dispose())
}

function trimCache(except?: string): void {
  let totalBytes = [...resources.values()].reduce((sum, item) => sum + item.bytes, 0)
  const unused = [...resources.values()].filter((item) => !item.users && item.key !== except)
    .sort((left, right) => left.lastUsed - right.lastUsed)
  for (const resource of unused) {
    if (resources.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break
    evict(resource); totalBytes -= resource.bytes
  }
}
