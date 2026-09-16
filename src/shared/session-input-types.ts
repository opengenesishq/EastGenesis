import type { SendMessagePayload } from './message-payload-types'
import type { SessionRequirementRevisionReceipt } from './session-requirement-revision'

/** A durable outbox for additions to an existing Session, never a new task. */
export interface SessionInputRecord {
  schemaVersion: 1
  /** Missing on the initial V1 receipts; normalized to 1 by the main-process store. */
  revision?: number
  /** Original accepted payload digest retained when an imported receipt's attachment paths move. */
  importedPayloadDigest?: string
  importedPayloadPaths?: { images: string[]; documents: string[] }
  id: string
  sessionId: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  messageId: string
  payload: SendMessagePayload
  /** requirements_applied records a contract-only command; it never means an engine received a message. */
  phase: 'queued' | 'dispatching' | 'applied' | 'requirements_applied' | 'needs_reconciliation' | 'cancelled'
  requirementRevision?: SessionRequirementRevisionReceipt
  createdAt: number
  updatedAt: number
  error?: string
}

export interface SessionInputApi {
  listSessionInputs(sessionId: string): Promise<SessionInputRecord[]>
  queueSessionInput(sessionId: string, requestId: string, payload: SendMessagePayload): Promise<SessionInputRecord>
  applySessionInput(sessionId: string, requestId: string): Promise<SessionInputRecord>
  cancelSessionInput(sessionId: string, requestId: string): Promise<SessionInputRecord>
}
