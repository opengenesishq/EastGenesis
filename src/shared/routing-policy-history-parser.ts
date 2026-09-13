import type { RoutingLegacyJsonValue, RoutingLegacyMigrationRecord, RoutingLegacyResolution, RoutingLegacyTransition, RoutingRetiredIdentity } from './routing-policy-types'
import { digest, discriminant, fail, integer, list, record, stableId, unique } from './routing-policy-parse-fields'

const MAX_LEGACY_RULES = 100
/** Bound metadata growth without ever dropping old retired IDs to fit a limit. */
export function readRoutingRetiredIdentities(value: unknown, revision: number): RoutingRetiredIdentity[] {
  return unique(list(value, '$.retiredIdentities', (raw, path) => {
    const row = record(raw, path, ['id', 'lastVersion', 'retiredAtRevision'])
    return { id: stableId(row.id, `${path}.id`), lastVersion: integer(row.lastVersion, `${path}.lastVersion`, 1),
      retiredAtRevision: integer(row.retiredAtRevision, `${path}.retiredAtRevision`, 1, revision) }
  }, 10_000, 0), '$.retiredIdentities', (entry) => entry.id)
}
export function readRoutingLegacyTransition(value: unknown, path: string): RoutingLegacyTransition {
  const row = record(value, path, ['legacyDigest', 'resolutions'])
  return { legacyDigest: digest(row.legacyDigest, `${path}.legacyDigest`), resolutions: readResolutions(row.resolutions, `${path}.resolutions`) }
}
function readResolution(value: unknown, path: string): RoutingLegacyResolution {
  const kind = discriminant(value, path)
  if (kind === 'replace') {
    const row = record(value, path, ['kind', 'legacyIndex', 'ruleId'])
    return { kind, legacyIndex: integer(row.legacyIndex, `${path}.legacyIndex`, 0, MAX_LEGACY_RULES - 1), ruleId: stableId(row.ruleId, `${path}.ruleId`) }
  }
  if (kind === 'retire') {
    const row = record(value, path, ['kind', 'legacyIndex'])
    return { kind, legacyIndex: integer(row.legacyIndex, `${path}.legacyIndex`, 0, MAX_LEGACY_RULES - 1) }
  }
  return fail('INVALID_VALUE', `${path}.kind`, 'Only replace or retire is a legacy disposition.')
}
function readResolutions(value: unknown, path: string): RoutingLegacyResolution[] {
  const entries = unique(list(value, path, readResolution, MAX_LEGACY_RULES, 0), path, (entry) => String(entry.legacyIndex))
  assertUniqueReplacements(entries, path)
  return entries
}
function assertUniqueReplacements(entries: RoutingLegacyResolution[], path: string): void {
  const replacements = entries.filter((entry): entry is Extract<RoutingLegacyResolution, { kind: 'replace' }> => entry.kind === 'replace')
  unique(replacements, path, (entry) => entry.ruleId)
}
export function readRoutingLegacyMigrationRecord(value: unknown, revision: number): RoutingLegacyMigrationRecord {
  const path = '$.legacyMigration'
  const row = record(value, path, ['schemaVersion', 'migratedAtRevision', 'legacyDigest', 'originalRules', 'resolutions'])
  if (row.schemaVersion !== 1) fail('INVALID_VALUE', `${path}.schemaVersion`, 'Only migration schema 1 is supported.')
  const originalRules = list(row.originalRules, `${path}.originalRules`, (entry, at) => readLegacyJson(entry, at, 0), MAX_LEGACY_RULES, 0)
  const resolutions = readResolutions(row.resolutions, `${path}.resolutions`)
  assertLegacyCoverage(resolutions, originalRules.length, `${path}.resolutions`)
  return { schemaVersion: 1, migratedAtRevision: integer(row.migratedAtRevision, `${path}.migratedAtRevision`, 1, revision),
    legacyDigest: digest(row.legacyDigest, `${path}.legacyDigest`), originalRules, resolutions }
}
export function assertLegacyCoverage(resolutions: RoutingLegacyResolution[], count: number, path: string): void {
  assertUniqueReplacements(resolutions, path)
  const indices = new Set(resolutions.map((entry) => entry.legacyIndex))
  if (indices.size !== resolutions.length || resolutions.length !== count || resolutions.some((entry) => entry.legacyIndex >= count)) {
    fail('MIGRATION_INCOMPLETE', path, 'Every legacy array entry must have exactly one in-range disposition.')
  }
}
/** Original JSON is audit data. Unknown keys are preserved only here, never as active policy fields. */
function readLegacyJson(value: unknown, path: string, depth: number): RoutingLegacyJsonValue {
  if (depth > 10) fail('INVALID_VALUE', path, 'Legacy JSON exceeds the review depth bound.')
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 20_000) return value
  if (Array.isArray(value)) return list(value, path, (entry, at) => readLegacyJson(entry, at, depth + 1), 1000, 0)
  return readLegacyJsonObject(value, path, depth)
}
function readLegacyJsonObject(value: unknown, path: string, depth: number): { [key: string]: RoutingLegacyJsonValue } {
  if (!value || typeof value !== 'object') return fail('INVALID_SHAPE', path, 'Legacy archive must contain finite JSON values.')
  const keys = Object.getOwnPropertyNames(value)
  if (keys.length > 1000) fail('INVALID_VALUE', path, 'Legacy object exceeds the review field bound.')
  const row = record(value, path, keys)
  const result: { [key: string]: RoutingLegacyJsonValue } = {}
  for (const key of keys) Object.defineProperty(result, key, { value: readLegacyJson(row[key], `${path}.${key}`, depth + 1), enumerable: true, writable: true, configurable: true })
  return result
}
