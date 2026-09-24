export interface ChatSnapshotMessage { id: string; role: 'user' | 'assistant'; text: string }
export interface ChatSnapshotSource {
  id: string; sessionId: string; title: string; capturedAt: number; expiresAt: number
  messages: ChatSnapshotMessage[]; redactedMessages: number; omittedEvents: number; omittedAttachments: number; incompleteTurns: number
}
export interface PrepareChatSnapshotInput { sourcePreviewId: string; title: string; selectedMessageIds: string[]; replacements?: Record<string,string> }
export interface ChatSnapshotView {
  id: string; sessionId: string; title: string; capturedAt: number; createdAt: number
  messageCount: number; bytes: number; digest: string; redactedMessages: number
}
export interface ChatSnapshotContent { snapshot: ChatSnapshotView; messages: ChatSnapshotMessage[]; html: string }
export interface ChatShareAdapterInput { id?: string; revision?: number; name: string; deploymentTargetId: string; deploymentTargetRevision: number; args: string[] }
export interface ChatShareAdapter {
  id: string; revision: number; name: string; sessionId: string; deploymentTargetId: string; deploymentTargetRevision: number
  executable: string; args: string[]; environmentKeys: string[]; timeoutSeconds: number
}
export interface ChatShareAccount {
  adapterNamespace: string; accountScope: string; targetId: string; accountName: string
  capabilities: { publish: boolean; revoke: boolean; inspect: boolean; idempotent: boolean; conditionalRevoke: boolean }
}
export interface ChatShareOperationInput {
  action: 'publish' | 'revoke'
  snapshotId: string
  adapterId?: string
  /** Required for revocation; references the exact confirmed publication receipt. */
  shareId?: string
}
export interface ChatShareOperationPreview {
  id: string; operationId: string; action: 'publish' | 'revoke'; snapshot: ChatSnapshotView
  adapter: ChatShareAdapter; account: ChatShareAccount; shareId: string; expectedRevision?: string
  command: string[]; createdAt: number; expiresAt: number
}
export interface ChatShareReceipt {
  id: string; snapshotId: string; sessionId: string; adapterId: string; adapterName: string
  action: 'publish' | 'revoke'; operationId: string; shareId: string; manifestDigest: string
  account: ChatShareAccount; expectedRevision?: string; revision?: string; url?: string
  status: 'executing' | 'confirmed' | 'not_applied' | 'needs_reconciliation'
  publicState: 'active' | 'revoked' | 'absent' | 'unknown'
  startedAt: number; finishedAt?: number; error?: string; effectId?: string; recoverySnapshotId?: string
}
export interface ChatSnapshotShareState { snapshots: ChatSnapshotView[]; adapters: ChatShareAdapter[]; receipts: ChatShareReceipt[] }
export interface ChatSnapshotShareApi {
  captureChatSnapshot(sessionId: string): Promise<ChatSnapshotSource>
  prepareChatSnapshot(sessionId: string, input: PrepareChatSnapshotInput): Promise<ChatSnapshotContent>
  readChatSnapshot(snapshotId: string): Promise<ChatSnapshotContent>
  listChatSnapshots(sessionId?: string): Promise<ChatSnapshotShareState>
  exportChatSnapshot(snapshotId: string): Promise<{ canceled: boolean; filePath?: string }>
  saveChatShareAdapter(sessionId: string, input: ChatShareAdapterInput): Promise<ChatShareAdapter>
  prepareChatShareOperation(input: ChatShareOperationInput): Promise<ChatShareOperationPreview | null>
  executeChatShareOperation(previewId: string): Promise<ChatShareReceipt | null>
  inspectChatShareOperation(receiptId: string): Promise<ChatShareReceipt | null>
  cancelChatShareOperation(operationId: string): Promise<boolean>
}
