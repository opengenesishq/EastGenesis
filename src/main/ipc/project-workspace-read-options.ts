import type { ProjectWorkspaceContentsOptions } from '../../shared/project-workspace-types'
import type { ListOptions } from '../project-workspace/store'

const LIST_OPTION_KEYS = new Set(['includeArchived', 'includeDeleted', 'goalId'])
const CONTENTS_OPTION_KEYS = new Set(['goals', 'workItems'])

export function normalizeListOptions(value: unknown): ListOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'list options')
  assertAllowedKeys(record, LIST_OPTION_KEYS, 'list options')
  if (record.includeArchived !== undefined && typeof record.includeArchived !== 'boolean') throw new Error('includeArchived must be boolean')
  if (record.includeDeleted !== undefined && typeof record.includeDeleted !== 'boolean') throw new Error('includeDeleted must be boolean')
  return {
    includeArchived: record.includeArchived as boolean | undefined,
    includeDeleted: record.includeDeleted as boolean | undefined,
    goalId: optionalString(record.goalId)
  }
}

export function normalizeContentsOptions(value: unknown): ProjectWorkspaceContentsOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'project contents options')
  assertAllowedKeys(record, CONTENTS_OPTION_KEYS, 'project contents options')
  return {
    ...(record.goals === undefined ? {} : { goals: normalizeListOptions(record.goals) }),
    ...(record.workItems === undefined ? {} : { workItems: normalizeListOptions(record.workItems) })
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function assertAllowedKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown field: ${key}`)
}

function optionalString(value: unknown, label = 'value'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}
