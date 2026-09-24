import type { SessionStatus } from './types'
import type { SessionInputRecord } from './session-input-types'

/** Main-process minted, persistent restriction; source is context provenance, never execution ownership. */
export interface SideChatBinding {
  schemaVersion: 1
  sideChatId: string
  sourceSessionId: string
  sourceSessionCreatedAt: number
  snapshotDigest: string
  policy: 'context_only_v1'
}
export interface SideChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  complete: boolean
  isError?: boolean
}
export interface SideChatView {
  id: string
  sourceSessionId: string
  sourceTitle: string
  sessionId: string
  title: string
  status: SessionStatus
  capturedAt: number
  contextSummary: string
  omittedCount: number
  providerId: string
  model: string
  costUsd: number
  messages: SideChatMessage[]
  error?: string
  closed: boolean
}
export interface SideChatCreateInput { sourceSessionId: string; requestId: string }
export interface SideChatSendInput { sideChatId: string; requestId: string; text: string }
export interface SideChatSendResult { view: SideChatView; input: SessionInputRecord }
export interface SideChatAdoptInput { sideChatId: string; messageId: string; /** Exact substring of a completed answer, omitted = full answer. */ selection?: string }
export interface SideChatAdoption {
  adoptionId: string
  sideChatId: string
  sourceSessionId: string
  sourceSessionCreatedAt: number
  messageId: string
  text: string
  capturedAt: number
}
export interface SideChatApi {
  createSideChat(input: SideChatCreateInput): Promise<SideChatView>
  listSideChats(sourceSessionId: string): Promise<SideChatView[]>
  getSideChat(sideChatId: string): Promise<SideChatView>
  sendSideChatMessage(input: SideChatSendInput): Promise<SideChatSendResult>
  interruptSideChat(sideChatId: string): Promise<void>
  closeSideChat(sideChatId: string): Promise<void>
  adoptSideChatAnswer(input: SideChatAdoptInput): Promise<SideChatAdoption>
}
