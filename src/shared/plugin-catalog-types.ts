import type { PluginRegistryKind } from './plugin-registry-types'
import type { PluginInstallResult } from './plugin-types'

export interface PluginCatalogRelease {
  version: string
  archiveUrl: string
  archiveSha256: string
  archiveBytes: number
  description?: string
}
export interface PluginCatalogPackage {
  id: string
  name: string
  summary: string
  kind: PluginRegistryKind
  releases: PluginCatalogRelease[]
}
export interface PluginCatalogDocument { schemaVersion: 1; name: string; packages: PluginCatalogPackage[] }
export interface PluginCatalogSource {
  id: string; name: string; url: string; enabled: boolean
  fetchedAt?: number; snapshotDigest?: string; error?: string
}
export interface PluginCatalogEntry extends Omit<PluginCatalogPackage, 'releases'> {
  sourceId: string; sourceName: string; sourceUrl: string; snapshotDigest: string
  release: PluginCatalogRelease
  changedVersion: boolean
}
export interface PluginCatalogSelection {
  sourceId: string; packageId: string; version: string; archiveSha256: string; snapshotDigest: string
}
export type PluginCatalogPreparationState = 'downloading' | 'ready' | 'installing' | 'installed' | 'waiting_reconciliation' | 'failed' | 'cancelled' | 'reverted'
export interface PluginCatalogPreparationView {
  id: string; operationId: string; selection: PluginCatalogSelection; name: string
  sourceUrl: string; archiveUrl: string; archiveBytes: number
  state: PluginCatalogPreparationState; createdAt: number; updatedAt: number; error?: string
  preview?: {
    digest: string; targetPath: string; directoryDigest: string; files: number; bytes: number; overwrite: boolean
    items: Array<{ name: string; kind: PluginRegistryKind; version?: string; contentDigest: string; capabilities: string[] }>
  }
  result?: PluginInstallResult
}
export interface PluginCatalogView { sources: PluginCatalogSource[]; entries: PluginCatalogEntry[]; preparations: PluginCatalogPreparationView[] }
export interface PluginCatalogApi {
  getPluginCatalog(): Promise<PluginCatalogView>
  addPluginCatalogSource(input: { name: string; url: string }): Promise<PluginCatalogView>
  setPluginCatalogSourceEnabled(id: string, enabled: boolean): Promise<PluginCatalogView>
  removePluginCatalogSource(id: string): Promise<PluginCatalogView>
  refreshPluginCatalogSource(id: string): Promise<PluginCatalogView>
  prepareCatalogPlugin(selection: PluginCatalogSelection): Promise<PluginCatalogPreparationView>
  cancelCatalogPluginPreparation(id: string): Promise<PluginCatalogPreparationView>
  installCatalogPlugin(input: { id: string; previewDigest: string; overwrite: boolean }): Promise<PluginCatalogPreparationView>
  reconcileCatalogPlugin(id: string): Promise<PluginCatalogPreparationView>
}
