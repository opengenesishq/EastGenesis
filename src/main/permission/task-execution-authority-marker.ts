import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import { activeSessionRecordsFromDocument } from '../active-session-registry-format'
import { historyEntriesFromDocument } from '../history-store-format'
import { runtimeContinuationReceiptPath } from '../session-runtime-continuation-path'
import { TaskExecutionAuthorityStore } from './task-execution-authority-store'

type MarkerMeta = Pick<SessionMeta, 'id' | 'createdAt' | 'cwd' | 'taskExecutionAuthorityRequired'> & Partial<SessionMeta>
const IDENTITY_FIELDS = ['id', 'createdAt', 'cwd', 'projectId', 'workspaceId', 'goalId', 'workItemId',
  'businessLineId', 'personalWorkspaceId', 'parentSessionId'] as const

/** A restriction is monotone across independently durable Session projections. */
export function reconcileTaskExecutionAuthorityMarker<T extends MarkerMeta>(meta: T, rootDir: string): T {
  const sources = [
    ...readRecords(join(rootDir, 'active-sessions.json'), activeSessionRecordsFromDocument),
    ...readRecords(join(rootDir, 'sessions.json'), historyEntriesFromDocument),
    ...readRecords(runtimeContinuationReceiptPath(rootDir, meta.id), activeSessionRecordsFromDocument)
  ]
  const merged = mergeTaskExecutionAuthorityMarker(meta, sources)
  // Revocation can commit while the Session snapshot write is unavailable.
  // Reading a same-Session private decision only carries the restriction; the
  // actual grant must still pass every current binding and permission check.
  return new TaskExecutionAuthorityStore(rootDir).hasPersistedRestriction(meta.id)
    ? { ...merged, taskExecutionAuthorityRequired: true }
    : merged
}

/** Kept separate so live Engine replacement can carry a restriction set while it awaited retirement. */
export function mergeTaskExecutionAuthorityMarker<T extends MarkerMeta>(meta: T, sources: readonly unknown[]): T {
  if (meta.taskExecutionAuthorityRequired !== undefined && meta.taskExecutionAuthorityRequired !== true) {
    throw new Error('TASK_AUTHORITY_MARKER_INVALID: task restriction cannot be reset')
  }
  let required = meta.taskExecutionAuthorityRequired === true
  for (const source of sources) {
    if (!isRecord(source) || source.id !== meta.id) continue
    if (source.taskExecutionAuthorityRequired !== undefined && source.taskExecutionAuthorityRequired !== true) {
      throw new Error('TASK_AUTHORITY_MARKER_INVALID: persisted task restriction is invalid')
    }
    if (source.taskExecutionAuthorityRequired !== true) continue
    if (IDENTITY_FIELDS.some(key => (source[key] ?? null) !== (meta[key] ?? null))) {
      throw new Error('TASK_AUTHORITY_MARKER_IDENTITY: restricted task recovery identity differs')
    }
    required = true
  }
  return required ? { ...meta, taskExecutionAuthorityRequired: true } : { ...meta }
}

function readRecords(path: string, parse: (value: unknown, source?: string) => unknown[]): unknown[] {
  let info
  try { info = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('TASK_AUTHORITY_MARKER_SOURCE: recovery source must be a regular file')
  return parse(JSON.parse(readFileSync(path, 'utf8')), path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
