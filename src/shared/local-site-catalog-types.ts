import type { LocalSitePreview } from './local-site-preview-types'

export interface LocalSiteOwner {
  sessionId: string
  createdAt: number
  cwd: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
}
export interface LocalSitePublication {
  receiptId: string
  targetName: string
  action: 'deploy' | 'rollback'
  status: 'executing' | 'confirmed' | 'not_started' | 'needs_reconciliation'
  startedAt: number
  deploymentId?: string
  url?: string
}
export interface LocalSiteView {
  id: string
  revision: string
  name: string
  sourcePath: string
  kind: 'html' | 'directory'
  owner: LocalSiteOwner
  taskKey: string
  taskTitle: string
  registeredAt: number
  origin: 'registered' | 'deployment'
  availability: 'available' | 'task_closed' | 'owner_changed' | 'missing_source' | 'unavailable'
  unavailableReason?: string
  lastConfirmedDeployment?: LocalSitePublication
  /** Newer rollbacks or unknown operations remain visible beside the last confirmed deploy. */
  latestOperation?: LocalSitePublication
  unresolvedOperations: number
}
export interface LocalSiteCatalog { sites: LocalSiteView[]; warnings: string[] }
export interface LocalSiteRegistration { sessionId: string; path: string; name?: string }
export interface LocalSiteResolution {
  siteId: string
  sessionId: string
  path: string
  kind: 'html' | 'directory'
  taskKey: string
}
export interface LocalSiteCatalogApi {
  listLocalSites(): Promise<LocalSiteCatalog>
  registerLocalSite(input: LocalSiteRegistration): Promise<LocalSiteView>
  resolveLocalSite(siteId: string, revision: string): Promise<LocalSiteResolution>
  previewLocalSite(siteId: string, revision: string): Promise<LocalSitePreview>
}
