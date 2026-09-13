import type { RoutingDiagnosticCode, RoutingParseResult } from './routing-policy-types'

export class RoutingParseFault extends Error {
  constructor(readonly code: RoutingDiagnosticCode, readonly path: string, message: string) { super(message) }
}
export function fail(code: RoutingDiagnosticCode, path: string, message: string): never {
  throw new RoutingParseFault(code, path, message)
}
export function parseResult<T>(read: () => T): RoutingParseResult<T> {
  try { return { ok: true, value: read() } } catch (error) {
    if (!(error instanceof RoutingParseFault)) throw error
    return { ok: false, diagnostics: [{ code: error.code, path: error.path, severity: 'error', message: error.message }] }
  }
}
export function record(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SHAPE', path, 'Expected an object.')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('INVALID_SHAPE', path, 'Expected a plain object.')
  const allowed = new Set([...required, ...optional])
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail('UNKNOWN_FIELD', `${path}.${String(key)}`, 'Unknown or cross-kind field.')
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !('value' in property) || property.value === undefined) fail('INVALID_SHAPE', `${path}.${key}`, 'Expected a defined data field.')
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail('MISSING_FIELD', `${path}.${key}`, 'Required field is missing.')
  return value as Record<string, unknown>
}
export function string(value: unknown, path: string, max = 200): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\u0000-\u001f]/.test(value)) {
    fail('INVALID_VALUE', path, `Expected nonempty trimmed text of at most ${max} characters.`)
  }
  return value
}
export function stableId(value: unknown, path: string): string {
  const id = string(value, path, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) fail('INVALID_VALUE', path, 'Expected a stable identifier.')
  return id
}
export function digest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_VALUE', path, 'Expected a SHA-256 digest.')
  return value
}
export function integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_VALUE', path, `Expected an integer from ${min} to ${max}.`)
  return value
}
export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_VALUE', path, 'Expected a boolean.')
  return value
}
export function oneOf<const T extends readonly string[]>(value: unknown, path: string, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) fail('INVALID_VALUE', path, `Expected one of ${choices.join(', ')}.`)
  return value as T[number]
}
export function list<T>(value: unknown, path: string, read: (value: unknown, path: string) => T, max: number, min = 1): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('INVALID_VALUE', path, `Expected an array with ${min} to ${max} entries.`)
  if (Object.getPrototypeOf(value) !== Array.prototype) fail('INVALID_SHAPE', path, 'Expected a plain array.')
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) fail('UNKNOWN_FIELD', path, 'Unexpected array property.')
  }
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field || !('value' in field)) fail('INVALID_SHAPE', `${path}[${index}]`, 'Sparse arrays and accessors are not supported.')
    return read(field.value, `${path}[${index}]`)
  })
}
export function unique<T>(values: T[], path: string, key: (value: T) => string): T[] {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const identity = key(value)
    if (seen.has(identity)) fail('DUPLICATE_VALUE', `${path}[${index}]`, 'Duplicate entry.')
    seen.add(identity)
  })
  return values
}
export function discriminant(value: unknown, path: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SHAPE', path, 'Expected a discriminated object.')
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  if (!descriptor || !('value' in descriptor)) fail('MISSING_FIELD', `${path}.kind`, 'Data discriminant is required.')
  return string(descriptor.value, `${path}.kind`, 40)
}
