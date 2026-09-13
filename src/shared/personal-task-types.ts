import type {
  CaoGenDriveMode,
  SessionMeta,
  SessionRoutingScope,
  TaskStrategy
} from './types'
import type { BusinessLineBinding } from './business-line-types'

/** One user action. Keep the same ID and input across IPC timeouts and restarts. */
export interface PersonalTaskSubmitInput extends BusinessLineBinding {
  clientRequestId: string
  text: string
  providerId?: string
  model?: string
  routingScope?: SessionRoutingScope
  driveMode?: CaoGenDriveMode
  taskStrategy?: TaskStrategy
  budgetUsd?: number
}

export interface PersonalTaskBinding {
  workspaceId: string
  goalId: string
  workItemId: string
  sessionId: string
}

export type PersonalTaskSubmissionStatus =
  | 'preparing'
  | 'ready'
  | 'submitted'
  | 'not_sent'
  | 'needs_reconciliation'

/** The receipt describes submission; task completion remains in the canonical Run. */
export interface PersonalTaskSubmissionView {
  clientRequestId: string
  revision: number
  status: PersonalTaskSubmissionStatus
  replayed: boolean
  /** Present only after the complete canonical task and Session binding is verified. */
  binding?: PersonalTaskBinding
  messageId: string
  runId?: string
  session?: SessionMeta
  error?: { code: string; message: string }
}

export interface PersonalTaskApi {
  submitPersonalTask(input: PersonalTaskSubmitInput): Promise<PersonalTaskSubmissionView>
  getPersonalTaskSubmission(clientRequestId: string): Promise<PersonalTaskSubmissionView | null>
}

/** Closed IPC command; caller-controlled channel names are never exposed. */
export type PersonalTaskCommand =
  | { kind: 'submit'; input: PersonalTaskSubmitInput }
  | { kind: 'get_submission'; clientRequestId: string }

export type PersonalTaskCommandResult<Command extends PersonalTaskCommand> =
  Command extends { kind: 'submit' } ? PersonalTaskSubmissionView : PersonalTaskSubmissionView | null
