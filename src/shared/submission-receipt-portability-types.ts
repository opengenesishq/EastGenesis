import type { ProjectGoalTaskPrepareInput } from './project-workspace-types'
import type { SessionInputRecord } from './session-input-types'

export interface PortableProjectGoalSubmission {
  schemaVersion: 1
  input: ProjectGoalTaskPrepareInput
  digest: string
  sessionId: string
  phase: 'reserved' | 'task_created' | 'creating_session' | 'session_ready' | 'ready'
  revision: number
  createdAt: number
  updatedAt: number
}

export interface PortableSessionInput {
  /** Attachment paths are relative to userData and constrained to this Session. */
  record: SessionInputRecord
  /** Retains the source ledger binding even when attachment paths move on import. */
  evidencePayloadDigest: string
  /** Original local path metadata used only to verify the source ledger digest, never to read files. */
  evidencePayloadPaths: { images: string[]; documents: string[] }
}

export interface ProjectSubmissionReceiptSlice {
  schemaVersion: 1
  projectId: string
  sessionInputs: PortableSessionInput[]
  projectGoals: PortableProjectGoalSubmission[]
  sliceDigest: string
}
