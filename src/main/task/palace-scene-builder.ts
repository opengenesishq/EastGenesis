/**
 * Palace Builder's first phase is deliberately a data-only editing surface.
 *
 * This module owns no Effect, IPC, filesystem, network, script or renderer
 * execution. It edits a validated PalaceScene manifest, keeps immutable
 * version summaries in memory, and can restore an earlier manifest exactly.
 * Persistence and command execution remain outside this boundary.
 */

import { createHash } from 'node:crypto'
import { parsePalaceSceneManifest, type PalaceSceneManifest } from '../../shared/palace-scene-manifest'
import type {
  PalaceSceneBuilderChangeArea,
  PalaceSceneBuilderPatch,
  PalaceSceneBuilderSnapshot,
  PalaceSceneBuilderVersion,
  PalaceSceneBuilderVersionSummary
} from '../../shared/palace-scene-builder-types'

export type {
  PalaceSceneBuilderChangeArea,
  PalaceSceneBuilderPatch,
  PalaceSceneBuilderSnapshot,
  PalaceSceneBuilderVersion,
  PalaceSceneBuilderVersionSummary
} from '../../shared/palace-scene-builder-types'

const DIGEST = /^sha256:[a-f0-9]{64}$/u

/** Stable JSON encoding: object keys are sorted, array order remains semantic. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stable(item)]))
}

function digestManifest(manifest: PalaceSceneManifest): `sha256:${string}` {
  const encoded = JSON.stringify(stable(manifest))
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function normalizeLayoutVersion(manifest: PalaceSceneManifest): PalaceSceneManifest {
  const layoutVersion = manifest.layoutVersion ?? manifest.version
  if (!Number.isSafeInteger(layoutVersion) || layoutVersion < 1) {
    throw new Error('Palace Builder layoutVersion must be a positive safe integer')
  }
  return parsePalaceSceneManifest({ ...manifest, layoutVersion })
}

function changedAreas(patch: PalaceSceneBuilderPatch): PalaceSceneBuilderChangeArea[] {
  const areas: PalaceSceneBuilderChangeArea[] = []
  if (patch.title !== undefined) areas.push('metadata')
  if (patch.layoutVersion !== undefined) areas.push('layout')
  if (patch.zones !== undefined) areas.push('zones')
  if (patch.roleBindings !== undefined) areas.push('roles')
  if (patch.viewBindings !== undefined) areas.push('views')
  if (patch.actionBindings !== undefined) areas.push('actions')
  if (patch.theme !== undefined) areas.push('theme')
  if (patch.camera !== undefined) areas.push('camera')
  return areas
}

function nextManifest(base: PalaceSceneManifest, patch: PalaceSceneBuilderPatch): PalaceSceneManifest {
  const areas = changedAreas(patch)
  if (areas.length === 0) throw new Error('Palace Builder edit must change at least one declarative field')
  const nextVersion = base.version + 1
  const baseLayoutVersion = base.layoutVersion ?? base.version
  const nextLayoutVersion = patch.layoutVersion ?? (baseLayoutVersion + 1)
  if (!Number.isSafeInteger(nextVersion) || !Number.isSafeInteger(nextLayoutVersion) || nextLayoutVersion < 1) {
    throw new Error('Palace Builder version overflow or invalid layoutVersion')
  }
  if (nextLayoutVersion <= baseLayoutVersion) throw new Error('Palace Builder layoutVersion must advance monotonically')
  const candidate: PalaceSceneManifest = {
    ...clone(base),
    ...patch,
    version: nextVersion,
    layoutVersion: nextLayoutVersion,
    zones: patch.zones === undefined ? base.zones : clone(patch.zones),
    roleBindings: patch.roleBindings === undefined ? base.roleBindings : clone(patch.roleBindings),
    viewBindings: patch.viewBindings === undefined ? base.viewBindings : clone(patch.viewBindings),
    actionBindings: patch.actionBindings === undefined ? base.actionBindings : clone(patch.actionBindings),
    ...(patch.theme === undefined ? (base.theme === undefined ? {} : { theme: clone(base.theme) }) : { theme: clone(patch.theme) }),
    ...(patch.camera === undefined ? (base.camera === undefined ? {} : { camera: clone(base.camera) }) : { camera: clone(patch.camera) })
  }
  // Parsing before mutation gives the editor an atomic, fail-closed boundary.
  return parsePalaceSceneManifest(candidate)
}

/** Pure one-shot patch helper for renderer or preload callers that do not need history. */
export function applyPalaceSceneBuilderPatch(
  manifest: PalaceSceneManifest,
  patch: PalaceSceneBuilderPatch
): PalaceSceneManifest {
  return nextManifest(importPalaceSceneBuilderManifest(manifest), patch)
}

