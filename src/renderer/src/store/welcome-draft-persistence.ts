import { AUTO_MODEL } from '../../../shared/types'
import type {
  WelcomeComputeSelectionSource,
  WelcomeDraftState
} from './welcome-draft'

export const WELCOME_DRAFT_STORAGE_KEY = 'caogen.welcome-draft.v1'
export const WELCOME_DRAFT_SCHEMA_VERSION = 5

const MAX_TEXT_LENGTH = 200_000
const MAX_PATH_LENGTH = 32_768
const MAX_ID_LENGTH = 2_048
const DRIVE_MODES = new Set(['spark', 'core', 'forge', 'command', 'genesis'])
const ROUTING_MODES = new Set(['fixed', 'provider', 'global'])
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
const TASK_STRATEGIES = new Set(['view', 'plan', 'execute'])

export function loadWelcomeDraft(
  fallback: WelcomeDraftState,
  storage: Storage | null = resolveStorage()
): WelcomeDraftState {
  if (!storage) return fallback
  try {
    const raw = storage.getItem(WELCOME_DRAFT_STORAGE_KEY)
    if (!raw) return fallback
    const payload = JSON.parse(raw) as { schemaVersion?: unknown; draft?: unknown }
    const draft = payload.schemaVersion === WELCOME_DRAFT_SCHEMA_VERSION
      ? parseDraft(payload.draft, false)
      : payload.schemaVersion === 4 || payload.schemaVersion === 3 || payload.schemaVersion === 2
        ? parseDraft(payload.draft, false)
      : payload.schemaVersion === 1
        ? parseDraft(payload.draft, true)
        : null
    if (draft) {
      if (payload.schemaVersion !== WELCOME_DRAFT_SCHEMA_VERSION) persistWelcomeDraft(draft, storage)
      return draft
    }
    storage.removeItem(WELCOME_DRAFT_STORAGE_KEY)
  } catch {
    try { storage.removeItem(WELCOME_DRAFT_STORAGE_KEY) } catch { /* best-effort recovery */ }
  }
  return fallback
}

export function persistWelcomeDraft(
  draft: WelcomeDraftState,
  storage: Storage | null = resolveStorage()
): void {
  if (!storage) return
  try {
    if (isEmptyDraft(draft)) storage.removeItem(WELCOME_DRAFT_STORAGE_KEY)
    else storage.setItem(
      WELCOME_DRAFT_STORAGE_KEY,
      JSON.stringify({ schemaVersion: WELCOME_DRAFT_SCHEMA_VERSION, draft })
    )
  } catch {
    // The in-memory draft remains usable when storage is unavailable or full.
  }
}

function resolveStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

function parseDraft(value: unknown, legacy: boolean): WelcomeDraftState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const draft = value as Record<string, unknown>
  if (!validDraftFields(draft, legacy)) return null
  return {
    text: draft.text, projectChoice: draft.projectChoice, cwd: draft.cwd, driveMode: draft.driveMode,
    routingMode: draft.routingMode, providerId: draft.providerId, model: draft.model, permissionMode: draft.permissionMode,
    taskStrategy: draft.taskStrategy, forkFromSdkSessionId: draft.forkFromSdkSessionId,
    forkCheckpointId: draft.forkCheckpointId, forkSourceTitle: draft.forkSourceTitle,
    draftVersion: Number.isSafeInteger(draft.draftVersion) ? draft.draftVersion : 0,
    computeSelectionSource: legacy
      ? inferLegacyComputeSelectionSource(draft)
      : draft.computeSelectionSource as WelcomeComputeSelectionSource
  } as unknown as WelcomeDraftState
}

function validDraftFields(draft: Record<string, unknown>, legacy: boolean): boolean {
  return [
    validString(draft.text, MAX_TEXT_LENGTH),
    validNullableString(draft.projectChoice, MAX_ID_LENGTH),
    validNullableString(draft.cwd, MAX_PATH_LENGTH),
    validNullableSet(draft.driveMode, DRIVE_MODES),
    validComputeSelectionSource(draft.computeSelectionSource, legacy),
    ROUTING_MODES.has(String(draft.routingMode)),
    validNullableString(draft.providerId, MAX_ID_LENGTH),
    validNullableString(draft.model, MAX_ID_LENGTH),
    validNullableSet(draft.permissionMode, PERMISSION_MODES),
    validOptionalSet(draft.taskStrategy, TASK_STRATEGIES),
    validForkFields(draft)
  ].every(Boolean)
}

function validNullableSet(value: unknown, allowed: Set<string>): boolean {
  return value === null || allowed.has(String(value))
}

function validOptionalSet(value: unknown, allowed: Set<string>): boolean {
  return value === undefined || allowed.has(String(value))
}

function validComputeSelectionSource(value: unknown, legacy: boolean): boolean {
  return legacy || value === 'default' || value === 'user'
}

function validForkFields(draft: Record<string, unknown>): boolean {
  return [
    validOptionalString(draft.forkFromSdkSessionId, MAX_ID_LENGTH),
    validOptionalString(draft.forkCheckpointId, MAX_ID_LENGTH),
    draft.forkCheckpointId === undefined || draft.forkFromSdkSessionId !== undefined,
    validOptionalString(draft.forkSourceTitle, MAX_ID_LENGTH)
  ].every(Boolean)
}

function inferLegacyComputeSelectionSource(
  draft: Record<string, unknown>
): WelcomeComputeSelectionSource {
  return draft.routingMode === 'global' && (draft.model === null || draft.model === AUTO_MODEL)
    ? 'default'
    : 'user'
}

function validString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function validNullableString(value: unknown, maxLength: number): value is string | null {
  return value === null || validString(value, maxLength)
}

function validOptionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || validString(value, maxLength)
}

function isEmptyDraft(draft: WelcomeDraftState): boolean {
  return draft.text === '' && draft.projectChoice === null && draft.cwd === null && draft.driveMode === null
    && draft.computeSelectionSource === 'default' && draft.routingMode === 'global'
    && draft.providerId === null && draft.model === null
    && draft.permissionMode === null && draft.taskStrategy === undefined
    && draft.forkFromSdkSessionId === undefined && draft.forkCheckpointId === undefined
    && draft.forkSourceTitle === undefined
}
