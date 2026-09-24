export interface SiteManagementConfig { protocol: 'caogen-site-management/1'; args: string[]; siteId: string }
export type HostedSiteChange = { kind: 'domain.bind'; hostname: string } | { kind: 'domain.unbind'; hostname: string } | { kind: 'access.set'; mode: 'public' | 'disabled' } | { kind: 'site.delete' }
  | { kind: 'environment.set'; name: string; secret: boolean; valueRef: string }
  | { kind: 'environment.remove'; name: string }
export interface HostedSiteEnvironmentVariable { name: string; secret: boolean; revision: string; updatedAt: string }
export interface HostedSiteEnvironmentInput { name: string; secret: boolean; value: string }
export interface HostedSiteRange { from: string; to: string; timeZone: string }
export interface HostedSiteCapabilities {
  domainRead: boolean; domainBind: boolean; domainUnbind: boolean
  accessRead: boolean; accessSetPublic: boolean; accessDisable: boolean
  analytics: boolean; deleteSite: boolean; inspectOperation: boolean
  idempotentOperations: boolean; conditionalMutations: boolean
  environmentRead?: boolean; environmentSet?: boolean; environmentRemove?: boolean
}
export interface HostedSiteDescriptor {
  adapterNamespace: string; accountScope: string; accountName: string; siteId: string; name: string
  revision: string; deploymentId?: string; url?: string; observedAt: string; deleted: boolean
  capabilities: HostedSiteCapabilities
  domains: Array<{ hostname: string; status: 'pending' | 'verified' | 'failed' | 'unknown'; dnsInstructions?: string; observedAt: string }>
  access: { mode: 'public' | 'disabled' | 'unknown'; description: string }
  /** Metadata only. Existing values are never returned to the workbench. */
  environment?: HostedSiteEnvironmentVariable[]
  environmentRequiresRedeploy?: boolean
}
export interface HostedSiteAnalytics {
  source: string; methodology: string; from: string; to: string; timeZone: string; generatedAt: string; sampled: boolean
  pageViews?: number; uniqueVisitors?: number
  daily: Array<{ date: string; pageViews?: number; uniqueVisitors?: number }>
}
export interface HostedSitePreview {
  id: string; sessionId: string; targetId: string; targetName: string
  operationId: string; planId: string; planDigest: string; expectedRevision: string
  change: HostedSiteChange; before: HostedSiteDescriptor; after: HostedSiteDescriptor; impact: string[]
  command: string[]; environmentKeys: string[]; createdAt: number; expiresAt: number
}
export interface HostedSiteReceipt {
  id: string; sessionId: string; targetId: string; operationId: string; previewId: string
  change: HostedSiteChange; siteId: string; accountScope: string
  status: 'executing' | 'confirmed' | 'not_applied' | 'needs_reconciliation'
  startedAt: number; finishedAt?: number; effectId?: string; recoverySnapshotId?: string
  result?: 'applied' | 'not_applied' | 'unknown'; after?: HostedSiteDescriptor
  error?: string; output: string
}
export interface HostedSiteState {
  configured: boolean; connected: boolean; descriptor?: HostedSiteDescriptor; analytics?: HostedSiteAnalytics
  receipts: HostedSiteReceipt[]; unavailableReason?: string
}
export interface HostedSiteApi {
  getHostedSite(sessionId: string, targetId: string): Promise<HostedSiteState>
  refreshHostedSite(sessionId: string, targetId: string, targetRevision: number): Promise<HostedSiteState>
  queryHostedSiteAnalytics(sessionId: string, targetId: string, range: HostedSiteRange): Promise<HostedSiteAnalytics>
  prepareHostedSiteChange(sessionId: string, targetId: string, change: HostedSiteChange): Promise<HostedSitePreview>
  prepareHostedSiteEnvironment(sessionId: string, targetId: string, input: HostedSiteEnvironmentInput): Promise<HostedSitePreview>
  discardHostedSitePreview(sessionId: string, previewId: string): Promise<void>
  executeHostedSiteChange(sessionId: string, previewId: string): Promise<HostedSiteReceipt | null>
  inspectHostedSiteChange(sessionId: string, receiptId: string): Promise<HostedSiteReceipt>
  cancelHostedSiteOperation(sessionId: string, operationId: string): Promise<boolean>
}
