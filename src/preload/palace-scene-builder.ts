import { ipcRenderer } from 'electron'
import type {
  AgentDeskApi,
  PalaceSceneBuilderApi,
  PalaceSceneBuilderManifestInput,
  PalaceSceneBuilderPatch
} from '../shared/types'

type PalaceSceneBuilderBridgeApi = Pick<AgentDeskApi, keyof PalaceSceneBuilderApi>

/** Explicit PalaceScene Builder allowlist; channel names never cross the bridge. */
export const palaceSceneBuilderApi: PalaceSceneBuilderBridgeApi = {
  getPalaceSceneBuilder: (sceneId: string) => ipcRenderer.invoke('palaceSceneBuilder:get', sceneId),
  savePalaceSceneBuilder: (sceneId: string, manifest: PalaceSceneBuilderManifestInput) =>
    ipcRenderer.invoke('palaceSceneBuilder:save', sceneId, manifest),
  editPalaceSceneBuilder: (sceneId: string, patch: PalaceSceneBuilderPatch) =>
    ipcRenderer.invoke('palaceSceneBuilder:edit', sceneId, patch),
  rollbackPalaceSceneBuilder: (sceneId: string, builderRevision: number) =>
    ipcRenderer.invoke('palaceSceneBuilder:rollback', sceneId, builderRevision),
  exportPalaceSceneBuilder: (sceneId: string) => ipcRenderer.invoke('palaceSceneBuilder:export', sceneId)
}

