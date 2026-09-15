import { app, ipcMain } from 'electron'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import {
  createPalaceSceneBuilder,
  type PalaceSceneBuilderPatch
} from '../task/palace-scene-builder'
import {
  persistPalaceSceneBuilderSnapshot,
  restorePalaceSceneBuilderSnapshot
} from '../task/palace-scene-builder-persistence'
import type {
  PalaceSceneBuilderManifestInput,
  PalaceSceneBuilderSnapshot
} from '../../shared/palace-scene-builder-types'

const CHANNELS = {
  get: 'palaceSceneBuilder:get',
  save: 'palaceSceneBuilder:save',
  edit: 'palaceSceneBuilder:edit',
  rollback: 'palaceSceneBuilder:rollback',
  export: 'palaceSceneBuilder:export'
} as const

function requiredSceneId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) {
    throw new Error('PalaceScene Builder requires a bounded sceneId')
  }
  return value
}

function requiredManifest(value: unknown): PalaceSceneBuilderManifestInput {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PalaceScene Builder requires a declarative manifest')
  }
  return value as PalaceSceneBuilderManifestInput
}

function requiredPatch(value: unknown): PalaceSceneBuilderPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PalaceScene Builder edit requires a declarative patch')
  }
  return value as PalaceSceneBuilderPatch
}

function requiredRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('PalaceScene Builder rollback requires a positive builder revision')
  }
  return value
}

async function readSession(sceneId: string) {
  const restored = await restorePalaceSceneBuilderSnapshot(app.getPath('userData'), sceneId)
  if (!restored) throw new Error(`PalaceScene Builder scene not found: ${sceneId}`)
  return restored.session
}

async function persist(sceneId: string, snapshot: PalaceSceneBuilderSnapshot): Promise<PalaceSceneBuilderSnapshot> {
  await persistPalaceSceneBuilderSnapshot(app.getPath('userData'), sceneId, snapshot)
  return snapshot
}

/**
 * Renderer boundary for PalaceScene Builder. Every handler is explicit and
 * receives only declarative data. No renderer supplied filesystem or external
 * capability is accepted here.
 */
export function registerPalaceSceneBuilderIpc(): void {
  ipcMain.handle(CHANNELS.get, async (event, rawSceneId: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const sceneId = requiredSceneId(rawSceneId)
    const restored = await restorePalaceSceneBuilderSnapshot(app.getPath('userData'), sceneId)
    return restored?.session.snapshot() ?? null
  })

  ipcMain.handle(CHANNELS.save, async (event, rawSceneId: unknown, rawManifest: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const sceneId = requiredSceneId(rawSceneId)
    const session = createPalaceSceneBuilder(requiredManifest(rawManifest))
    return persist(sceneId, session.snapshot())
  })

  ipcMain.handle(CHANNELS.edit, async (event, rawSceneId: unknown, rawPatch: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const sceneId = requiredSceneId(rawSceneId)
    const session = await readSession(sceneId)
    return persist(sceneId, session.edit(requiredPatch(rawPatch)))
  })

  ipcMain.handle(CHANNELS.rollback, async (event, rawSceneId: unknown, rawRevision: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const sceneId = requiredSceneId(rawSceneId)
    const session = await readSession(sceneId)
    return persist(sceneId, session.rollback(requiredRevision(rawRevision)))
  })

  ipcMain.handle(CHANNELS.export, async (event, rawSceneId: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const sceneId = requiredSceneId(rawSceneId)
    const restored = await restorePalaceSceneBuilderSnapshot(app.getPath('userData'), sceneId)
    return restored?.session.export() ?? null
  })
}

export { CHANNELS as PALACE_SCENE_BUILDER_IPC_CHANNELS }
