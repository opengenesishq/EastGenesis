import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalRoutingJson, copySettingsDocument } from './routing-settings/routing-settings-json'
import type { RoutingSettingsDocument, RoutingSettingsSnapshot, RoutingSettingsCommitResult } from './routing-settings/routing-settings-types'

export const SETTINGS_SCHEMA_VERSION = 1
export class UnsupportedSettingsSchemaError extends Error {
  constructor(version: unknown) { super(`Unsupported settings schema version: ${String(version)}`) }
}
export class SettingsFileWriteError extends Error {
  readonly code?: string
  constructor(readonly commitState: 'not_committed' | 'unknown', cause: unknown) {
    super(commitState === 'not_committed' ? 'Settings were not committed.' : 'Settings commit outcome is unknown; reread before retrying.', { cause })
    // Preserve a classified filesystem/test failure for callers that need to
    // distinguish the injected/root cause while keeping the commit-state
    // contract as the public error semantics.
    this.code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined
  }
}

/** Read the complete authority, before AppSettings normalization can discard legacy data. */
export function readSettingsFileSnapshot(file: string): RoutingSettingsSnapshot {
  let bytes: Buffer
  try { bytes = readFileSync(file) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { token: 'absent', document: {} }
    throw error
  }
  const document = copySettingsDocument(JSON.parse(bytes.toString('utf8')))
  if (document._schemaVersion !== undefined && document._schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new UnsupportedSettingsSchemaError(document._schemaVersion)
  }
  return { document, token: createHash('sha256').update(bytes).digest('hex') }
}

/** The single-instance main process owns all settings writers. There is no yield
 * between whole-file comparison and replacement; independent OS writers remain outside this lock domain. */
export function compareAndWriteSettingsFile(file: string, input: { expectedToken: string; document: RoutingSettingsDocument }): RoutingSettingsCommitResult {
  const current = readSettingsFileSnapshot(file)
  if (current.token !== input.expectedToken) return { status: 'conflict' }
  const document = copySettingsDocument(input.document)
  if (canonicalRoutingJson(document) !== canonicalRoutingJson(current.document)) writeSettingsFileAtomic(file, document)
  return { status: 'committed' }
}

function writeSettingsFileAtomic(file: string, value: RoutingSettingsDocument): void {
  const directory = dirname(file), temporary = join(directory, `.settings.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  let commitState: 'not_committed' | 'unknown' = 'not_committed'
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    // Once rename is attempted, an unclassified filesystem exception cannot prove non-commit.
    commitState = 'unknown'
    renameSync(temporary, file)
    syncSettingsDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch { /* best effort descriptor cleanup */ } }
    if (existsSync(temporary)) { try { unlinkSync(temporary) } catch { /* canonical settings remain authoritative */ } }
    throw new SettingsFileWriteError(commitState, error)
  }
}

function syncSettingsDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // Preserve the existing writer's best-effort directory fsync on filesystems that reject it.
  }
}