function makeSummary(
  manifest: PalaceSceneManifest,
  builderRevision: number,
  change: PalaceSceneBuilderVersionSummary['change'],
  changed: PalaceSceneBuilderChangeArea[],
  parentDigest?: `sha256:${string}`,
  restoredFromRevision?: number
): PalaceSceneBuilderVersionSummary {
  return {
    builderRevision,
    manifestVersion: manifest.version,
    layoutVersion: manifest.layoutVersion ?? manifest.version,
    digest: digestManifest(manifest),
    ...(parentDigest ? { parentDigest } : {}),
    change,
    changedAreas: [...changed],
    ...(restoredFromRevision === undefined ? {} : { restoredFromRevision })
  }
}

/**
 * Import a manifest from JSON or an object. JSON parsing and manifest parsing
 * happen before any state is created; malformed or executable/network-shaped
 * input therefore cannot enter a Builder session.
 */
export function importPalaceSceneBuilderManifest(input: string | unknown): PalaceSceneManifest {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      throw new Error('Palace Builder import rejected: invalid JSON')
    }
  }
  return normalizeLayoutVersion(parsePalaceSceneManifest(value))
}

/** Descriptive aliases kept stable for callers that prefer parse/serialize terminology. */
export const parsePalaceSceneBuilderManifest = importPalaceSceneBuilderManifest

export function exportPalaceSceneBuilderManifest(manifest: PalaceSceneManifest): string {
  return JSON.stringify(importPalaceSceneBuilderManifest(manifest))
}

export const serializePalaceSceneBuilderManifest = exportPalaceSceneBuilderManifest

export class PalaceSceneBuilderSession {
  private current: PalaceSceneManifest
  private currentSummary: PalaceSceneBuilderVersionSummary
  private readonly summaries: PalaceSceneBuilderVersionSummary[]
  private readonly manifests = new Map<`sha256:${string}`, PalaceSceneManifest>()

  constructor(initial: PalaceSceneManifest | string) {
    this.current = importPalaceSceneBuilderManifest(initial)
    this.currentSummary = makeSummary(this.current, 1, 'initial', ['metadata', 'layout', 'zones', 'roles', 'views', 'actions', 'theme', 'camera'])
    this.summaries = [clone(this.currentSummary)]
    this.manifests.set(this.currentSummary.digest, clone(this.current))
  }

  snapshot(): PalaceSceneBuilderSnapshot {
    const versions = this.summaries.map((summary) => ({ summary: clone(summary), manifest: clone(this.manifests.get(summary.digest)!) }))
    return { manifest: clone(this.current), summary: clone(this.currentSummary), history: clone(this.summaries), versions }
  }

  edit(patch: PalaceSceneBuilderPatch): PalaceSceneBuilderSnapshot {
    const candidate = nextManifest(this.current, patch)
    const previous = this.currentSummary
    const areas = changedAreas(patch)
    // Every accepted edit advances the layout contract revision, including a
    // metadata-only edit, so the summary records that boundary explicitly.
    if (!areas.includes('layout')) areas.push('layout')
    const summary = makeSummary(candidate, previous.builderRevision + 1, 'edit', areas, previous.digest)
    this.current = candidate
    this.currentSummary = summary
    this.summaries.push(clone(summary))
    this.manifests.set(summary.digest, clone(candidate))
    return this.snapshot()
  }

