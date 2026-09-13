import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEventRecord,
  WorkflowGoalRecord,
  WorkflowRunRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import type { TaskEvidenceRecord } from './task-evidence-store'

export interface WorkflowEventReferenceIndex {
  goals: Map<string, WorkflowGoalRecord>
  workItems: Map<string, WorkflowWorkItemRecord>
  runs: Map<string, WorkflowRunRecord>
  artifacts: Map<string, WorkflowArtifactRecord>
  acceptances: Map<string, WorkflowAcceptanceRecord>
  evidenceLinks: Map<string, WorkflowEvidenceLinkRecord>
  taskEvidence: Map<string, TaskEvidenceRecord> | null
}

export interface WorkflowEventAppendState {
  events: WorkflowEventRecord[]
  references: WorkflowEventReferenceIndex
}
