import type {
  PalaceSceneActionBinding,
  PalaceSceneCamera,
  PalaceSceneManifest,
  PalaceSceneRoleBinding,
  PalaceSceneTheme,
  PalaceSceneViewBinding,
  PalaceSceneZone
} from './palace-scene-manifest'

export type PalaceSceneBuilderManifestInput = PalaceSceneManifest | string

export type PalaceSceneBuilderChangeArea =
  | 'metadata'
  | 'layout'
  | 'zones'
  | 'roles'
  | 'views'
  | 'actions'
  | 'theme'
  | 'camera'

export interface PalaceSceneBuilderPatch {
  title?: string
  layoutVersion?: number
  zones?: PalaceSceneZone[]
  roleBindings?: PalaceSceneRoleBinding[]
  viewBindings?: PalaceSceneViewBinding[]
  actionBindings?: PalaceSceneActionBinding[]
  theme?: PalaceSceneTheme
  camera?: PalaceSceneCamera
}

export interface PalaceSceneBuilderVersionSummary {
  builderRevision: number
  manifestVersion: number
  layoutVersion: number
  digest: `sha256:${string}`
  parentDigest?: `sha256:${string}`
  change: 'initial' | 'edit' | 'rollback'
  changedAreas: PalaceSceneBuilderChangeArea[]
  restoredFromRevision?: number
}

export interface PalaceSceneBuilderVersion {
  summary: PalaceSceneBuilderVersionSummary
  manifest: PalaceSceneManifest
}

export interface PalaceSceneBuilderSnapshot {
  manifest: PalaceSceneManifest
  summary: PalaceSceneBuilderVersionSummary
  history: readonly PalaceSceneBuilderVersionSummary[]
  versions: readonly PalaceSceneBuilderVersion[]
}

/** The only PalaceScene surface exposed to renderer code. */
export interface PalaceSceneBuilderApi {
  getPalaceSceneBuilder(sceneId: string): Promise<PalaceSceneBuilderSnapshot | null>
  savePalaceSceneBuilder(sceneId: string, manifest: PalaceSceneBuilderManifestInput): Promise<PalaceSceneBuilderSnapshot>
  editPalaceSceneBuilder(sceneId: string, patch: PalaceSceneBuilderPatch): Promise<PalaceSceneBuilderSnapshot>
  rollbackPalaceSceneBuilder(sceneId: string, builderRevision: number): Promise<PalaceSceneBuilderSnapshot>
  exportPalaceSceneBuilder(sceneId: string): Promise<string | null>
}
