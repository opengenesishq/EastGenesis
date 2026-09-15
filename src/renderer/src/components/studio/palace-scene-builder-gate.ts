import {
  parsePalaceSceneManifest,
  type PalaceSceneActionBinding,
  type PalaceSceneManifest,
  type PalaceSceneRoleBinding,
  type PalaceSceneViewBinding,
  type PalaceSceneZone
} from '../../../../shared/palace-scene-manifest'
import type { PalaceSceneBuilderPatch } from '../../../../shared/palace-scene-builder-types'

/**
 * Renderer side boundary for Builder drafts. The shared parser is deliberately
 * pure and data-only, so malformed or executable shaped drafts are rejected
 * before they reach IPC. This helper must never acquire filesystem/network
 * capabilities.
 */
export interface PalaceSceneBuilderUiGateResult {
  ok: boolean
  manifest?: PalaceSceneManifest
  error?: string
}

export function parsePalaceSceneBuilderUiManifest(value: unknown): PalaceSceneManifest {
  return parsePalaceSceneManifest(value)
}

export function validatePalaceSceneBuilderUiManifest(value: unknown): PalaceSceneBuilderUiGateResult {
  try {
    return { ok: true, manifest: parsePalaceSceneBuilderUiManifest(value) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Build a complete declarative edit patch from the visible form state. */
export function buildPalaceSceneBuilderEditPatch(
  base: PalaceSceneManifest,
  draft: PalaceSceneManifest
): PalaceSceneBuilderPatch {
  const parsedBase = parsePalaceSceneBuilderUiManifest(base)
  const parsedDraft = parsePalaceSceneBuilderUiManifest(draft)
  const patch: PalaceSceneBuilderPatch = {}
  if (parsedDraft.title !== parsedBase.title) patch.title = parsedDraft.title
  if (!same(parsedDraft.zones, parsedBase.zones)) patch.zones = cloneRows(parsedDraft.zones)
  if (!same(parsedDraft.roleBindings, parsedBase.roleBindings)) patch.roleBindings = cloneRows(parsedDraft.roleBindings)
  if (!same(parsedDraft.viewBindings, parsedBase.viewBindings)) patch.viewBindings = cloneRows(parsedDraft.viewBindings)
  if (!same(parsedDraft.actionBindings, parsedBase.actionBindings)) patch.actionBindings = cloneRows(parsedDraft.actionBindings)
  if (!same(parsedDraft.theme, parsedBase.theme)) patch.theme = parsedDraft.theme ? { ...parsedDraft.theme } : {}
  if (!same(parsedDraft.camera, parsedBase.camera)) patch.camera = parsedDraft.camera ? { ...parsedDraft.camera } : undefined
  return patch
}

export function hasDeclarativeOnlyBuilderPayload(value: unknown): boolean {
  try {
    parsePalaceSceneBuilderUiManifest(value)
    const serialized = JSON.stringify(value)
    return !/(?:script|javascript|eval|fetch|network|request|webhook|socket|executable|runtime|callback)/iu.test(serialized)
  } catch {
    return false
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneRows<T extends PalaceSceneZone | PalaceSceneRoleBinding | PalaceSceneViewBinding | PalaceSceneActionBinding>(rows: T[]): T[] {
  return rows.map((row) => structuredClone(row))
}
