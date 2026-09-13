import { createHash } from 'node:crypto'
import type { RoutingSettingsDocument } from './routing-settings-types'
import { fail } from '../../shared/routing-policy-parse-fields'

/** Main-only canonical JSON. Reject non-JSON inputs instead of silently dropping data. */
export function canonicalRoutingJson(value: unknown): string { return encodeJson(value, '$', new Set<object>()) }
export function routingSettingsDigest(value: unknown): string { return createHash('sha256').update(canonicalRoutingJson(value)).digest('hex') }
export function copySettingsDocument(value: unknown): RoutingSettingsDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SHAPE', '$', 'Settings must be a JSON object.')
  return JSON.parse(canonicalRoutingJson(value)) as RoutingSettingsDocument
}
/** Existing normalizers use optional object fields set to undefined. This is only
 * for their candidate output, after authoritative routing fields are restored. */
export function copyNormalizedSettingsCandidate(value: unknown): RoutingSettingsDocument {
  return JSON.parse(encodeJson(copySettingsObjectFields(value), '$', new Set<object>(), true)) as RoutingSettingsDocument
}
export function copySettingsObjectFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SHAPE', '$', 'Settings must be an object.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) fail('INVALID_SHAPE', '$', 'Settings must be a plain object.')
  const result: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('INVALID_SHAPE', '$', 'Settings keys must be strings.')
    Object.defineProperty(result, key, { value: dataField(value, key, `$.${key}`), enumerable: true, writable: true, configurable: true })
  }
  return result
}
function encodeJson(value: unknown, path: string, seen: Set<object>, omitObjectUndefined = false): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (!value || typeof value !== 'object') fail('INVALID_SHAPE', path, 'Expected finite JSON data without undefined values.')
  if (seen.has(value)) fail('INVALID_SHAPE', path, 'Cyclic settings values are not JSON.')
  seen.add(value)
  const encoded = Array.isArray(value) ? encodeArray(value, path, seen, omitObjectUndefined) : encodeObject(value, path, seen, omitObjectUndefined)
  seen.delete(value)
  return encoded
}
function dataField(value: object, key: PropertyKey, path: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !('value' in field)) fail('INVALID_SHAPE', path, 'Settings fields must be data properties.')
  return field.value
}
function encodeArray(value: unknown[], path: string, seen: Set<object>, omitObjectUndefined: boolean): string {
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('INVALID_SHAPE', path, 'Expected a dense JSON array without extra fields.')
  return `[${Array.from({ length: value.length }, (_, index) => encodeJson(dataField(value, String(index), `${path}[${index}]`), `${path}[${index}]`, seen, omitObjectUndefined)).join(',')}]`
}
function encodeObject(value: object, path: string, seen: Set<object>, omitObjectUndefined: boolean): string {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) fail('INVALID_SHAPE', path, 'Expected a plain JSON object.')
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) fail('INVALID_SHAPE', path, 'JSON keys must be strings.')
  const present = (keys as string[]).sort().filter((key) => !omitObjectUndefined || dataField(value, key, `${path}.${key}`) !== undefined)
  return `{${present.map((key) => `${JSON.stringify(key)}:${encodeJson(dataField(value, key, `${path}.${key}`), `${path}.${key}`, seen, omitObjectUndefined)}`).join(',')}}`
}
