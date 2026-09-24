import type { SessionMeta } from './types'
import type { VoiceDraftApi } from './voice-input-types'

export type DesktopCompanionSize = 'small' | 'medium' | 'large'
export interface DesktopCompanionSettings {
  enabled: boolean
  size: DesktopCompanionSize
  mode?: 'figure' | 'mini'
  displayId?: string
  position?: { x: number; y: number }
  /** App-owned PNG/GIF asset; omitted selects the built-in Ming attendant. */
  imageId?: string
}
export interface DesktopCompanionTask {
  sessionId: string
  title: string
  status: SessionMeta['status']
  pendingApprovalCount: number
}
export interface DesktopCompanionSnapshot {
  language: 'zh' | 'en'
  expanded: boolean
  selectedSessionId?: string
  tasks: DesktopCompanionTask[]
  runningCount: number
  attentionCount: number
  settings: DesktopCompanionSettings
  deliveries: DesktopCompanionDraftReceipt[]
  error?: string
}
export interface DesktopCompanionDraftReceipt {
  requestId: string
  sessionId: string
  status: 'pending' | 'delivered' | 'rejected'
  error?: string
}
export interface DesktopCompanionNavigation {
  requestId: string
  target: 'main' | 'palace'
  sessionId?: string
}
export interface DesktopCompanionDraftDelivery {
  deliveryId: string
  requestId: string
  sessionId: string
  text: string
  binding: Pick<SessionMeta, 'id' | 'createdAt' | 'workspaceId' | 'goalId' | 'workItemId'>
  status?: 'delivered' | 'rejected'
  error?: string
}
export interface DesktopCompanionApi extends VoiceDraftApi {
  setMode(mode: 'figure' | 'mini'): Promise<void>
  getFigure(): Promise<{ dataUrl: string; name: string } | null>
  getState(): Promise<DesktopCompanionSnapshot>
  selectTask(sessionId: string): Promise<DesktopCompanionSnapshot>
  setExpanded(expanded: boolean): Promise<DesktopCompanionSnapshot>
  hide(): Promise<void>
  openTask(sessionId: string, target?: 'main' | 'detached'): Promise<void>
  openMain(target?: 'main' | 'palace'): Promise<void>
  onState(cb: (state: DesktopCompanionSnapshot) => void): () => void
  submitDraft(input: { requestId: string; sessionId: string; text: string }): Promise<DesktopCompanionDraftReceipt>
}
export interface DesktopCompanionWorkbenchApi {
  readyDesktopCompanionReceiver(): Promise<void>
  acknowledgeDesktopCompanionDraft(delivery: DesktopCompanionDraftDelivery): Promise<void>
  onDesktopCompanionDraft(cb: (delivery: DesktopCompanionDraftDelivery) => void): () => void
  onNavigate(cb: (navigation: DesktopCompanionNavigation) => void): () => void
  acknowledgeNavigation(requestId: string): Promise<void>
}
