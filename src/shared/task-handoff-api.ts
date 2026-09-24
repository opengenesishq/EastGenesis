import type { TaskHandoffHostIdentity, TaskHandoffIdentity } from './task-handoff-types'

export interface TaskHandoffDestinationView { id: string; label: string; path: string; expiresAt: number; enabled: boolean }
export interface TaskHandoffRemoteCapabilities { protocolVersion: 1; host: TaskHandoffHostIdentity; destinations: TaskHandoffDestinationView[] }
export interface TaskHandoffView {
  id: string; direction: 'outgoing' | 'incoming'; identity: TaskHandoffIdentity; title: string
  state: 'preparing' | 'uploading' | 'ready' | 'released' | 'importing' | 'committed' | 'cancelled' | 'needs_reconciliation'
  hostId?: string; sourceHostId: string; targetHostId: string; targetPath?: string
  createdAt: number; updatedAt: number; files: number; bytes: number; excluded: string[]
  previewDigest?: string; message?: string; missingResources: string[]
  canCancelBeforeRelease?: boolean
}
export interface TaskHandoffApi {
  listTaskHandoffs(sessionId?: string): Promise<TaskHandoffView[]>
  getTaskHandoffTargets(hostId: string, sessionId: string): Promise<TaskHandoffRemoteCapabilities>
  prepareTaskHandoff(input: { sessionId: string; hostId: string; destinationId: string }): Promise<TaskHandoffView>
  commitTaskHandoff(input: { id: string; previewDigest: string }): Promise<TaskHandoffView>
  reconcileTaskHandoff(id: string): Promise<TaskHandoffView>
  cancelTaskHandoff(id: string): Promise<TaskHandoffView>
  listTaskHandoffDestinations(): Promise<TaskHandoffDestinationView[]>
  addTaskHandoffDestination(): Promise<TaskHandoffDestinationView | undefined>
  revokeTaskHandoffDestination(id: string): Promise<void>
  renewTaskHandoffDestination(id: string): Promise<void>
}