  rollback(builderRevision: number): PalaceSceneBuilderSnapshot {
    if (!Number.isSafeInteger(builderRevision) || builderRevision < 1) {
      throw new Error('Palace Builder rollback requires a positive builder revision')
    }
    const target = this.summaries.find((item) => item.builderRevision === builderRevision)
    if (!target) throw new Error(`Palace Builder rollback revision not found: ${builderRevision}`)
    // The manifest is retained privately by digest so summaries cannot be used
    // to manufacture a state that was never imported or edited successfully.
    const targetManifest = this.manifests.get(target.digest)
    if (!targetManifest) throw new Error(`Palace Builder rollback manifest missing: ${target.digest}`)
    const previous = this.currentSummary
    const summary = makeSummary(targetManifest, previous.builderRevision + 1, 'rollback', ['layout', 'zones', 'roles', 'views', 'actions', 'theme', 'camera'], previous.digest, builderRevision)
    this.current = clone(targetManifest)
    this.currentSummary = summary
    this.summaries.push(clone(summary))
    this.manifests.set(summary.digest, clone(targetManifest))
    return this.snapshot()
  }

  export(): string {
    return exportPalaceSceneBuilderManifest(this.current)
  }

  /** Internal restore hook keeps snapshot hydration inside the session boundary. */
  hydrateFromSnapshot(current: PalaceSceneManifest, summary: PalaceSceneBuilderVersionSummary, versions: PalaceSceneBuilderVersion[]): void {
    this.current = clone(current)
    this.currentSummary = clone(summary)
    this.summaries.splice(0, this.summaries.length, ...versions.map((entry) => clone(entry.summary)))
    this.manifests.clear()
    for (const entry of versions) this.manifests.set(entry.summary.digest, clone(entry.manifest))
  }

}

/** Construct a session from a validated manifest or JSON document. */
export function createPalaceSceneBuilder(initial: PalaceSceneManifest | string): PalaceSceneBuilderSession {
  return new PalaceSceneBuilderSession(initial)
}

export const createPalaceSceneBuilderSession = createPalaceSceneBuilder

/** Restore a validated persisted snapshot while retaining historical rollback manifests. */
export function restorePalaceSceneBuilderSession(snapshot: PalaceSceneBuilderSnapshot): PalaceSceneBuilderSession {
  if (!snapshot || !Array.isArray(snapshot.history) || !Array.isArray(snapshot.versions) || snapshot.history.length !== snapshot.versions.length || snapshot.history.length < 1) {
    throw new Error('Palace Builder restore rejected: history is incomplete')
  }
  const versions = snapshot.versions.map((entry) => ({ summary: clone(entry.summary), manifest: importPalaceSceneBuilderManifest(entry.manifest) }))
  for (let index = 0; index < versions.length; index += 1) {
    const entry = versions[index]
    if (entry.summary.builderRevision !== index + 1 || palaceSceneBuilderDigest(entry.manifest) !== entry.summary.digest) throw new Error('Palace Builder restore rejected: version summary digest mismatch')
    if (index > 0 && versions[index - 1].summary.builderRevision >= entry.summary.builderRevision) throw new Error('Palace Builder restore rejected: revisions are not monotonic')
  }
  const current = importPalaceSceneBuilderManifest(snapshot.manifest)
  const last = versions[versions.length - 1]
  if (snapshot.summary.builderRevision !== last.summary.builderRevision || palaceSceneBuilderDigest(current) !== snapshot.summary.digest || snapshot.summary.digest !== last.summary.digest) throw new Error('Palace Builder restore rejected: current summary mismatch')
  const session = new PalaceSceneBuilderSession(versions[0].manifest)
  session.hydrateFromSnapshot(current, snapshot.summary, versions)
  return session
}

export function palaceSceneBuilderDigest(manifest: PalaceSceneManifest): `sha256:${string}` {
  const parsed = importPalaceSceneBuilderManifest(manifest)
  const result = digestManifest(parsed)
  if (!DIGEST.test(result)) throw new Error('Palace Builder produced an invalid digest')
  return result
}
