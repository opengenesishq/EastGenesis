import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../project-workspace/persistence'
import {
  importPalaceSceneBuilderManifest,
  palaceSceneBuilderDigest,
  restorePalaceSceneBuilderSession,
  type PalaceSceneBuilderSession,
  type PalaceSceneBuilderSnapshot
} from './palace-scene-builder'

export const PALACE_SCENE_BUILDER_PERSISTENCE_SCHEMA_VERSION = 1 as const
export const PALACE_SCENE_BUILDER_PERSISTENCE_FORMAT = 'caogen.palace-scene-builder.v1' as const

export interface PersistedPalaceSceneBuilderSnapshot {
  format: typeof PALACE_SCENE_BUILDER_PERSISTENCE_FORMAT
  schemaVersion: typeof PALACE_SCENE_BUILDER_PERSISTENCE_SCHEMA_VERSION
  sceneId: string
  snapshot: PalaceSceneBuilderSnapshot
  digest: `sha256:${string}`
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stable(item)]))
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`
}

function requiredSceneId(sceneId: string): string {
  if (typeof sceneId !== 'string' || !sceneId.trim() || sceneId.length > 200) {
    throw new Error('Palace Builder persistence requires a bounded sceneId')
  }
  return sceneId
}

export function palaceSceneBuilderPersistencePath(rootDir: string, sceneId: string): string {
  const id = requiredSceneId(sceneId)
  const key = createHash('sha256').update(id).digest('hex')
  return join(rootDir, 'palace-scene-builder', `${key}.json`)
}

export async function persistPalaceSceneBuilderSnapshot(
  rootDir: string,
  sceneId: string,
  snapshot: PalaceSceneBuilderSnapshot
): Promise<PersistedPalaceSceneBuilderSnapshot> {
  const id = requiredSceneId(sceneId)
  // Re-validate before publishing so callers cannot persist a forged snapshot.
  const session = restorePalaceSceneBuilderSession(snapshot)
  const canonicalSnapshot = session.snapshot()
  const body = {
    format: PALACE_SCENE_BUILDER_PERSISTENCE_FORMAT,
    schemaVersion: PALACE_SCENE_BUILDER_PERSISTENCE_SCHEMA_VERSION,
    sceneId: id,
    snapshot: canonicalSnapshot
  } as const
  const record: PersistedPalaceSceneBuilderSnapshot = { ...body, digest: digest(body) }
  await atomicWrite(palaceSceneBuilderPersistencePath(rootDir, id), record)
  return record
}

export async function restorePalaceSceneBuilderSnapshot(
  rootDir: string,
  sceneId: string
): Promise<{ record: PersistedPalaceSceneBuilderSnapshot; session: PalaceSceneBuilderSession } | undefined> {
  const id = requiredSceneId(sceneId)
  let raw: string
  try {
    raw = await readFile(palaceSceneBuilderPersistencePath(rootDir, id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Palace Builder persistence rejected: invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Palace Builder persistence rejected: invalid record')
  const candidate = parsed as Partial<PersistedPalaceSceneBuilderSnapshot>
  if (candidate.format !== PALACE_SCENE_BUILDER_PERSISTENCE_FORMAT || candidate.schemaVersion !== PALACE_SCENE_BUILDER_PERSISTENCE_SCHEMA_VERSION || candidate.sceneId !== id || !candidate.snapshot || typeof candidate.digest !== 'string') {
    throw new Error('Palace Builder persistence rejected: unsupported or incomplete record')
  }
  const { digest: savedDigest, ...body } = candidate as PersistedPalaceSceneBuilderSnapshot
  if (savedDigest !== digest(body)) throw new Error('Palace Builder persistence rejected: digest mismatch')
  const session = restorePalaceSceneBuilderSession(candidate.snapshot)
  // Ensure the canonical manifest digest remains bound to the persisted summary.
  if (palaceSceneBuilderDigest(session.snapshot().manifest) !== session.snapshot().summary.digest) {
    throw new Error('Palace Builder persistence rejected: manifest digest mismatch')
  }
  return { record: candidate as PersistedPalaceSceneBuilderSnapshot, session }
}

export const savePalaceSceneBuilderSnapshot = persistPalaceSceneBuilderSnapshot
export const loadPalaceSceneBuilderSnapshot = restorePalaceSceneBuilderSnapshot
